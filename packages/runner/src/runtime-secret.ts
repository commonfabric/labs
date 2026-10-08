/**
 * Runtime secrets: values the runtime mints for its own use, one document per
 * space and name, which executed code can neither choose nor use. The salt
 * `sqliteQuery` hashes into each result row document's id is one: without it a
 * reader could recompute a row's id from a guess at the row's content, and so
 * confirm the guess without reading the row.
 *
 * The id namespace is reserved. The transaction write chokepoint refuses every
 * unprivileged write to it. `IExtendedStorageTransaction.ensureRuntimeSecret()`
 * is the one writer: it mints a random value when no trusted one is stored,
 * hands none back, and takes the runtime's in-package authorization, so
 * executed code cannot mint a secret in its own transaction and read it there
 * before its label is stored.
 *
 * A stored value is trusted only when its stored schema carries the writer
 * claim `writeAuthorizedBy: [RUNTIME_SECRET_WRITER]`, or when the transaction
 * reading it minted it. The runtime committing a write refuses a claim whose
 * writer is not the builtin it names, and no runtime lets executed code act as
 * a builtin, so a value that code planted in the namespace, before the
 * chokepoint existed or through a runtime without it, carries no such claim.
 * `ensureRuntimeSecret()` replaces an untrusted value.
 *
 * A secret is labeled with {@link RUNTIME_SECRET_LABEL}, an atom no reader
 * holds and no ceiling admits, so code that reads one cannot write, display
 * or send anything derived from it. The runtime reads its own secrets with
 * {@link readRuntimeSecret}, as a verifier-internal read that joins nothing to
 * the transaction's flow label; the marker that read carries is private to the
 * runtime.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";

import { isObjectOrArray } from "@commonfabric/utils/types";

import { ContextualFlowControl } from "./cfc.ts";
import { readStoredCfcMetadata } from "./cfc/metadata.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "./cfc/observation.ts";
import type { JSONSchema } from "./builder/types.ts";
import type { NormalizedFullLink } from "./link-utils.ts";
import { RUNTIME_SECRET_ID_PREFIX } from "./runtime-secret-id.ts";
import type { URI } from "./sigil-types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  ignoreReadForScheduling,
  internalVerifierRead,
} from "./storage/reactivity-log.ts";

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

/** The schema a runtime secret is written under. */
export const RUNTIME_SECRET_SCHEMA = {
  type: "string",
  ifc: { ...RUNTIME_SECRET_LABEL, writeAuthorizedBy: [RUNTIME_SECRET_WRITER] },
} as const;

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

/**
 * Returns the runtime secret called `name` in `space`, or `undefined` when no
 * trusted one is stored: none at all, or a value whose stored schema does not
 * carry the runtime's writer claim and which this transaction did not mint.
 * The reads are verifier-internal: they stay in the transaction's conflict
 * set, so a secret minted concurrently elsewhere fails this transaction's
 * commit rather than going unseen, and they join nothing to the flow label.
 */
export const readRuntimeSecret = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  name: string,
): string | undefined => {
  const link = runtimeSecretLink(space, name);
  const value = tx.readValueOrThrow(link, { meta: internalVerifierRead });
  if (typeof value !== "string") return undefined;
  return mintedIn(tx, link) || carriesWriterClaim(tx, link) ? value : undefined;
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
 * for {@link RUNTIME_SECRET_WRITER} at its root.
 */
const carriesWriterClaim = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): boolean => {
  const metadata = readStoredCfcMetadata(tx, link);
  if (metadata === undefined) return false;
  const stored = tx.readOrThrow({
    space: link.space,
    id: `cid:${metadata.schemaHash}` as URI,
    type: "application/json",
    path: [],
  }, { meta: { ...ignoreReadForScheduling, ...internalVerifierRead } });
  if (!isObjectOrArray(stored) || stored.value === undefined) return false;
  const schema = ContextualFlowControl.getSchemaAtPath(
    stored.value as JSONSchema,
    [],
  );
  const claim = isObjectOrArray(schema) && isObjectOrArray(schema.ifc)
    ? schema.ifc.writeAuthorizedBy
    : undefined;
  return Array.isArray(claim) && claim.includes(RUNTIME_SECRET_WRITER);
};
