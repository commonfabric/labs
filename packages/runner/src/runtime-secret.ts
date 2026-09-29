/**
 * Runtime secrets: values the runtime mints for its own use, one document per
 * space and name, which executed code can neither choose nor use. The salt
 * `sqliteQuery` hashes into each result row document's id is one: without it a
 * reader could recompute a row's id from a guess at the row's content, and so
 * confirm the guess without reading the row.
 *
 * The id namespace is reserved. The transaction write chokepoint refuses every
 * unprivileged write to it, so no code can plant a secret it knows before the
 * runtime mints one. `IExtendedStorageTransaction.ensureRuntimeSecret()` is
 * the one writer: it mints a random value when none is stored and hands none
 * back, so calling it tells the caller nothing.
 *
 * A secret is labeled with {@link RUNTIME_SECRET_LABEL}, an atom no reader
 * holds and no ceiling admits, so code that reads one cannot write, display
 * or send anything derived from it. The runtime reads its own secrets with
 * {@link readRuntimeSecret}, as a verifier-internal read that joins nothing to
 * the transaction's flow label; the marker that read carries is private to the
 * runtime.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";

import { CFC_LABEL_READ_FAILED_ATOM } from "./cfc/observation.ts";
import type { NormalizedFullLink } from "./link-utils.ts";
import type { URI } from "./sigil-types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { internalVerifierRead } from "./storage/reactivity-log.ts";

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

/** The schema a runtime secret is written under. */
export const RUNTIME_SECRET_SCHEMA = {
  type: "string",
  ifc: RUNTIME_SECRET_LABEL,
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

/** Returns whether `id` names a runtime secret. */
export const isRuntimeSecretId = (id: string): boolean =>
  id.startsWith(RUNTIME_SECRET_ID_PREFIX);

/**
 * Returns the runtime secret called `name` in `space`, or `undefined` when
 * none is stored. The read is verifier-internal: it stays in the
 * transaction's conflict set, so a secret minted concurrently elsewhere fails
 * this transaction's commit rather than going unseen, and it joins nothing to
 * the flow label.
 */
export const readRuntimeSecret = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  name: string,
): string | undefined => {
  const value = tx.readValueOrThrow(runtimeSecretLink(space, name), {
    meta: internalVerifierRead,
  });
  return typeof value === "string" ? value : undefined;
};
