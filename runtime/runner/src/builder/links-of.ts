/**
 * `linksOf()`, which pattern code calls to read a list of links as the cells
 * they name, rather than as the values those cells hold.
 */

import { internSchema } from "@commonfabric/data-model-schema";

import type { Cell } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { isPrimitiveCellLink, parseLink } from "../link-utils.ts";
import { withdrawHandlerWhileLoading } from "../scheduler/handler-load-wait.ts";
import { topFrame } from "./frame-context.ts";
import { cellOfTarget } from "./space-access.ts";
import type { JSONSchema } from "./types.ts";

/**
 * A list whose elements are read as the cells their links name. Typing the
 * elements `unknown` is what keeps the read to the list's own document: a
 * handle minted under a reader with no shape of its own adopts the link's
 * schema and follows a link stored at the target, which reads the target.
 */
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
 * Each cell carries the schema its link stores, and a cell at an element
 * holding a value carries none, so a read through a cell reads the value it
 * names and a cell written into another list stores the link this list
 * holds. The `unknown` the list is read under stays off the cells: written
 * as a link, it would declare the target opaque, and a read that decides by
 * the link's own schema, as a conditional does, would find a reference where
 * the value is (`docs/specs/link-schema-precedence.md`, "The read entry").
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
  const resolved = list.resolveAsCell();
  if (frame.frameKind === "handler") {
    const link = resolved.getAsNormalizedFullLink();
    withdrawHandlerWhileLoading(
      runtime,
      tx,
      { ...link, path: [] },
      `the list \`${link.id}\` was read while it was still loading`,
    );
  }
  const links: readonly Cell<T>[] | undefined = list.asSchema<
    Cell<T>[] | undefined
  >(linkListSchema).get();
  if (!Array.isArray(links)) return [];
  // The slots are read where the traversal read them, so this reads no
  // document it did not.
  const slots = resolved.getRaw();
  const base = resolved.getAsNormalizedFullLink();
  return links.map((cell: Cell<T>, index: number) =>
    cell.asSchema<T>(
      storedSchemaAt(Array.isArray(slots) ? slots[index] : undefined, base),
    )
  );
}

/**
 * The schema the link in `slot` stores, or `undefined` where `slot` holds a
 * value or a link that stores none. `base` is the list the slot is in, which
 * a link relative to it is read against.
 */
function storedSchemaAt(
  slot: unknown,
  base: NormalizedFullLink,
): JSONSchema | undefined {
  return isPrimitiveCellLink(slot) ? parseLink(slot, base).schema : undefined;
}
