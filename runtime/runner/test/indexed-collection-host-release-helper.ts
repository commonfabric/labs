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
 *   another while a cell of the host's runtime holds the first, the host's
 *   cells are collected, and a fourth topic is added. The report says
 *   whether the host's session watched the held topic once the fourth was
 *   maintained (`heldWatched`), and how many of the other two it watched
 *   (`releasedWatched`).
 * - `release-before-projection`: a topic is added and maintained, and then
 *   retitled. The drain that re-reads it is held once it has synced the
 *   topic and before it queues the transaction that projects it, while the
 *   host's cells are collected and a release pass runs. The report says
 *   whether the topic's document was still loaded in the host's runtime once
 *   the pass had run (`loadedThroughPass`), and the titles the collection
 *   holds once the host has settled (`titles`).
 */

import type { SqliteDbRef } from "@commonfabric/memory/v2";

import { indexedCollectionHostFixture } from "./indexed-collection-host-fixture.ts";

type Fixture = Awaited<ReturnType<typeof indexedCollectionHostFixture>>;

const scenario = Deno.args[0];
if (
  scenario !== "earlier-members" && scenario !== "release-before-projection"
) {
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

/**
 * Adds the topic `a`, and waits for the host to adopt the collection, bring
 * it up to its declaration, and re-read the topic. Returns the database.
 */
async function addFirstTopic(f: Fixture): Promise<SqliteDbRef> {
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
  return db;
}

/** Runs the `earlier-members` scenario, and returns its report. */
async function earlierMembers(f: Fixture) {
  await addFirstTopic(f);
  const runtime = f.host.runtime!;
  const held = runtime.getCell(f.space, "topic-a");
  await held.sync();
  for (const title of ["b", "c"]) {
    await f.addTopic(title);
    await runtime.settled();
  }

  await collect();
  await f.addTopic("d");
  await runtime.settled();
  const roots = new Set(f.hostWatchRoots());
  const heldWatched = roots.has(held.getAsNormalizedFullLink().id);
  const releasedWatched =
    ["b", "c"].filter((title) =>
      roots.has(f.topicCell(title).getAsNormalizedFullLink().id)
    ).length;
  return { heldWatched, releasedWatched };
}

/** Runs the `release-before-projection` scenario, and returns its report. */
async function releaseBeforeProjection(f: Fixture) {
  const db = await addFirstTopic(f);
  const runtime = f.host.runtime!;
  // The next maintenance event of the space waits for this turn, which says
  // when the event has begun to wait for it, and ends once the pass has run.
  const waiting = Promise.withResolvers<void>();
  const passed = Promise.withResolvers<void>();
  const turn: PromiseLike<void> = {
    then: (onFulfilled, onRejected) => {
      waiting.resolve();
      return passed.promise.then(onFulfilled, onRejected);
    },
  };
  runtime.indexedCollections.accessForTestingOnly.turns.set(
    f.space,
    turn as Promise<void>,
  );
  await f.retitleTopic("a", "renamed");
  await waiting.promise;

  await collect();
  await runtime.releaseUnreadDocuments();
  const id = f.topicCell("a").getAsNormalizedFullLink().id;
  const loadedThroughPass = runtime.storageManager.open(f.space).replica
    .hasLocalDocumentCoverage?.(id) === true;
  passed.resolve();
  await runtime.settled();
  const titles = (await f.select(db, "SELECT title FROM topics")).map((row) =>
    row.title
  );
  return { loadedThroughPass, titles };
}

const f = await indexedCollectionHostFixture();
try {
  const report = scenario === "earlier-members"
    ? await earlierMembers(f)
    : await releaseBeforeProjection(f);
  console.log(JSON.stringify(report));
} finally {
  await f.close();
}
