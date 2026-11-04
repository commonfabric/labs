/**
 * Helper for `piece-get-transform.test.ts`. Runs in its own process so that it
 * can force a collection (`--v8-flags=--expose-gc`): a release pass keeps a
 * document while a cell that loaded it is reachable, and only a collection
 * ends that.
 *
 * It reads a selection, lets the cells of that read be collected, runs release
 * passes, and reads the same selection again. It prints one line of JSON:
 * `dropped`, whether the passes dropped any document, and `repeat`, the value
 * the second read returned or the message of the error it threw.
 */

import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  deriveSelectedValue,
  parseSelectionProjection,
} from "../lib/cell-selection.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const signer = await Identity.fromPassphrase("cf-piece-get-transform-gc");
const space = signer.did();
const itemsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { id: { type: "number" }, title: { type: "string" } },
  },
} as const satisfies JSONSchema;

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
});

try {
  const tx = runtime.edit();
  const source = runtime.getCell(space, "released-source", itemsSchema, tx);
  source.set([{ id: 1, title: "First" }]);
  const committed = await tx.commit().settled;
  if (committed.error) throw committed.error;

  const read = async () =>
    await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection("id"),
    });

  await read();
  const dropsBefore = storageManager.droppedDocuments();
  // A `WeakRef` target reached in a turn survives that turn whatever holds
  // it, so cross a task boundary before collecting. This is an event-loop
  // yield, not a wait. A pass keeps what was read since the pass before it,
  // so the second pass is the one that drops the first read's documents.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  gc();
  await runtime.releaseUnreadDocuments();
  await runtime.releaseUnreadDocuments();
  const dropped = storageManager.droppedDocuments() > dropsBefore;

  const repeat = await read().catch((error: Error) => error.message);
  console.log(JSON.stringify({ dropped, repeat }));
} finally {
  await runtime.dispose();
  await storageManager.close();
}
