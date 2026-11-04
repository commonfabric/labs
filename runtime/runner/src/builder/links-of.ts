/**
 * `linksOf()`, which pattern code calls to read a list of links as the cells
 * they name, rather than as the values those cells hold.
 */

import { internSchema } from "@commonfabric/data-model-schema";

import type { Cell } from "../cell.ts";
import { withdrawHandlerWhileLoading } from "../scheduler/handler-load-wait.ts";
import { topFrame } from "./frame-context.ts";
import { cellOfTarget } from "./space-access.ts";

/** A list whose elements are read as the cells their links name. */
const linkListSchema = internSchema({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
});

/**
 * Returns the elements of the list `target` holds as the cells their links
 * name, reading the list's own document and none of the documents its links
 * name, so that a list linking documents not yet loaded, or ones this runtime
 * cannot read, still reads as the links it holds. An element that holds a
 * value rather than a link reads as a cell at that element. A `target` that
 * holds no list reads as none, and a `target` passed as `undefined` as
 * `undefined`. In a handler, a list still loading withdraws the handler,
 * which runs again once it arrives.
 *
 * @throws If called outside a handler or a reactive computation, with a
 *   `target` that is neither a cell nor `undefined`, or when reading the list
 *   fails.
 */
export function linksOf<T>(target: unknown): Cell<T>[] | undefined {
  const name = "linksOf(target)";
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
  const list = cellOfTarget(target, name).withTx(tx);
  if (frame.frameKind === "handler") {
    const link = list.resolveAsCell().getAsNormalizedFullLink();
    withdrawHandlerWhileLoading(
      runtime,
      tx,
      { ...link, path: [] },
      `the list \`${link.id}\` was read while it was still loading`,
    );
  }
  const links = list.asSchema<Cell<T>[] | undefined>(linkListSchema).get();
  return Array.isArray(links) ? links : [];
}
