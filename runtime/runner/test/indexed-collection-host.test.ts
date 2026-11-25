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
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { IndexedCollectionHost } from "../src/builtins/indexed-collection/host.ts";
import type { Cell } from "../src/cell.ts";
import { LoopbackStorageManager } from "../src/executor/loopback-storage.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("indexed collection host");
const alice = await Identity.fromPassphrase("indexed collection host alice");

type Rows<Row> = { pending?: boolean; result?: Row[]; error?: unknown };
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
  const host = new IndexedCollectionHost({
    server,
    runtimeOptions: () => ({
      apiUrl: new URL(import.meta.url),
      storageManager: LoopbackStorageManager.connect(server, { as: service }),
      experimental: { serverExecution: false },
    }),
  });
  let cancel: (() => void) | undefined;
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
  async function run() {
    const pattern = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: SOURCE }],
    }, { space });
    const argument = runtime.getCell(
      space,
      "indexed-collection-host-input",
      pattern.argumentSchema,
    );
    const result = runtime.getCell<Board>(
      space,
      "indexed-collection-host-result",
      pattern.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const start = runtime.edit();
    runtime.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancel = result.sink(() => {});
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
  return { space, runtime, host, errors, run, close };
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
