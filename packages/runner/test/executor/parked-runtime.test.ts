import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Spy, spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { JSONSchema } from "../../src/builder/types.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import {
  PARKED_RUNTIME_WRITE_REFUSED,
  type ParkedRuntimeTaint,
  ParkedServingRuntime,
} from "../../src/executor/parked-runtime.ts";
import {
  SEAL_AFTER_PARK_REFUSED,
  type SpaceServerPolicy,
} from "../../src/executor/space-server.ts";
import { Runtime } from "../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  MemorySpace,
  StorageNotification,
  TransactionSealDestination,
} from "../../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import { ArrivalLog } from "../support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("parked runtime space");
const space = spaceSigner.did() as MemorySpace;
const elsewhereSigner = await Identity.fromPassphrase(
  "parked runtime elsewhere",
);
const elsewhereSpace = elsewhereSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("parked runtime service");
const aliceSigner = await Identity.fromPassphrase("parked runtime alice");

/** A piece whose one derived value the serving loop computes on demand. */
const DOUBLER_SOURCE = `
import { computed, pattern } from "commonfabric";
export default pattern<{ value: number }, { doubled: number }>(
  ({ value }) => ({ doubled: computed(() => value * 2) }),
);
`;

/**
 * The result schema a reader demands a piece under: it crosses to the
 * computed behind `doubled`, which is what makes the serving loop derive it.
 */
const DOUBLED_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const satisfies JSONSchema;

/** A piece whose one derived value is a network request's response. */
const FETCHER_SOURCE = `
import { fetchText, pattern } from "commonfabric";
export default pattern<{ url: string }, { fetched: any }>(
  ({ url }) => ({ fetched: fetchText({ url }) }),
);
`;

/** The result schema a reader demands the fetching piece under. */
const FETCHED_SCHEMA = {
  type: "object",
  properties: {
    fetched: {
      type: "object",
      properties: {
        pending: { type: "boolean" },
        result: { type: "string" },
      },
    },
  },
} as const satisfies JSONSchema;

/** How many pieces the space runs. */
const PIECES = 3;

type Doubled = { doubled: number };

describe("parked-runtime", () => {
  let server: MemoryV2Server.Server;
  let sessions: MemoryV2Server.SessionRegistry;
  let host: ExecutorHost | undefined;

  /** Every serving runtime the host built, in build order. */
  let built: Runtime[];

  /**
   * Piece pre-syncs the serving runtimes ran: the step that names and syncs
   * everything a piece reads before a start runs it.
   */
  let presyncs: number;

  /** Spies on the serving runtimes' module-graph evaluations. */
  let evaluationSpies: Spy[];

  /** Disposes a serving runtime; what the host's factory hands it. */
  let disposeServing: (runtime: Runtime) => Promise<void>;

  /** Each tenure's park, by space. */
  let parks: ArrivalLog<{ space: string; reason: string }>;

  /** Each activation's outcome, by space. */
  let activations: ArrivalLog<{ space: string; outcome: string }>;

  /** Module-graph evaluations the serving runtimes have run. */
  const evaluations = (): number =>
    evaluationSpies.reduce((total, each) => total + each.calls.length, 0);

  /**
   * A host whose serving runtimes are counted: each one built, each piece
   * pre-sync, and each module-graph evaluation.
   */
  const newHost = (policy: SpaceServerPolicy): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      ensureSpaceRoots: false,
      policy: { idleParkMs: 1_000, ...policy },
      createRuntime: () => {
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: serviceSigner,
          }),
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        runtime.runner.accessForTestingOnly.dependencySyncer = (
          resultCell,
          pattern,
          inputs,
          sync,
        ) => {
          presyncs += 1;
          return sync(resultCell, pattern, inputs);
        };
        evaluationSpies.push(
          spy(runtime.harness, "evaluateRecordGraph"),
          spy(runtime.harness, "evaluateCachedModules"),
        );
        built.push(runtime);
        // The runtime's dispose closes the storage manager it was given.
        return Promise.resolve({
          runtime,
          dispose: () => disposeServing(runtime),
        });
      },
      onSpaceParked: (parked, reason) =>
        parks.record({ space: parked, reason }),
      onActivationSettled: (activated, outcome) =>
        activations.record({ space: activated, outcome }),
    });

  /** A client runtime in the ON posture, as `alice`. */
  const newClient = (): Runtime =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      }),
      experimental: { serverExecution: true },
    });

  /**
   * Disposes a client and removes its session outright: the registry
   * prunes a detached session only lazily, and the space parks idle only
   * once no client session is left.
   */
  const closeClient = async (
    client: Runtime,
    visited: MemorySpace = space,
  ): Promise<void> => {
    await client.dispose();
    sessions.remove(visited, client.storageManager.id);
  };

  /** Resolves once `parked` has parked idle, counting parks already past. */
  const parkedIdle = (parked: MemorySpace = space): Promise<unknown> =>
    parks.matching((entry) =>
      entry.space === parked && entry.reason === "idle"
    );

  /** Starts the pieces from a client; resolves once the setup committed. */
  const startPieces = async (): Promise<void> => {
    const writer = newClient();
    try {
      const pattern = await writer.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: DOUBLER_SOURCE }],
      }, { space });
      await writer.patternManager.flushCompileCacheWrites();
      const tx = writer.edit();
      for (let index = 0; index < PIECES; index++) {
        const argument = writer.getCell<{ value: number }>(
          space,
          `argument-${index}`,
        );
        argument.withTx(tx).set({ value: index + 1 });
        writer.run(
          tx,
          pattern,
          argument,
          writer.getCell<Doubled>(space, `result-${index}`),
        );
      }
      expect((await tx.commit()).error).toBeUndefined();
    } finally {
      await closeClient(writer);
    }
  };

  /** Writes each piece's argument from a client that then closes. */
  const writeArguments = async (
    value: (index: number) => number,
  ): Promise<void> => {
    const writer = newClient();
    try {
      const tx = writer.edit();
      for (let index = 0; index < PIECES; index++) {
        const argument = writer.getCell<{ value: number }>(
          space,
          `argument-${index}`,
        );
        await argument.sync();
        argument.withTx(tx).set({ value: value(index) });
      }
      expect((await tx.commit()).error).toBeUndefined();
    } finally {
      await closeClient(writer);
    }
  };

  /**
   * A client demanding every piece's result, which is what the serving loop
   * derives for. Resolves once the demand is registered.
   */
  const openReader = async (): Promise<Runtime> => {
    const reader = newClient();
    for (let index = 0; index < PIECES; index++) {
      await reader.getCell<Doubled>(space, `result-${index}`, DOUBLED_SCHEMA)
        .sync();
    }
    return reader;
  };

  /**
   * Resolves once `reader` reads `expected(index)` for every piece. The
   * reader runs no pattern, so what it reads is what the serving loop
   * committed.
   */
  const readAll = async (
    reader: Runtime,
    expected: (index: number) => number,
  ): Promise<void> => {
    for (let index = 0; index < PIECES; index++) {
      await waitForCellValue<Doubled>(
        reader,
        reader.getCell<Doubled>(space, `result-${index}`, DOUBLED_SCHEMA),
        (value) => value?.doubled === expected(index),
        { stuckLabel: `piece ${index} to read ${expected(index)}` },
      );
    }
  };

  /**
   * Serves every piece once, then drops every client and resolves once the
   * space has parked idle.
   */
  const serveThenPark = async (): Promise<void> => {
    await startPieces();
    const reader = await openReader();
    await readAll(reader, (index) => (index + 1) * 2);
    await closeClient(reader);
    await parkedIdle();
  };

  /**
   * Re-activates the parked space with a demanding reader, then moves every
   * piece's argument; resolves once the reader reads what the serving loop
   * derived from the new arguments. Neither the store nor the reader holds
   * those values before this runs.
   */
  const revisit = async (): Promise<void> => {
    const reader = await openReader();
    try {
      await activations.reached(2);
      await writeArguments((index) => index + 10);
      await readAll(reader, (index) => (index + 10) * 2);
    } finally {
      await closeClient(reader);
    }
  };

  beforeEach(() => {
    sessions = new MemoryV2Server.SessionRegistry();
    server = newLoopbackServer({ sessions });
    host = undefined;
    built = [];
    presyncs = 0;
    evaluationSpies = [];
    disposeServing = (runtime) => runtime.dispose();
    parks = new ArrivalLog();
    activations = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    await server.close();
  });

  describe("an idle park", () => {
    for (const storeReadThrough of [false, true]) {
      const reads = storeReadThrough
        ? "reading through the store"
        : "reading over its session";
      it(`keeps the runtime, and the next tenure serves with it without building, evaluating, or pre-syncing a piece, ${reads}`, async () => {
        host = newHost({ storeReadThrough });
        await serveThenPark();
        expect(host.stats().parkedRuntimes.held).toBe(1);
        const presyncsBefore = presyncs;
        const evaluationsBefore = evaluations();

        await revisit();

        expect(built).toHaveLength(1);
        expect(evaluations() - evaluationsBefore).toBe(0);
        expect(presyncs - presyncsBefore).toBe(0);
        expect(host.stats().parkedRuntimes).toMatchObject({
          retained: 1,
          reused: 1,
          discarded: 0,
        });
      });
    }

    it("disposes the runtime when retention is off, and the next tenure builds, evaluates, and pre-syncs every piece", async () => {
      // The control for the case above: the same visit, with nothing kept.

      host = newHost({ parkedRuntimeRetentionMs: 0 });
      await serveThenPark();
      expect(host.stats().parkedRuntimes.held).toBe(0);
      const presyncsBefore = presyncs;
      const evaluationsBefore = evaluations();

      await revisit();

      expect(built).toHaveLength(2);
      expect(evaluations() - evaluationsBefore).toBeGreaterThan(0);
      expect(presyncs - presyncsBefore).toBeGreaterThanOrEqual(PIECES);
    });
  });

  describe("retention", () => {
    it("disposes a kept runtime once `parkedRuntimeRetentionMs` has passed", async () => {
      host = newHost({ parkedRuntimeRetentionMs: 60_000 });
      await serveThenPark();
      expect(host.stats().parkedRuntimes.held).toBe(1);

      await clock.tick(60_000);

      expect(host.stats().parkedRuntimes).toMatchObject({
        held: 0,
        discarded: 1,
      });
      await revisit();
      expect(built).toHaveLength(2);
    });

    it("disposes the longest-kept runtime once more than `maxParkedRuntimes` are kept", async () => {
      host = newHost({ maxParkedRuntimes: 1 });
      for (const visited of [space, elsewhereSpace]) {
        const client = newClient();
        await client.getCell<{ n: number }>(visited, "visit").sync();
        await activations.matching((entry) =>
          entry.space === visited && entry.outcome === "active"
        );
        await closeClient(client, visited);
        await parkedIdle(visited);
      }

      expect(host.stats().parkedRuntimes).toMatchObject({
        retained: 2,
        discarded: 1,
        held: 1,
      });
      // The one kept is the later park's: the next visit there builds
      // nothing.
      const client = newClient();
      await client.getCell<{ n: number }>(elsewhereSpace, "visit").sync();
      await activations.reached(3);
      await closeClient(client, elsewhereSpace);
      expect(activations.entries[2]).toEqual({
        space: elsewhereSpace,
        outcome: "active",
      });
      expect(built).toHaveLength(2);
      expect(host.stats().parkedRuntimes.reused).toBe(1);
    });

    it("counts a kept runtime whose dispose fails as discarded, and `close()` still returns", async () => {
      disposeServing = async (runtime) => {
        await runtime.dispose();
        throw new Error("dispose failed (test-injected)");
      };
      host = newHost({ parkedRuntimeRetentionMs: 60_000 });
      await serveThenPark();

      await clock.tick(60_000);
      await host.close();

      expect(host.stats().parkedRuntimes).toMatchObject({
        held: 0,
        discarded: 1,
      });
      expect(host.stats().parkDisposeTimeouts).toBe(0);
    });

    for (const late of ["completes", "fails"] as const) {
      it(`abandons a kept runtime's dispose that overruns \`parkDisposeTimeoutMs\`, so \`close()\` returns before it, when the dispose later ${late}`, async () => {
        const gate = Promise.withResolvers<void>();
        let disposal: Promise<void> | undefined;
        disposeServing = (runtime) => {
          disposal = gate.promise.then(async () => {
            await runtime.dispose();
            if (late === "fails") {
              throw new Error("dispose failed late (test-injected)");
            }
          });
          return disposal;
        };
        host = newHost({
          parkedRuntimeRetentionMs: 60_000,
          parkDisposeTimeoutMs: 1_000,
        });
        await serveThenPark();

        await clock.tick(60_000);
        await clock.tick(1_000);
        await host.close();

        expect(host.stats().parkDisposeTimeouts).toBe(1);
        expect(host.stats().parkedRuntimes.discarded).toBe(1);
        gate.resolve();
        await disposal!.catch(() => {});
        await clock.settle();
      });
    }
  });

  describe("a parked runtime", () => {
    it("holds none of the demand its tenure entered, warm demand included", async () => {
      host = newHost({});
      await serveThenPark();
      const engine = await server.engineForSpace(space);
      const probe = newClient();
      const resultId = probe.getCell<Doubled>(space, "result-0")
        .getAsNormalizedFullLink().id;
      await closeClient(probe);

      // A warm request activates the space with no session, and its tenure
      // demands the named instance until it parks — past the point where
      // any session's departure would have released it.
      server.noteExecutorCommit({
        space,
        seq: Engine.serverSeq(engine),
        class: "authored",
        sessionId: "parked-runtime-warm",
        writes: [{ id: resultId, scopeKey: "space" }],
        warm: true,
      });
      await activations.reached(2);
      await parks.reached(2);

      expect(built).toHaveLength(1);
      expect(host.stats().parkedRuntimes.reused).toBe(1);
      expect(built[0].scheduler.demandedEntityCount).toBe(0);
    });

    it("is not reused once the store moved without it, and the fresh runtime derives the moved input", async () => {
      host = newHost({});
      await serveThenPark();

      // A write the in-process memory server never admits, and so never
      // delivers to the parked runtime: the shape of another process
      // writing the same store.
      const engine = await server.engineForSpace(space);
      const probe = newClient();
      const argumentId = probe.getCell<{ value: number }>(space, "argument-1")
        .getAsNormalizedFullLink().id;
      await closeClient(probe);
      Engine.applyCommit(engine, {
        sessionId: "parked-runtime-elsewhere",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: argumentId,
            patches: [{ op: "replace", path: "/value/value", value: 7 }],
          }],
        },
      });

      const reader = await openReader();
      await readAll(reader, (index) => index === 1 ? 14 : (index + 1) * 2);
      await closeClient(reader);
      expect(built).toHaveLength(2);
      expect(host.stats().parkedRuntimes).toMatchObject({
        reused: 0,
        discarded: 1,
      });
    });

    it("is disposed once its storage takes in a change, and is not reused", async () => {
      host = newHost({});
      await serveThenPark();
      const engine = await server.engineForSpace(space);
      const head = Engine.serverSeq(engine);
      // A document in another space, written without a session.
      const elsewhere = built[0].getCell<{ text: string }>(
        elsewhereSpace,
        "elsewhere",
      );
      Engine.applyCommit(await server.engineForSpace(elsewhereSpace), {
        sessionId: "parked-runtime-elsewhere",
        space: elsewhereSpace,
        principal: elsewhereSpace,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: elsewhere.getAsNormalizedFullLink().id,
            value: { value: { text: "elsewhere" } },
          }],
        },
      });

      // Loading it changes the parked runtime's storage and leaves this
      // space's store where it was, as a change delivered for a foreign
      // document it reads would.
      await elsewhere.sync();

      expect(elsewhere.get()).toEqual({ text: "elsewhere" });
      expect(Engine.serverSeq(engine)).toBe(head);
      expect(host.stats().parkedRuntimes).toMatchObject({
        held: 0,
        discarded: 1,
      });
      await revisit();
      expect(built).toHaveLength(2);
    });

    it("refuses a write it closes, commits nothing, and is not reused", async () => {
      host = newHost({});
      await serveThenPark();
      const engine = await server.engineForSpace(space);
      const head = Engine.serverSeq(engine);

      const parked = built[0];
      const tx = parked.edit();
      parked.getCell<{ value: number }>(space, "argument-2").withTx(tx)
        .set({ value: 100 });
      const { error } = await tx.commit();

      expect(error).toMatchObject({
        name: "StorageTransactionAborted",
        reason: { message: PARKED_RUNTIME_WRITE_REFUSED },
      });
      expect(Engine.serverSeq(engine)).toBe(head);
      await revisit();
      expect(built).toHaveLength(2);
      expect(host.stats().parkedRuntimes.reused).toBe(0);
    });

    it("refuses a transaction its tenure opened and closed after the park, commits nothing, and is not reused", async () => {
      host = newHost({});
      await startPieces();
      const reader = await openReader();
      await readAll(reader, (index) => (index + 1) * 2);
      const serving = built[0];
      const tx = serving.edit();
      serving.getCell<{ value: number }>(space, "argument-2").withTx(tx)
        .set({ value: 100 });
      await closeClient(reader);
      await parkedIdle();
      const engine = await server.engineForSpace(space);
      const head = Engine.serverSeq(engine);

      const { error } = await tx.commit();

      expect(error).toMatchObject({
        name: "StorageTransactionAborted",
        reason: { message: SEAL_AFTER_PARK_REFUSED },
      });
      expect(Engine.serverSeq(engine)).toBe(head);
      await revisit();
      expect(built).toHaveLength(2);
      expect(host.stats().parkedRuntimes.reused).toBe(0);
    });

    it("is not kept when its tenure refused a write while the park was still under way", async () => {
      host = newHost({});
      await startPieces();
      const reader = await openReader();
      await readAll(reader, (index) => (index + 1) * 2);
      const serving = built[0];
      const tx = serving.edit();
      serving.getCell<{ value: number }>(space, "argument-2").withTx(tx)
        .set({ value: 100 });
      const tenure = host.spaceServer(space)!;
      expect(tenure.suspendedOnInput).toBe(true);

      // The park refuses writes from its first step, and offers the runtime
      // only at its last.
      const parking = tenure.park("idle");
      const { error } = await tx.commit();
      await parking;
      await closeClient(reader);

      expect(error).toMatchObject({
        name: "StorageTransactionAborted",
        reason: { message: SEAL_AFTER_PARK_REFUSED },
      });
      expect(host.stats().parkedRuntimes).toMatchObject({
        retained: 0,
        held: 0,
      });
    });

    it("refuses a cross-space append its tenure stages after the park, and is not reused", async () => {
      host = newHost({});
      await startPieces();
      const reader = await openReader();
      await readAll(reader, (index) => (index + 1) * 2);
      const tenure = host.spaceServer(space)!;
      await closeClient(reader);
      await parkedIdle();
      expect(host.stats().parkedRuntimes.held).toBe(1);
      const tx = built[0].edit();

      // The refusal comes before the row is read.
      expect(() => tenure.stageOutboundAppend(tx, {} as OutboxAppendRow))
        .toThrow("staged after its serving tenure parked");
      tx.abort();
      await clock.settle();

      expect(host.stats().parkedRuntimes).toMatchObject({
        held: 0,
        discarded: 1,
      });
      await revisit();
      expect(built).toHaveLength(2);
    });

    it("is disposed when keeping it fails, and the next tenure builds fresh", async () => {
      host = newHost({});
      await startPieces();
      const reader = await openReader();
      await readAll(reader, (index) => (index + 1) * 2);
      // Keeping the runtime installs its fence, which this refuses.
      using _refuse = stub(built[0], "installSealDestination", () => {
        throw new Error("install refused (test-injected)");
      });
      await closeClient(reader);
      await parkedIdle();

      expect(host.stats().parkedRuntimes).toMatchObject({
        retained: 0,
        held: 0,
      });
      await revisit();
      expect(built).toHaveLength(2);
    });

    it("is not kept when its tenure parks with an effect still in flight", async () => {
      const url = "https://example.test/parked-runtime-fetch";
      const request = Promise.withResolvers<Response>();
      const issued = Promise.withResolvers<void>();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const requested = input instanceof Request ? input.url : String(input);
        if (!requested.startsWith(url)) return originalFetch(input, init);
        issued.resolve();
        return request.promise;
      };
      try {
        host = newHost({});
        const writer = newClient();
        try {
          const pattern = await writer.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: FETCHER_SOURCE }],
          }, { space });
          await writer.patternManager.flushCompileCacheWrites();
          const tx = writer.edit();
          const argument = writer.getCell<{ url: string }>(space, "fetch-in");
          argument.withTx(tx).set({ url });
          writer.run(
            tx,
            pattern,
            argument,
            writer.getCell(space, "fetch-out"),
          );
          expect((await tx.commit()).error).toBeUndefined();
        } finally {
          await closeClient(writer);
        }
        const reader = newClient();
        await reader.getCell(space, "fetch-out", FETCHED_SCHEMA).sync();
        await issued.promise;
        await closeClient(reader);
        await parkedIdle();

        expect(host.stats().parkedRuntimes).toMatchObject({
          retained: 0,
          held: 0,
        });
      } finally {
        request.resolve(new Response("late payload"));
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("ParkedServingRuntime", () => {
    /**
     * A parked instance over a stand-in runtime that records its seal
     * destination and storage watchers, parked at head 5.
     */
    const parkStandIn = () => {
      let destination: TransactionSealDestination | undefined;
      const watchers = new Set<IStorageNotification>();
      const runtime = {
        installSealDestination: (installed: TransactionSealDestination) => {
          destination = installed;
        },
        clearSealDestination: () => {
          destination = undefined;
        },
        storageManager: {
          subscribe: (watcher: IStorageNotification) => {
            watchers.add(watcher);
          },
          unsubscribe: (watcher: IStorageNotification) => {
            watchers.delete(watcher);
          },
        },
      } as unknown as Runtime;
      let disposals = 0;
      const parked = new ParkedServingRuntime({
        runtime,
        dispose: () => {
          disposals += 1;
          return Promise.resolve();
        },
        space,
        head: 5,
      });
      const taints: ParkedRuntimeTaint[] = [];
      parked.onTainted = (taint) => taints.push(taint);
      return {
        parked,
        runtime,
        watchers,
        taints,
        destination: () => destination,
        disposals: () => disposals,
      };
    };

    /** A transaction the fence refuses without reading. */
    const unread = {} as IExtendedStorageTransaction;

    it("hands the runtime on once, only at the head it parked at, unfenced and unwatched", async () => {
      const standIn = parkStandIn();

      expect(standIn.parked.take(4)).toBeUndefined();
      expect(standIn.parked.take(5)?.runtime).toBe(standIn.runtime);
      expect(standIn.destination()).toBeUndefined();
      expect(standIn.watchers.size).toBe(0);
      expect(standIn.parked.take(5)).toBeUndefined();
      await standIn.parked.dispose();
      expect(standIn.disposals()).toBe(0);
    });

    it("refuses every write at its fence, reports the taint once, and is not handed on", async () => {
      const standIn = parkStandIn();
      const fence = standIn.destination()!;

      const first = await fence.seal(unread);
      await fence.seal(unread);

      expect(first.error).toMatchObject({
        name: "StorageTransactionAborted",
        reason: { message: PARKED_RUNTIME_WRITE_REFUSED },
      });
      expect(fence.deferSealedEffects?.(unread, [])).toBe(true);
      expect(standIn.taints).toEqual(["write"]);
      expect(standIn.parked.take(5)).toBeUndefined();
      await standIn.parked.dispose();
      expect(standIn.disposals()).toBe(1);
    });

    for (
      const [notification, taints] of [
        [{ type: "load", space, changes: [] }, []],
        [{ type: "load", space, changes: [{}] }, ["storage"]],
        [{ type: "reset", space }, ["storage"]],
      ] as [unknown, ParkedRuntimeTaint[]][]
    ) {
      const kind = notification as { type: string; changes?: unknown[] };
      const carrying = kind.changes === undefined
        ? ""
        : ` carrying ${kind.changes.length} changes`;
      it(`reports ${taints.length} taints for a ${kind.type} notification${carrying}`, () => {
        const standIn = parkStandIn();
        const [watcher] = standIn.watchers;

        watcher.next(notification as StorageNotification);

        expect(standIn.taints).toEqual(taints);
      });
    }
  });
});
