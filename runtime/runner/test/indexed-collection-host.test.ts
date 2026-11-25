/**
 * Runs a pattern that declares an indexed collection in a client with server
 * execution off that maintains no collection, beside an
 * `IndexedCollectionHost` on the same memory server: every row a re-read
 * writes is written by the host's runtime, and reaches the client's queries
 * through the database. The memory server enforces its access lists, and the
 * host's runtime reaches it over loopback sessions as a service principal,
 * as toolshed's does.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import {
  defineIndexedCollections,
  type IndexedCollectionOptions,
} from "../src/builtins/indexed-collection/definition.ts";
import { IndexedCollectionHost } from "../src/builtins/indexed-collection/host.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { LoopbackStorageManager } from "../src/executor/loopback-storage.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("indexed collection host");
const alice = await Identity.fromPassphrase("indexed collection host alice");

type Rows<Row> = { pending?: boolean; result?: Row[]; error?: unknown };
type Collection = { add(kind: string, member: unknown): void };
type Board = {
  titles: Rows<{ title: string }>;
  add: unknown;
  rename: unknown;
};

const SOURCE = `
import {
  handler,
  indexedCollections,
  type IndexedCollections,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

type TopicInput = { title: Writable<string> };
type TopicOutput = { title: string };

const Topic = pattern<TopicInput, TopicOutput>(({ title }) => ({ title }));

type State = {
  topics: IndexedCollections<{ topics: TopicOutput }>;
  byTitle: Writable<Record<string, TopicOutput>>;
};

const add = handler<{ title: string }, State>(({ title }, { topics, byTitle }) => {
  const topic = Topic({ title });
  topics.add("topics", topic);
  byTitle.key(title).set(topic);
});

const rename = handler<{ from: string; to: string }, State>(
  ({ from, to }, { byTitle }) => {
    byTitle.key(from).key("title").set(to);
  },
);

export default pattern<Record<string, never>, {
  titles: { pending: boolean; result?: { title: string }[] };
  add: Stream<{ title: string }>;
  rename: Stream<{ from: string; to: string }>;
}>(() => {
  const topics = indexedCollections<{ topics: TopicOutput }>({
    topics: { columns: { title: "text" } },
  });
  const byTitle = Writable.of<Record<string, TopicOutput>>({});
  const state = { topics, byTitle };
  return {
    titles: topics.query<{ title: string }>(
      "SELECT title FROM topics ORDER BY title",
    ),
    add: add(state),
    rename: rename(state),
  };
});
`;

async function fixture() {
  // A database outlives the server that wrote it, so each case gets a space,
  // and with it a database, of its own.
  const owner = await Identity.fromPassphrase(
    `indexed collection host space ${crypto.randomUUID()}`,
  );
  const space = owner.did() as MemorySpace;
  const server = new MemoryV2Server.Server({
    namesInstances: namesInstancesByDefault,
    store: new URL(`memory://indexed-collection-host-${crypto.randomUUID()}`),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: "did:key:z6Mk-runner-emulated-memory" },
    acl: { mode: "enforce", serviceDids: [service.did()] },
  });
  // The space is alice's, and names nobody else.
  Engine.applyCommit(await server.engineForSpace(space), {
    sessionId: "indexed-collection-host-genesis",
    space,
    principal: space,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}`,
        value: { value: { [alice.did()]: "OWNER" } },
      }],
    },
  });
  const errors: unknown[] = [];
  const manager = EmulatedStorageManager.connectTo(server, { as: alice });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
    experimental: { serverExecution: false },
    indexedCollectionMaintenance: "none",
  });
  runtime.scheduler.onError((error) => errors.push(error));
  // The host reads each registry through this, so a case can make one of
  // those reads fail.
  let failRegistryRead = false;
  const hostServer = {
    watchAdmittedCommits: server.watchAdmittedCommits.bind(server),
    readDocument: (...args: Parameters<typeof server.readDocument>) => {
      if (!failRegistryRead) return server.readDocument(...args);
      failRegistryRead = false;
      return Promise.reject(new Error("the store is unavailable"));
    },
  };
  const newHost = () =>
    new IndexedCollectionHost({
      server: hostServer,
      runtimeOptions: () => ({
        apiUrl: new URL(import.meta.url),
        storageManager: LoopbackStorageManager.connect(server, { as: service }),
        experimental: { serverExecution: false },
      }),
    });
  let host = newHost();
  /** Replaces the host with a new one, as a toolshed that restarts does. */
  async function restartHost() {
    await host.runtime?.settled();
    await host.close();
    host = newHost();
  }
  const cancels: Array<() => void> = [];
  async function close() {
    for (const cancel of cancels) cancel();
    // Maintenance can still be under way when a case's last wait returns.
    await host.runtime?.settled();
    await host.close();
    try {
      await runtime.dispose({ closeStorage: false });
    } finally {
      await manager.close();
    }
    await server.close();
  }
  /** Runs the pattern in the space, on cells named after `name`. */
  async function run(name = "indexed-collection-host") {
    const pattern = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: SOURCE }],
    }, { space });
    const argument = runtime.getCell(
      space,
      `${name}-input`,
      pattern.argumentSchema,
    );
    const result = runtime.getCell<Board>(
      space,
      `${name}-result`,
      pattern.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const start = runtime.edit();
    runtime.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancels.push(result.sink(() => {}));
    const titles = (expected: string[]) =>
      waitForCellValue<Rows<{ title: string }>>(
        runtime,
        (result as Cell<Board>).key("titles"),
        (state) =>
          state?.pending === false &&
          JSON.stringify(state.result?.map((row) => row.title)) ===
            JSON.stringify(expected),
      );
    return { result, titles };
  }
  /** Commits `fn` from the client. */
  async function commit(fn: (tx: IExtendedStorageTransaction) => void) {
    const tx = runtime.edit();
    fn(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
  }
  /**
   * Mints, or declares again, the handle of a collection of topics declared
   * by `options`, and returns its database.
   */
  async function declare(options: IndexedCollectionOptions) {
    const { tables, index } = defineIndexedCollections({ topics: options });
    let db: SqliteDbRef | undefined;
    await commit((tx) => {
      const handle = runtime.getCell(space, "collection", undefined, tx);
      db = {
        id: handle.getAsNormalizedFullLink().id.replace(/^of:/, ""),
        tables,
      };
      // A handle declared again keeps the write revision it had.
      const { rev } = (handle.getRaw() ?? {}) as { rev?: number };
      handle.setRawUntyped({ ...db, index, ...(rev !== undefined && { rev }) });
    });
    return db!;
  }
  /** Adds a topic titled `title` to the collection `declare()` minted. */
  function addTopic(title: string) {
    return commit((tx) => {
      const topic = runtime.getCell<{ title: string }>(
        space,
        `topic-${title}`,
        undefined,
        tx,
      );
      topic.set({ title });
      (createCell(
        runtime,
        runtime.getCell(space, "collection").getAsNormalizedFullLink(),
        tx,
        false,
        "sqlite",
      ) as unknown as Collection).add("topics", topic);
    });
  }
  /**
   * Returns the rows `sql` selects from `db` once `done` accepts them,
   * asking again after each commit the server admits to the space.
   */
  function stored(
    db: SqliteDbRef,
    sql: string,
    done: (rows: Record<string, unknown>[]) => boolean,
  ): Promise<Record<string, unknown>[]> {
    const { promise, resolve } = Promise.withResolvers<
      Record<string, unknown>[]
    >();
    let found = false;
    const ask = async () => {
      if (found) return;
      try {
        const { rows } = await manager.open(space).sqliteQuery!(db, sql);
        const selected = rows as Record<string, unknown>[];
        if (found || !done(selected)) return;
        found = true;
        unwatch();
        resolve(selected);
      } catch {
        // A column the declaration has just gained is not in the table
        // until the first write after the change, and naming it fails
        // until then.
      }
    };
    const unwatch = server.watchAdmittedCommits((notice) => {
      if (notice.space === space) void ask();
    });
    void ask();
    return promise;
  }
  return {
    space,
    runtime,
    get host() {
      return host;
    },
    errors,
    run,
    declare,
    addTopic,
    stored,
    restartHost,
    failNextRegistryRead: () => {
      failRegistryRead = true;
    },
    close,
  };
}

describe("indexed-collection-host", () => {
  it("fills the rows of members a client's handler creates and adds", async () => {
    // A member the handler creates is stored with its columns unset, and the
    // client maintains nothing, so a title in the listing was written by the
    // host's re-read.
    const f = await fixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      result.key("add").send({ title: "second" });

      await titles(["first", "second"]);
      expect(f.host.runtime).toBeDefined();
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("re-reads a member whose mirrored field a client writes later", async () => {
    const f = await fixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      await titles(["first"]);
      result.key("rename").send({ from: "first", to: "renamed" });

      await titles(["renamed"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("re-reads a member written after a restart, in a space whose registry predates the host", async () => {
    // The new host hears of no write to the registry, so it learns that the
    // space lists a collection by reading the registry document.
    const f = await fixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      await titles(["first"]);
      await f.restartHost();
      result.key("rename").send({ from: "first", to: "renamed" });

      await titles(["renamed"]);
      expect(f.host.runtime).toBeDefined();
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("re-reads a member written while a registry read failed, once a later read succeeds", async () => {
    // The restarted host has to read the registry to learn of the
    // collection, and the read for the rename's commit fails. Only the ids
    // that read held can bring the member to the next read.
    const f = await fixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      await titles(["first"]);
      await f.restartHost();
      f.failNextRegistryRead();
      result.key("rename").send({ from: "first", to: "renamed" });
      await f.runtime.idle();
      await f.runtime.storageManager.synced();
      await Promise.all(f.host.accessForTestingOnly.reads);
      // A write the member was not read from has the host read again.
      const plain = f.runtime.getCell<{ count: number }>(f.space, "plain");
      await plain.sync();
      const tx = f.runtime.edit();
      plain.withTx(tx).set({ count: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();

      await titles(["renamed"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("fills the rows of a collection listed after the host read the space's registry", async () => {
    // The first board's collection has the host read the registry, which
    // lists only that one; a later commit lists the second board's.
    const f = await fixture();
    try {
      const first = await f.run("first-board");
      first.result.key("add").send({ title: "first" });
      await first.titles(["first"]);
      const second = await f.run("second-board");
      second.result.key("add").send({ title: "other" });

      await second.titles(["other"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("fills a column that a declaration changed in place gains", async () => {
    // The host adopts the collection under its first declaration and goes
    // quiet, so the member is re-read only if the host checks the
    // declaration it holds: no write to the member follows.
    const f = await fixture();
    try {
      const db = await f.declare({ columns: { title: "text" } });
      await f.addTopic("a");
      await f.stored(
        db,
        "SELECT value FROM collection_meta WHERE key = 'declaration'",
        (rows) => rows.length === 1,
      );
      await f.host.runtime!.settled();
      const redeclared = await f.declare({
        columns: { title: "text", again: { type: "text", path: ["title"] } },
      });

      expect(
        await f.stored(
          redeclared,
          "SELECT again FROM topics",
          (rows) => rows[0]?.again === "a",
        ),
      ).toEqual([{ again: "a" }]);
    } finally {
      await f.close();
    }
  });

  it("builds no runtime for commits to a space that lists no collection", async () => {
    const f = await fixture();
    try {
      const cell = f.runtime.getCell<{ count: number }>(f.space, "plain");
      await cell.sync();
      const tx = f.runtime.edit();
      cell.withTx(tx).set({ count: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();
      await Promise.all(f.host.accessForTestingOnly.reads);

      expect(f.host.runtime).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});
