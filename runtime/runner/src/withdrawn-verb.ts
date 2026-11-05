/**
 * Whether a holder's slot names a verb its producer no longer publishes.
 *
 * A read mints a verb's handle from the schema that declares the position, and
 * a live verb stores nothing for that handle to find: its stream's document
 * holds no value. So a handle alone cannot tell a live verb from one whose
 * producer stopped publishing it. Two durable facts can, and this module reads
 * them. Each is a positive one: a location whose documents are not loaded
 * reads as neither, so an unloaded verb is still minted as a handle.
 *
 * A handler is registered in one of two places. A pattern's handler listens
 * at the root of its stream's own document. A builtin's handler listens at a
 * key of the builtin's own document, which carries no piece metadata. So:
 *
 * - A slot that resolves to an empty location inside a piece's result or
 *   argument document names no handler. The piece does not publish that
 *   field, or nobody wired that input.
 * - A slot that resolves to the root of an empty document whose owner no
 *   longer names it, in its manifest or as its argument, names a stream the
 *   owner's current pattern no longer has.
 *
 * Anything else is read as a live verb.
 */

import {
  areNormalizedLinksSame,
  type NormalizedFullLink,
} from "./link-types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import type { Runtime } from "./runtime.ts";
import type { Cell } from "./cell.ts";
import { resolveLink } from "./link-resolution.ts";
import { getMetaLink, parseLink } from "./link-utils.ts";
import { excludeReadFromConflict } from "./storage/reactivity-log.ts";
import { isObjectNotArray } from "@commonfabric/js-values/types";

/**
 * The meta reads below are ordinary reads, so a holder runs again when the
 * producer is re-seated, and they are excluded from conflict like the
 * resolution of any other reference a read mints a handle for.
 */
const TRACKED = {} as const;

/**
 * Whether the verb `slot` names is known to be gone: see the module comment
 * for the two facts that say so. `slot` is the holder's own position, before
 * any link stored there is followed.
 */
export function isWithdrawnVerb(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  slot: NormalizedFullLink,
): boolean {
  return tx.runWithAmbientReadMeta(excludeReadFromConflict, () => {
    const end = resolveLink(
      runtime,
      tx,
      { ...slot, schema: undefined },
      "value",
    );
    if (end.pendingHopDoc !== undefined) return false;
    if (tx.readValueOrThrow({ ...end, schema: undefined }) !== undefined) {
      return false;
    }
    const document = runtime.getCellFromLink(
      { ...end, path: [], schema: undefined },
      undefined,
      tx,
    );
    return end.path.length > 0
      ? isPieceDataDocument(runtime, tx, document)
      : isOrphanedDocument(runtime, tx, document);
  });
}

/** Whether `document` is a piece's result document or its argument document. */
function isPieceDataDocument(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  document: Cell<unknown>,
): boolean {
  if (document.getMetaRaw("argument", TRACKED) !== undefined) return true;
  const owner = ownerOf(runtime, tx, document);
  if (owner === undefined) return false;
  return namesDocument(getMetaLink(owner, "argument", TRACKED), document);
}

/**
 * Whether the empty document `document` is a derived document its owner no
 * longer names. An owner with no manifest is one this cannot judge.
 */
function isOrphanedDocument(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  document: Cell<unknown>,
): boolean {
  const owner = ownerOf(runtime, tx, document);
  if (owner === undefined) return false;
  const manifest = owner.getMetaRaw("internal", TRACKED);
  if (!Array.isArray(manifest)) return false;
  for (const entry of manifest) {
    if (!isObjectNotArray(entry)) continue;
    if (namesDocument(parseLink(entry.link, owner), document)) return false;
  }
  return !namesDocument(getMetaLink(owner, "argument", TRACKED), document);
}

/** The piece result document `document`'s `result` back-link names. */
function ownerOf(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  document: Cell<unknown>,
): Cell<unknown> | undefined {
  const ownerLink = getMetaLink(document, "result", TRACKED);
  if (ownerLink === undefined) return undefined;
  return runtime.getCellFromLink(
    { ...ownerLink, path: [], schema: undefined },
    undefined,
    tx,
  );
}

/** Whether `link` names `document`'s root, in the same scope. */
function namesDocument(
  link: NormalizedFullLink | undefined,
  document: Cell<unknown>,
): boolean {
  if (link === undefined) return false;
  return areNormalizedLinksSame(
    { ...link, path: [] },
    { ...document.getAsNormalizedFullLink(), path: [] },
  );
}
