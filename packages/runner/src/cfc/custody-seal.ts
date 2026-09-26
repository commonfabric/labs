/**
 * Seals an actor's reviewed value into the custody of a trusted declassifier:
 * a module policy `P` whose release rules admit only what that module's
 * endorsed code computes over values this host operation wrote. This module is
 * absent from authored pattern imports; the trusted host drives it from a
 * confirmation dialog, as it drives `share-snapshot.ts`.
 *
 * One instance of a custody room is `(P, D)`: `P` names the room's policy with
 * the room space `S` as its subject, and `D` is the digest of the room's
 * terms. Each seal writes one entry into the instance's box, a single document
 * in `S` whose every location carries `TransformedBy{builtin cfc-custody-seal}`,
 * so a transformation that reads the whole box earns the input witness
 * (`docs/specs/cfc-transformed-by-input-witnesses.md`) and a transformation
 * that reads anything else beside it does not.
 *
 * Entries are keyed by a blinded key, a digest of the actor's signature over
 * `(P, D)`, and neither the entry's value nor its label names the actor. The
 * key is deterministic for one actor and unpredictable to anyone without the
 * actor's signing key, which is what lets the seal refuse a second entry by
 * the same actor without telling the room who sealed. What the blinding does
 * not hide, and the rest of the contract, is
 * `docs/specs/cfc-custody-seal.md`.
 */

import type { JSONValue } from "@commonfabric/api";
import {
  CFC_ATOM_TYPE,
  type CfcAtom,
  cfcAtom,
  type CfcModulePolicyRefAtom,
} from "@commonfabric/api/cfc";
import { sha256 } from "@commonfabric/content-hash";
import { debugStr, deepFreeze, hashStringOf } from "@commonfabric/data-model";
import { isDID, isWellFormedDID } from "@commonfabric/identity/did";
import {
  aclDocId,
  ANYONE_USER,
  type Capability,
  hasConcreteOwner,
  isACL,
} from "@commonfabric/memory/acl";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { utf8Compare, utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import { type Cell, isCell } from "../cell.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { matchAtomPattern } from "./atom-pattern.ts";
import {
  type CfcConfClause,
  clauseAlternatives,
  clausesEqual,
} from "./clause.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { cfcPolicyManifestDocId } from "./policy.ts";
import { collectConsumedLabel } from "./prepare.ts";
import { CfcReadCeilingError } from "./read-ceiling.ts";
import { snapshotJsonValue } from "./share-snapshot-value.ts";
import { type CfcTrustConfig, createTrustResolver } from "./trust.ts";
import { isRendererTrustedEvent } from "./ui-contract.ts";

/** Builtin implementation identity that alone may write a custody box. */
export const CUSTODY_SEAL_WRITER = "cfc-custody-seal";

/**
 * Trust concept a room's policy must satisfy, under the actor's own trust
 * closure, before the actor's value may enter its custody.
 */
export const TRUSTED_DECLASSIFIER_CONCEPT =
  "https://commonfabric.org/cfc/concepts/trusted-declassifier";

/** The `provenance.ui.pattern` mark of the host's confirmation gesture. */
export const CUSTODY_SEAL_GESTURE = "CustodySeal";

/** The room a value is sealed into. */
export interface CustodyRoom {
  /**
   * The room's write-once terms document. Its space is the room space `S`.
   * The terms are a JSON object naming at least `seats`, the DIDs that may
   * seal, and `stanceSchema`, the instruction-inert schema every sealed value
   * satisfies; the rest is displayed to the actor and sealed with the value.
   */
  readonly terms: Cell<unknown>;

  /**
   * The room's custody policy; its subject must be the room space. A host
   * whose policy reference is stored passes the cell holding it: the seal then
   * reads the cell at prepare and again at commit, refuses a commit whose
   * reading differs from the one the actor reviewed, and has the transaction
   * that writes the entry verify that the cell still holds it.
   */
  readonly policy: CfcModulePolicyRefAtom | Cell<unknown>;
}

/** Host-supplied bounds on what the actor may seal into this room. */
export interface CustodySealOptions {
  /**
   * The actor's own `Context` and `Resource` sources this room may draw on. A
   * value whose label names any other source is refused; an empty list admits
   * only values labeled for the actor alone (`User` or a bare DID), which is
   * what a value the actor typed in carries.
   *
   * A host passes the actor-private settings cell that holds the list, in the
   * form {@link readCustodySourcePolicy} reads, rather than a list it read
   * itself: the seal then reads the cell at prepare and again at commit, and
   * the transaction that writes the entry verifies that the cell still holds
   * what the commit read. A fixed list is for a caller whose allowance is not
   * stored: nothing binds a list to the write, so a stored policy narrowed
   * after the host read it does not refuse the seal.
   */
  readonly allowedSources: readonly CfcAtom[] | Cell<unknown>;
}

/**
 * A principal the room space's access list lets read the room, and so read
 * what the room releases: a DID, or `*` for anyone.
 */
export interface CustodyRoomReader {
  /** The principal's DID, or `*` for anyone. */
  readonly principal: string;

  /** The capability the access list gives it. */
  readonly role: "owner" | "writer" | "reader";
}

/** Type-only brand for host-held consent objects. */
declare const consentBrand: unique symbol;

/** One-use seal authority held only by the trusted host. */
export interface CustodySealConsent {
  /** Nominal token whose identity is verified against a private registry. */
  readonly [consentBrand]: true;
}

/** Frozen preview for the trusted host's confirmation dialog. */
export interface PreparedCustodySeal {
  /** The authenticated actor whose value is sealed. */
  readonly actor: string;

  /** The room space `S`: the space the terms document lives in. */
  readonly room: string;

  /**
   * Who can read the room, from the room space's access list, ordered by
   * principal. The room's readers are the audience of anything it releases.
   */
  readonly readers: readonly CustodyRoomReader[];

  /** Exact value that enters custody. */
  readonly stance: JSONValue;

  /** Terms the value is sealed under, exactly as they are sealed. */
  readonly terms: JSONValue;

  /** The instance `D`: the digest of the terms. */
  readonly instance: string;

  /** The room's custody policy, with the room space as its subject. */
  readonly policy: CfcModulePolicyRefAtom;

  /** The actor's `Context` and `Resource` sources the value draws on. */
  readonly sources: readonly CfcAtom[];

  /** One-use authority bound to this preview and authenticated actor. */
  readonly consent: CustodySealConsent;
}

/** Host-supplied controls on one commit. */
export interface CustodySealCommitOptions {
  /**
   * Aborted when whoever asked for the seal can no longer see it land, such
   * as a host client that detached. The commit checks it before each write
   * and until the entry's transaction is sent, and an aborted commit throws
   * the signal's reason without writing the entry. It cannot recall a write
   * already sent, and a commit aborted after its receipt is written leaves
   * that receipt without an entry, which is how a seal that did not commit
   * reads.
   */
  readonly signal?: AbortSignal;
}

/** What a committed seal wrote. */
export interface CustodySealResult {
  /** The instance's box, in the room space. */
  readonly box: Cell<unknown>;

  /** The blinded key of the actor's entry in the box. */
  readonly entryKey: string;

  /** The actor-private receipt, in the actor's home space. */
  readonly receipt: Cell<unknown>;
}

/** A read whose content the commit re-verifies. */
interface ReadEvidence {
  readonly address: IMemorySpaceAddress;
  readonly digest: string;
}

/** Everything one inspection establishes. */
interface Inspection {
  readonly actor: string;
  readonly allowedSources: readonly CfcAtom[];
  readonly room: string;
  readonly readers: readonly CustodyRoomReader[];
  readonly draftLink: NormalizedFullLink;
  readonly termsLink: NormalizedFullLink;
  readonly stance: JSONValue;
  readonly terms: JSONValue;
  readonly instance: string;
  readonly policy: CfcModulePolicyRefAtom;
  readonly sources: readonly CfcAtom[];
  readonly entryKey: string;
  readonly evidence: readonly ReadEvidence[];
}

/** Runtime-owned state behind an opaque consent token. */
interface ConsentState extends Inspection {
  readonly draft: Cell<unknown>;
  readonly requestedRoom: CustodyRoom;
  readonly options: CustodySealOptions;
  readonly eventId: string;
}

const consents = new WeakMap<CustodySealConsent, ConsentState>();

const MODULE_POLICY_KEYS = [
  "type",
  "policyRefKind",
  "moduleIdentity",
  "symbol",
  "policyDigest",
  "subject",
] as const;

const STANCE_SCHEMA_MAX_DEPTH = 8;

const STANCE_SCHEMA_KEYS = new Set([
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "minimum",
  "maximum",
  "title",
  "description",
]);

const ENTRY_KEY_DOMAIN = "cfc-custody-seal/entry-key/v1\n";

const SEALED_BY = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: CUSTODY_SEAL_WRITER },
};

/** Whether `value` is a record with exactly the keys named. */
const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/**
 * Whether one confidentiality alternative stands for the actor alone. Each
 * shape is matched on its exact key set, so an atom carrying any further
 * field (a `hash` binding a named policy, a `scope`) is never the actor's.
 */
const isActorOwnedAlternative = (atom: unknown, actor: string): boolean => {
  if (typeof atom === "string") return atom === actor;
  if (!isObjectNotArray(atom)) return false;
  switch (atom.type) {
    case CFC_ATOM_TYPE.User:
      return hasExactKeys(atom, ["type", "subject"]) &&
        atom.subject === actor;
    case CFC_ATOM_TYPE.Context:
      return hasExactKeys(atom, ["type", "name", "subject"]) &&
        typeof atom.name === "string" && atom.subject === actor;
    case CFC_ATOM_TYPE.Resource:
      return hasExactKeys(atom, ["type", "class", "subject"]) &&
        typeof atom.class === "string" && atom.subject === actor;
    // The actor's home space is the space named by the actor's own DID. Its
    // access list is the actor's to write, so what it admits is the actor's
    // decision, as with a clause naming the actor.
    case CFC_ATOM_TYPE.Space:
      return hasExactKeys(atom, ["type", "id"]) && atom.id === actor;
    case CFC_ATOM_TYPE.PersonalSpace:
      return hasExactKeys(atom, ["type", "owner"]) && atom.owner === actor;
    default:
      return false;
  }
};

/**
 * The DID an alternative would stand for if it were an actor-owned shape, for
 * naming an identity mismatch, or `undefined` when it has no such shape.
 */
const ownerShapedSubject = (atom: unknown): string | undefined => {
  if (typeof atom === "string") return isDID(atom) ? atom : undefined;
  if (!isObjectNotArray(atom) || typeof atom.subject !== "string") {
    return undefined;
  }
  const exact = atom.type === CFC_ATOM_TYPE.User
    ? hasExactKeys(atom, ["type", "subject"])
    : atom.type === CFC_ATOM_TYPE.Context
    ? hasExactKeys(atom, ["type", "name", "subject"])
    : atom.type === CFC_ATOM_TYPE.Resource
    ? hasExactKeys(atom, ["type", "class", "subject"])
    : false;
  return exact && isDID(atom.subject) ? atom.subject : undefined;
};

/**
 * Checks that every clause of the draft's label is the actor's own, and
 * returns the `Context` and `Resource` sources it draws on.
 *
 * @throws If a clause is empty, carries a caveat, names another principal, or
 *   holds any alternative that is not the actor's own.
 */
const actorOwnedSources = (
  confidentiality: readonly CfcConfClause[],
  actor: string,
): CfcAtom[] => {
  const sources: CfcAtom[] = [];
  for (const clause of confidentiality) {
    const alternatives = clauseAlternatives(clause);
    if (alternatives.length === 0) {
      throw new Error(
        "Custody seal refuses an unsatisfiable clause; sealing it would open it",
      );
    }
    if (
      alternatives.some((atom) =>
        isObjectNotArray(atom) && atom.type === CFC_ATOM_TYPE.Caveat
      )
    ) {
      throw new Error(
        debugStr`Custody seal refuses a value that still carries a caveat: $quote${clause}`,
      );
    }
    if (alternatives.every((atom) => isActorOwnedAlternative(atom, actor))) {
      for (const atom of alternatives) {
        if (
          isObjectNotArray(atom) &&
          (atom.type === CFC_ATOM_TYPE.Context ||
            atom.type === CFC_ATOM_TYPE.Resource) &&
          !sources.some((source) => deepEqual(source, atom))
        ) sources.push(atom as CfcAtom);
      }
      continue;
    }
    const other = alternatives.map(ownerShapedSubject)
      .find((subject) => subject !== undefined && subject !== actor);
    if (other !== undefined) {
      throw new Error(
        `Custody seal identity mismatch: the value is labeled for \`${other}\`, and this runtime acts as \`${actor}\``,
      );
    }
    throw new Error(
      debugStr`Custody seal refuses a clause the authenticated actor does not own: $quote,long${clause}`,
    );
  }
  return sources;
};

/** Stands in for a property the stance leaves out: its schema alone is checked. */
const UNUSED_PROPERTY: unique symbol = Symbol("unused property");

/**
 * Checks that `value` satisfies `schema`, and that `schema` admits only
 * instruction-inert values: booleans, bounded numbers, constants, and
 * enumerated primitives, composed by closed objects. Arrays are refused; a
 * multiple choice is an object of booleans.
 *
 * @throws If the schema admits free text or any other open-ended leaf, or if
 *   the value does not satisfy it.
 */
const checkInertStance = (
  schema: unknown,
  value: unknown,
  path: readonly (string | number)[] = [],
): void => {
  // A property the value leaves out still has its schema checked, so an
  // optional open-ended property is refused whether or not a value uses it.
  const checksValue = value !== UNUSED_PROPERTY;
  const at = `/${path.join("/")}`;
  const refuse = (reason: string): never => {
    throw new Error(
      `Custody seal requires an instruction-inert stance: ${reason} at \`${at}\``,
    );
  };
  if (path.length > STANCE_SCHEMA_MAX_DEPTH) refuse("the schema is too deep");
  if (!isObjectNotArray(schema)) refuse("the schema is not an object");
  const node = schema as Record<string, unknown>;
  for (const key of Object.keys(node)) {
    if (!STANCE_SCHEMA_KEYS.has(key)) {
      refuse(`the schema keyword \`${key}\` is not allowed`);
    }
  }
  const isPrimitive = (entry: unknown) =>
    entry === null || typeof entry === "string" ||
    typeof entry === "boolean" ||
    (typeof entry === "number" && Number.isFinite(entry));
  if (Object.hasOwn(node, "const")) {
    if (!isPrimitive(node.const)) refuse("`const` is not a primitive");
    if (checksValue && !deepEqual(value, node.const)) {
      refuse("the value is not the constant");
    }
    return;
  }
  if (Object.hasOwn(node, "enum")) {
    if (
      !Array.isArray(node.enum) || node.enum.length === 0 ||
      !node.enum.every(isPrimitive)
    ) refuse("`enum` is not a list of primitives");
    if (
      checksValue &&
      !(node.enum as unknown[]).some((entry) => deepEqual(entry, value))
    ) {
      refuse("the value is not one of the enumerated values");
    }
    return;
  }
  switch (node.type) {
    case "boolean":
      if (checksValue && typeof value !== "boolean") {
        refuse("the value is not a boolean");
      }
      return;
    case "null":
      if (checksValue && value !== null) refuse("the value is not `null`");
      return;
    case "number":
    case "integer": {
      const { minimum, maximum } = node;
      if (
        typeof minimum !== "number" || typeof maximum !== "number" ||
        !Number.isFinite(minimum) || !Number.isFinite(maximum)
      ) refuse("a number needs a finite `minimum` and `maximum`");
      if (!checksValue) return;
      if (
        typeof value !== "number" || !Number.isFinite(value) ||
        value < (minimum as number) || value > (maximum as number) ||
        (node.type === "integer" && !Number.isInteger(value))
      ) refuse("the value is outside the number's bounds");
      return;
    }
    case "object": {
      const { properties, required } = node;
      if (!isObjectNotArray(properties)) refuse("an object needs `properties`");
      if (node.additionalProperties !== false) {
        refuse("an object needs `additionalProperties: false`");
      }
      if (
        required !== undefined &&
        (!Array.isArray(required) ||
          !required.every((key) =>
            typeof key === "string" &&
            Object.hasOwn(properties as object, key)
          ))
      ) refuse("`required` names a key the object does not declare");
      if (!checksValue) {
        for (const [key, entry] of Object.entries(properties as object)) {
          checkInertStance(entry, UNUSED_PROPERTY, [...path, key]);
        }
        return;
      }
      if (!isObjectNotArray(value)) refuse("the value is not an object");
      const record = value as Record<string, unknown>;
      for (const key of (required as string[] | undefined) ?? []) {
        if (!Object.hasOwn(record, key)) refuse(`\`${key}\` is missing`);
      }
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties as object, key)) {
          refuse(`\`${key}\` is not declared`);
        }
      }
      for (const [key, entry] of Object.entries(properties as object)) {
        checkInertStance(
          entry,
          Object.hasOwn(record, key) ? record[key] : UNUSED_PROPERTY,
          [...path, key],
        );
      }
      return;
    }
    default:
      refuse(debugStr`the type $quote${node.type} admits open-ended values`);
  }
};

/**
 * Checks the terms' shape and the actor's seat, returning the stance schema.
 *
 * @throws If the terms name no seats or no stance schema, or if the actor
 *   holds no seat.
 */
const checkTerms = (terms: JSONValue, actor: string): unknown => {
  if (!isObjectNotArray(terms)) {
    throw new Error("Custody terms must be an object");
  }
  const { seats, stanceSchema } = terms as Record<string, unknown>;
  if (
    !Array.isArray(seats) || seats.length === 0 ||
    !seats.every(isWellFormedDID) ||
    new Set(seats).size !== seats.length
  ) {
    throw new Error(
      "Custody terms must name `seats` as distinct, well-formed DIDs",
    );
  }
  if (!(seats as readonly string[]).includes(actor)) {
    throw new Error(
      `Custody seal refuses \`${actor}\`: the terms give it no seat`,
    );
  }
  if (stanceSchema === undefined) {
    throw new Error("Custody terms must name a `stanceSchema`");
  }
  return stanceSchema;
};

/**
 * Validates the room's policy reference and pins its subject to the room
 * space.
 *
 * @throws If the reference is not an exact module policy reference, or its
 *   subject is not the room space.
 */
const checkPolicy = (
  policy: unknown,
  room: string,
): CfcModulePolicyRefAtom => {
  if (
    !isObjectNotArray(policy) || !hasExactKeys(policy, MODULE_POLICY_KEYS) ||
    policy.type !== CFC_ATOM_TYPE.Policy || policy.policyRefKind !== "module" ||
    typeof policy.moduleIdentity !== "string" ||
    typeof policy.symbol !== "string" ||
    typeof policy.policyDigest !== "string"
  ) {
    throw new Error("Custody seal requires an exact module policy reference");
  }
  if (policy.subject !== room) {
    throw new Error(
      debugStr`Custody seal refuses a policy whose subject $quote${policy.subject} is not the room space $quote${room}`,
    );
  }
  return cfcAtom.modulePolicyRef(
    policy.moduleIdentity,
    policy.symbol,
    policy.policyDigest,
    room,
  );
};

/**
 * The policy as a schema declares it: the runtime substitutes the owning
 * space for the subject, so a declaration in the room space names the room.
 */
const declaredPolicy = (policy: CfcModulePolicyRefAtom) => ({
  ...policy,
  subject: { __ctOwningSpace: true },
});

/**
 * `value` as JSON with every object's keys sorted, so equal terms serialize to
 * equal bytes. Terms are sealed into each entry as this one string: a leaf,
 * which no write below it can alter, and which a consumer compares across
 * entries byte for byte.
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

/** Records every read of an inspection transaction with its content digest. */
const readEvidence = (tx: IExtendedStorageTransaction): ReadEvidence[] => {
  const reads = tx.getReadActivities?.();
  if (reads === undefined) {
    throw new Error("Custody seal requires a verifiable read journal");
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
 * Whether the document at `link` is absent, or its root was written by the
 * seal. Anyone can address a box, so a box some other code created first is
 * refused rather than trusted to carry the seal's policy.
 */
const absentOrSealed = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): boolean => {
  if (
    tx.readValueOrThrow({ ...link, path: [] }, {
      meta: internalVerifierRead,
    }) ===
      undefined
  ) return true;
  return (readStoredCfcMetadata(tx, link)?.labelMap.entries ?? []).some(
    (entry) =>
      entry.path.length === 0 && entry.origin === "derived" &&
      (entry.label.integrity ?? []).some((atom) => deepEqual(atom, SEALED_BY)),
  );
};

/**
 * Whether the anchor at `link` is absent, or holds exactly the value and the
 * label the seal gives it: one declared root clause and no integrity on any
 * entry. An anchor some other code created with another clause, or holding a
 * link whose target the seal's read would follow, would taint every entry or
 * leave it unattributed; one carrying integrity would hand that integrity,
 * and any `TransformedBy` witness in it, to every entry, since the anchor is
 * the entry transaction's one labeled read.
 */
const absentOrAnchor = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  clause: CfcConfClause,
  instance: string,
): boolean => {
  const stored = tx.readValueOrThrow({ ...link, path: [] }, {
    meta: internalVerifierRead,
  });
  if (stored === undefined) return true;
  if (!deepEqual(stored, { instance })) return false;
  const entries = readStoredCfcMetadata(tx, link)?.labelMap.entries ?? [];
  if (entries.some((entry) => (entry.label.integrity ?? []).length > 0)) {
    return false;
  }
  const labeled = entries.filter((entry) =>
    (entry.label.confidentiality ?? []).length > 0
  );
  return labeled.length > 0 &&
    labeled.every((entry) =>
      entry.path.length === 0 && entry.origin === "declared" &&
      entry.label.confidentiality!.length === 1 &&
      clausesEqual(entry.label.confidentiality![0] as CfcConfClause, clause)
    );
};

/** The clause the anchor carries: the room's policy, or the room's readers. */
const anchorClause = (policy: CfcModulePolicyRefAtom): CfcConfClause => ({
  anyOf: [policy, cfcAtom.space(policy.subject as string)],
});

/** The instance's box, in the room space. */
const boxCell = (
  runtime: Cell<unknown>["runtime"],
  policy: CfcModulePolicyRefAtom,
  instance: string,
  tx?: IExtendedStorageTransaction,
) =>
  runtime.getCell<Record<string, JSONValue>>(
    policy.subject as never,
    { custodyBox: { policy, instance } },
    {
      type: "object",
      ifc: {
        confidentiality: [declaredPolicy(policy)],
        writeAuthorizedBy: [CUSTODY_SEAL_WRITER],
      },
      // Each entry repeats the writer claim, and names no type: a claim
      // whose schema names a type governs only writes of values of that type.
      additionalProperties: {
        ifc: {
          confidentiality: [declaredPolicy(policy)],
          writeAuthorizedBy: [CUSTODY_SEAL_WRITER],
        },
      },
    } as never,
    tx,
  );

/**
 * The instance's anchor: a seal-written constant each seal reads before it
 * writes. The read makes the sealing transaction's flow join nonempty, which
 * is what attributes its writes to the seal (`TransformedBy` is minted only
 * over a nonempty join), and the anchor's clause admits nothing the box's own
 * declared policy does not already bound.
 */
const anchorCell = (
  runtime: Cell<unknown>["runtime"],
  policy: CfcModulePolicyRefAtom,
  instance: string,
  tx?: IExtendedStorageTransaction,
) =>
  runtime.getCell<JSONValue>(
    policy.subject as never,
    { custodyAnchor: { policy, instance } },
    {
      additionalProperties: {
        ifc: { writeAuthorizedBy: [CUSTODY_SEAL_WRITER] },
      },
      ifc: {
        confidentiality: [{
          anyOf: [
            declaredPolicy(policy),
            cfcAtom.space(policy.subject as string),
          ],
        }],
        writeAuthorizedBy: [CUSTODY_SEAL_WRITER],
      },
    } as never,
    tx,
  );

/**
 * The actor's blinded entry key for an instance: a digest of the actor's
 * signature over `(P, D)`. Ed25519 signatures are deterministic, so the key
 * is stable for the actor across devices, and it is unpredictable to anyone
 * without the actor's signing key, including other members who know the
 * actor's DID.
 *
 * @throws If the runtime's storage signer is not the actor, or it signs the
 *   same message two ways.
 */
const blindedEntryKey = async (
  runtime: Cell<unknown>["runtime"],
  actor: string,
  policy: CfcModulePolicyRefAtom,
  instance: string,
): Promise<string> => {
  const signer = runtime.storageManager.as;
  if (signer.did() !== actor) {
    throw new Error(
      `Custody seal requires the storage signer \`${signer.did()}\` to be the acting principal \`${actor}\``,
    );
  }
  const message = new TextEncoder().encode(
    ENTRY_KEY_DOMAIN + hashStringOf({ policy, instance }),
  );
  const sign = async () => {
    const { ok, error } = await signer.sign(message as never);
    if (error || !ok) {
      throw new Error("Custody seal could not sign its entry key", {
        cause: error,
      });
    }
    return toUnpaddedBase64url(sha256(new Uint8Array(ok)));
  };
  const first = await sign();
  if (first !== await sign()) {
    throw new Error("Custody seal requires a deterministic signer");
  }
  return first;
};

/**
 * Whether the actor's trust closure holds `policy` as a trusted declassifier
 * through a statement that names `policy`'s exact manifest digest. A
 * manifest's `moduleIdentity` and `symbol` are fields its author writes, so a
 * statement that leaves the digest open is satisfied by anyone's manifest
 * that copies those two fields; such statements are not consulted here.
 */
const trustsAsDeclassifier = (
  config: CfcTrustConfig | undefined,
  policy: CfcModulePolicyRefAtom,
  actor: string,
): boolean => {
  if (config === undefined) return false;
  const pinning = config.statements.filter((statement) =>
    isObjectNotArray(statement.concrete) &&
    statement.concrete.policyDigest === policy.policyDigest &&
    matchAtomPattern(statement.concrete, policy) !== null
  );
  return createTrustResolver({ ...config, statements: pinning })
    .conceptSatisfied(TRUSTED_DECLASSIFIER_CONCEPT, [policy], actor);
};

const ROLE_OF = { OWNER: "owner", WRITE: "writer", READ: "reader" } as const;

/**
 * The room's readers, ordered by principal: every principal its access list
 * names, and the room space's own key, which the memory service treats as an
 * owner whether or not the list names it.
 *
 * @throws If the room space has no access list, one with no concrete owner,
 *   or one naming a principal that is neither `*` nor a well-formed DID.
 *   Without one, who can read the room cannot be named, and the actor would
 *   consent to an audience nobody showed them.
 */
const roomReaders = (acl: unknown, room: string): CustodyRoomReader[] => {
  if (!isACL(acl) || !hasConcreteOwner(acl)) {
    throw new Error(
      "Custody seal requires a room space whose access list names its readers",
    );
  }
  const listed: Record<string, Capability> = {
    ...(acl as Record<string, Capability>),
    [room]: "OWNER",
  };
  if (
    !Object.keys(listed).every((principal) =>
      principal === ANYONE_USER || isWellFormedDID(principal)
    )
  ) {
    throw new Error(
      "Custody seal requires a room space whose access list names only well-formed DIDs or `*`",
    );
  }
  return Object.entries(listed)
    .map(([principal, capability]) => ({
      principal,
      role: ROLE_OF[capability],
    }))
    .sort((a, b) => utf8Compare(a.principal, b.principal));
};

/**
 * Reads the actor's allowed sources for custody rooms from a settings
 * document in the actor's home space: a list of the actor's own `Context` and
 * `Resource` atoms. This is how a seal reads the settings cell a host passes
 * as {@link CustodySealOptions.allowedSources}; a host calls it only to show
 * the allowance outside a seal.
 *
 * The document is read only from the actor's home space, so a room, or anyone
 * else who can write a space the actor reads, cannot widen what the actor
 * allows. Code running as the actor can write the actor's home space; what
 * holds against that code is the confirmation, which shows the sources the
 * value draws on.
 *
 * @throws If there is no authenticated actor, the document is not in the
 *   actor's home space, or it holds anything other than a list of the actor's
 *   own `Context` and `Resource` atoms.
 */
export async function readCustodySourcePolicy(
  settings: Cell<unknown>,
): Promise<CfcAtom[]> {
  await settings.sync();
  const tx = settings.runtime.edit();
  try {
    return sourcePolicyIn(settings, tx);
  } finally {
    tx.abort();
  }
}

/**
 * Reads the actor's allowed sources from `settings` in `tx`, as
 * {@link readCustodySourcePolicy} describes.
 */
const sourcePolicyIn = (
  settings: Cell<unknown>,
  tx: IExtendedStorageTransaction,
): CfcAtom[] => {
  const actor = tx.getCfcState().trustSnapshot?.actingPrincipal;
  if (!isDID(actor)) {
    throw new Error("Custody seal requires an authenticated actor");
  }
  const link = settings.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
  if (link.space !== actor) {
    throw new Error(
      "Custody seal reads the allowed sources only from the actor's home space",
    );
  }
  const value = snapshotJsonValue(settings.withTx(tx).get());
  if (
    !Array.isArray(value) ||
    !value.every((atom) =>
      isObjectNotArray(atom) &&
      (atom.type === CFC_ATOM_TYPE.Context ||
        atom.type === CFC_ATOM_TYPE.Resource) &&
      isActorOwnedAlternative(atom, actor)
    )
  ) {
    throw new Error(
      "Custody seal requires the allowed sources to be the actor's own `Context` and `Resource` atoms",
    );
  }
  return value as unknown as CfcAtom[];
};

const STALE_REVIEW = "Custody seal review is stale; review the value again";

/**
 * Returns the allowed sources `options` names: a copy of its list, or what its
 * settings cell holds. A cell's read is added to `evidence`, so the entry's
 * transaction verifies it.
 */
const allowedSourcesOf = async (
  runtime: Cell<unknown>["runtime"],
  options: CustodySealOptions,
  evidence: ReadEvidence[],
): Promise<readonly CfcAtom[]> => {
  const allowed = options?.allowedSources;
  if (Array.isArray(allowed)) return structuredClone(allowed);
  if (!isCell(allowed)) {
    throw new Error("Custody seal requires the room's allowed sources");
  }
  if (allowed.runtime !== runtime) {
    throw new Error("Custody seal handles must belong to the same runtime");
  }
  await allowed.sync();
  const tx = runtime.edit();
  try {
    const sources = sourcePolicyIn(allowed, tx);
    evidence.push(...readEvidence(tx));
    return sources;
  } finally {
    tx.abort();
  }
};

/**
 * Returns the policy reference `policy` names: the reference itself, or what
 * its cell holds. A cell's read is added to `evidence`, so the entry's
 * transaction verifies it. The caller checks the reference.
 */
const requestedPolicyOf = async (
  runtime: Cell<unknown>["runtime"],
  policy: CustodyRoom["policy"],
  evidence: ReadEvidence[],
): Promise<unknown> => {
  if (!isCell(policy)) return policy;
  if (policy.runtime !== runtime) {
    throw new Error("Custody seal handles must belong to the same runtime");
  }
  await policy.sync();
  const tx = runtime.edit();
  try {
    const value = snapshotJsonValue(policy.withTx(tx).get());
    evidence.push(...readEvidence(tx));
    return value;
  } finally {
    tx.abort();
  }
};

/**
 * Reads the draft, the terms, and the room's state, and checks them all. At
 * commit, `reviewed` is what the prepare established, and a stored input that
 * no longer holds it is refused as stale before anything is checked against
 * it.
 */
const inspect = async (
  draft: Cell<unknown>,
  requestedRoom: CustodyRoom,
  options: CustodySealOptions,
  reviewed?: Inspection,
): Promise<Inspection> => {
  const runtime = draft.runtime;
  if (requestedRoom.terms.runtime !== runtime) {
    throw new Error("Custody seal handles must belong to the same runtime");
  }
  await Promise.all([draft.sync(), requestedRoom.terms.sync()]);

  const evidence: ReadEvidence[] = [];
  const allowed = await allowedSourcesOf(runtime, options, evidence);
  if (reviewed && !deepEqual(allowed, reviewed.allowedSources)) {
    throw new Error(STALE_REVIEW);
  }

  const draftTx = runtime.edit();
  let actor: string;
  let draftLink: NormalizedFullLink;
  let stance: JSONValue;
  let sources: CfcAtom[];
  try {
    const acting = draftTx.getCfcState().trustSnapshot?.actingPrincipal;
    if (!isDID(acting)) {
      throw new Error("Custody seal requires an authenticated actor");
    }
    actor = acting;
    draftLink = draft.withTx(draftTx).resolveAsCell().getAsNormalizedFullLink();
    stance = snapshotJsonValue(draft.withTx(draftTx).get());
    sources = actorOwnedSources(
      collectConsumedLabel(draftTx).confidentiality,
      actor,
    );
    evidence.push(...readEvidence(draftTx));
  } finally {
    draftTx.abort();
  }
  const refused = sources.find((source) =>
    !allowed.some((entry) => deepEqual(entry, source))
  );
  if (refused !== undefined) {
    throw new Error(
      debugStr`Custody seal refuses a source this room does not allow: $quote,long${refused}`,
    );
  }

  const requestedPolicy = await requestedPolicyOf(
    runtime,
    requestedRoom.policy,
    evidence,
  );
  if (reviewed && !deepEqual(requestedPolicy, reviewed.policy)) {
    throw new Error(STALE_REVIEW);
  }

  const termsTx = runtime.edit();
  let termsLink: NormalizedFullLink;
  let terms: JSONValue;
  let policy: CfcModulePolicyRefAtom;
  let room: string;
  try {
    termsLink = requestedRoom.terms.withTx(termsTx).resolveAsCell()
      .getAsNormalizedFullLink();
    room = termsLink.space;
    if (!isDID(room)) {
      throw new Error("Custody terms must live in a space named by a DID");
    }
    policy = checkPolicy(requestedPolicy, room);
    terms = snapshotJsonValue(requestedRoom.terms.withTx(termsTx).get());
    // Terms are copied into every entry, so they may carry only what the
    // room's readers already hold: a clause admitting the room space, or the
    // room's own policy.
    for (const clause of collectConsumedLabel(termsTx).confidentiality) {
      if (
        !clauseAlternatives(clause).some((atom) =>
          deepEqual(atom, cfcAtom.space(room)) || deepEqual(atom, policy)
        )
      ) {
        throw new Error(
          debugStr`Custody terms carry a clause the room's readers do not hold: $quote,long${clause}`,
        );
      }
    }
    evidence.push(...readEvidence(termsTx));
  } finally {
    termsTx.abort();
  }
  const manifest = runtime.getCellFromEntityId(
    room,
    cfcPolicyManifestDocId(policy.policyDigest),
  );
  await manifest.sync();
  const manifestTx = runtime.edit();
  try {
    if (!runtime.resolveCfcPolicyManifest(policy, manifestTx, room, false)) {
      throw new Error(
        debugStr`Custody seal refuses a policy not installed in the room space: $quote${policy.policyDigest}`,
      );
    }
  } finally {
    manifestTx.abort();
  }
  const acl = runtime.getCellFromLink({
    space: room,
    id: aclDocId(room),
    path: [],
  } as never);
  await acl.sync();
  const aclTx = runtime.edit();
  let readers: CustodyRoomReader[];
  try {
    readers = roomReaders(
      aclTx.readValueOrThrow({ ...acl.getAsNormalizedFullLink(), path: [] }, {
        meta: internalVerifierRead,
      }),
      room,
    );
    evidence.push(...readEvidence(aclTx));
  } finally {
    aclTx.abort();
  }
  checkInertStance(checkTerms(terms, actor), stance);
  if (!trustsAsDeclassifier(runtime.cfcTrustConfig, policy, actor)) {
    throw new Error(
      debugStr`Custody seal refuses a policy the actor does not trust as a declassifier: $quote,long${policy}`,
    );
  }

  const instance = hashStringOf(terms);
  const entryKey = await blindedEntryKey(runtime, actor, policy, instance);
  const box = boxCell(runtime, policy, instance);
  await box.sync();
  const boxTx = runtime.edit();
  try {
    const entry = boxTx.readValueOrThrow({
      ...box.getAsNormalizedFullLink(),
      path: [entryKey],
    }, { meta: internalVerifierRead });
    if (entry !== undefined) {
      throw new Error("Custody seal refuses a second entry for this actor");
    }
    if (!absentOrSealed(boxTx, box.getAsNormalizedFullLink())) {
      throw new Error("Custody seal refuses a box the seal did not create");
    }
  } finally {
    boxTx.abort();
  }
  return {
    actor,
    allowedSources: allowed,
    room: policy.subject as string,
    readers,
    draftLink,
    termsLink,
    stance,
    terms,
    instance,
    policy,
    sources,
    entryKey,
    evidence,
  };
};

/**
 * Prepares a seal of `draft` into `room` for the host's confirmation dialog.
 * The preview is exactly what the commit writes; the consent it returns is
 * good for one commit.
 *
 * @throws If the value is not entirely the actor's own, is not instruction
 *   inert, draws on a source the room does not allow, or the room's policy is
 *   malformed, untrusted, not the room space's, or not installed there, or the
 *   actor holds no seat or has already sealed.
 */
export async function prepareCustodySeal(
  draft: Cell<unknown>,
  room: CustodyRoom,
  options: CustodySealOptions,
): Promise<PreparedCustodySeal> {
  // The preview and the retained consent share these values, so they are
  // frozen: a caller that edits what it was shown cannot change what the
  // commit compares against.
  const inspected = await inspect(draft, room, options);
  deepFreeze(inspected.stance);
  deepFreeze(inspected.terms);
  deepFreeze(inspected.policy);
  deepFreeze(inspected.sources);
  deepFreeze(inspected.allowedSources);
  deepFreeze(inspected.readers);
  const consent = Object.freeze({}) as CustodySealConsent;
  consents.set(consent, {
    ...inspected,
    draft: draft.withTx(undefined),
    requestedRoom: room,
    options: Object.freeze({
      allowedSources: isCell(options.allowedSources)
        ? options.allowedSources.withTx(undefined)
        : structuredClone(options.allowedSources),
    }),
    eventId: crypto.randomUUID(),
  });
  return Object.freeze({
    actor: inspected.actor,
    room: inspected.room,
    readers: inspected.readers,
    stance: inspected.stance,
    terms: inspected.terms,
    instance: inspected.instance,
    policy: inspected.policy,
    sources: inspected.sources,
    consent,
  });
}

/**
 * Writes the reviewed entry after a host-trusted seal gesture: the
 * instance's anchor if it is absent, then the actor-private receipt in the
 * actor's home space, then the entry in the box. A transaction writes one
 * space, so each is a separate commit, and the receipt is written before the
 * entry so that no entry exists without one; a receipt whose entry is absent
 * records a seal whose commit failed, or an entry lost afterwards.
 *
 * @throws If the consent is unknown or spent, the gesture is not the host's,
 *   anything reviewed changed, the anchor is withheld from this runtime, the
 *   actor's entry exists, or `options.signal` aborted before the entry's
 *   transaction was sent.
 */
export async function commitCustodySeal(
  consent: CustodySealConsent,
  event: unknown,
  options: CustodySealCommitOptions = {},
): Promise<CustodySealResult> {
  const { signal } = options;
  const state = consents.get(consent);
  if (!state) {
    throw new Error("Custody seal consent is unknown or already consumed");
  }
  consents.delete(consent);
  if (
    !isRendererTrustedEvent(event) || !isObjectNotArray(event) ||
    !isObjectNotArray(event.provenance) || event.provenance.origin !== "dom" ||
    event.provenance.trusted !== true ||
    !isObjectNotArray(event.provenance.ui) ||
    event.provenance.ui.pattern !== CUSTODY_SEAL_GESTURE
  ) {
    throw new Error("Custody seal requires a trusted host seal gesture");
  }
  signal?.throwIfAborted();
  const current = await inspect(
    state.draft,
    state.requestedRoom,
    state.options,
    state,
  );
  if (
    current.actor !== state.actor ||
    !deepEqual(current.readers, state.readers) ||
    !deepEqual(current.stance, state.stance) ||
    !deepEqual(current.terms, state.terms) ||
    current.instance !== state.instance ||
    !deepEqual(current.policy, state.policy) ||
    !deepEqual(current.sources, state.sources) ||
    !deepEqual(current.draftLink, state.draftLink) ||
    !deepEqual(current.termsLink, state.termsLink) ||
    current.entryKey !== state.entryKey
  ) {
    throw new Error(STALE_REVIEW);
  }
  const runtime = state.draft.runtime;
  const { actor, policy, instance, entryKey } = state;
  signal?.throwIfAborted();

  // The anchor comes first, so a seal that cannot establish it has written
  // nothing durable. It is written only where absent, and its value is a
  // constant the entry transaction verifies, so two first seals racing to
  // create it need no create-only mark: the loser's retry finds the winner's.
  const anchor = anchorCell(runtime, policy, instance);
  await anchor.sync();
  const anchorLink = anchor.getAsNormalizedFullLink();
  const anchored = await runtime.editWithRetry(
    (tx) => {
      if (
        tx.readValueOrThrow(anchorLink, { meta: internalVerifierRead }) !==
          undefined
      ) {
        // Checked here as well as in the entry transaction, so a squatted
        // anchor is refused before the receipt makes anything durable.
        if (!absentOrAnchor(tx, anchorLink, anchorClause(policy), instance)) {
          throw new Error(
            "Custody seal refuses an anchor the seal did not create",
          );
        }
        return;
      }
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: CUSTODY_SEAL_WRITER,
      });
      anchor.withTx(tx).set({ instance });
    },
    undefined,
    { signal },
  );
  if (anchored.error) {
    const reason = "reason" in anchored.error
      ? anchored.error.reason
      : undefined;
    if (reason instanceof Error) throw reason;
    throw new Error(
      `Custody seal could not create its anchor: ${anchored.error.message}`,
    );
  }

  signal?.throwIfAborted();
  const receiptTx = runtime.edit();
  let receipt: Cell<unknown>;
  try {
    receiptTx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: CUSTODY_SEAL_WRITER,
    });
    receipt = runtime.getCell(actor as never, {
      custodySealReceipt: state.eventId,
    }, {
      type: "object",
      additionalProperties: {
        ifc: { writeAuthorizedBy: [CUSTODY_SEAL_WRITER] },
      },
      ifc: {
        confidentiality: [cfcAtom.user(actor)],
        writeAuthorizedBy: [CUSTODY_SEAL_WRITER],
      },
    }, receiptTx);
    receipt.set({
      eventId: state.eventId,
      policy,
      instance,
      entryKey,
      sources: state.sources,
      stanceDigest: hashStringOf(state.stance),
      draftId: state.draftLink.id,
    });
    receiptTx.markCreateOnly?.(receipt.getAsNormalizedFullLink());
    signal?.throwIfAborted();
    const result = await receiptTx.commit();
    if (result.error) {
      throw new Error(`Custody seal receipt failed: ${result.error.message}`);
    }
  } catch (error) {
    receiptTx.abort();
    throw error;
  }

  // Every seal of an instance writes the one box document, so seals by
  // different actors conflict; each retry re-runs every check against the
  // state that won, including whether this actor's entry now exists. The
  // signal is checked here and, by `editWithRetry`, at every step until the
  // transaction is sent.
  let box: Cell<Record<string, JSONValue>> | undefined;
  const sealed = await runtime.editWithRetry(
    (tx) => {
      signal?.throwIfAborted();
      if (tx.getCfcState().trustSnapshot?.actingPrincipal !== actor) {
        throw new Error("Custody seal actor changed after review");
      }
      for (const read of current.evidence) {
        const stored = tx.readOrThrow(read.address, {
          meta: internalVerifierRead,
        });
        if (hashStringOf(stored) !== read.digest) {
          throw new Error("Custody seal review changed before commit");
        }
      }
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: CUSTODY_SEAL_WRITER,
      });
      if (!absentOrAnchor(tx, anchorLink, anchorClause(policy), instance)) {
        throw new Error(
          "Custody seal refuses an anchor the seal did not create",
        );
      }
      box = boxCell(runtime, policy, instance, tx);
      const boxLink = box.getAsNormalizedFullLink();
      if (!absentOrSealed(tx, boxLink)) {
        throw new Error("Custody seal refuses a box the seal did not create");
      }
      // The one labeled read in this transaction: it attributes the entry's
      // writes to the seal. Every other read is a verifier read, so neither the
      // draft's clauses nor anyone else's reach the entry.
      try {
        anchor.withTx(tx).get();
      } catch (error) {
        if (error instanceof CfcReadCeilingError) {
          throw new Error(
            "Custody seal requires a runtime whose read ceiling admits the room's custody",
            { cause: error },
          );
        }
        throw error;
      }
      const entryLink = { ...boxLink, path: [entryKey] };
      if (tx.readValueOrThrow(entryLink, { meta: internalVerifierRead })) {
        throw new Error("Custody seal refuses a second entry for this actor");
      }
      box.key(entryKey).set({
        instance,
        terms: canonicalJson(state.terms),
        stance: state.stance,
      });
    },
    undefined,
    { signal },
  );
  if (sealed.error) {
    // A check that threw is the refusal to report; anything else is the
    // commit's own failure.
    const reason = "reason" in sealed.error ? sealed.error.reason : undefined;
    if (reason instanceof Error) throw reason;
    throw new Error(`Custody seal failed: ${sealed.error.message}`);
  }
  return {
    box: box!.withTx(undefined) as Cell<unknown>,
    entryKey,
    receipt: receipt.withTx(undefined),
  };
}
