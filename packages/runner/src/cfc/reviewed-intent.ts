/**
 * Mints reviewed intents for the trusted host's reviewed-intent surface. A
 * reviewed intent is a record, written once under this module's builtin
 * identity, stating that the authenticated actor released exactly these
 * parameters to exactly these destinations, recently, once. An application
 * that acts outside the fabric on the actor's behalf (the consumer) publishes
 * a descriptor of what it accepts; the host previews the cells the pattern
 * binds against it, and a trusted gesture on the host's surface commits the
 * record. This module is absent from authored pattern imports.
 *
 * The record is what a consumer acts on, and {@link verifyReviewedIntentRecord}
 * is how it tells a record this module wrote from one a pattern wrote. The
 * rest of the contract, the consumer's half included, is
 * `docs/specs/cfc-reviewed-intent.md`.
 */

import type { JSONValue } from "@commonfabric/api";
import { type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import { debugStr, deepFreeze, hashStringOf } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { type Cell, cellRuntime } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  type AtomPattern,
  isAtomPattern,
  matchAtomPattern,
  matchAtomPatternConjunction,
} from "./atom-pattern.ts";
import type { CfcConfClause } from "./clause.ts";
import {
  canonicalJson,
  evidenceHolds,
  hasExactKeys,
  type ReadEvidence,
  readEvidence,
  rootWrittenByBuiltin,
  syncResolved,
} from "./host-review.ts";
import { canonicalizeCfcLogicalPath } from "./label-view-state.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { cfcObservationFitsCeiling } from "./observation.ts";
import {
  collectConsumedLabel,
  isRuntimeMintedIntegrityAtom,
} from "./prepare.ts";
import { snapshotJsonValue } from "./share-snapshot-value.ts";
import { isTrustedGestureOn } from "./ui-contract.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";

/** Builtin implementation identity that alone writes reviewed intents. */
export const REVIEWED_INTENT_WRITER = "cfc-reviewed-intent";

/** The `provenance.ui.pattern` mark of the host's commit gesture. */
export const REVIEWED_INTENT_GESTURE = "ReviewedIntent";

/** The host surface a record names in its `evidence`. */
export const REVIEWED_INTENT_COMPONENT = "cf-reviewed-intent";

/**
 * The longest a reviewed intent stays good for, whatever its descriptor asks:
 * ten minutes, the short-intent window ruled by @seefeldb.
 */
export const SHORT_INTENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * The identity a reviewed intent's transactions write under. Its bare
 * `TransformedBy` stamps every location the record's transaction writes, and
 * a record's root must carry it to verify.
 */
const REVIEWED_INTENT_IDENTITY = Object.freeze({
  kind: "builtin" as const,
  builtinId: REVIEWED_INTENT_WRITER,
});

/** A declared parameter whose value is one or more bound destinations. */
export interface ReviewedIntentDestinationsParameter {
  readonly kind: "destinations";

  /** Fewest destinations a record carries for this key. */
  readonly min: number;

  /** Most destinations a record carries for this key; at least 1. */
  readonly max: number;

  /**
   * Atom patterns each destination's stored integrity must satisfy together,
   * as one conjunction whose variables are shared across the patterns. At
   * least one.
   */
  readonly integrity: readonly AtomPattern[];
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
   * How long after the gesture a record is good for, in milliseconds. A record
   * takes the smaller of this and {@link SHORT_INTENT_WINDOW_MS}.
   */
  readonly windowMs: number;

  /** How many delivery attempts a consumer may make on one record. */
  readonly maxAttempts: number;
}

/** A storage location: a document, its scope, and a path in its value. */
export interface ReviewedLocation {
  readonly space: string;
  readonly id: string;
  readonly scope: string;
  readonly path: readonly string[];
}

/** A destination as reviewed. */
export interface ReviewedDestination {
  /** The destination's stored value, exactly as the surface shows it. */
  readonly address: JSONValue;

  /**
   * The atoms of the destination's stored integrity that satisfied its
   * parameter's patterns: one per pattern, under the first binding of their
   * variables that satisfies them all.
   */
  readonly integrity: readonly CfcAtom[];

  /** Where the destination's cell resolved, for a consumer to resolve again. */
  readonly source: ReviewedLocation;
}

/** The cells a pattern binds for one reviewed intent. */
export interface ReviewedIntentBindings {
  /** The consumer's published descriptor. */
  readonly descriptor: Cell<unknown>;

  /**
   * The cells bound for each declared parameter whose kind takes cells, in
   * the order the record lists them. A `destinations` parameter takes its
   * destinations; a `text` parameter takes none.
   */
  readonly parameters: Readonly<Record<string, readonly Cell<unknown>[]>>;

  /**
   * The pattern's cell that receives a link to the committed record. Its write
   * target is reviewed with the rest. The link is an ordinary write under no
   * implementation identity, so a target whose writer claim names particular
   * writers, this module included, refuses it.
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

/** One declared parameter as the surface shows it. */
export type ReviewedParameterPreview =
  | {
    readonly kind: "destinations";

    /** The destinations, as the record carries them. */
    readonly destinations: readonly ReviewedDestination[];
  }
  | {
    readonly kind: "text";

    /** The bound on the text the surface's field takes. */
    readonly maxLength: number;
  };

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

  /** Every declared parameter, by key. */
  readonly parameters: Readonly<Record<string, ReviewedParameterPreview>>;

  /** How long after the gesture the record is good for, in milliseconds. */
  readonly windowMs: number;

  /** The descriptor's `maxAttempts`. */
  readonly maxAttempts: number;

  /** One-use authority bound to this preview and the authenticated actor. */
  readonly consent: ReviewedIntentConsent;
}

/**
 * What the actor entered on the surface, given to the commit: the value of
 * every declared parameter the actor types, by key, and nothing else.
 */
export type ReviewedIntentInput = Readonly<Record<string, string>>;

/**
 * The record a commit writes, as a consumer that verified it acts on it. The
 * members are a closed set a reader must understand: a new constraint arrives
 * through the descriptor, which the consumer wrote, not as a new member.
 * `evidence` alone is open, and a reader ignores members of it it does not
 * know.
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
   * and {@link verifyReviewedIntentRecord} returns it parsed. A writer claim
   * governs the location it is declared at and not the locations below it, so
   * a leaf is one location the record's claim covers whole. And a host's cell
   * is made inside a builder frame, which every runtime pushes, so a write
   * through it stores a plain object inside an array as a document of its own,
   * which the record's root stamp would not cover.
   */
  readonly parameters: Readonly<
    Record<string, string | readonly ReviewedDestination[]>
  >;

  /** The data-model digest of `parameters`. */
  readonly payloadDigest: string;

  /**
   * A random value unique to the consent. It is the record's identity for a
   * consumer's attempts, and its address derives from it.
   */
  readonly idempotencyKey: string;

  /** When the commit wrote the record, in milliseconds since the epoch. */
  readonly at: number;

  /** When the record stops being good, in milliseconds since the epoch. */
  readonly exp: number;

  /** The descriptor's `maxAttempts`. */
  readonly maxAttempts: number;

  /** Informational: the surface the gesture was made on. */
  readonly evidence: Readonly<Record<string, JSONValue>>;
}

/** What a commit wrote. */
export interface ReviewedIntentResult {
  /** The record, in the actor's home space. */
  readonly record: Cell<unknown>;

  /** The actor-private receipt, in the actor's home space. */
  readonly receipt: Cell<unknown>;
}

/** Everything one inspection establishes. */
interface Inspection {
  readonly actor: string;
  readonly descriptor: ReviewedIntentDescriptor;
  readonly endpoint: string;
  readonly descriptorLocation: ReviewedLocation;
  readonly bound: Record<string, ReviewedDestination[]>;
  readonly resultLocation: ReviewedLocation;
  readonly confidentiality: readonly CfcConfClause[];
  readonly evidence: readonly ReadEvidence[];
}

/** Runtime-owned state behind an opaque consent token. */
interface ConsentState extends Inspection {
  readonly bindings: ReviewedIntentBindings;
  readonly idempotencyKey: string;
}

const consents = new WeakMap<ReviewedIntentConsent, ConsentState>();

const STALE_REVIEW =
  "Reviewed intent review is stale; review the destinations again";

const DESCRIPTOR_KEYS = [
  "consumer",
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

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Whether every atom `pattern` matches is of a type only trusted runtime code
 * mints, so no pattern can author an atom it matches.
 */
const namesRuntimeMintedAtom = (pattern: AtomPattern): boolean =>
  typeof pattern === "string"
    ? isRuntimeMintedIntegrityAtom(pattern)
    : isObjectNotArray(pattern) && typeof pattern.type === "string" &&
      isRuntimeMintedIntegrityAtom({ type: pattern.type });

/** Validates one declared parameter, refusing a kind or member it does not know. */
const parseParameter = (
  key: string,
  value: unknown,
): ReviewedIntentParameter => {
  if (isObjectNotArray(value) && value.kind === "destinations") {
    const { min, max, integrity } = value;
    if (
      Array.isArray(integrity) && integrity.every(isAtomPattern) &&
      !integrity.every(namesRuntimeMintedAtom)
    ) {
      throw new Error(
        debugStr`Reviewed intent descriptor requires destination integrity a pattern could author for $quote${key}`,
      );
    }
    if (
      hasExactKeys(value, ["integrity", "kind", "max", "min"]) &&
      isCount(min) && isPositiveInteger(max) && min <= max &&
      Array.isArray(integrity) && integrity.length > 0 &&
      integrity.every(isAtomPattern)
    ) return { kind: "destinations", min, max, integrity: [...integrity] };
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
 *   not one this build knows.
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
  return {
    operation,
    endpointName,
    consumer,
    parameters: parsed,
    windowMs,
    maxAttempts,
  };
}

/**
 * The digest a record carries as `endpoint` for `descriptor`: the data-model
 * hash `hashStringOf`, whose bytes
 * `docs/specs/space-model-formal-spec/2-hash-byte-format.md` specifies.
 */
export const reviewedIntentEndpoint = (
  descriptor: ReviewedIntentDescriptor,
): string => hashStringOf(descriptor as unknown as JSONValue);

/** `link`'s location, with the scope normalized and nothing else. */
const locationOf = (link: NormalizedFullLink): ReviewedLocation => ({
  space: link.space,
  id: link.id,
  scope: normalizeCellScope(link.scope),
  path: [...link.path],
});

/**
 * `value` as a JSON copy.
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
 * The integrity the runtime derived for the whole of the value at `link`:
 * that of every `derived` entry at or above its path that labels content.
 * Only the runtime writes a `derived` entry, and its `TransformedBy` is taken
 * away when another writer writes at, above, or below it, so what it says
 * about who wrote the value still holds. A declared label says what a
 * location's values carry by its schema, not who wrote the value there, so
 * it does not count.
 */
const derivedIntegrity = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): CfcAtom[] =>
  (readStoredCfcMetadata(tx, link)?.labelMap.entries ?? [])
    .filter((entry) => {
      const path = canonicalizeCfcLogicalPath(entry.path);
      return entry.origin === "derived" &&
        (entry.observes === undefined || entry.observes === "value") &&
        path.length <= link.path.length &&
        path.every((segment, index) => segment === link.path[index]);
    })
    .flatMap((entry) => entry.label.integrity ?? []);

/**
 * The atoms of `carried` that satisfy `patterns`: one per pattern, the first
 * consistent with the first binding of the patterns' variables that satisfies
 * them all, or `undefined` when no binding does.
 */
const satisfyingAtoms = (
  patterns: readonly AtomPattern[],
  carried: readonly CfcAtom[],
): CfcAtom[] | undefined => {
  const [binding] = matchAtomPatternConjunction(patterns, carried);
  if (binding === undefined) return undefined;
  const chosen: CfcAtom[] = [];
  for (const pattern of patterns) {
    const atom = carried.find((candidate) =>
      matchAtomPattern(pattern, candidate, binding) !== null
    )!;
    if (!chosen.some((existing) => deepEqual(existing, atom))) {
      chosen.push(atom);
    }
  }
  return chosen;
};

/**
 * Reads one destination: its stored value, which is all the surface shows of
 * it, the atoms of its stored integrity that satisfy `patterns`, and where it
 * is.
 */
const readDestination = (
  tx: IExtendedStorageTransaction,
  cell: Cell<unknown>,
  patterns: readonly AtomPattern[],
): ReviewedDestination => {
  const link = cell.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
  // Read as stored, so that a link inside the value is refused rather than
  // followed: the integrity covers this document, not one it links to.
  const stored = tx.readValueOrThrow(link);
  if (stored === null || stored === undefined) {
    throw new Error("Reviewed intent refuses a destination that holds nothing");
  }
  const address = reviewedJson(stored, "destination");
  const integrity = satisfyingAtoms(patterns, derivedIntegrity(tx, link));
  if (integrity === undefined) {
    throw new Error(
      debugStr`Reviewed intent refuses a destination without the integrity its descriptor requires: $quote,long${address}`,
    );
  }
  return {
    address,
    integrity: reviewedJson(integrity, "destination") as CfcAtom[],
    source: locationOf(link),
  };
};

/** Reads everything the host will show, and what the commit verifies. */
const inspect = async (
  bindings: ReviewedIntentBindings,
): Promise<Inspection> => {
  const runtime = cellRuntime(bindings.descriptor);
  const cells = [
    bindings.descriptor,
    bindings.result,
    ...Object.values(bindings.parameters).flat(),
  ];
  if (cells.some((cell) => cellRuntime(cell) !== runtime)) {
    throw new Error("Reviewed intent handles must belong to the same runtime");
  }
  // The record's stamp is a flow label, so a runtime that would not persist
  // one could only write records that never verify.
  if (
    runtime.cfcFlowLabels !== "persist" ||
    runtime.cfcEnforcementMode === "disabled"
  ) {
    throw new Error(
      "Reviewed intent requires a runtime that enforces CFC and persists flow labels",
    );
  }
  await Promise.all(cells.map(syncResolved));

  const tx = runtime.edit();
  let actor: string;
  let descriptor: ReviewedIntentDescriptor;
  let descriptorLocation: ReviewedLocation;
  const bound: Record<string, ReviewedDestination[]> = {};
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
    descriptorLocation = locationOf(descriptorLink);
    const { schema: _schema, ...stored } = descriptorLink;
    descriptor = parseReviewedIntentDescriptor(
      reviewedJson(
        runtime.getCellFromLink(stored, undefined, tx).get(),
        "descriptor",
      ),
    );
    for (const key of Object.keys(bindings.parameters)) {
      if (descriptor.parameters[key]?.kind !== "destinations") {
        throw new Error(
          debugStr`Reviewed intent refuses cells for a parameter its descriptor does not declare as bound: $quote${key}`,
        );
      }
    }
    for (const [key, declared] of Object.entries(descriptor.parameters)) {
      if (declared.kind !== "destinations") continue;
      const cellsForKey = bindings.parameters[key] ?? [];
      if (
        cellsForKey.length < declared.min || cellsForKey.length > declared.max
      ) {
        throw new Error(
          debugStr`Reviewed intent requires between ${declared.min} and ${declared.max} destinations for $quote${key}`,
        );
      }
      bound[key] = cellsForKey.map((cell) =>
        readDestination(tx, cell, declared.integrity)
      );
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
    for (const read of readEvidence(tx, "Reviewed intent")) evidence.push(read);
  } finally {
    tx.abort();
  }

  // Where the link will be written is reviewed, but what the reads that find
  // it consumed is not shown and does not reach the record.
  const resultTx = runtime.edit();
  let resultLocation: ReviewedLocation;
  try {
    const target = resolveLink(
      runtime,
      resultTx,
      bindings.result.getAsNormalizedFullLink(),
      "writeRedirect",
    );
    if (rootWrittenByBuiltin(resultTx, target, REVIEWED_INTENT_IDENTITY)) {
      throw new Error(
        "Reviewed intent refuses a result cell inside a reviewed intent",
      );
    }
    resultLocation = locationOf(target);
    for (const read of readEvidence(resultTx, "Reviewed intent")) {
      evidence.push(read);
    }
  } finally {
    resultTx.abort();
  }
  return {
    actor,
    descriptor,
    endpoint: reviewedIntentEndpoint(descriptor),
    descriptorLocation,
    bound,
    resultLocation,
    confidentiality,
    evidence,
  };
};

/**
 * Prepares a reviewed intent from the cells a pattern binds, for the host's
 * surface. The preview is exactly what the commit writes besides the values
 * the actor enters; the consent it returns is good for one commit.
 *
 * @throws If there is no authenticated actor, the descriptor is not one this
 *   build can show, cells are bound for a parameter the descriptor does not
 *   declare as bound or in a number it does not allow, a destination holds
 *   nothing or a cell reference, or lacks the integrity its parameter
 *   requires, or what the surface would show exceeds the read ceiling.
 */
export async function prepareReviewedIntent(
  bindings: ReviewedIntentBindings,
): Promise<PreparedReviewedIntent> {
  const inspected = await inspect(bindings);
  const { descriptor } = inspected;
  // The host transport carries no durable event identity, so the commit's
  // identity is minted here, unpredictably: the record's address derives
  // from it, and no other code can create that document first.
  const idempotencyKey = crypto.randomUUID();
  refuseUnlinkableResult(
    bindings.result,
    recordCellFor(cellRuntime(bindings.result), inspected, idempotencyKey),
  );
  // The preview and the retained consent share these values, so they are
  // frozen: a caller that edits what it was shown cannot change what the
  // commit compares against.
  deepFreeze(inspected.bound);
  const consent = Object.freeze({}) as ReviewedIntentConsent;
  consents.set(consent, {
    ...inspected,
    bindings: Object.freeze({
      descriptor: bindings.descriptor.withTx(undefined),
      result: bindings.result.withTx(undefined),
      parameters: Object.freeze(Object.fromEntries(
        Object.entries(bindings.parameters).map(([key, cells]) => [
          key,
          Object.freeze(cells.map((cell) => cell.withTx(undefined))),
        ]),
      )),
    }),
    idempotencyKey,
  });
  return Object.freeze({
    actor: inspected.actor,
    operation: descriptor.operation,
    endpointName: descriptor.endpointName,
    consumer: descriptor.consumer,
    endpoint: inspected.endpoint,
    parameters: deepFreeze(Object.fromEntries(
      Object.entries(descriptor.parameters).map((
        [key, declared],
      ): [string, ReviewedParameterPreview] => [
        key,
        declared.kind === "destinations"
          ? { kind: "destinations", destinations: inspected.bound[key] }
          : { kind: "text", maxLength: declared.maxLength },
      ]),
    )),
    windowMs: Math.min(descriptor.windowMs, SHORT_INTENT_WINDOW_MS),
    maxAttempts: descriptor.maxAttempts,
    consent,
  });
}

/**
 * The record's parameters: the reviewed destinations, and the value entered
 * for each declared `text` parameter.
 *
 * @throws If `input` holds a value for a key the descriptor does not declare
 *   as entered, lacks one it does, or holds text over its `maxLength`.
 */
const parametersOf = (
  descriptor: ReviewedIntentDescriptor,
  bound: Record<string, ReviewedDestination[]>,
  input: ReviewedIntentInput,
): Record<string, string | ReviewedDestination[]> => {
  if (!isObjectNotArray(input)) {
    throw new Error("Reviewed intent commit requires the entered values");
  }
  for (const key of Object.keys(input)) {
    if (descriptor.parameters[key]?.kind !== "text") {
      throw new Error(
        debugStr`Reviewed intent refuses a value for a parameter its descriptor does not declare as entered: $quote${key}`,
      );
    }
  }
  const parameters: Record<string, string | ReviewedDestination[]> = {};
  for (const [key, declared] of Object.entries(descriptor.parameters)) {
    if (declared.kind === "destinations") {
      parameters[key] = bound[key];
      continue;
    }
    const entered = input[key];
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

/** The record a commit with `idempotencyKey` writes for `inspected`. */
const recordCellFor = (
  runtime: Runtime,
  inspected: Inspection,
  idempotencyKey: string,
): Cell<JSONValue> =>
  runtime.getCell<JSONValue>(
    inspected.actor as never,
    { reviewedIntent: idempotencyKey },
    writtenOnlyByReviewedIntent(inspected.confidentiality),
  );

/**
 * Refuses a result cell whose write target would refuse the link to `record`,
 * by preparing that write and discarding it, so that a commit never writes a
 * record it cannot link.
 */
const refuseUnlinkableResult = (
  result: Cell<unknown>,
  record: Cell<JSONValue>,
): void => {
  const runtime = cellRuntime(result);
  const tx = runtime.edit();
  try {
    writeRecordLink(runtime, tx, result, record);
    runtime.prepareTxForCommit(tx);
    if (tx.getCfcState().prepare.status === "invalidated") {
      throw new Error(
        "Reviewed intent refuses a result cell that refuses the record's link",
      );
    }
  } finally {
    tx.abort();
  }
};

/**
 * Writes a link to `record` where a write to `result` lands, and returns that
 * location.
 */
const writeRecordLink = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  result: Cell<unknown>,
  record: Cell<JSONValue>,
): NormalizedFullLink => {
  const target = resolveLink(
    runtime,
    tx,
    result.getAsNormalizedFullLink(),
    "writeRedirect",
  );
  const { schema: _schema, ...recordLink } = record.getAsNormalizedFullLink();
  runtime.getCellFromLink(target, undefined, tx).set(
    runtime.getCellFromLink(recordLink, undefined, tx),
  );
  return target;
};

/**
 * Writes the reviewed intent after a host-trusted gesture on the surface: the
 * actor-private receipt, then the record, both in the actor's home space,
 * then the record's link into the pattern's result cell, which may be in
 * another space. A transaction writes one space, so each is a separate
 * commit. The receipt comes first because the record's transaction reads it
 * (see the attribution comment below); a receipt whose record is absent
 * records a commit that failed. A record whose link was not written is never
 * acted on, and its window runs out.
 *
 * The record's confidentiality joins the labels of everything the preview
 * read, and the actor's own `User` clause.
 *
 * @throws If the consent is unknown or spent, the gesture is not the host's,
 *   the entered values do not satisfy the descriptor, anything reviewed
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
  if (!isTrustedGestureOn(event, REVIEWED_INTENT_GESTURE)) {
    throw new Error("Reviewed intent requires a trusted host gesture");
  }
  const parameters = snapshotJsonValue(
    parametersOf(state.descriptor, state.bound, input),
  );
  const current = await inspect(state.bindings);
  if (
    current.actor !== state.actor ||
    !deepEqual(current.descriptor, state.descriptor) ||
    !deepEqual(current.descriptorLocation, state.descriptorLocation) ||
    !deepEqual(current.bound, state.bound) ||
    !deepEqual(current.resultLocation, state.resultLocation)
  ) {
    throw new Error(STALE_REVIEW);
  }
  const runtime = cellRuntime(state.bindings.descriptor);
  const { actor, descriptor, idempotencyKey } = state;
  const at = Date.now();
  const record = {
    operation: descriptor.operation,
    endpoint: state.endpoint,
    consumer: descriptor.consumer,
    subject: actor,
    parameters: canonicalJson(parameters),
    payloadDigest: hashStringOf(parameters),
    idempotencyKey,
    at,
    exp: at + Math.min(descriptor.windowMs, SHORT_INTENT_WINDOW_MS),
    maxAttempts: descriptor.maxAttempts,
    evidence: { component: REVIEWED_INTENT_COMPONENT },
  };
  const schema = writtenOnlyByReviewedIntent(current.confidentiality);
  const recordCell = recordCellFor(runtime, current, idempotencyKey);

  const receiptTx = runtime.edit();
  let receipt: Cell<unknown>;
  try {
    setCfcImplementationIdentity(receiptTx, REVIEWED_INTENT_IDENTITY);
    receipt = runtime.getCell(
      actor as never,
      { reviewedIntentReceipt: idempotencyKey },
      schema,
      receiptTx,
    );
    receipt.set({
      record: recordCell.getAsNormalizedFullLink().id,
      payloadDigest: record.payloadDigest,
      at,
    });
    // Enforced only under `experimental.commitPreconditions`; otherwise the
    // unpredictable address and the writer claim are what protect it.
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
    if (!evidenceHolds(recordTx, current.evidence)) {
      throw new Error("Reviewed intent review changed before commit");
    }
    setCfcImplementationIdentity(recordTx, REVIEWED_INTENT_IDENTITY);
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
    const target = writeRecordLink(
      runtime,
      linkTx,
      state.bindings.result,
      recordCell,
    );
    if (!deepEqual(locationOf(target), state.resultLocation)) {
      throw new Error(STALE_REVIEW);
    }
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

/** Whether `value` is a reviewed location as a record stores one. */
const isStoredLocation = (value: unknown): boolean =>
  isObjectNotArray(value) &&
  hasExactKeys(value, ["id", "path", "scope", "space"]) &&
  isNonEmptyString(value.space) && isNonEmptyString(value.id) &&
  isNonEmptyString(value.scope) && Array.isArray(value.path) &&
  value.path.every((segment) => typeof segment === "string");

/** Whether `value` is a reviewed destination as a record stores one. */
const isStoredDestination = (value: unknown): boolean =>
  isObjectNotArray(value) &&
  hasExactKeys(value, ["address", "integrity", "source"]) &&
  value.address !== null && Array.isArray(value.integrity) &&
  value.integrity.length > 0 && isStoredLocation(value.source);

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
 * `payloadDigest` that is the digest of what it parses to. Only the runtime
 * mints a `derived` entry, and only a transaction under this module's
 * identity mints that atom, so pattern code cannot write a record that
 * passes: a stored `writeAuthorizedBy` naming this module is not evidence,
 * since a pattern's own initialization can carry one. `evidence` is
 * informational, and only its being a record is checked.
 *
 * A write into a committed record is refused by its writer claim, and a
 * persisted flow label takes the stamp away from a location something else
 * writes. A runtime that runs patterns over the subject's home space with
 * neither, writer claims unenforced and flow labels not persisted, can rewrite
 * a record and leave the stamp in place; the check holds while every such
 * runtime enforces writer claims or persists flow labels.
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
    if (!rootWrittenByBuiltin(reader, link, REVIEWED_INTENT_IDENTITY)) {
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
      !isObjectNotArray(value.evidence)
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
