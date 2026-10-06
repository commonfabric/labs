/**
 * The shell's `?path=` deep link, delivered into a piece that takes one.
 *
 * Opt-in by contract: a piece takes the link by exporting an `openPath`
 * stream on its result (Mobile Loom, for one, opens the given cabinet path in
 * its page viewer). A piece that exports none, or whose `openPath` is not a
 * stream, is not written to.
 */

import type { JSONSchema } from "@commonfabric/runner/shared";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  type CellHandle,
  CellReadRefusedError,
  isCellHandle,
} from "@commonfabric/runtime-client";

/**
 * The read that asks whether a piece exports an `openPath` stream: what is
 * stored at that field and nothing else, which the display ceiling decides
 * it on. A handler's stream is stored there as a link whose schema declares
 * the stream, and so comes back as a handle: this schema declares no handle
 * of its own, so a link to anything else is followed and comes back as the
 * value it leads to. A piece from before streams were declared by schema
 * holds the `$stream` marker there instead. The field is not read as a
 * stream: a schema that declared one would make a handle for it whether or
 * not the piece held one.
 */
const OPEN_PATH_PRESENCE_SCHEMA = {
  type: "object",
  properties: {
    openPath: {
      type: "object",
      properties: { $stream: { type: "boolean" } },
    },
  },
} as const satisfies JSONSchema;

/**
 * Sends `path` to the `openPath` stream of the piece `cell` holds, if it
 * exports one, and says whether it sent it. A piece that exports none, whose
 * `openPath` is not a stream, or whose field the worker will not show the
 * host, is left untouched. `claim` is asked once the answer is in, just
 * before the send, whether to send still: a caller that delivers once, or
 * only while the piece is showing, says so there.
 */
export async function deliverOpenPath<T>(
  cell: CellHandle<T>,
  path: string,
  claim: () => boolean,
): Promise<boolean> {
  let exported: { openPath?: unknown } | undefined;
  try {
    exported = await cell.asSchema<{ openPath?: unknown }>(
      OPEN_PATH_PRESENCE_SCHEMA,
    ).sync();
  } catch (error) {
    if (error instanceof CellReadRefusedError) return false;
    throw error;
  }
  const field = exported?.openPath;
  const stream = isCellHandle(field) ||
    (isObjectNotArray(field) && field.$stream === true);
  if (!stream || !claim()) return false;
  await cell.asSchema<{ openPath: { path: string } }>({ type: "object" })
    .key("openPath").send({ path });
  return true;
}
