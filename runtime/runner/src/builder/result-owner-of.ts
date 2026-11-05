/**
 * `resultOwnerOf()`, which pattern code calls to ask which pattern result a
 * cell belongs to, so that a handler can tell the cells one pattern bound it
 * from cells that only look like them.
 */

import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { getMetaLink } from "../link-utils.ts";
import { withdrawHandlerWhileLoading } from "../scheduler/handler-load-wait.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { topFrame } from "./frame-context.ts";
import { cellOfTarget } from "./space-access.ts";

/**
 * Returns the address, as `<space>/<id>`, of the pattern result the document
 * a write to `target` lands in belongs to, its redirects followed and a link
 * it holds as its value not: the result whose argument or derived
 * internal cell the document is, as the `result` back-link setup writes onto
 * those documents names it, which no pattern can write. With `field`, only
 * when that result's own `field` is that document too, the place its writes
 * land, so a cell of the result's bound in another field's place names none.
 * Returns `undefined` for a document with no such back-link, for one that is
 * not the result's `field`, and for a `target` passed as `undefined`. Two
 * cells one pattern instance owns, such as two of its
 * `new Writable(...).for(...)` cells, return the same address, and a cell of
 * another instance, or another pattern, returns another. Every read is one a
 * reactive computation reruns on. In a handler, a document still loading
 * withdraws the handler, which runs again once it arrives.
 *
 * @throws If called outside a handler or a reactive computation, or with a
 *   `target` that is neither a cell nor `undefined`.
 */
export function resultOwnerOf(
  target: unknown,
  field?: string,
): string | undefined {
  const name = "resultOwnerOf(target)";
  const frame = topFrame();
  if (frame?.frameKind !== "lift" && frame?.frameKind !== "handler") {
    throw new Error(
      `\`${name}\` can only be called from a handler or a reactive computation.`,
    );
  }
  const { runtime, tx } = frame;
  if (runtime === undefined || tx === undefined) {
    throw new Error(`\`${name}\` requires an executing runtime.`);
  }
  if (target === undefined) return undefined;
  const readTx = runtime.readTx(tx);
  const wait = (document: NormalizedFullLink) => {
    if (frame.frameKind !== "handler") return;
    withdrawHandlerWhileLoading(
      runtime,
      tx,
      { ...document, path: [] },
      `the document \`${document.id}\` was read while it was still loading`,
    );
  };
  // A write to the cell lands where its redirects lead, and a link it holds
  // as its value is not followed, so the document is the one the cell is.
  const link = resolveLink(
    runtime,
    readTx,
    cellOfTarget(target, name).withTx(tx).getAsNormalizedFullLink(),
    "writeRedirect",
  );
  wait(link);
  const owner = getMetaLink(
    runtime.getCellFromLink({ ...link, path: [] }, undefined, tx),
    "result",
    { meta: internalVerifierRead },
  );
  if (owner === undefined) return undefined;
  if (field !== undefined) {
    wait(owner);
    const lands = resolveLink(
      runtime,
      readTx,
      { ...owner, path: [field] },
      "writeRedirect",
    );
    if (
      lands.space !== link.space || lands.id !== link.id ||
      lands.path.join("/") !== link.path.join("/")
    ) return undefined;
  }
  return `${owner.space}/${owner.id}`;
}
