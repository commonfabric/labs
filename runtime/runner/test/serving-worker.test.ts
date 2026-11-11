/**
 * Runs the serving loop in Workers over a file-backed memory server on this
 * thread, and drives it from client runtimes here: a client's authored
 * commits reach its space's worker through the port, the worker's host's
 * derived commits land in the store through the bridge's sink, and a client
 * reads the result back through its ordinary subscription.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import { type Cell, sendEvent } from "../src/cell.ts";
import { exposeGarbageCollector } from "../src/collected-memory.ts";
import {
  ServingWorkerPool,
  type ServingWorkerPoolOptions,
} from "../src/executor/serving-worker-host.ts";
import type { ServingLoopStats } from "../src/executor/stats.ts";
import { readWatermarkSeq } from "../src/executor/watermark-engine.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog, awaitAdmitted } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("serving worker space");
const space = spaceSigner.did() as MemorySpace;
const otherSigner = await Identity.fromPassphrase("serving worker other space");
const otherSpace = otherSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("serving worker service");
const aliceSigner = await Identity.fromPassphrase("serving worker alice");

// Before any worker starts, as a server does.
exposeGarbageCollector();

const PARENT_PATTERN = `
import { computed, pattern } from "commonfabric";
export default pattern<{ n: number }, { total: number }>(({ n }) => ({
  total: computed(() => n + 1),
}));
`;

/**
 * The result schema a reader demands the parent piece under: it crosses to
 * the computed behind `total`, which is what makes the serving loop derive it.
 */
const TOTAL_SCHEMA = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
} as const satisfies JSONSchema;

const BUMP_PATTERN = `
import { handler, pattern, Stream, Writable } from "commonfabric";
const bump = handler<unknown, { value: Writable<number> }>(
  (_event, { value }) => { value.set((value.get() ?? 0) + 1); },
);
export default pattern<
  { value: Writable<number> },
  { value: number; bump: Stream<unknown> }
>(({ value }) => ({ value, bump: bump({ value }) }));
`;

describe("serving-worker", () => {
  let directory: string;
  let server: MemoryV2Server.Server;
  let sessions: MemoryV2Server.SessionRegistry;
  let worker: ServingWorkerPool;
  let clients: Runtime[];

  /** Each activation's outcome, by space. */
  let activations: ArrivalLog<{ space: string; outcome: string }>;

  /** Each worker taken out of the pool, with its spaces and the cause. */
  let closures: ArrivalLog<{ spaces: readonly string[]; cause: string }>;

  /** Starts the pool under test; a space parks only when a case says so. */
  const start = async (
    over: Partial<ServingWorkerPoolOptions> = {},
  ): Promise<void> => {
    worker = new ServingWorkerPool({
      server,
      identity: serviceSigner,
      apiUrl: new URL(import.meta.url),
      ensureSpaceRoots: false,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (activated, outcome) =>
        activations.record({ space: activated, outcome }),
      onWorkerClosed: (spaces, cause) => closures.record({ spaces, cause }),
      ...over,
    });
    await worker.ready;
  };

  /** A client runtime in the ON posture, as `alice`. */
  const newClient = (): Runtime => {
    const client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      }),
      experimental: { serverExecution: true },
    });
    clients.push(client);
    return client;
  };

  /**
   * Disposes a client and removes its session on `visited` outright: the
   * registry prunes a detached session only lazily, and a space parks idle
   * only once no client session is left.
   */
  const closeClient = async (
    client: Runtime,
    visited: MemorySpace,
  ): Promise<void> => {
    clients = clients.filter((each) => each !== client);
    await client.dispose();
    sessions.remove(visited, client.storageManager.id);
  };

  /** Resolves once `served`'s tenure is active. */
  const activated = (served: MemorySpace): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === served && entry.outcome === "active"
    );

  /**
   * Starts the parent piece in `served` over `n` from a client that then
   * closes; resolves once the setup has committed.
   */
  const startParent = async (served: MemorySpace, n: number): Promise<void> => {
    const writer = newClient();
    try {
      const parent = await writer.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: PARENT_PATTERN }],
      }, { space: served });
      await writer.patternManager.flushCompileCacheWrites();
      const tx = writer.edit();
      const argument = writer.getCell<{ n: number }>(served, "worker-arg");
      argument.withTx(tx).set({ n });
      writer.run(
        tx,
        parent,
        argument,
        writer.getCell<{ total: number }>(served, "worker-result"),
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    } finally {
      await closeClient(writer, served);
    }
  };

  /**
   * Resolves with a client that demands the parent piece's result in
   * `served`, once it reads `total`. The reader runs no pattern, so what it
   * reads is what the serving loop committed.
   */
  const readTotal = async (
    served: MemorySpace,
    total: number,
  ): Promise<Runtime> => {
    const reader = newClient();
    const result = reader.getCell<{ total: number }>(
      served,
      "worker-result",
      TOTAL_SCHEMA,
    );
    await result.sync();
    await waitForCellValue(
      reader,
      result,
      (value: { total: number } | undefined) => value?.total === total,
      { stuckLabel: `the reader's total in ${served} to reach ${total}` },
    );
    return reader;
  };

  /** The holders the derived commits in `served`'s store name. */
  const derivedHolders = async (served: MemorySpace): Promise<Set<string>> => {
    const engine = await server.engineForSpace(served);
    const rows = engine.database.prepare(
      `SELECT holder FROM "commit" WHERE class = 'derived'`,
    ).all() as { holder: string }[];
    return new Set(rows.map((row) => row.holder));
  };

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "serving-worker-" });
    sessions = new MemoryV2Server.SessionRegistry();
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      store: toFileUrl(`${directory}/`),
      sessions,
    });
    clients = [];
    activations = new ArrivalLog();
    closures = new ArrivalLog();
  });

  afterEach(async () => {
    await worker.close();
    for (const client of clients) await client.dispose();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  });

  it("derives a client's authored input in the worker and settles the client past it", async () => {
    await start();
    const client = newClient();
    const parent = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PARENT_PATTERN }],
    }, { space });
    const argument: Cell<{ n: number }> = client.getCell(
      space,
      "worker-arg",
      undefined,
    );
    const result = client.getCell<{ total: number }>(
      space,
      "worker-result",
      parent.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const seed = client.edit();
    argument.withTx(seed).set({ n: 41 });
    expect((await seed.commit().settled).error).toBeUndefined();
    const run = client.edit();
    client.run(run, parent, argument, result);
    expect((await run.commit().settled).error).toBeUndefined();
    const engine = await server.engineForSpace(space);
    const authoredSeq = Engine.serverSeq(engine);
    // The client's subscription is the demand the worker's loop derives for.
    // The client reads its own speculative value at once; the worker's
    // derivation shows as the watermark passing the client's input.
    const cancelDemand = result.sink(() => {});
    try {
      await activated(space);
      await awaitAdmitted(
        server,
        () => readWatermarkSeq(engine) >= authoredSeq,
      );
      await waitForCellValue(
        client,
        result.key("total"),
        (total: number | undefined) => total === 42,
        { stuckLabel: "the client's total to reach 42" },
      );
    } finally {
      cancelDemand();
    }

    // The derived commits are the worker's: held under a lease whose
    // holder names the service identity, through the store this thread's
    // server owns.
    const holders = await derivedHolders(space);
    expect(holders.size).toBe(1);
    for (const holder of holders) {
      expect(holder.startsWith(`${serviceSigner.did()}#`)).toBe(true);
    }
    const stats = await worker.requestStats();
    expect(stats.activeSpaces).toBe(1);
    expect(stats.derivedCommits).toBeGreaterThanOrEqual(1);
    expect(stats.workers).toMatchObject({ serving: 1, started: 1 });
  });

  it("holds counters on this thread that count an event by the time the wave commit covering it lands", async () => {
    await start();
    const client = newClient();
    const bumper = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: BUMP_PATTERN }],
    }, { space });
    const argument: Cell<{ value: number }> = client.getCell(
      space,
      "bump-arg",
      undefined,
    );
    const result = client.getCell<{ value: number; bump: unknown }>(
      space,
      "bump-result",
      bumper.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const seed = client.edit();
    argument.withTx(seed).set({ value: 0 });
    expect((await seed.commit().settled).error).toBeUndefined();
    const run = client.edit();
    client.run(run, bumper, argument, result);
    expect((await run.commit().settled).error).toBeUndefined();
    const engine = await server.engineForSpace(space);
    const startedSeq = Engine.serverSeq(engine);
    const cancelDemand = result.sink(() => {});
    // What the health route would answer at the moment each commit is
    // admitted on this thread: the counters the worker last posted.
    let appendSeq: number | undefined;
    let countedAtCover: ServingLoopStats | undefined;
    const unwatch = server.watchAdmittedCommits((notice) => {
      if (notice.space !== space) return;
      if ((notice.eventAppends?.length ?? 0) > 0) {
        appendSeq = notice.seq;
      } else if (
        appendSeq !== undefined && countedAtCover === undefined &&
        readWatermarkSeq(engine) >= appendSeq
      ) {
        countedAtCover = worker.stats();
      }
    });
    try {
      await activated(space);
      await awaitAdmitted(server, () => readWatermarkSeq(engine) >= startedSeq);
      sendEvent(result.key("bump"), {});
      await awaitAdmitted(server, () => countedAtCover !== undefined);
    } finally {
      unwatch();
      cancelDemand();
    }

    expect(countedAtCover?.events.appended).toBe(1);
    expect(countedAtCover?.events.processed).toBe(1);
    // The events post updates the last full copy rather than replacing it.
    expect(countedAtCover?.activeSpaces).toBe(1);
  });

  it("reports the memory of each worker's isolate after a collection, which leaves out what this thread holds", async () => {
    await start({ spareWorkers: 1 });
    const size = 64 * 1024 * 1024;
    const [before] = await worker.collectedMemory();
    expect(before.heapUsed).toBeGreaterThan(0);
    expect(before.spaces).toEqual([]);
    const held = new Uint8Array(size);
    const [during] = await worker.collectedMemory();
    expect(during.external - before.external).toBeLessThan(size);
    expect(held.length).toBe(size);
  });

  it("serves two spaces from a worker each, which commit under a lease holder each", async () => {
    await start();
    await startParent(space, 1);
    await startParent(otherSpace, 10);
    await readTotal(space, 2);
    await readTotal(otherSpace, 11);

    // How many workers started is not pinned: a writer whose session is gone
    // before its space's worker serves leaves that worker nothing to serve,
    // and the reader's visit then starts another.
    const stats = await worker.requestStats();
    expect(stats.workers).toMatchObject({ serving: 2, shared: 0 });
    expect(stats.activeSpaces).toBe(2);
    const holders = await derivedHolders(space);
    const otherHolders = await derivedHolders(otherSpace);
    expect(holders.size).toBe(1);
    expect(otherHolders.size).toBe(1);
    expect([...holders][0]).not.toBe([...otherHolders][0]);
    const placed = await worker.collectedMemory();
    expect(placed.map((each) => each.spaces).sort()).toEqual(
      [[space], [otherSpace]].sort(),
    );
  });

  it("serves two spaces from one worker under `maxWorkers: 1`", async () => {
    await start({ maxWorkers: 1 });
    await startParent(space, 1);
    await startParent(otherSpace, 10);
    await readTotal(space, 2);
    await readTotal(otherSpace, 11);

    const stats = await worker.requestStats();
    expect(stats.workers.serving).toBe(1);
    expect(stats.workers.shared).toBeGreaterThanOrEqual(1);
    expect(stats.activeSpaces).toBe(2);
    const placed = await worker.collectedMemory();
    expect(placed.map((each) => [...each.spaces].sort())).toEqual([
      [space, otherSpace].sort(),
    ]);
  });

  it("closes a space's worker once the space has parked with no runtime kept, and serves the space's next visit from a fresh one", async () => {
    await start({
      policy: {
        flushDeadlineMs: 5_000,
        idleParkMs: 250,
        parkedRuntimeRetentionMs: 0,
      },
    });
    await startParent(space, 1);
    const first = await readTotal(space, 2);
    const engine = await server.engineForSpace(space);
    const [holder] = await derivedHolders(space);
    await closeClient(first, space);

    expect(await closures.matching((entry) => entry.cause === "retired"))
      .toEqual({ spaces: [space], cause: "retired" });
    expect(engine.executionLeases.holderOf(space)).toBeUndefined();
    expect(worker.stats().workers).toMatchObject({ serving: 0, retired: 1 });
    // The closed worker's counters stay in the pool's.
    expect(worker.stats().derivedCommitsBySpace[space]).toBeGreaterThanOrEqual(
      1,
    );

    const writer = newClient();
    const argument = writer.getCell<{ n: number }>(space, "worker-arg");
    await argument.sync();
    const tx = writer.edit();
    argument.withTx(tx).set({ n: 20 });
    expect((await tx.commit().settled).error).toBeUndefined();
    await readTotal(space, 21);
    expect(worker.stats().workers.serving).toBe(1);
    const holders = await derivedHolders(space);
    expect(holders.size).toBe(2);
    expect(holders.has(holder)).toBe(true);
  });
});
