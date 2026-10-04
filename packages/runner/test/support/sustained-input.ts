/**
 * A serving space under sustained input, for the suite and the benchmark that
 * measure watermark coverage while input keeps arriving (serving-loop.md §3's
 * prefix coverage). It runs a real memory server, an ExecutorHost serving a
 * two-stage cascade, and a client session that demands the cascade's result
 * and writes its argument.
 *
 * The stream it drives is paced by the settle itself: the serving storage
 * manager's input barrier admits the next client commit, and flushes its
 * frames, before it returns. So every barrier a settle crosses finds new input
 * behind it, and no settle observes quiescence while the stream runs. Each
 * stage of the cascade outlasts the serving scheduler's cooperative-yield
 * slice, which is what leaves the scheduler busy when the settle probes it.
 */

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import { readWatermarkSeq } from "../../src/executor/watermark.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, highestAuthoredSeq } from "./serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("sustained input space");
const serviceSigner = await Identity.fromPassphrase("sustained input service");
const aliceSigner = await Identity.fromPassphrase("sustained input alice");

/** The space the fixture serves. */
export const sustainedInputSpace = spaceSigner.did() as MemorySpace;

/** Iterations of each cascade stage's spin unless a fixture asks for more:
 * enough that the serving scheduler yields a macrotask between the stages. */
const DEFAULT_STAGE_SPINS = 3_000_000;

/** Two chained derivations, each a spin of `stageSpins` iterations. `total`
 * is `n * 7 + 1` once both have run for `n`. */
const cascadePattern = (stageSpins: number): string =>
  [
    "import { computed, pattern } from 'commonfabric';",
    "const spin = (seed: number): number => {",
    "  let x = seed;",
    `  for (let i = 0; i < ${stageSpins}; i++) x = (x * 31 + i) % 1000003;`,
    "  return x;",
    "};",
    "export default pattern<{ n: number }, { stage: number; total: number }>(",
    "  ({ n }) => {",
    "    const stage = computed(() => (spin(n) >= 0 ? n * 7 : 0));",
    "    const total = computed(() => (spin(stage) >= 0 ? stage + 1 : 0));",
    "    return { stage, total };",
    "  },",
    ");",
  ].join("\n");

/** The store's state as one wave cycle ends. */
export interface CycleEnd {
  /** The watermark the space's watermark document holds. */
  readonly watermark: number;

  /** The committed value of the cascade's `total`. */
  readonly total: unknown;
}

/** One input the stream committed. */
export interface StreamedInput {
  /** The seq it committed at. */
  readonly seq: number;

  /** The argument it wrote. */
  readonly n: number;
}

/** A running stream of inputs. */
export interface InputStream {
  /** Every input committed so far, in order. */
  readonly inputs: readonly StreamedInput[];

  /** Stops the stream; a barrier crossed afterwards commits nothing. Resolves
   * once a write already under way has landed, so `inputs` is final. */
  stop(): Promise<void>;
}

/** A serving space and the client writing to it. */
export interface SustainedInputFixture {
  readonly server: MemoryV2Server.Server;
  readonly engine: Engine.Engine;
  readonly host: ExecutorHost;

  /** The serving runtime, once the space has activated. */
  readonly servingRuntime: Runtime;

  /** Each wave cycle as it ends. */
  readonly cycles: ArrivalLog<CycleEnd>;

  /** Writes `n` as the cascade's argument, returning the commit's seq. */
  write(n: number): Promise<number>;

  /** Starts a stream committing one new input at every settle barrier, one
   * at a time. At most one stream runs at a time. */
  stream(): InputStream;

  /** Tears down the host, the client, and the server. */
  close(): Promise<void>;
}

/**
 * Opens a served space whose serving loop cuts its settles at
 * `flushDeadlineMs`, with the client already demanding the cascade's result.
 * `stageSpins` lengthens each cascade stage, for a case that needs one stage
 * to outlast the deadline itself on however fast a machine. `directInputs`
 * has the memory server's direct-write path write the inputs instead of the
 * client, which then neither syncs nor demands the argument document, so no
 * input re-arms a terminal root whose deferred retry would hold W back.
 */
export const openSustainedInputFixture = async (
  { flushDeadlineMs, stageSpins = DEFAULT_STAGE_SPINS, directInputs = false }: {
    flushDeadlineMs: number;
    stageSpins?: number;
    directInputs?: boolean;
  },
): Promise<SustainedInputFixture> => {
  const space = sustainedInputSpace;
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const engine = await server.engineForSpace(space);
  const cycles = new ArrivalLog<CycleEnd>();
  const activations = new ArrivalLog<string>();
  let onBarrier: (() => Promise<void>) | undefined;
  let servingRuntime: Runtime | undefined;
  let totalId: string | undefined;

  const committedTotal = (): unknown =>
    totalId === undefined
      ? undefined
      : Engine.read(engine, { id: totalId as never })?.value;

  const host = new ExecutorHost({
    server,
    serviceIdentity: serviceSigner.did(),
    createRuntime: async () => {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: serviceSigner,
      });
      const inputSynced = manager.inputSynced.bind(manager);
      manager.inputSynced = async () => {
        await onBarrier?.();
        await inputSynced();
      };
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      servingRuntime = runtime;
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: cascadePattern(stageSpins) }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(space, "arg");
      const result = runtime.getCell<{ stage: number; total: number }>(
        space,
        "result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(`serving run failed: ${committed.error.message}`);
      }
      await runtime.idle();
      totalId = result.key("total").resolveAsCell()
        .getAsNormalizedFullLink().id;
      return {
        runtime,
        dispose: async () => {
          await runtime.dispose();
          await manager.close();
        },
      };
    },
    policy: { flushDeadlineMs, idleParkMs: 600_000 },
    onActivationSettled: (_space, outcome) => activations.record(outcome),
    onWaveCycle: () => {
      // A cycle can end after teardown has closed the store.
      if (!engine.database.open) return;
      cycles.record({
        watermark: readWatermarkSeq(engine),
        total: committedTotal(),
      });
    },
  });

  const clientManager = EmulatedStorageManager.connectTo(server, {
    as: aliceSigner,
  });
  const client = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: clientManager,
    experimental: { serverExecution: true },
  });
  const result = client.getCell<{ total: number }>(space, "result");
  await result.sync();
  result.sink(() => {});
  await activations.matching((outcome) => outcome === "active");
  const argument = client.getCell<{ n: number }>(space, "arg");
  const argumentId = argument.getAsNormalizedFullLink().id;
  // A client that writes the argument demands it, and a demanded document
  // with no pattern of its own is a terminal root that each write re-arms.
  if (!directInputs) await argument.sync();

  const write = async (n: number): Promise<number> => {
    if (directInputs) {
      return (await server.writeDocument(space, argumentId, { n })).seq;
    }
    const tx = client.edit();
    argument.withTx(tx).set({ n });
    const committed = await tx.commit();
    if (committed.error !== undefined) {
      throw new Error(`input write failed: ${committed.error.message}`);
    }
    return highestAuthoredSeq(engine);
  };

  return {
    server,
    engine,
    host,
    get servingRuntime(): Runtime {
      if (servingRuntime === undefined) {
        throw new Error("the space has not activated");
      }
      return servingRuntime;
    },
    cycles,
    write,
    stream: () => {
      const inputs: StreamedInput[] = [];
      let streaming = true;
      let writing: Promise<void> | undefined;
      const next = async () => {
        // A settle the deadline cut keeps crossing barriers detached, so
        // two can be in flight; one input at a time keeps `inputs` in seq
        // order.
        if (!streaming || writing !== undefined) return;
        const n = inputs.length + 1;
        writing = write(n).then((seq) => {
          inputs.push({ seq, n });
        });
        try {
          await writing;
        } finally {
          writing = undefined;
        }
        await server.idle();
      };
      onBarrier = next;
      // The first input wakes a loop that may be waiting on its feed; every
      // later one rides a barrier.
      void next();
      return {
        inputs,
        stop: async () => {
          streaming = false;
          await writing;
        },
      };
    },
    close: async () => {
      onBarrier = undefined;
      await host.close();
      await client.dispose();
      await clientManager.close();
      await server.close();
    },
  };
};
