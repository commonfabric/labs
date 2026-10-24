/**
 * Retained heap for changing immutable values with and without retained IDs.
 * Run with `deno run -A --v8-flags=--expose-gc
 * packages/runner/test/immutable-cell-retention.ts`.
 */
import { yieldToEventLoop } from "@commonfabric/utils/sleep";
import { deepFreeze } from "@commonfabric/data-model";
import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { ImmutableCellStore } from "../src/immutable-cell.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Run with --v8-flags=--expose-gc");

async function heap(): Promise<number> {
  // WeakRef targets remain live until the job that created them has ended.
  await yieldToEventLoop();
  gc!();
  await yieldToEventLoop();
  gc!();
  return Deno.memoryUsage().heapUsed;
}

// Warm the canonical string/hash caches before measuring retained graphs.
const warmup = new ImmutableCellStore();
for (let version = 0; version < 100; version++) {
  const value = deepFreeze({
    version,
    rows: Array.from({ length: 1000 }, (_, index) => ({
      index,
      text: `version ${version} row ${index}: ${"x".repeat(256)}`,
    })),
  });
  dataUriFromValue(value);
  warmup.create(value);
}
warmup.dispose();
await heap();

const results = [];
for (const retainIds of [false, true]) {
  for (const mode of ["legacy", "explicit", "element"]) {
    const store = new ImmutableCellStore();
    const ids: string[] = [];
    const before = await heap();
    for (let version = 0; version < 100; version++) {
      const value = deepFreeze({
        version,
        rows: Array.from({ length: 1000 }, (_, index) => ({
          index,
          text: `version ${version} row ${index}: ${"x".repeat(256)}`,
        })),
      });
      const id = mode === "legacy"
        ? dataUriFromValue(value)
        : mode === "element"
        ? store.createElement(value, { id: "of:retention", path: [] }).id
        : store.create(value).id;
      if (retainIds) ids.push(id);
    }
    const after = await heap();
    const idChars = ids.reduce((total, id) => total + id.length, 0);
    store.dispose();
    ids.length = 0;
    const disposed = await heap();
    results.push({
      mode,
      retainIds,
      versions: 100,
      rows: 1000,
      before,
      after,
      disposed,
      retainedBytes: after - before,
      releasedBytes: after - disposed,
      idChars,
    });
  }
}
console.log(JSON.stringify({ runtime: Deno.version, results }, null, 2));
