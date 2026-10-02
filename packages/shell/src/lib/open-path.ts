/**
 * The shell's `?path=` deep link, delivered into a piece that takes one.
 *
 * Opt-in by contract: a piece takes the link by exporting an `openPath`
 * stream on its result (Mobile Loom, for one, opens the given cabinet path in
 * its page viewer). A piece that exports none, or whose `openPath` is not a
 * stream, is not written to.
 */

import type { JSONSchema } from "@commonfabric/runner/shared";
import {
  type CellHandle,
  CellReadRefusedError,
} from "@commonfabric/runtime-client";

/**
 * The read that asks whether a piece exports an `openPath` stream: the
 * stream marker at that field and nothing else. A schema that read the field
 * as a stream would make a handle for it whether or not the piece held one,
 * so this reads only what is stored there, and the piece's other fields not
 * at all, which the display ceiling decides it on.
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
  let exported: { openPath?: { $stream?: boolean } } | undefined;
  try {
    exported = await cell.asSchema<{ openPath?: { $stream?: boolean } }>(
      OPEN_PATH_PRESENCE_SCHEMA,
    ).sync();
  } catch (error) {
    if (error instanceof CellReadRefusedError) return false;
    throw error;
  }
  if (exported?.openPath?.$stream !== true || !claim()) return false;
  await cell.asSchema<{ openPath: { path: string } }>({ type: "object" })
    .key("openPath").send({ path });
  return true;
}
