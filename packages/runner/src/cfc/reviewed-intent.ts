/**
 * Mints reviewed intents for the trusted host's reviewed-intent surface. A
 * reviewed intent is a create-only record, written under this module's builtin
 * identity, stating that the authenticated actor released exactly these
 * parameters to exactly these destinations, recently, once. An application
 * that acts outside the fabric on the actor's behalf (the consumer) publishes
 * a descriptor of what it accepts; the host previews the destinations the
 * pattern binds against it, and a trusted gesture on the host's surface
 * commits the record. This module is absent from authored pattern imports.
 *
 * The record is what a consumer acts on, and {@link verifyReviewedIntentRecord}
 * is how it tells a record this module wrote from one a pattern wrote. The
 * rest of the contract, the consumer's half included, is
 * `docs/specs/cfc-reviewed-intent.md`.
 */

import type { JSONValue } from "@commonfabric/api";
import { CFC_ATOM_TYPE, type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import { debugStr, deepFreeze, hashStringOf } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import { type Cell, cellRuntime } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import {
  type AtomPattern,
  isAtomPattern,
  matchAtomPattern,
  matchAtomPatternConjunction,
} from "./atom-pattern.ts";
import type { CfcConfClause } from "./clause.ts";
import { cfcLabelViewFromMetadata } from "./label-view-state.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { cfcObservationFitsCeiling } from "./observation.ts";
import { collectConsumedLabel } from "./prepare.ts";
import { snapshotJsonValue } from "./share-snapshot-value.ts";
import { isRendererTrustedEvent } from "./ui-contract.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";

/** Builtin implementation identity that alone writes reviewed intents. */
export const REVIEWED_INTENT_WRITER = "cfc-reviewed-intent";

/** The `provenance.ui.pattern` mark of the host's commit gesture. */
export const REVIEWED_INTENT_GESTURE = "ReviewedIntent";

/** The host surface a record names as its evidence. */
export const REVIEWED_INTENT_COMPONENT = "cf-reviewed-intent";

/**
 * The longest a reviewed intent stays good for, whatever its descriptor asks:
 * ten minutes, the short-intent window ruled by @seefeldb.
 */
export const SHORT_INTENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * The stamp every location a reviewed intent's transaction writes carries,
 * and the one a record's root must carry to verify.
 */
const WRITTEN_BY_REVIEWED_INTENT = deepFreeze({
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: REVIEWED_INTENT_WRITER },
});

/** A declared parameter whose value is one or more bound destinations. */
export interface ReviewedIntentDestinationsParameter {
  readonly kind: "destinations";

  /** Fewest destinations a record carries for this key. */
  readonly min: number;

  /** Most destinations a record carries for this key; at least 1. */
  readonly max: number;
}

/** A declared parameter whose value is text the actor enters on the surface. */
export interface ReviewedIntentTextParameter {
  readonly kind: "text";

  /** Most Unicode code points the text holds, as JSON Schema counts them. */
  readonly maxLength: number;
}

/** One declared parameter of a descriptor. */
export type ReviewedIntentParameter =
  | ReviewedIntentDestinationsParameter
  | ReviewedIntentTextParameter;

/**
 * What a consumer accepts, published by the consumer in a cell the host
 * reads. A record names its descriptor by digest (`endpoint`), so a consumer
 * acts only on records reviewed against the descriptor it publishes. Every
 * member is required and no other is accepted, at any level: a member this
 * build does not know could be a limit it would fail to enforce, so a
 * descriptor carrying one is refused rather than read without it.
 */
export interface ReviewedIntentDescriptor {
  /** What a record authorizes, such as `send-message`. */
  readonly operation: string;

  /** The name the surface shows the actor as the way the intent is carried. */
  readonly endpointName: string;

  /** The consumer that acts on records. */
  readonly consumer: string;

  /** The only parameter keys a record carries, each with its kind. */
  readonly parameters: Readonly<Record<string, ReviewedIntentParameter>>;

  /**
   * Atom patterns every destination's stored integrity must satisfy together,
   * as one conjunction with shared variables. Nonempty when any parameter is
   * of kind `destinations`.
   */
  readonly destinationIntegrity: readonly AtomPattern[];

  /**
   * How long after the gesture a record is good for, in milliseconds. A record
   * takes the smaller of this and {@link SHORT_INTENT_WINDOW_MS}.
   */
  readonly windowMs: number;

  /** How many delivery attempts a consumer may make on one record. */
  readonly maxAttempts: number;
}

/** A destination as reviewed: its stored value and the integrity it carries. */
export interface ReviewedDestination {
  /** The destination cell's stored value, exactly as the surface shows it. */
  readonly address: JSONValue;

  /** The atoms of the destination's stored integrity the descriptor names. */
  readonly integrity: readonly CfcAtom[];
}

/** The cells a pattern binds for one reviewed intent. */
export interface ReviewedIntentBindings {
  /** The consumer's published descriptor. */
  readonly descriptor: Cell<unknown>;

  /**
   * The destination cells for each declared `destinations` parameter, in the
   * order the record lists them.
   */
  readonly destinations: Readonly<Record<string, readonly Cell<unknown>[]>>;

  /**
   * The pattern's cell that receives a link to the committed record. Its write
   * target is reviewed with the rest, and the link is written without this
   * module's identity, so a target in a document that admits only this
   * module's writes refuses it.
   */
  readonly result: Cell<unknown>;
}

/** Type-only brand for host-held consent objects. */
declare const consentBrand: unique symbol;

/** One-use commit authority held only by the trusted host. */
export interface ReviewedIntentConsent {
  /** Nominal token whose identity is verified against a private registry. */
  readonly [consentBrand]: true;
}

/** Frozen preview for the trusted host's surface. */
export interface PreparedReviewedIntent {
  /** The authenticated actor the record names as its subject. */
  readonly actor: string;

  /** The descriptor's `operation`. */
  readonly operation: string;

  /** The descriptor's `endpointName`. */
  readonly endpointName: string;

  /** The descriptor's `consumer`. */
  readonly consumer: string;

  /** The descriptor's digest, which the record carries as `endpoint`. */
  readonly endpoint: string;

  /** Every `destinations` parameter, as the record carries it. */
  readonly destinations: Readonly<
    Record<string, readonly ReviewedDestination[]>
  >;

  /** Every `text` parameter, for the field the surface draws for it. */
  readonly text: Readonly<Record<string, { readonly maxLength: number }>>;

  /** How long after the gesture the record is good for, in milliseconds. */
  readonly windowMs: number;

  /** The descriptor's `maxAttempts`. */
  readonly maxAttempts: number;

  /** One-use authority bound to this preview and the authenticated actor. */
  readonly consent: ReviewedIntentConsent;
}

/** What the actor entered on the surface, given to the commit. */
export interface ReviewedIntentInput {
  /** The text of every declared `text` parameter, and nothing else. */
  readonly text: Readonly<Record<string, string>>;
}

/**
 * The record a commit writes, as a consumer that verified it acts on it.
 */
export interface ReviewedIntentRecord {
  /** The descriptor's `operation`. */
  readonly operation: string;

  /** The digest of the descriptor the actor reviewed against. */
  readonly endpoint: string;

  /** The descriptor's `consumer`. */
  readonly consumer: string;

  /** The actor who made the gesture; the record lives in their home space. */
  readonly subject: string;

  /**
   * Every declared parameter: a `destinations` parameter as its reviewed
   * destinations, a `text` parameter as the text entered.
   *
   * The stored record holds this as its JSON text with sorted keys, a leaf,
   * and {@link verifyReviewedIntentRecord} returns it parsed. The runtime
   * stores an object inside an array as a document of its own, which the
   * record's root stamp would not cover; a leaf keeps every parameter inside
   * the one document the stamp vouches for.
   */
  readonly parameters: Readonly<
    Record<string, string | readonly ReviewedDestination[]>
  >;

  /** The data-model digest of `parameters`. */
  readonly payloadDigest: string;

  /** Unique to the consent; what a consumer keys its delivery attempts on. */
  readonly idempotencyKey: string;

  /** When the commit wrote the record, in milliseconds since the epoch. */
  readonly at: number;

  /** When the record stops being good, in milliseconds since the epoch. */
  readonly exp: number;

  /** The descriptor's `maxAttempts`. */
  readonly maxAttempts: number;

  /** The surface and the host event the gesture was made on. */
  readonly evidence: {
    readonly component: string;
    readonly event: string;
  };
}

/** What a commit wrote. */
export interface ReviewedIntentResult {
  /** The record, in the actor's home space. */
  readonly record: Cell<unknown>;

  /** The actor-private receipt, in the actor's home space. */
  readonly receipt: Cell<unknown>;
}

/** A storage address compared by space, id, scope and path. */
interface ReviewedAddress {
  readonly space: string;
  readonly id: string;
  readonly scope: string;
  readonly path: readonly string[];
}

/** A read whose content the record's transaction verifies. */
interface ReadEvidence {
  readonly address: IMemorySpaceAddress;
  readonly digest: string;
}

/** Everything one inspection establishes. */
interface Inspection {
  readonly actor: string;
  readonly descriptor: ReviewedIntentDescriptor;
  readonly endpoint: string;
  readonly descriptorAddress: ReviewedAddress;
  readonly destinations: Record<string, ReviewedDestination[]>;
  readonly destinationAddresses: Record<string, ReviewedAddress[]>;
  readonly resultAddress: ReviewedAddress;
  readonly confidentiality: readonly CfcConfClause[];
  readonly evidence: readonly ReadEvidence[];
}

/** Runtime-owned state behind an opaque consent token. */
interface ConsentState extends Inspection {
  readonly bindings: ReviewedIntentBindings;
  readonly eventId: string;
  readonly idempotencyKey: string;
}

const consents = new WeakMap<ReviewedIntentConsent, ConsentState>();

const STALE_REVIEW =
  "Reviewed intent review is stale; review the destinations again";

const DESCRIPTOR_KEYS = [
  "consumer",
  "destinationIntegrity",
  "endpointName",
  "maxAttempts",
  "operation",
  "parameters",
  "windowMs",
] as const;

const RECORD_KEYS = [
  "at",
  "consumer",
  "endpoint",
  "evidence",
  "exp",
  "idempotencyKey",
  "maxAttempts",
  "operation",
  "parameters",
  "payloadDigest",
  "subject",
] as const;

/** Whether `value` is a record with exactly the keys named. */
const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/**
 * `value` as JSON text with every object's keys in UTF-8 order, so equal
 * values have equal text.
 */
const canonicalJson = (value: JSONValue): string =>
  JSON.stringify(
    value,
    (_key, entry: unknown) =>
      isObjectNotArray(entry)
        ? Object.fromEntries(
          utf8SortedKeysOf(entry).map((key) => [key, entry[key]]),
        )
        : entry,
  );

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Validates one declared parameter, refusing a kind or member it does not know. */
const parseParameter = (
  key: string,
  value: unknown,
): ReviewedIntentParameter => {
  if (isObjectNotArray(value) && value.kind === "destinations") {
    if (
      hasExactKeys(value, ["kind", "max", "min"]) && isCount(value.min) &&
      isPositiveInteger(value.max) && value.min <= value.max
    ) return { kind: "destinations", min: value.min, max: value.max };
  } else if (isObjectNotArray(value) && value.kind === "text") {
    if (
      hasExactKeys(value, ["kind", "maxLength"]) &&
      isPositiveInteger(value.maxLength)
    ) return { kind: "text", maxLength: value.maxLength };
  }
  throw new Error(
    debugStr`Reviewed intent descriptor declares a parameter this build cannot show: $quote${key}`,
  );
};

/**
 * Reads a reviewed-intent descriptor, as a host does before a preview and a
 * consumer should before publishing one.
 *
 * @throws If `value` is not a descriptor: a member is missing, malformed, or
 *   not one this build knows, or a `destinations` parameter is declared with
 *   no destination integrity.
 */
export function parseReviewedIntentDescriptor(
  value: unknown,
): ReviewedIntentDescriptor {
  if (!isObjectNotArray(value) || !hasExactKeys(value, DESCRIPTOR_KEYS)) {
    throw new Error(
      `Reviewed intent descriptor must hold exactly ${
        DESCRIPTOR_KEYS.map((key) => `\`${key}\``).join(", ")
      }`,
    );
  }
  const {
    operation,
    endpointName,
    consumer,
    parameters,
    destinationIntegrity,
    windowMs,
    maxAttempts,
  } = value;
  if (
    !isNonEmptyString(operation) || !isNonEmptyString(endpointName) ||
    !isNonEmptyString(consumer)
  ) {
    throw new Error(
      "Reviewed intent descriptor requires a nonempty `operation`, `endpointName` and `consumer`",
    );
  }
  if (!isPositiveInteger(windowMs) || !isPositiveInteger(maxAttempts)) {
    throw new Error(
      "Reviewed intent descriptor requires a positive integer `windowMs` and `maxAttempts`",
    );
  }
  if (!isObjectNotArray(parameters)) {
    throw new Error("Reviewed intent descriptor `parameters` must be a record");
  }
  const parsed: Record<string, ReviewedIntentParameter> = {};
  for (const [key, declared] of Object.entries(parameters)) {
    parsed[key] = parseParameter(key, declared);
  }
  if (
    !Array.isArray(destinationIntegrity) ||
    !destinationIntegrity.every(isAtomPattern) ||
    (destinationIntegrity.length === 0 &&
      Object.values(parsed).some((entry) => entry.kind === "destinations"))
  ) {
    throw new Error(
      "Reviewed intent descriptor requires `destinationIntegrity` to be atom patterns, at least one when it declares destinations",
    );
  }
  return {
    operation,
    endpointName,
    consumer,
    parameters: parsed,
    destinationIntegrity: [...destinationIntegrity],
    windowMs,
    maxAttempts,
  };
}

/** The digest a record carries as `endpoint` for `descriptor`. */
export const reviewedIntentEndpoint = (
  descriptor: ReviewedIntentDescriptor,
): string => hashStringOf(descriptor as unknown as JSONValue);

/** `link`'s address, with the scope normalized and nothing else. */
const addressOf = (link: NormalizedFullLink): ReviewedAddress => ({
  space: link.space,
  id: link.id,
  scope: normalizeCellScope(link.scope),
  path: [...link.path],
});

/** Records every read of an inspection transaction with its content digest. */
const readEvidence = (tx: IExtendedStorageTransaction): ReadEvidence[] => {
  const reads = tx.getReadActivities?.();
  if (reads === undefined) {
    throw new Error("Reviewed intent requires a verifiable read journal");
  }
  return [...reads].map((read) => {
    const address: IMemorySpaceAddress = {
      space: read.space,
      id: read.id,
      type: read.type,
      scope: read.scope,
      path: [...read.path],
    };
    return {
      address,
      digest: hashStringOf(
        tx.readOrThrow(address, { meta: internalVerifierRead }),
      ),
    };
  });
};

/**
 * `value` as a frozen-ready JSON copy.
 *
 * @throws If `value` holds a cell reference, a cycle, or anything else that
 *   is not JSON, naming `what` it was read as.
 */
const reviewedJson = (value: unknown, what: string): JSONValue => {
  try {
    return snapshotJsonValue(value);
  } catch (error) {
    throw new Error(
      `Reviewed intent requires its ${what} to be JSON without cell references`,
      { cause: error },
    );
  }
};

/**
 * Loads `cell` and the document it resolves to. A cell a pattern hands the
 * host is often a field of its result that links to the document holding
 * the value.
 */
const syncResolved = async (cell: Cell<unknown>): Promise<void> => {
  await cell.sync();
  await cell.resolveAsCell().sync();
};

/**
 * The integrity stored on the whole of the value at `link`: the integrity of
 * every entry at or above its path, other than the entries a link carried,
 * which describe the document a stored link names rather than this one.
 */
const storedIntegrity = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): CfcAtom[] =>
  (cfcLabelViewFromMetadata(readStoredCfcMetadata(tx, link), link.path)
    ?.entries ?? [])
    .filter((entry) =>
      entry.path.length === 0 && entry.observes !== "followRef"
    )
    .flatMap((entry) => entry.label.integrity ?? []);

/**
 * Reads one destination: its stored value, which is all the surface shows of
 * it, and the atoms of its stored integrity the descriptor's patterns name.
 */
const readDestination = (
  tx: IExtendedStorageTransaction,
  cell: Cell<unknown>,
  patterns: readonly AtomPattern[],
): { destination: ReviewedDestination; address: ReviewedAddress } => {
  const link = cell.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
  // Read as stored, so that a link inside the value is refused rather than
  // followed: the integrity covers this document, not one it links to.
  const stored = tx.readValueOrThrow(link);
  if (stored === null || stored === undefined) {
    throw new Error("Reviewed intent refuses a destination that holds nothing");
  }
  const address = reviewedJson(stored, "destination");
  const carried = storedIntegrity(tx, link);
  if (matchAtomPatternConjunction(patterns, carried).length === 0) {
    throw new Error(
      debugStr`Reviewed intent refuses a destination without the integrity its descriptor requires: $quote,long${address}`,
    );
  }
  const integrity = snapshotJsonValue(
    carried.filter((atom) =>
      patterns.some((pattern) => matchAtomPattern(pattern, atom) !== null)
    ),
  ) as CfcAtom[];
  return { destination: { address, integrity }, address: addressOf(link) };
};

/** Reads everything the host will show, and what the commit verifies. */
const inspect = async (
  bindings: ReviewedIntentBindings,
): Promise<Inspection> => {
  const runtime = cellRuntime(bindings.descriptor);
  const cells = [
    bindings.descriptor,
    bindings.result,
    ...Object.values(bindings.destinations).flat(),
  ];
  if (cells.some((cell) => cellRuntime(cell) !== runtime)) {
    throw new Error("Reviewed intent handles must belong to the same runtime");
  }
  await Promise.all(cells.map(syncResolved));

  const tx = runtime.edit();
  let actor: string;
  let descriptor: ReviewedIntentDescriptor;
  let descriptorAddress: ReviewedAddress;
  const destinations: Record<string, ReviewedDestination[]> = {};
  const destinationAddresses: Record<string, ReviewedAddress[]> = {};
  let confidentiality: CfcConfClause[];
  const evidence: ReadEvidence[] = [];
  try {
    const acting = tx.getCfcState().trustSnapshot?.actingPrincipal;
    if (!isDID(acting)) {
      throw new Error("Reviewed intent requires an authenticated actor");
    }
    actor = acting;
    const descriptorLink = bindings.descriptor.withTx(tx).resolveAsCell()
      .getAsNormalizedFullLink();
    descriptorAddress = addressOf(descriptorLink);
    const { schema: _schema, ...stored } = descriptorLink;
    descriptor = parseReviewedIntentDescriptor(
      reviewedJson(
        runtime.getCellFromLink(stored, undefined, tx).get(),
        "descriptor",
      ),
    );
    for (const key of Object.keys(bindings.destinations)) {
      if (descriptor.parameters[key]?.kind !== "destinations") {
        throw new Error(
          debugStr`Reviewed intent refuses a destination for a parameter its descriptor does not declare: $quote${key}`,
        );
      }
    }
    for (const [key, declared] of Object.entries(descriptor.parameters)) {
      if (declared.kind !== "destinations") continue;
      const bound = bindings.destinations[key] ?? [];
      if (bound.length < declared.min || bound.length > declared.max) {
        throw new Error(
          debugStr`Reviewed intent requires between ${declared.min} and ${declared.max} destinations for $quote${key}`,
        );
      }
      const read = bound.map((cell) =>
        readDestination(tx, cell, descriptor.destinationIntegrity)
      );
      destinations[key] = read.map((entry) => entry.destination);
      destinationAddresses[key] = read.map((entry) => entry.address);
    }
    const consumed = collectConsumedLabel(tx).confidentiality;
    const actorAtom = cfcAtom.user(actor);
    // The surface shows what it shows outside the render policy, so this is
    // the gate on what it may show: the host's own read ceiling, or else the
    // actor's.
    if (
      !cfcObservationFitsCeiling(
        consumed,
        runtime.cfcReadMaxConfidentiality ?? [actorAtom],
      )
    ) {
      throw new Error(
        "Reviewed intent destinations exceed the authenticated actor's read ceiling",
      );
    }
    confidentiality = [...consumed];
    if (!confidentiality.some((clause) => deepEqual(clause, actorAtom))) {
      confidentiality.push(actorAtom);
    }
    for (const read of readEvidence(tx)) evidence.push(read);
  } finally {
    tx.abort();
  }

  // Where the link will be written is reviewed, but what the reads that find
  // it consumed is not shown and does not reach the record.
  const resultTx = runtime.edit();
  let resultAddress: ReviewedAddress;
  try {
    const target = resolveLink(
      runtime,
      resultTx,
      bindings.result.getAsNormalizedFullLink(),
      "writeRedirect",
    );
    if (writtenByReviewedIntent(resultTx, target)) {
      throw new Error(
        "Reviewed intent refuses a result cell inside a reviewed intent",
      );
    }
    resultAddress = addressOf(target);
    for (const read of readEvidence(resultTx)) evidence.push(read);
  } finally {
    resultTx.abort();
  }
  return {
    actor,
    descriptor,
    endpoint: reviewedIntentEndpoint(descriptor),
    descriptorAddress,
    destinations,
    destinationAddresses,
    resultAddress,
    confidentiality,
    evidence,
  };
};

/**
 * Prepares a reviewed intent from the cells a pattern binds, for the host's
 * surface. The preview is exactly what the commit writes besides the text the
 * actor enters; the consent it returns is good for one commit.
 *
 * @throws If there is no authenticated actor, the descriptor is not one this
 *   build can show, a destination is bound for a parameter the descriptor
 *   does not declare or in a number it does not allow, a destination holds
 *   nothing or a cell reference, or lacks the integrity the descriptor
 *   requires, or what the surface would show exceeds the read ceiling.
 */
export async function prepareReviewedIntent(
  bindings: ReviewedIntentBindings,
): Promise<PreparedReviewedIntent> {
  const inspected = await inspect(bindings);
  // The preview and the retained consent share these values, so they are
  // frozen: a caller that edits what it was shown cannot change what the
  // commit compares against.
  deepFreeze(inspected.destinations);
  const consent = Object.freeze({}) as ReviewedIntentConsent;
  consents.set(consent, {
    ...inspected,
    bindings: Object.freeze({
      descriptor: bindings.descriptor.withTx(undefined),
      result: bindings.result.withTx(undefined),
      destinations: Object.freeze(Object.fromEntries(
        Object.entries(bindings.destinations).map(([key, cells]) => [
          key,
          Object.freeze(cells.map((cell) => cell.withTx(undefined))),
        ]),
      )),
    }),
    eventId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  const { descriptor } = inspected;
  return Object.freeze({
    actor: inspected.actor,
    operation: descriptor.operation,
    endpointName: descriptor.endpointName,
    consumer: descriptor.consumer,
    endpoint: inspected.endpoint,
    destinations: inspected.destinations,
    text: deepFreeze(Object.fromEntries(
      Object.entries(descriptor.parameters).flatMap(([key, declared]) =>
        declared.kind === "text"
          ? [[key, { maxLength: declared.maxLength }]]
          : []
      ),
    )),
    windowMs: Math.min(descriptor.windowMs, SHORT_INTENT_WINDOW_MS),
    maxAttempts: descriptor.maxAttempts,
    consent,
  });
}

/**
 * The record's parameters: the reviewed destinations, and the text entered
 * for each declared `text` parameter.
 *
 * @throws If `input` holds text for a key the descriptor does not declare as
 *   text, lacks text for one it does, or holds text over its `maxLength`.
 */
const parametersOf = (
  descriptor: ReviewedIntentDescriptor,
  destinations: Record<string, ReviewedDestination[]>,
  input: ReviewedIntentInput,
): Record<string, string | ReviewedDestination[]> => {
  const text = isObjectNotArray(input) && isObjectNotArray(input.text)
    ? input.text
    : undefined;
  if (text === undefined) {
    throw new Error("Reviewed intent commit requires the entered text");
  }
  for (const key of Object.keys(text)) {
    if (descriptor.parameters[key]?.kind !== "text") {
      throw new Error(
        debugStr`Reviewed intent refuses text for a parameter its descriptor does not declare: $quote${key}`,
      );
    }
  }
  const parameters: Record<string, string | ReviewedDestination[]> = {};
  for (const [key, declared] of Object.entries(descriptor.parameters)) {
    if (declared.kind === "destinations") {
      parameters[key] = destinations[key];
      continue;
    }
    const entered = text[key];
    if (typeof entered !== "string") {
      throw new Error(
        debugStr`Reviewed intent commit requires text for $quote${key}`,
      );
    }
    if ([...entered].length > declared.maxLength) {
      throw new Error(
        debugStr`Reviewed intent refuses text over ${declared.maxLength} characters for $quote${key}`,
      );
    }
    parameters[key] = entered;
  }
  return parameters;
};

/** Whether the document at `link`'s root was written by this module. */
const writtenByReviewedIntent = (
  tx: IExtendedStorageTransaction,
  link: Pick<NormalizedFullLink, "space" | "id" | "scope">,
): boolean =>
  (readStoredCfcMetadata(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  })?.labelMap.entries ?? [])
    .some((entry) =>
      entry.path.length === 0 && entry.origin === "derived" &&
      (entry.label.integrity ?? []).some((atom) =>
        deepEqual(atom, WRITTEN_BY_REVIEWED_INTENT)
      )
    );

/**
 * The schema of a document only this module writes, labeled
 * `confidentiality`. A writer claim governs the location it is declared at and
 * not the locations below it, so it is repeated on every member and on every
 * member of the one member that is a record, `evidence`; everything else is a
 * leaf.
 */
const writtenOnlyByReviewedIntent = (
  confidentiality: readonly CfcConfClause[],
) => {
  const written = { ifc: { writeAuthorizedBy: [REVIEWED_INTENT_WRITER] } };
  return {
    type: "object",
    properties: {
      evidence: { ...written, additionalProperties: written },
    },
    additionalProperties: written,
    ifc: {
      confidentiality: [...confidentiality],
      writeAuthorizedBy: [REVIEWED_INTENT_WRITER],
    },
  } as const;
};

/**
 * Writes the reviewed intent after a host-trusted gesture on the surface: the
 * actor-private receipt, then the record, both in the actor's home space,
 * then the record's link into the pattern's result cell, which may be in
 * another space. A transaction writes one space, so each is a separate
 * commit. The receipt comes first, so no record exists without one; a receipt
 * whose record is absent records a commit that failed. A record whose link
 * was not written is never acted on, and its window runs out.
 *
 * The record's confidentiality joins the labels of everything the preview
 * read, and the actor's own `User` clause.
 *
 * @throws If the consent is unknown or spent, the gesture is not the host's,
 *   the entered text does not satisfy the descriptor, anything reviewed
 *   changed, or a write fails.
 */
export async function commitReviewedIntent(
  consent: ReviewedIntentConsent,
  event: unknown,
  input: ReviewedIntentInput,
): Promise<ReviewedIntentResult> {
  const state = consents.get(consent);
  if (!state) {
    throw new Error("Reviewed intent consent is unknown or already consumed");
  }
  consents.delete(consent);
  if (
    !isRendererTrustedEvent(event) || !isObjectNotArray(event) ||
    !isObjectNotArray(event.provenance) || event.provenance.origin !== "dom" ||
    event.provenance.trusted !== true ||
    !isObjectNotArray(event.provenance.ui) ||
    event.provenance.ui.pattern !== REVIEWED_INTENT_GESTURE
  ) {
    throw new Error("Reviewed intent requires a trusted host gesture");
  }
  const parameters = snapshotJsonValue(
    parametersOf(state.descriptor, state.destinations, input),
  );
  const current = await inspect(state.bindings);
  if (
    current.actor !== state.actor || current.endpoint !== state.endpoint ||
    !deepEqual(current.descriptor, state.descriptor) ||
    !deepEqual(current.descriptorAddress, state.descriptorAddress) ||
    !deepEqual(current.destinations, state.destinations) ||
    !deepEqual(current.destinationAddresses, state.destinationAddresses) ||
    !deepEqual(current.resultAddress, state.resultAddress) ||
    !deepEqual(current.confidentiality, state.confidentiality)
  ) {
    throw new Error(STALE_REVIEW);
  }
  const runtime = cellRuntime(state.bindings.descriptor);
  const { actor, descriptor, eventId } = state;
  const at = Date.now();
  const record = {
    operation: descriptor.operation,
    endpoint: state.endpoint,
    consumer: descriptor.consumer,
    subject: actor,
    parameters: canonicalJson(parameters),
    payloadDigest: hashStringOf(parameters),
    idempotencyKey: state.idempotencyKey,
    at,
    exp: at + Math.min(descriptor.windowMs, SHORT_INTENT_WINDOW_MS),
    maxAttempts: descriptor.maxAttempts,
    evidence: { component: REVIEWED_INTENT_COMPONENT, event: eventId },
  };
  const schema = writtenOnlyByReviewedIntent(current.confidentiality);
  const recordCell = runtime.getCell<JSONValue>(
    actor as never,
    { reviewedIntent: eventId },
    schema,
  );

  const receiptTx = runtime.edit();
  let receipt: Cell<unknown>;
  try {
    if (receiptTx.getCfcState().trustSnapshot?.actingPrincipal !== actor) {
      throw new Error("Reviewed intent actor changed after review");
    }
    setCfcImplementationIdentity(receiptTx, {
      kind: "builtin",
      builtinId: REVIEWED_INTENT_WRITER,
    });
    receipt = runtime.getCell(
      actor as never,
      { reviewedIntentReceipt: eventId },
      schema,
      receiptTx,
    );
    receipt.set({
      record: recordCell.getAsNormalizedFullLink().id,
      payloadDigest: record.payloadDigest,
      at,
    });
    receiptTx.markCreateOnly?.(receipt.getAsNormalizedFullLink());
    const result = await receiptTx.commit();
    if (result.error) {
      throw new Error(
        `Reviewed intent receipt failed: ${result.error.message}`,
      );
    }
  } catch (error) {
    receiptTx.abort();
    throw error;
  }

  const recordTx = runtime.edit();
  try {
    if (recordTx.getCfcState().trustSnapshot?.actingPrincipal !== actor) {
      throw new Error("Reviewed intent actor changed after review");
    }
    // These comparisons bind the reviewed reads to the committing
    // transaction: verifier reads keep their conflict checks without carrying
    // a label of their own into the record.
    for (const read of current.evidence) {
      const stored = recordTx.readOrThrow(read.address, {
        meta: internalVerifierRead,
      });
      if (hashStringOf(stored) !== read.digest) {
        throw new Error("Reviewed intent review changed before commit");
      }
    }
    setCfcImplementationIdentity(recordTx, {
      kind: "builtin",
      builtinId: REVIEWED_INTENT_WRITER,
    });
    // The one labeled read in this transaction. `TransformedBy` is minted
    // only over a nonempty flow join, and the receipt's label is never empty,
    // so this read is what stamps every location of the record with this
    // module's identity, the root included.
    receipt.withTx(recordTx).get();
    recordCell.withTx(recordTx).set(record);
    recordTx.markCreateOnly?.(recordCell.getAsNormalizedFullLink());
    const result = await recordTx.commit();
    if (result.error) {
      throw new Error(`Reviewed intent failed: ${result.error.message}`);
    }
  } catch (error) {
    recordTx.abort();
    throw error;
  }
  // A runtime that does not persist flow labels writes no stamp, and a record
  // without one is never linked: every record a pattern receives verifies.
  verifyReviewedIntentRecord(recordCell as Cell<unknown>);

  const linkTx = runtime.edit();
  try {
    const target = resolveLink(
      runtime,
      linkTx,
      state.bindings.result.getAsNormalizedFullLink(),
      "writeRedirect",
    );
    if (!deepEqual(addressOf(target), state.resultAddress)) {
      throw new Error(STALE_REVIEW);
    }
    const { schema: _schema, ...recordLink } = recordCell
      .getAsNormalizedFullLink();
    runtime.getCellFromLink(target, undefined, linkTx).set(
      runtime.getCellFromLink(recordLink, undefined, linkTx),
    );
    const result = await linkTx.commit();
    if (result.error) {
      throw new Error(
        `Reviewed intent could not link its record: ${result.error.message}`,
      );
    }
  } catch (error) {
    linkTx.abort();
    throw error;
  }
  return {
    record: recordCell.withTx(undefined) as Cell<unknown>,
    receipt: receipt.withTx(undefined),
  };
}

/** Whether `value` is a reviewed destination as a record stores one. */
const isStoredDestination = (value: unknown): boolean =>
  isObjectNotArray(value) && hasExactKeys(value, ["address", "integrity"]) &&
  value.address !== null && Array.isArray(value.integrity);

/**
 * Parses a record's stored `parameters` text.
 *
 * @throws If it is not JSON, or not a record of text and destination lists.
 */
const parseStoredParameters = (
  text: unknown,
): ReviewedIntentRecord["parameters"] => {
  let parsed: unknown;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (
    !isObjectNotArray(parsed) ||
    !Object.values(parsed).every((entry) =>
      typeof entry === "string" ||
      (Array.isArray(entry) && entry.every(isStoredDestination))
    )
  ) {
    throw new Error("Reviewed intent record's `parameters` are malformed");
  }
  return parsed as ReviewedIntentRecord["parameters"];
};

/**
 * Reads the reviewed intent `record` names and verifies that this module
 * wrote it. `record` may be the record itself or a cell that links to it,
 * such as a pattern's result cell.
 *
 * The check a consumer relies on, in full: the cell resolves to the root of a
 * document whose root label-map entry is a `derived` one carrying the bare
 * `TransformedBy{builtin cfc-reviewed-intent}` atom; the document is in the
 * home space of the record's `subject`; and the record has exactly the
 * members a commit writes, with `parameters` text that parses and a
 * `payloadDigest` that is the digest of what it parses to. Only the runtime mints a `derived` entry, and only a
 * transaction under this module's identity mints that atom, so a pattern
 * cannot write a record that passes: a stored `writeAuthorizedBy` naming this
 * module is not evidence, since a pattern's own initialization can carry
 * one. A write into a record after the commit takes the stamp away.
 *
 * This verifies authorship and integrity only. Whether the record is the
 * consumer's, unexpired, and not yet acted on is the consumer's to check.
 *
 * Reads happen in `tx` when given, so that a consumer's transaction conflicts
 * with a change to the record; otherwise in a transaction of its own. The
 * caller syncs `record` first.
 *
 * @throws If any part of the check fails.
 */
export function verifyReviewedIntentRecord(
  record: Cell<unknown>,
  tx?: IExtendedStorageTransaction,
): ReviewedIntentRecord {
  const reader = tx ?? cellRuntime(record).edit();
  try {
    const link = record.withTx(reader).resolveAsCell()
      .getAsNormalizedFullLink();
    if (link.path.length !== 0) {
      throw new Error(
        "Reviewed intent record must be a document root, not a location inside one",
      );
    }
    if (!writtenByReviewedIntent(reader, link)) {
      throw new Error(
        "Reviewed intent record was not written by the reviewed-intent builtin",
      );
    }
    const value = reviewedJson(
      reader.readValueOrThrow({ ...link, path: [] }),
      "record",
    );
    if (
      !isObjectNotArray(value) || !hasExactKeys(value, RECORD_KEYS) ||
      !isNonEmptyString(value.operation) ||
      !isNonEmptyString(value.endpoint) ||
      !isNonEmptyString(value.consumer) || !isDID(value.subject) ||
      !isNonEmptyString(value.idempotencyKey) ||
      !Number.isSafeInteger(value.at) || !Number.isSafeInteger(value.exp) ||
      !isPositiveInteger(value.maxAttempts) ||
      !isObjectNotArray(value.evidence) ||
      !hasExactKeys(value.evidence, ["component", "event"]) ||
      value.evidence.component !== REVIEWED_INTENT_COMPONENT ||
      !isNonEmptyString(value.evidence.event)
    ) {
      throw new Error("Reviewed intent record is malformed");
    }
    const parameters = parseStoredParameters(value.parameters);
    if (value.payloadDigest !== hashStringOf(parameters as JSONValue)) {
      throw new Error(
        "Reviewed intent record's `payloadDigest` does not match its parameters",
      );
    }
    if (link.space !== value.subject) {
      throw new Error(
        "Reviewed intent record is not in its subject's home space",
      );
    }
    return deepFreeze({
      ...value,
      parameters,
    }) as unknown as ReviewedIntentRecord;
  } finally {
    if (tx === undefined) reader.abort();
  }
}
