/**
 * Runs a pattern that declares an indexed collection under a service
 * execution host, with clients that execute nothing they store: every row is
 * written by the serving runtime, and every query result reaches a client by
 * replication.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

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
  indexedCollection,
  type IndexedCollection,
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
  topics: IndexedCollection<TopicOutput>;
  byTitle: Writable<Record<string, TopicOutput>>;
};

const add = handler<{ title: string }, State>(({ title }, { topics, byTitle }) => {
  const topic = Topic({ title, mentions: [] });
  topics.add(topic);
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
  const topics = indexedCollection<TopicOutput>({
    columns: { title: "text" },
    relations: ["mentions"],
  });
  const byTitle = Writable.of<Record<string, TopicOutput>>({});
  const state = { topics, byTitle };
  return {
    titles: topics.query<{ title: string }>(
      "SELECT title FROM members ORDER BY title",
    ),
    mentioningFirst: topics.query<{ title: string }>(
      "SELECT m.title AS title FROM mentions e JOIN members m " +
        "ON m.member_cf_link = e.source_cf_link WHERE e.target_cf_link = " +
        "(SELECT member_cf_link FROM members WHERE title = 'first') " +
        "ORDER BY m.title",
    ),
    add: add(state),
    rename: rename(state),
    mention: mention(state),
  };
});
`;

async function fixture() {
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
