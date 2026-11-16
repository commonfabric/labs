import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { defer } from "@commonfabric/async/defer";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import { fromFileUrl } from "@std/path";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import type { Action } from "../src/scheduler/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-document-release");
const space: MemorySpace = signer.did();

const counterSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const satisfies JSONSchema;

const parentSchema = {
  type: "object",
  properties: { child: counterSchema },
} as const satisfies JSONSchema;

describe("document-release", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
  });

  afterEach(async () => {
    await writer?.dispose();
    await reader?.dispose();
    await writerStorage?.close();
    await readerStorage?.close();
    await server?.close();
  });

  /** Writes `{ n }` to the counter document named `cause`. */
  const write = async (cause: string, n: number) => {
    const tx = writer.edit();
    writer.getCell(space, cause, counterSchema, tx).set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    await delivered();
  };

  /** Waits for the server to deliver what the writer committed. */
  const delivered = async () => {
    await writerStorage.synced();
    await server.flushSessions();
    await readerStorage.synced();
  };

  /** The id of the document `cause` names in the reader's runtime. */
  const idOf = (cause: string) =>
    reader.getCell(space, cause, counterSchema).getAsNormalizedFullLink()
      .id as URI;

  /**
   * The value the reader's replica holds for `id`, or `undefined`. Reading
   * it counts as a read, which keeps the document through the next pass.
   */
  const held = (id: URI) =>
    readerReplica().get({ id, type: "application/json" })?.is;

  /** Whether the reader's replica holds `id`, without reading it. */
  const loaded = (id: URI) =>
    readerReplica().hasLocalDocumentCoverage?.(id) === true;

  const readerReplica = () => readerStorage.open(space).replica;

  /** Whether the reader's replica holds a known stored version of `id`. */
  const confirmed = (id: URI) =>
    readerReplica().isConfirmedDocument?.(id) === true;

  /** Runs two release passes, so a document loaded before the first goes. */
  const releaseTwice = async () => {
    await reader.scheduler.idle();
    await readerStorage.releaseUnreadDocuments();
    await readerStorage.releaseUnreadDocuments();
  };

  /** Loads `id` into the reader's replica with no cell to hold it. */
  const load = async (id: URI, schema: JSONSchema = false) => {
    expect(
      (await readerStorage.open(space).sync(id, { path: [], schema })).error,
    ).toBeUndefined();
  };

  it("releases a document nothing reads, and loads it as it now stands when read again", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);
    expect(held(id)).toEqual({ value: { n: 1 } });

    await releaseTwice();
    expect(held(id)).toBeUndefined();
    expect(readerReplica().getSizes?.().watchedDocuments).toBe(0);

    await write("counter", 2);
    const cell = reader.getCell(space, "counter", counterSchema);
    await cell.pull();
    expect(cell.get()).toEqual({ n: 2 });
  });

  it("releases a document a cell loaded once that cell has been collected", async () => {
    // Collection needs `--expose-gc` and the real clock, which this package's
    // test task does not give, so the helper runs in a process of its own.
    const helper = new URL("./document-release-gc-helper.ts", import.meta.url);
    // Spawned by name so the launch matches the task's `--allow-run=deno`
    // grant, which resolves the name through PATH the same way.
    const output = await new Deno.Command("deno", {
      args: ["run", "-A", "--v8-flags=--expose-gc", fromFileUrl(helper)],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    expect(
      output.success,
      `helper failed:\n${new TextDecoder().decode(output.stderr)}\n${stdout}`,
    ).toBe(true);
    // Loggers may write above the report; the report is the last line.
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1])).toEqual({
      keptWhileHeld: true,
      keptByKey: true,
      keptOnceCollected: false,
    });
  });

  it("keeps a document read since the previous pass through the pass that follows", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);
    await readerStorage.releaseUnreadDocuments();

    // Read after the first pass began: the second pass keeps it.
    expect(held(id)).toEqual({ value: { n: 1 } });
    await readerStorage.releaseUnreadDocuments();
    expect(loaded(id)).toBe(true);

    // Not read since: the third pass releases it.
    await readerStorage.releaseUnreadDocuments();
    expect(loaded(id)).toBe(false);
  });

  it("reports a document it keeps only for a recent load, which the next pass releases", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);

    expect(await readerStorage.releaseUnreadDocuments()).toBe(true);
    expect(loaded(id)).toBe(true);

    expect(await readerStorage.releaseUnreadDocuments()).toBe(false);
    expect(loaded(id)).toBe(false);
  });

  it("reports a document read while the pass waits to watch another on its own", async () => {
    // A pass that releases a root first watches, on its own, a document
    // something still reads only through that root's links. The counter is
    // read while that watch is on its way, so the pass keeps it, and says
    // so.

    await write("child", 1);
    const tx = writer.edit();
    writer.getCell(space, "parent", parentSchema, tx).set({
      child: writer.getCell(space, "child", counterSchema, tx),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await write("counter", 1);
    const child = idOf("child");
    const parent = idOf("parent");
    const id = idOf("counter");
    await load(parent, parentSchema);
    await load(id);
    const reading = readerStorage.addDocumentReader((address) =>
      address.id === child
    );
    expect(await readerStorage.releaseUnreadDocuments()).toBe(true);

    const watch = defer<void>();
    const watching = defer<void>();
    const watchAdd = server.watchAdd.bind(server);
    server.watchAdd = async (message) => {
      server.watchAdd = watchAdd;
      watching.resolve();
      await watch.promise;
      return await watchAdd(message);
    };
    const pass = readerStorage.releaseUnreadDocuments();
    await watching.promise;
    expect(held(id)).toEqual({ value: { n: 1 } });
    watch.resolve();

    expect(await pass).toBe(true);
    expect(held(parent)).toBeUndefined();
    expect(loaded(id)).toBe(true);
    reading();
  });

  it("releases what a stopped piece read in the pass after the one its stop asked for", async () => {
    // The stop's own pass keeps what was loaded since the previous pass, as
    // it keeps anything a read still under way may need; the pass that
    // follows it, which nothing else asks for here, releases it.
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);

    const { pattern, lift } = createTrustedBuilder(reader).commonfabric;
    const doubled = pattern<{ n: number }>(({ n }) =>
      lift((n: number) => n * 2, { type: "number" }, { type: "number" })(n)
    );
    const tx = reader.edit();
    const piece = reader.run(
      tx,
      doubled,
      { n: 2 },
      reader.getCell<number>(space, "doubled-and-stopped", undefined, tx),
    );
    reader.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(await piece.pull()).toBe(4);
    expect(loaded(id)).toBe(true);

    reader.runner.stop(piece);
    // Shares the release the stop asked for, which is still waiting for the
    // scheduler to be idle.
    await reader.releaseUnreadDocuments();
    expect(loaded(id)).toBe(false);
  });

  it("keeps a document a scheduler action reads until the action is unsubscribed", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);
    // A raw transaction read, so no cell holds the document.
    const action: Action = (tx) => {
      tx.readValueOrThrow({ space, scope: "space", id, path: [] });
    };
    reader.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await reader.scheduler.idle();
    await releaseTwice();
    expect(loaded(id)).toBe(true);

    reader.scheduler.unsubscribe(action);
    await releaseTwice();
    expect(loaded(id)).toBe(false);
  });

  it("keeps current a document an action begins to read while its release is on its way", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);
    await readerStorage.releaseUnreadDocuments();

    // The server holds the removal until the action has read the document.
    const removal = defer<void>();
    const watchRemove = server.watchRemove.bind(server);
    server.watchRemove = async (message) => {
      await removal.promise;
      return await watchRemove(message);
    };
    const released = reader.releaseUnreadDocuments();
    await reader.scheduler.idle();
    const seen: unknown[] = [];
    const action: Action = (tx) => {
      seen.push(tx.readValueOrThrow({ space, scope: "space", id, path: [] }));
    };
    reader.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await reader.scheduler.idle();
    removal.resolve();
    await released;
    await readerStorage.synced();
    expect(loaded(id)).toBe(true);

    await write("counter", 2);
    await reader.scheduler.idle();
    expect(seen.at(-1)).toEqual({ n: 2 });
    reader.scheduler.unsubscribe(action);
  });

  /**
   * Loads the counter, has an action begin to read it while the server holds
   * its removal, and lets the removal through with `watchAdd` answering the
   * replacement watch with `refusal`, once. Resolves to what the action read.
   */
  const releaseUnderRefusedRewatch = async (
    id: URI,
    refusal: { name: string; message: string },
  ) => {
    await load(id);
    await readerStorage.releaseUnreadDocuments();

    const removal = defer<void>();
    const watchRemove = server.watchRemove.bind(server);
    server.watchRemove = async (message) => {
      await removal.promise;
      return await watchRemove(message);
    };
    const released = reader.releaseUnreadDocuments();
    await reader.scheduler.idle();
    const seen: unknown[] = [];
    const action: Action = (tx) => {
      seen.push(tx.readValueOrThrow({ space, scope: "space", id, path: [] }));
    };
    reader.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await reader.scheduler.idle();
    const watchAdd = server.watchAdd.bind(server);
    server.watchAdd = (message) => {
      server.watchAdd = watchAdd;
      return Promise.resolve({
        type: "response",
        requestId: message.requestId,
        error: refusal,
      });
    };
    removal.resolve();
    await released;
    await readerStorage.synced();
    await reader.scheduler.idle();
    return { seen, action };
  };

  it("keeps a document held during its release that cannot at first be watched again, and the next pass keeps it current", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    const { seen, action } = await releaseUnderRefusedRewatch(id, {
      name: "Error",
      message: "watch failed",
    });
    expect(loaded(id)).toBe(true);
    expect(confirmed(id)).toBe(false);
    expect(seen.at(-1)).toEqual({ n: 1 });

    await releaseTwice();
    await readerStorage.synced();
    expect(confirmed(id)).toBe(true);
    await write("counter", 2);
    await reader.scheduler.idle();
    expect(seen.at(-1)).toEqual({ n: 2 });

    reader.scheduler.unsubscribe(action);
    await releaseTwice();
    expect(loaded(id)).toBe(false);
  });

  it("drops a document that could not be watched again at the next pass once nothing holds it", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    const { action } = await releaseUnderRefusedRewatch(id, {
      name: "Error",
      message: "watch failed",
    });
    const dropped: URI[] = [];
    const unsubscribe = readerStorage.subscribeDocumentsDropped(
      (_space, addresses) => {
        for (const address of addresses) dropped.push(address.id);
      },
    );
    reader.scheduler.unsubscribe(action);
    await reader.scheduler.idle();
    await readerStorage.releaseUnreadDocuments();
    await readerStorage.synced();
    expect(loaded(id)).toBe(false);
    expect(dropped).toEqual([id]);
    unsubscribe();
  });

  it("drops a document held during its release when the space refuses to watch it again", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    const dropped: URI[] = [];
    const unsubscribe = readerStorage.subscribeDocumentsDropped(
      (_space, addresses) => {
        for (const address of addresses) dropped.push(address.id);
      },
    );
    const { action } = await releaseUnderRefusedRewatch(id, {
      name: "AuthorizationError",
      message: "watch refused",
    });
    expect(loaded(id)).toBe(false);
    expect(dropped).toEqual([id]);
    unsubscribe();
    reader.scheduler.unsubscribe(action);
  });

  it("keeps a document a live cell has loaded, and keeps it current", async () => {
    await write("counter", 1);
    const cell = reader.getCell(space, "counter", counterSchema);
    await cell.sync();

    await releaseTwice();
    expect(cell.get()).toEqual({ n: 1 });
    await write("counter", 2);
    expect(cell.get()).toEqual({ n: 2 });
  });

  it("leaves a live cell loaded, without loading it again, when another document is dropped", async () => {
    await write("counter", 1);
    await write("other", 1);
    const cell = reader.getCell(space, "counter", counterSchema);
    await cell.sync();
    const other = idOf("other");
    await load(other);
    await releaseTwice();
    expect(loaded(other)).toBe(false);

    expect(cell.get()).toEqual({ n: 1 });
    expect(readerStorage.getSizes().pendingLoads).toBe(0);
  });

  it("logs a release pass that fails rather than rejecting its caller", async () => {
    const failed = () =>
      getLoggerCountsBreakdown()["runtime.document-release"]?.["release-failed"]
        ?.warn ?? 0;
    const before = failed();
    readerStorage.releaseUnreadDocuments = () =>
      Promise.reject(new Error("release pass failed"));

    await reader.releaseUnreadDocuments();
    expect(failed()).toBe(before + 1);
  });

  it("answers every call made while a pass is under way with one pass after it", async () => {
    // Each call comes once the scheduler is idle again, as the unsubscribes of
    // a closing pane arrive one message at a time.
    const passBegan = defer();
    const passMayEnd = defer();
    const release = readerStorage.releaseUnreadDocuments.bind(readerStorage);
    let passes = 0;
    readerStorage.releaseUnreadDocuments = async () => {
      passes++;
      if (passes === 1) {
        passBegan.resolve();
        await passMayEnd.promise;
      }
      return await release();
    };

    const first = reader.releaseUnreadDocuments();
    await passBegan.promise;
    const later: Promise<void>[] = [];
    for (let call = 0; call < 10; call++) {
      later.push(reader.releaseUnreadDocuments());
      await reader.scheduler.idle();
    }
    expect(passes).toBe(1);
    passMayEnd.resolve();
    await Promise.all([first, ...later]);
    expect(passes).toBe(2);
  });

  it("keeps a document a refresh retracts while something reads it, unwatched, and drops it once nothing does", async () => {
    await write("child", 1);
    const tx = writer.edit();
    writer.getCell(space, "parent", parentSchema, tx).set({
      child: writer.getCell(space, "child", counterSchema, tx),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await delivered();
    const child = idOf("child");
    const parent = idOf("parent");
    await load(parent, parentSchema);
    expect(held(child)).toEqual({ value: { n: 1 } });
    // The replica asks the reader about the child as it meets the
    // retraction, which is when it decides to keep the child.
    const retracting = defer<void>();
    const reading = readerStorage.addDocumentReader((address) => {
      if (address.id !== child) return false;
      retracting.resolve();
      return true;
    });

    // The link goes: the refresh retracts the child, which the reader
    // holds, so the replica keeps its value for the reader, with no watch
    // of its own: a later write does not reach it.
    const unlink = writer.edit();
    writer.getCell(space, "parent", parentSchema, unlink).set({});
    expect((await unlink.commit().settled).error).toBeUndefined();
    await delivered();
    await retracting.promise;
    expect(held(child)).toEqual({ value: { n: 1 } });
    expect(readerReplica().getSizes?.().watchedDocuments).toBe(1);
    await write("child", 2);
    expect(held(child)).toEqual({ value: { n: 1 } });

    // Kept through a pass while read, dropped by the pass after the reader
    // lets go; a read then loads it as it now stands.
    await releaseTwice();
    expect(held(child)).toEqual({ value: { n: 1 } });
    reading();
    await releaseTwice();
    expect(loaded(child)).toBe(false);
    const cell = reader.getCell(space, "child", counterSchema);
    await cell.pull();
    expect(cell.get()).toEqual({ n: 2 });
  });

  it("drops a document a refresh retracts that nothing reads", async () => {
    await write("child", 1);
    const tx = writer.edit();
    writer.getCell(space, "parent", parentSchema, tx).set({
      child: writer.getCell(space, "child", counterSchema, tx),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await delivered();
    const child = idOf("child");
    const parent = idOf("parent");
    await load(parent, parentSchema);
    expect(loaded(child)).toBe(true);

    const unlink = writer.edit();
    writer.getCell(space, "parent", parentSchema, unlink).set({});
    expect((await unlink.commit().settled).error).toBeUndefined();
    await delivered();
    expect(loaded(child)).toBe(false);
    expect(readerReplica().getSizes?.().documents).toBe(1);
  });

  it("releases what nothing reads once a piece stops, without being asked", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);
    // One pass ages the load; the next one releases it.
    await readerStorage.releaseUnreadDocuments();
    expect(loaded(id)).toBe(true);

    const { pattern, lift } = createTrustedBuilder(reader).commonfabric;
    const doubled = pattern<{ n: number }>(({ n }) =>
      lift((n: number) => n * 2, { type: "number" }, { type: "number" })(n)
    );
    const tx = reader.edit();
    const piece = reader.run(
      tx,
      doubled,
      { n: 2 },
      reader.getCell<number>(space, "doubled", undefined, tx),
    );
    reader.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(await piece.pull()).toBe(4);

    const dropped = defer<URI[]>();
    const unsubscribe = readerStorage.subscribeDocumentsDropped((
      _space,
      addresses,
    ) => dropped.resolve(addresses.map((address) => address.id)));
    reader.runner.stop(piece);
    expect(await dropped.promise).toContain(id);
    unsubscribe();
    expect(loaded(id)).toBe(false);
  });

  it("keeps a document still read through a released root's links, watched on its own", async () => {
    await write("child", 1);
    const tx = writer.edit();
    writer.getCell(space, "parent", parentSchema, tx).set({
      child: writer.getCell(space, "child", counterSchema, tx),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await delivered();

    // The child arrives through the parent's watch alone.
    const child = idOf("child");
    const parent = idOf("parent");
    await load(parent, parentSchema);
    expect(held(child)).toEqual({ value: { n: 1 } });

    // The runtime reads neither document, so this alone decides.
    const reading = readerStorage.addDocumentReader((address) =>
      address.id === child
    );
    await releaseTwice();
    expect(held(parent)).toBeUndefined();
    expect(held(child)).toEqual({ value: { n: 1 } });

    // Watched again: a change reaches the reader with no read of its own.
    await write("child", 2);
    expect(held(child)).toEqual({ value: { n: 2 } });

    // Read by nothing: dropped with the rest.
    reading();
    await releaseTwice();
    expect(held(child)).toBeUndefined();
    expect(readerReplica().getSizes?.().documents).toBe(0);
  });

  it("watches a kept document on a replica that replaces the one that released its root", async () => {
    await write("child", 1);
    const tx = writer.edit();
    writer.getCell(space, "parent", parentSchema, tx).set({
      child: writer.getCell(space, "child", counterSchema, tx),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await delivered();

    // A manager on the default route, which a host hint can replace. Both
    // routes reach the one server here, so each opens a session of its own
    // rather than resuming the other's.
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("https://default.test"),
    }, {
      create: async (space, signer) => {
        const client = await MemoryV2Client.connect({
          transport: MemoryV2Client.loopback(server),
          instanceNames: namesInstancesByDefault(),
        });
        const session = await client.mount(
          space,
          {},
          testPrincipalSessionOpenAuthFactory(signer),
        );
        return { client, session };
      },
    });
    try {
      const child = idOf("child");
      const parent = idOf("parent");
      const value = (id: URI) =>
        storage.open(space).replica.get({ id, type: "application/json" })?.is;
      expect(
        (await storage.open(space).sync(parent, {
          path: [],
          schema: parentSchema,
        })).error,
      ).toBeUndefined();
      storage.addDocumentReader((address) => address.id === child);
      await storage.releaseUnreadDocuments();
      await storage.releaseUnreadDocuments();
      expect(value(parent)).toBeUndefined();
      expect(value(child)).toEqual({ value: { n: 1 } });

      const replaced = storage.open(space).replica;
      expect(storage.registerSpaceHostDetailed(space, "https://other.test"))
        .toEqual({ accepted: true });
      await storage.synced();
      expect(storage.open(space).replica).not.toBe(replaced);
      expect(value(child)).toEqual({ value: { n: 1 } });
      expect(value(parent)).toBeUndefined();

      await write("child", 2);
      await storage.synced();
      expect(value(child)).toEqual({ value: { n: 2 } });
    } finally {
      await storage.close();
    }
  });

  it("offers the watches of a removal that failed to a later pass", async () => {
    await write("counter", 1);
    const id = idOf("counter");
    await load(id);
    const watchRemove = server.watchRemove.bind(server);
    server.watchRemove = (message) =>
      Promise.resolve({
        type: "response",
        requestId: message.requestId,
        error: { name: "Error", message: "removal refused" },
      });
    await releaseTwice();
    expect(loaded(id)).toBe(true);

    server.watchRemove = watchRemove;
    await readerStorage.releaseUnreadDocuments();
    expect(loaded(id)).toBe(false);
  });

  it("keeps every watch on a server that cannot remove one by id", async () => {
    const flags = server.memoryProtocolFlags.bind(server);
    server.memoryProtocolFlags = () => ({ ...flags(), watchRemoveV1: false });
    await write("counter", 1);
    await load(idOf("counter"));

    await releaseTwice();
    expect(held(idOf("counter"))).toEqual({ value: { n: 1 } });
    await write("counter", 2);
    expect(held(idOf("counter"))).toEqual({ value: { n: 2 } });
  });

  it("releases a document a pass kept for its cell once that cell has been collected, with no further request", async () => {
    // Collection needs `--expose-gc` and the real clock, which this package's
    // test task does not give, so the helper runs in a process of its own.
    const helper = new URL(
      "./document-release-collection-helper.ts",
      import.meta.url,
    );
    // Spawned by name so the launch matches the task's `--allow-run=deno`
    // grant, which resolves the name through PATH the same way.
    const output = await new Deno.Command("deno", {
      args: ["run", "-A", "--v8-flags=--expose-gc", fromFileUrl(helper)],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    expect(
      output.success,
      `helper failed:\n${new TextDecoder().decode(output.stderr)}\n${stdout}`,
    ).toBe(true);
    // Loggers may write above the report; the report is the last line.
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1])).toEqual({
      droppedOnceCollected: true,
      keptOnceHeldAgain: true,
    });
  });

  describe("when the registry reports a hold token collected", () => {
    /** Reports each token's collection, by the token. */
    let collections: Map<object, () => void>;

    beforeEach(async () => {
      // The reader is built again, with a registry this test drives.
      await reader.dispose();
      collections = new Map();
      readerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
        createHoldRegistry: <T>(cleanup: (held: T) => void) => ({
          register: (token: object, held: T) => {
            collections.set(token, () => cleanup(held));
          },
        }),
      });
      reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
    });

    /**
     * Reports `token` collected, as the registry would once it had been. The
     * test may still hold it, which is what a cell that holds it again would
     * do.
     */
    const collect = (token: object) => {
      const report = collections.get(token);
      expect(report).toBeDefined();
      collections.delete(token);
      report!();
    };

    /** The hold token of the document `id`, which a cell loading it took. */
    const tokenOf = (id: URI) => readerStorage.holdDocument({ space, id });

    /** Loads the counter document named `cause` through a cell. */
    const loadCell = async (cause: string) => {
      const cell = reader.getCell(space, cause, counterSchema);
      await cell.sync();
      return cell;
    };

    /** Counts the reports the reader's storage manager makes. */
    const countReports = () => {
      let reports = 0;
      readerStorage.subscribeHoldsCollected(() => reports++);
      return () => reports;
    };

    /**
     * Counts the release passes the reader's storage manager runs, and
     * returns the count so far and a promise of the next pass's end.
     */
    const countPasses = () => {
      const release = readerStorage.releaseUnreadDocuments.bind(readerStorage);
      let passes = 0;
      let ended = defer();
      readerStorage.releaseUnreadDocuments = async (options) => {
        passes++;
        try {
          return await release(options);
        } finally {
          ended.resolve();
          ended = defer();
        }
      };
      return { passes: () => passes, ended: () => ended.promise };
    };

    it("reports nothing for a token no pass something asked for has found live", async () => {
      await write("counter", 1);
      await loadCell("counter");
      const token = tokenOf(idOf("counter"));
      await releaseTwice();
      const reports = countReports();

      collect(token);
      expect(reports()).toBe(0);
    });

    it("reports a token a pass something asked for found live", async () => {
      await write("counter", 1);
      await loadCell("counter");
      const token = tokenOf(idOf("counter"));
      await reader.releaseUnreadDocuments();
      const reports = countReports();

      collect(token);
      expect(reports()).toBe(1);
    });

    it("asks for one pass for all the tokens one collection reports", async () => {
      const causes = ["a", "b", "c", "d", "e"];
      for (const [n, cause] of causes.entries()) await write(cause, n);
      const cells = await Promise.all(causes.map(loadCell));
      await reader.releaseUnreadDocuments();
      const tokens = causes.map((cause) => tokenOf(idOf(cause)));
      const reports = countReports();
      const { passes, ended } = countPasses();

      const passEnded = ended();
      for (const token of tokens) collect(token);
      expect(reports()).toBe(causes.length);
      await passEnded;
      await reader.scheduler.idle();
      expect(passes()).toBe(1);
      for (const [n, cell] of cells.entries()) {
        expect(cell.get()).toEqual({ n });
      }
    });

    it("keeps a document a cell still holds through the pass a report asks for", async () => {
      await write("counter", 1);
      const cell = await loadCell("counter");
      const id = idOf("counter");
      await reader.releaseUnreadDocuments();
      const { passes, ended } = countPasses();

      const passEnded = ended();
      collect(tokenOf(id));
      await passEnded;
      expect(passes()).toBe(1);
      expect(loaded(id)).toBe(true);
      await write("counter", 2);
      expect(cell.get()).toEqual({ n: 2 });
    });

    it("reports nothing for a token only a pass a report asked for found live", async () => {
      await write("first", 1);
      await write("second", 2);
      await loadCell("first");
      const first = tokenOf(idOf("first"));
      await reader.releaseUnreadDocuments();
      await loadCell("second");
      const second = tokenOf(idOf("second"));
      // Passes nothing asked for, so that the second document is neither
      // recent nor followed up on.
      await releaseTwice();
      const { ended } = countPasses();

      const passEnded = ended();
      collect(first);
      await passEnded;
      await reader.scheduler.idle();
      const reports = countReports();
      collect(second);
      expect(reports()).toBe(0);
    });

    it("reports a token found live by a pass a report and a request share", async () => {
      await write("first", 1);
      await write("second", 2);
      await loadCell("first");
      const first = tokenOf(idOf("first"));
      await reader.releaseUnreadDocuments();
      await loadCell("second");
      const second = tokenOf(idOf("second"));
      // Passes nothing asked for, so that the second document is neither
      // recent nor followed up on.
      await releaseTwice();
      const { passes, ended } = countPasses();

      const passEnded = ended();
      collect(first);
      const requested = reader.releaseUnreadDocuments();
      await passEnded;
      await requested;
      expect(passes()).toBe(1);
      const reports = countReports();
      collect(second);
      expect(reports()).toBe(1);
    });

    it("reports nothing for a token first held between the two passes one request runs", async () => {
      await write("recent", 1);
      await releaseTwice();
      // Loaded since the previous pass, so the request's first pass keeps it
      // and the runtime runs a second.
      await load(idOf("recent"));
      const release = readerStorage.releaseUnreadDocuments.bind(readerStorage);
      let passes = 0;
      let token: object | undefined;
      readerStorage.releaseUnreadDocuments = async (options) => {
        const deferred = await release(options);
        passes++;
        if (passes === 1) token = tokenOf(idOf("later"));
        return deferred;
      };

      await reader.releaseUnreadDocuments();
      expect(passes).toBe(2);
      const reports = countReports();
      collect(token!);
      expect(reports()).toBe(0);
    });

    it("reports nothing for a token marked before the storage manager closed, once its space has opened again", async () => {
      await write("counter", 1);
      await loadCell("counter");
      const token = tokenOf(idOf("counter"));
      await reader.releaseUnreadDocuments();

      await readerStorage.close();
      readerStorage.open(space);
      const reports = countReports();
      collect(token);
      expect(reports()).toBe(0);
    });

    it("stops listening for reports once the runtime has been disposed", async () => {
      const observers = readerStorage.accessForTestingOnly
        .holdsCollectedObservers;
      expect(observers.size).toBe(1);

      await reader.dispose({ closeStorage: false });
      expect(observers.size).toBe(0);
    });

    it("reports nothing once the storage manager has been closed", async () => {
      await write("counter", 1);
      await loadCell("counter");
      const token = tokenOf(idOf("counter"));
      await reader.releaseUnreadDocuments();
      const reports = countReports();

      await readerStorage.close();
      collect(token);
      expect(reports()).toBe(0);
    });
  });
});
