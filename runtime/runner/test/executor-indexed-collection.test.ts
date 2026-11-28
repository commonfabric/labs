/**
 * Runs a pattern that declares an indexed collection under a service
 * execution host, with clients that execute nothing they store: every row is
 * written by the serving runtime, and every query result reaches a client by
 * replication.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { describe, it } from "@commonfabric/test-support/test";
import { useRealClock } from "@commonfabric/test-support/fake-clock";

import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// This file runs on the real clock because it drives a live ExecutorHost whose
// consequence-flush deadline and idle park are real-time policies; auto-advance
// would fire those timers as fast as they arm, which changes what the test
// observes rather than speeding it up.
useRealClock();

const service = await Identity.fromPassphrase("indexed collection service");
const alice = await Identity.fromPassphrase("indexed collection alice");

type Rows<Row> = { pending?: boolean; result?: Row[]; error?: unknown };
type Board = {
  titles: Rows<{ title: string }>;
  mentioningFirst: Rows<{ title: string }>;
  add: unknown;
  rename: unknown;
  mention: unknown;
};

const SOURCE = `
import {
  type Cell,
  type Default,
  handler,
  indexedCollections,
  type IndexedCollections,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

type TopicInput = {
  title: Writable<string>;
  mentions: Writable<Default<unknown[], []>>;
};
type TopicOutput = { title: string; mentions: unknown[] };

const Topic = pattern<TopicInput, TopicOutput>(({ title, mentions }) => ({
  title,
  mentions,
}));

type State = {
  topics: IndexedCollections<{ topics: TopicOutput }>;
  byTitle: Writable<Record<string, TopicOutput>>;
};

const add = handler<{ title: string }, State>(({ title }, { topics, byTitle }) => {
  const topic = Topic({ title, mentions: [] });
  topics.add("topics", topic);
  byTitle.key(title).set(topic);
});

const rename = handler<{ from: string; to: string }, State>(
  ({ from, to }, { byTitle }) => {
    byTitle.key(from).key("title").set(to);
  },
);

const mention = handler<{ from: string; to: string }, State>(
  ({ from, to }, { byTitle }) => {
    byTitle.key(from).key("mentions").push(byTitle.key(to));
  },
);

type Titles = { pending: boolean; result?: { title: string }[] };

export default pattern<Record<string, never>, {
  titles: Titles;
  mentioningFirst: Titles;
  add: Stream<{ title: string }>;
  rename: Stream<{ from: string; to: string }>;
  mention: Stream<{ from: string; to: string }>;
}>(() => {
  const topics = indexedCollections<{ topics: TopicOutput }>({
    topics: { columns: { title: "text" }, relations: ["mentions"] },
  });
  const byTitle = Writable.of<Record<string, TopicOutput>>({});
  const state = { topics, byTitle };
  return {
    titles: topics.query<{ title: string }>(
      "SELECT title FROM topics ORDER BY title",
    ),
    mentioningFirst: topics.query<{ title: string }>(
      "SELECT m.title AS title FROM topics_mentions e JOIN topics m " +
        "ON m.member_cf_link = e.source_cf_link WHERE e.target_cf_link = " +
        "(SELECT member_cf_link FROM topics WHERE title = 'first') " +
        "ORDER BY m.title",
    ),
    add: add(state),
    rename: rename(state),
    mention: mention(state),
  };
});
`;

/**
 * What a case hears of the serving runtime's queries: `before` is awaited
 * ahead of each one, and `after` is called once it has returned.
 */
type QueryHooks = {
  before?: (sql: string) => Promise<void> | void;
  after?: (sql: string) => void;
};

async function fixture(hooks: QueryHooks = {}) {
  // A database outlives the server that wrote it, so each case gets a space,
  // and with it a database, of its own.
  const owner = await Identity.fromPassphrase(
    `indexed collection space ${crypto.randomUUID()}`,
  );
  const space = owner.did() as MemorySpace;
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const errors: unknown[] = [];
  const manager = EmulatedStorageManager.connectTo(server, { as: alice });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
    experimental: { serverExecution: true },
  });
  let cancel: (() => void) | undefined;
  const host = new ExecutorHost({
    server,
    serviceIdentity: service.did(),
    // The host factory contract returns a promise.
    // deno-lint-ignore require-await
    createRuntime: async () => {
      const serving = EmulatedStorageManager.connectTo(server, { as: service });
      const provider = serving.open(space);
      const query = provider.sqliteQuery!.bind(provider);
      provider.sqliteQuery = async (handle, sql, ...rest) => {
        await hooks.before?.(sql);
        const reply = await query(handle, sql, ...rest);
        hooks.after?.(sql);
        return reply;
      };
      const servingRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: serving,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      servingRuntime.scheduler.onError((error) => errors.push(error));
      return {
        runtime: servingRuntime,
        dispose: async () => {
          try {
            await servingRuntime.dispose();
          } catch (error) {
            await serving.close();
            throw error;
          }
        },
      };
    },
    policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
  });
  async function close() {
    cancel?.();
    await host.close();
    try {
      await runtime.dispose({ closeStorage: false });
    } finally {
      await manager.close();
    }
    await server.close();
  }
  try {
    const pattern = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: SOURCE }],
    }, { space });
    const argument = runtime.getCell(
      space,
      "indexed-collection-input",
      pattern.argumentSchema,
    );
    const result = runtime.getCell<Board>(
      space,
      "indexed-collection-result",
      pattern.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const start = runtime.edit();
    runtime.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancel = result.sink(() => {});
    const titles = (
      key: "titles" | "mentioningFirst",
      expected: string[],
    ) =>
      waitForCellValue<Rows<{ title: string }>>(
        runtime,
        (result as Cell<Board>).key(key),
        (state) =>
          state?.pending === false &&
          JSON.stringify(state.result?.map((row) => row.title)) ===
            JSON.stringify(expected),
      );
    return { result, errors, titles, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("executor-indexed-collection", () => {
  it("serves a query over members added by a handler", async () => {
    const f = await fixture();
    try {
      f.result.key("add").send({ title: "first" });
      f.result.key("add").send({ title: "second" });

      await f.titles("titles", ["first", "second"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("re-reads a member whose mirrored field a later handler writes", async () => {
    const f = await fixture();
    try {
      f.result.key("add").send({ title: "first" });
      await f.titles("titles", ["first"]);
      f.result.key("rename").send({ from: "first", to: "renamed" });

      await f.titles("titles", ["renamed"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("leaves a query result unwritten when a collection write keeps its rows", async () => {
    // The re-run of the query whose rows stay the same has to be seen to
    // finish, or its result would be unwritten only because it had not been
    // written yet.
    const rerun = Promise.withResolvers<void>();
    let watching = false;
    const f = await fixture({
      after: (sql) => {
        if (
          watching &&
          sql.startsWith("SELECT m.title AS title FROM topics_mentions")
        ) {
          rerun.resolve();
        }
      },
    });
    try {
      f.result.key("add").send({ title: "first" });
      f.result.key("add").send({ title: "second" });
      f.result.key("add").send({ title: "other" });
      f.result.key("mention").send({ from: "second", to: "first" });
      await f.titles("mentioningFirst", ["second"]);
      const seen: string[] = [];
      const cancel = f.result.key("mentioningFirst").sink((state) => {
        seen.push(JSON.stringify(state));
      });
      const settledBefore = seen.length;
      watching = true;

      // Renaming an uninvolved member rewrites its row, and so re-runs both
      // queries, while the rows of the second stay what they were.
      f.result.key("rename").send({ from: "other", to: "renamed" });
      await rerun.promise;
      await f.titles("titles", ["first", "renamed", "second"]);

      expect(seen.slice(settledBefore)).toEqual([]);
      cancel();
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("serves the rows of the last of two writes made while a re-run was in flight", async () => {
    // The listing's re-run after the first rename is held at the database,
    // and the second rename is carried into the collection behind it. The
    // other query is not held, so its second re-run returning says the
    // second rename has reached the database.
    const TITLES = "SELECT title FROM topics";
    const MENTIONING = "SELECT m.title AS title FROM topics_mentions";
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reruns = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let armed = false;
    let seen = 0;
    const f = await fixture({
      before: async (sql) => {
        if (armed && sql.startsWith(TITLES)) {
          armed = false;
          held.resolve();
          await release.promise;
        }
      },
      after: (sql) => {
        if (sql.startsWith(MENTIONING)) reruns[seen++]?.resolve();
      },
    });
    try {
      f.result.key("add").send({ title: "first" });
      await f.titles("titles", ["first"]);
      await f.titles("mentioningFirst", []);
      seen = 0;
      armed = true;

      f.result.key("rename").send({ from: "first", to: "once" });
      await held.promise;
      await reruns[0].promise;
      f.result.key("rename").send({ from: "first", to: "twice" });
      await reruns[1].promise;
      release.resolve();

      await f.titles("titles", ["twice"]);
      expect(f.errors).toEqual([]);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("serves the members referring to a member", async () => {
    const f = await fixture();
    try {
      f.result.key("add").send({ title: "first" });
      f.result.key("add").send({ title: "second" });
      f.result.key("add").send({ title: "third" });
      await f.titles("titles", ["first", "second", "third"]);
      f.result.key("mention").send({ from: "second", to: "first" });
      f.result.key("mention").send({ from: "third", to: "first" });

      await f.titles("mentioningFirst", ["second", "third"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
