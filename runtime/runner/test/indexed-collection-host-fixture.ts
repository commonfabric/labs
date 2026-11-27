/**
 * A memory server holding one space, a client of it with server execution off
 * that maintains no collection, and an `IndexedCollectionHost` beside them, as
 * toolshed runs one: every row a re-read writes is written by the host's
 * runtime, and reaches the client's queries through the database. The memory
 * server enforces its access lists, and the host's runtime reaches it over
 * loopback sessions as a service principal, as toolshed's does.
 *
 * `indexed-collection-host.test.ts` runs its cases on this, and so does
 * `indexed-collection-host-release-helper.ts`, which forces collections in a
 * process of its own.
 */

import { expect } from "@std/expect";

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

/** Builds the server, the client and the host, in a space of its own. */
export async function indexedCollectionHostFixture() {
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
  /** Returns the cell of the topic titled `title` that `addTopic()` adds. */
  function topicCell(title: string, tx?: IExtendedStorageTransaction) {
    return runtime.getCell<{ title: string }>(
      space,
      `topic-${title}`,
      undefined,
      tx,
    );
  }
  /** Adds a topic titled `title` to the collection `declare()` minted. */
  function addTopic(title: string) {
    return commit((tx) => {
      const topic = topicCell(title, tx);
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
  /** Returns the rows `sql` selects from `db` now. */
  async function select(
    db: SqliteDbRef,
    sql: string,
  ): Promise<Record<string, unknown>[]> {
    const { rows } = await manager.open(space).sqliteQuery!(db, sql);
    return rows as Record<string, unknown>[];
  }
  /**
   * Returns the ids of the documents the host's sessions on the memory
   * server watch, one for each root of each watch.
   */
  function hostWatchRoots(): string[] {
    return server.accessForTestingOnly.sessionsForSpace(space)
      .filter((session) => session.principal === service.did())
      .flatMap((session) => session.watches)
      .flatMap((watch) =>
        watch.kind === "operation"
          ? []
          : watch.query.roots.map((root) => root.id)
      );
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
    topicCell,
    addTopic,
    stored,
    select,
    hostWatchRoots,
    restartHost,
    failNextRegistryRead: () => {
      failRegistryRead = true;
    },
    close,
  };
}
