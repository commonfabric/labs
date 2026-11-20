/**
 * Helper for `v2-shared-values.test.ts`, run in a process of its own with
 * `--v8-flags=--expose-gc`. It decodes a document holding one stored subtree,
 * and prints, as JSON, how many decoded objects the table counts as live
 * while the document is held and once it is not, and how many decodes reading
 * it again costs.
 */

import { Database } from "@db/sqlite";

import { encodeMemoryBoundary } from "../v2.ts";
import { SharedValues } from "../v2/shared-values.ts";
import { VALUE_STORE_SCHEMA, ValueStore } from "../v2/value-store.ts";

const collectGarbage = (globalThis as { gc?: () => void }).gc;
if (collectGarbage === undefined) {
  throw new Error("run with --v8-flags=--expose-gc");
}

/**
 * Collects garbage. A `WeakRef` target reached in a turn survives that turn
 * whatever holds it, so this crosses one task boundary first.
 */
const collect = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  collectGarbage();
  collectGarbage();
};

const subtree = `{"k":"${"x".repeat(70)}","n":1}`;
const text = `fvj1:{"value":{"a":${subtree},"own":1}}`;

const database = new Database(":memory:");
database.exec(VALUE_STORE_SCHEMA);
const values = new ValueStore(database);
const shared = new SharedValues(values);
database.exec("BEGIN IMMEDIATE");
values.storeRowText(`fvj1:${subtree}`);
const vid = values.storeRowText(text) as number;
database.exec("COMMIT");

let held: unknown = shared.documentOf(vid);
const liveWhileHeld = shared.stats().live;
held = undefined;
await collect();
const liveOnceDropped = shared.stats().live;
const decodesBeforeReadingAgain = shared.stats().decodes;
held = shared.documentOf(vid);
console.log(JSON.stringify({
  liveWhileHeld,
  liveOnceDropped,
  decodesBeforeReadingAgain,
  decodesAfterReadingAgain: shared.stats().decodes,
  readAgainEqual: encodeMemoryBoundary(held as never) === text,
}));
values.close();
database.close();
