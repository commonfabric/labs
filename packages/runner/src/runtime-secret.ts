/**
 * Runtime secrets: values the runtime mints for its own use, one document per
 * space and name, which executed code can neither choose nor read. The salt
 * `sqliteQuery` hashes into each result row document's id is one: without it
 * a reader could recompute a row's id from a guess at the row's content, and
 * so confirm the guess without reading the row. A module policy's key is
 * another (`modulePolicySecret()`), under which `policySecretHash` computes
 * the keyed hashes it hands to patterns (docs/specs/cfc-policy-secret.md).
 *
 * The id namespace is reserved. The transaction write chokepoint refuses every
 * unprivileged write to it, and the read chokepoint every read of a secret's
 * value but this module's own, whose marker is private to it, so no executed
 * code holds a secret.
 * `IExtendedStorageTransaction.ensureRuntimeSecret()` is the one writer: it
 * mints a random value when no trusted one is stored, hands none back, and
 * takes the runtime's in-package authorization, so executed code cannot mint
 * a secret in its own transaction and read it there before its label is
 * stored.
 *
 * A stored value is trusted only when its stored schema carries the writer
 * claim `writeAuthorizedBy: [RUNTIME_SECRET_WRITER]` over the confidentiality
 * the secret is stored under, or when the transaction reading it minted it. The runtime committing a write refuses a claim whose
 * writer is not the builtin it names, and no runtime lets executed code act as
 * a builtin, so a value that code planted in the namespace through a runtime
 * without the chokepoint carries no such claim.
 * `ensureRuntimeSecret()` replaces an untrusted value. A value whose stored
 * schema is named but resolves neither in the replica nor in the schema
 * registry is neither trusted nor untrusted, and reading it throws: a replica
 * can hold a document before the schema document its metadata names, and the
 * mint writing over it then would re-roll a trusted secret with nothing in
 * its commit to catch the overwrite.
 *
 * Each secret is stored under the confidentiality its {@link RuntimeSecret}
 * names. The salt's is {@link RUNTIME_SECRET_LABEL}, an atom no reader holds
 * and no ceiling admits, and the runtime reads it only verifier-internally,
 * so nothing derived from it carries a label. A policy's key is stored under
 * that policy's clause, and the runtime reads it into the flow of the
 * transaction that hashes with it, so everything derived from it carries the
 * clause.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { readStoredCfcMetadata } from "./cfc/metadata.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "./cfc/observation.ts";
import type { CfcModulePolicyMarker } from "./cfc/policy.ts";
import { loadSchemaDocument } from "./cfc/prepare.ts";
import type { NormalizedFullLink } from "./link-utils.ts";
import type { URI } from "./sigil-types.ts";
import type {
  IExtendedStorageTransaction,
  Metadata,
} from "./storage/interface.ts";
import {
  internalVerifierRead,
  stableInternalVerifierRead,
} from "./storage/reactivity-log.ts";

/** The reserved id namespace of runtime secrets. */
export const RUNTIME_SECRET_ID_PREFIX = "of:runtime-secret:";

/**
 * The confidentiality a runtime secret is stored under: the read-failed
 * marker, which `cfcObservationFitsCeiling` treats as ungrantable, so a value
 * derived from a secret fits no ceiling, even one that names the marker.
 */
export const RUNTIME_SECRET_LABEL = {
  confidentiality: [CFC_LABEL_READ_FAILED_ATOM],
} as const;

/** The builtin identity a runtime secret is minted under. */
export const RUNTIME_SECRET_WRITER = "runtime-secret";

/**
 * A runtime secret: the name it is stored under in every space, and the
 * confidentiality it is stored with.
 */
export type RuntimeSecret = {
  /** The name the secret's id in a space is derived from. */
  readonly name: string;

  /**
   * The confidentiality clauses the secret is stored under, as a schema's
   * `ifc.confidentiality` declares them.
   */
  readonly confidentiality: readonly CfcAtom[];
};

/**
 * Returns the runtime secret called `name` that nothing derived from may be
 * used: stored under {@link RUNTIME_SECRET_LABEL}.
 */
export const unusableRuntimeSecret = (name: string): RuntimeSecret => ({
  name,
  confidentiality: RUNTIME_SECRET_LABEL.confidentiality,
});

/**
 * Returns the key of the module policy `marker` names, a compiled `PolicyOf`
 * marker: one per space and policy digest, stored under that policy's clause,
 * whose subject commit preparation binds to the space it is stored in.
 */
export const modulePolicySecret = (
  marker: CfcModulePolicyMarker,
): RuntimeSecret => ({
  name: `policy:${marker.policyDigest}`,
  confidentiality: [marker],
});

/** Returns the schema the runtime secret `secret` is written under. */
export const runtimeSecretSchema = (secret: RuntimeSecret): JSONSchema => ({
  type: "string",
  ifc: {
    confidentiality: [...secret.confidentiality],
    writeAuthorizedBy: [RUNTIME_SECRET_WRITER],
  },
});

/** Returns the id of the runtime secret called `name`. */
export const runtimeSecretId = (name: string): URI =>
  `${RUNTIME_SECRET_ID_PREFIX}${name}` as URI;

/** Returns the address of the runtime secret called `name` in `space`. */
export const runtimeSecretLink = (
  space: MemorySpace,
  name: string,
): NormalizedFullLink => ({
  space,
  id: runtimeSecretId(name),
  scope: "space",
  path: [],
});

/** Returns whether `id` names a runtime secret. */
export const isRuntimeSecretId = (id: string): boolean =>
  id.startsWith(RUNTIME_SECRET_ID_PREFIX);

const ownReadMarker: unique symbol = Symbol("runtimeSecretOwnReadMarker");

/**
 * The runtime's verifier-internal read of a secret: it joins nothing to the
 * flow label, and schedules nothing, so no later write to a secret runs again
 * the transaction that read it.
 */
const trustRead: Metadata = {
  ...stableInternalVerifierRead,
  [ownReadMarker]: true,
};

/**
 * The runtime's watch on a secret that is not yet usable: verifier-internal,
 * so it joins nothing, and scheduled, so the transaction runs again when the
 * secret is stored.
 */
const watchRead: Metadata = { ...internalVerifierRead, [ownReadMarker]: true };

/**
 * The runtime's ordinary read of a secret, which joins the secret's stored
 * label to the reading transaction.
 */
const flowRead: Metadata = { [ownReadMarker]: true };

/**
 * Returns whether `meta` marks one of this module's reads of a runtime
 * secret's value, the only reads of it the read chokepoint admits from a
 * transaction outside a privileged write. The marker is private to this
 * module.
 */
export const isRuntimeSecretOwnRead = (meta?: Metadata): boolean =>
  meta?.[ownReadMarker] === true;

/**
 * Thrown by a read of a runtime secret whose stored metadata names a schema
 * that resolves neither in the replica nor in the schema registry, so that
 * whether the runtime wrote it is unknown.
 */
export class RuntimeSecretUnresolvedError extends Error {
  /** Constructs an instance for the secret at `id`. */
  constructor(id: string, options: { cause: unknown }) {
    super(`${id}: the schema stored with it cannot be resolved`, options);
    this.name = "RuntimeSecretUnresolvedError";
  }
}

/**
 * Returns the runtime secret `secret` in `space`, or `undefined` when no
 * trusted one is stored: none at all, or a value which this transaction did
 * not mint and whose stored schema does not carry the runtime's writer claim
 * over the secret's own confidentiality. The reads are verifier-internal:
 * they stay in the transaction's conflict set, so a secret minted
 * concurrently elsewhere fails this transaction's commit rather than going
 * unseen, they join nothing to the flow label, and they schedule nothing.
 *
 * @throws RuntimeSecretUnresolvedError when whether the runtime wrote the
 * stored value is unknown.
 */
export const readRuntimeSecret = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  secret: RuntimeSecret,
): string | undefined => {
  const link = runtimeSecretLink(space, secret.name);
  const value = tx.readValueOrThrow(link, { meta: trustRead });
  if (typeof value !== "string") return undefined;
  return mintedIn(tx, link) || carriesWriterClaim(tx, link, secret)
    ? value
    : undefined;
};

/**
 * Makes the runtime secret `secret` in `space` a scheduling dependency of
 * `tx`, without reading it into anything: `tx` runs again when the secret is
 * written.
 */
export const watchRuntimeSecret = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  secret: RuntimeSecret,
): void => {
  tx.readValueOrThrow(runtimeSecretLink(space, secret.name), {
    meta: watchRead,
  });
};

/**
 * Like {@link readRuntimeSecret}, except that a trusted value is read a second
 * time with an ordinary read, so the secret's stored label joins the flow of
 * `tx` and a later change to the secret runs it again; and that where no
 * trusted value is stored, `tx` still runs again once one is. The runtime
 * reads a policy's key this way to compute from it.
 *
 * @throws RuntimeSecretUnresolvedError when whether the runtime wrote the
 * stored value is unknown.
 */
export const readRuntimeSecretIntoFlow = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  secret: RuntimeSecret,
): string | undefined => {
  let trusted: string | undefined;
  try {
    trusted = readRuntimeSecret(tx, space, secret);
  } finally {
    if (trusted === undefined) watchRuntimeSecret(tx, space, secret);
  }
  if (trusted === undefined) return undefined;
  const value = tx.readValueOrThrow(runtimeSecretLink(space, secret.name), {
    meta: flowRead,
  });
  return typeof value === "string" ? value : undefined;
};

/** Returns whether `tx` wrote the document `link` names. */
const mintedIn = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): boolean =>
  [...(tx.getWriteDetails?.(link.space) ?? [])].some((detail) =>
    detail.address.id === link.id
  );

/**
 * Returns whether the schema stored with the document `link` names claims it
 * for {@link RUNTIME_SECRET_WRITER} at its root, over exactly the
 * confidentiality `secret` is stored under. A document with no stored
 * metadata carries no claim.
 *
 * @throws RuntimeSecretUnresolvedError when the stored metadata names a schema
 * that cannot be resolved.
 */
const carriesWriterClaim = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  secret: RuntimeSecret,
): boolean => {
  const metadata = readStoredCfcMetadata(tx, link);
  if (metadata === undefined) return false;
  let stored: JSONSchema;
  try {
    stored = loadSchemaDocument(tx, link.space, metadata.schemaHash);
  } catch (error) {
    throw new RuntimeSecretUnresolvedError(link.id, { cause: error });
  }
  const schema = ContextualFlowControl.getSchemaAtPath(stored, []);
  const ifc = isObjectOrArray(schema) && isObjectOrArray(schema.ifc)
    ? schema.ifc
    : undefined;
  return Array.isArray(ifc?.writeAuthorizedBy) &&
    ifc.writeAuthorizedBy.includes(RUNTIME_SECRET_WRITER) &&
    deepEqual(ifc.confidentiality, secret.confidentiality);
};
