/**
 * A host's questions about what a piece exports beside its UI: whether it
 * takes an `openPath` deep link, and whether it shows a sidebar.
 *
 * Each is asked of the one field it is about. The worker decides a host's
 * read on everything the read takes in (CFC §8.10.6), so a question asked by
 * reading the whole piece is refused wherever anything the piece holds is,
 * the owner's own credentials included, and the answer would be lost with
 * it. A read of one field's shape, addressed at the field, takes in that
 * field alone and is decided on it.
 */

import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import type { JSONSchema } from "@commonfabric/runner/shared";

import { type CellHandle, CellReadRefusedError } from "./cell-handle.ts";
import type { VNode } from "./vnode-types.ts";

/**
 * The read that asks whether a field holds anything: the field, read as an
 * object with no properties, so that nothing it holds is read. A link the
 * field holds is followed, under the schema the link carries when it carries
 * one, as a handler stream's link does, which reads as the stream's handle.
 */
export const FIELD_SHAPE_SCHEMA = {
  type: "object",
  properties: {},
} as const satisfies JSONSchema;

/**
 * Whether `cell` holds anything at `field`, or `false` when the worker
 * refuses even that read: a field the display ceiling keeps from the host is,
 * to the host, a field it cannot use.
 *
 * The read is addressed at the field rather than made from `cell` with a
 * schema naming the field. A read is decided on the labels of the cell it
 * starts from as well as on what it consumes, and a cell's labels cover
 * everything inside it, so a read starting from `cell` would be refused for
 * whatever sits beside the field in the same document.
 */
async function holdsAt<T>(
  cell: CellHandle<T>,
  field: string,
): Promise<boolean> {
  try {
    const shape = await cell.asSchema<Record<string, unknown>>({
      type: "object",
    }).key(field).asSchema(FIELD_SHAPE_SCHEMA).sync();
    return shape !== undefined;
  } catch (error) {
    if (error instanceof CellReadRefusedError) return false;
    throw error;
  }
}

/**
 * Sends `path` to the `openPath` stream of the piece `cell` holds, if it
 * exports one, and says whether it sent it. A piece that exports none, or
 * whose stream the worker will not show the host, is left untouched.
 * `claim` is asked once the answer is in, just before the send, whether to
 * send still: a caller that delivers once, or only while the piece is
 * showing, says so there.
 */
export async function deliverOpenPath<T>(
  cell: CellHandle<T>,
  path: string,
  claim: () => boolean = () => true,
): Promise<boolean> {
  if (!await holdsAt(cell, "openPath") || !claim()) return false;
  await cell.asSchema<{ openPath: { path: string } }>({ type: "object" })
    .key("openPath").send({ path });
  return true;
}

/**
 * The handle a sidebar is rendered from, when the piece `cell` holds shows
 * one: its `sidebarUI`, read as a render tree. `undefined` when it shows none,
 * or when the worker will not show the host that it does.
 */
export async function sidebarOf<T>(
  cell: CellHandle<T>,
): Promise<CellHandle<VNode> | undefined> {
  if (!await holdsAt(cell, "sidebarUI")) return undefined;
  return cell.asSchema<{ sidebarUI: VNode }>({ type: "object" })
    .key("sidebarUI").asSchema<VNode>(rendererVDOMSchema);
}
