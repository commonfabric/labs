/**
 * Helper for `indexed-collection-host.test.ts`. Runs in its own process so
 * that it can force a collection (`--v8-flags=--expose-gc`) and cross a real
 * task boundary, which a `WeakRef` needs before it can report its target
 * collected; the package's fake-clock preload would freeze that boundary. A
 * cell holds its document until it is collected
 * (`IStorageManager.holdDocument()`), so what the host's runtime releases of
 * the members it re-read shows only once the cells it read them through have
 * gone.
 *
 * It runs `indexed-collection-host-fixture.ts` and prints one line of JSON.
 * The first argument names the scenario:
 *
 * - `earlier-members`: three topics are added and maintained one after
 *   another, the host's cells are collected, and a fourth is added. The
 *   report says how many of the first three the host's session watched
 *   before the collection (`watchedBefore`) and after the fourth was
 *   maintained (`watchedAfter`).
 */

import { indexedCollectionHostFixture } from "./indexed-collection-host-fixture.ts";

const scenario = Deno.args[0];
if (scenario !== "earlier-members") {
  throw new Error(`Unknown scenario: \`${scenario}\``);
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

/** Collects what nothing reaches any more. */
async function collect(): Promise<void> {
  // A `WeakRef` target reached in a turn survives that turn whatever holds
  // it, so cross one task boundary before collecting. This is an event-loop
  // yield, not a wait.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc!();
  gc!();
}

const f = await indexedCollectionHostFixture();
try {
  const db = await f.declare({ columns: { title: "text" } });
  // The first topic lists the collection, which the host adopts and brings
  // up to its declaration before it re-reads anything; the declaration is
  // recorded last.
  await f.addTopic("a");
  await f.stored(
    db,
    "SELECT value FROM collection_meta WHERE key = 'declaration'",
    (rows) => rows.length === 1,
  );
  await f.host.runtime!.settled();
  for (const title of ["b", "c"]) {
    await f.addTopic(title);
    await f.host.runtime!.settled();
  }
  const earlier = ["a", "b", "c"].map((title) =>
    f.topicCell(title).getAsNormalizedFullLink().id
  );
  const watched = () => {
    const roots = new Set(f.hostWatchRoots());
    return earlier.filter((id) => roots.has(id)).length;
  };
  const watchedBefore = watched();

  await collect();
  await f.addTopic("d");
  await f.host.runtime!.settled();
  const watchedAfter = watched();

  console.log(JSON.stringify({ watchedBefore, watchedAfter }));
} finally {
  await f.close();
}
