/**
 * What the trusted host's reviewed operations share: the snapshot copy, the
 * custody seal, and the reviewed intent each inspect what they will show,
 * hand the host a preview, and write only if what they read still holds when
 * a trusted gesture commits. This module holds the pieces of that pattern
 * that do not depend on what is reviewed: recording a review's reads and
 * checking them again, loading what a pattern's cell resolves to, writing a
 * value as one comparable string, recognizing a document a builtin wrote,
 * accepting a trusted gesture on one surface, and telling a pattern that names
 * what it matches outright from one that leaves part of it open.
 */

import type { JSONValue } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import type { Cell } from "../cell.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import type { ImplementationIdentity } from "./types.ts";
import { isTrustedGesture } from "./ui-contract.ts";

/** A read a review made, with the digest of what it read. */
export interface ReadEvidence {
  readonly address: IMemorySpaceAddress;
  readonly digest: string;
}

/**
 * Records every read `tx` made with the digest of its content, for a later
 * transaction to check with {@link evidenceHolds}.
 *
 * @throws If `tx` keeps no read journal, naming `operation` as what requires
 *   one.
 */
export const readEvidence = (
  tx: IExtendedStorageTransaction,
  operation: string,
): ReadEvidence[] => {
  const reads = tx.getReadActivities?.();
  if (reads === undefined) {
    throw new Error(`${operation} requires a verifiable read journal`);
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
 * Whether every read in `evidence` reads the same content in `tx`. The reads
 * are verifier reads: they join `tx`'s conflict checks, so a later change
 * refuses its commit, without carrying a label into what `tx` writes.
 */
export const evidenceHolds = (
  tx: IExtendedStorageTransaction,
  evidence: readonly ReadEvidence[],
): boolean =>
  evidence.every((read) =>
    hashStringOf(
      tx.readOrThrow(read.address, { meta: internalVerifierRead }),
    ) ===
      read.digest
  );

/**
 * Loads `cell` and the document it resolves to. A cell a pattern hands the
 * host is often a field of its result that links to the document holding
 * the value, as a computed output or an argument does.
 */
export const syncResolved = async (cell: Cell<unknown>): Promise<void> => {
  await cell.sync();
  await cell.resolveAsCell().sync();
};

/** Whether `value` is a record with exactly the keys named. */
export const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/**
 * `value` as JSON text with every object's keys in UTF-8 order, so that equal
 * values have equal text. Stored as one string, a value is a leaf: no write
 * below it can alter part of it, and a reader compares it byte for byte.
 */
export const canonicalJson = (value: JSONValue): string =>
  JSON.stringify(
    value,
    (_key, entry: unknown) =>
      isObjectNotArray(entry)
        ? Object.fromEntries(
          utf8SortedKeysOf(entry).map((key) => [key, entry[key]]),
        )
        : entry,
  );

/**
 * Whether the root of the document at `link` carries the bare
 * `TransformedBy{identity}` of a builtin on a `derived` label entry. Only the
 * runtime writes a `derived` entry, and only a transaction under `identity`
 * mints that atom, so this tells a document the builtin wrote from one other
 * code wrote, whatever writer claim either stores.
 */
export const rootWrittenByBuiltin = (
  tx: IExtendedStorageTransaction,
  link: Pick<NormalizedFullLink, "space" | "id" | "scope">,
  identity: Extract<ImplementationIdentity, { kind: "builtin" }>,
): boolean => {
  const stamp = { type: CFC_ATOM_TYPE.TransformedBy, identity };
  return (readStoredCfcMetadata(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  })?.labelMap.entries ?? []).some((entry) =>
    entry.path.length === 0 && entry.origin === "derived" &&
    (entry.label.integrity ?? []).some((atom) => deepEqual(atom, stamp))
  );
};

/**
 * Whether `event` is a trusted gesture on the host surface whose
 * `provenance.ui.pattern` mark is `surface`: the test a host operation's
 * commit applies to the gesture that authorizes it.
 */
export const isTrustedGestureOn = (event: unknown, surface: string): boolean =>
  isTrustedGesture(event) && isObjectNotArray(event) &&
  isObjectNotArray(event.provenance) &&
  isObjectNotArray(event.provenance.ui) &&
  event.provenance.ui.pattern === surface;

/** The provenance a trusted gesture on a host surface carries. */
export type HostGestureProvenance = {
  /** Always `dom`, the one origin `isTrustedGesture()` admits. */
  origin: "dom";

  /** Always `true`: the event came from a trusted surface. */
  trusted: true;

  /** The host surface the gesture was made on. */
  ui: {
    /** The surface, which `isTrustedGestureOn()` compares to its own. */
    pattern: string;
  };
};

/**
 * Builds the provenance of a trusted gesture on the host surface `surface`,
 * which `isTrustedGestureOn()` accepts for that surface. It returns a fresh
 * object on each call. The event it goes on is accepted only once it also
 * carries the renderer-trust mark, which `markRendererTrustedEvent()` applies.
 */
export const hostGestureProvenance = (
  surface: string,
): HostGestureProvenance => ({
  origin: "dom",
  trusted: true,
  ui: { pattern: surface },
});

/**
 * Whether atom pattern `pattern` holds a `{ var }` placeholder anywhere, or a
 * record carrying a `var` key in any arrangement: whether any part of it is
 * left open rather than stated.
 */
export const containsAtomPatternVariable = (pattern: unknown): boolean =>
  Array.isArray(pattern)
    ? pattern.some(containsAtomPatternVariable)
    : isObjectNotArray(pattern) &&
      (Object.hasOwn(pattern, "var") ||
        Object.values(pattern).some(containsAtomPatternVariable));
