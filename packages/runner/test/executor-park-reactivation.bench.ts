/**
 * Measures a space's return from an idle park: a client demands every piece
 * of a parked space, moves each piece's input, and waits for the serving
 * loop's derivations of the new inputs. With retention the space's next
 * tenure serves with the runtime its last tenure parked; without it the
 * tenure builds a fresh runtime, which restarts and pre-syncs every piece
 * (serving-loop.md §1, "Parking").
 *
 * Each case owns an in-process memory server and serving host with the
 * pieces running. Every iteration first parks the space, untimed, and checks
 * the park kept the runtime or did not, as the case names; the timed interval
 * runs from opening the demanding client to its reading every new value.
 * The timing therefore includes the client's own session and sync work,
 * identical in both arms.
 *
 * Run with:
 *   deno bench --allow-read --allow-write --allow-net --allow-ffi \
 *     --allow-env --no-check test/executor-park-reactivation.bench.ts
 */

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { JSONSchema } from "../src/builder/types.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const serviceSigner = await Identity.fromPassphrase("park bench service");
const aliceSigner = await Identity.fromPassphrase("park bench alice");

/** A piece whose one derived value the serving loop computes on demand. */
const DOUBLER_SOURCE = `
import { computed, pattern } from "commonfabric";
export default pattern<{ value: number }, { doubled: number }>(
  ({ value }) => ({ doubled: computed(() => value * 2) }),
);
`;

/** The result schema a client demands a piece under. */
const DOUBLED_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const satisfies JSONSchema;

type Doubled = { doubled: number };

/** One case's server, host, and running pieces. */
type Fixture = {
  /** Parks the space, and resolves once it has. */
  park(): Promise<void>;

  /** Demands every piece, moves each input, and reads every new value. */
  revisit(): Promise<void>;

  /** Closes the reader, the host with any runtime it keeps, and the server. */
  close(): Promise<void>;
};

/**
 * Builds a fixture of `pieces` running pieces, served by a host that keeps a
 * parked runtime when `retain` is set and disposes it otherwise.
 */
async function buildFixture(
  pieces: number,
  retain: boolean,
): Promise<Fixture> {
  const space = (await Identity.fromPassphrase(
    `park bench ${pieces} ${retain}`,
  )).did() as MemorySpace;
  const sessions = new MemoryV2Server.SessionRegistry();
  const server = newLoopbackServer({ sessions });
  /** Resolved as each wave cycle of the space ends. */
  let cycleWaiters: (() => void)[] = [];
  const host = new ExecutorHost({
    server,
    serviceIdentity: serviceSigner.did(),
    ensureSpaceRoots: false,
    // The iterations park the space themselves.
    policy: {
      idleParkMs: 3_600_000,
      parkedRuntimeRetentionMs: retain ? 3_600_000 : 0,
    },
    createRuntime: () => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        }),
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      return Promise.resolve({ runtime, dispose: () => runtime.dispose() });
    },
    onWaveCycle: () => {
      const waiters = cycleWaiters;
      cycleWaiters = [];
      for (const wake of waiters) wake();
    },
  });
  const newClient = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      }),
      experimental: { serverExecution: true },
    });
  const closeClient = async (client: Runtime) => {
    await client.dispose();
    sessions.remove(space, client.storageManager.id);
  };
  const resultOf = (client: Runtime, index: number) =>
    client.getCell<Doubled>(space, `result-${index}`, DOUBLED_SCHEMA);
  const argumentOf = (client: Runtime, index: number) =>
    client.getCell<{ value: number }>(space, `argument-${index}`);

  const writer = newClient();
  const pattern = await writer.patternManager.compilePattern({
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: DOUBLER_SOURCE }],
  }, { space });
  await writer.patternManager.flushCompileCacheWrites();
  const setup = writer.edit();
  for (let index = 0; index < pieces; index++) {
    argumentOf(writer, index).withTx(setup).set({ value: index });
    writer.run(
      setup,
      pattern,
      argumentOf(writer, index),
      resultOf(writer, index),
    );
  }
  const setupResult = await setup.commit();
  if (setupResult.error !== undefined) throw setupResult.error;
  await closeClient(writer);

  let round = 0;
  let reader: Runtime | undefined;

  const revisit = async () => {
    round += 1;
    const current = newClient();
    reader = current;
    for (let index = 0; index < pieces; index++) {
      await resultOf(current, index).sync();
    }
    const mover = newClient();
    const move = mover.edit();
    for (let index = 0; index < pieces; index++) {
      const argument = argumentOf(mover, index);
      await argument.sync();
      argument.withTx(move).set({ value: round * 1_000 + index });
    }
    const moved = await move.commit();
    if (moved.error !== undefined) throw moved.error;
    await closeClient(mover);
    for (let index = 0; index < pieces; index++) {
      const expected = (round * 1_000 + index) * 2;
      await waitForCellValue<Doubled>(
        current,
        resultOf(current, index),
        (value) => value?.doubled === expected,
      );
    }
  };

  const park = async () => {
    if (reader !== undefined) await closeClient(reader);
    reader = undefined;
    const serving = host.spaceServer(space);
    if (serving === undefined) {
      throw new Error("the bench space has no serving tenure to park");
    }
    // Parked once the loop has settled on its input wait, as the loop
    // itself parks: a park abandoning an open wave keeps nothing. The loop
    // arms that wait synchronously after the cycle it reports.
    while (!serving.suspendedOnInput) {
      await new Promise<void>((wake) => cycleWaiters.push(wake));
    }
    await serving.park("idle");
    const held = host.stats().parkedRuntimes.held;
    if (held !== (retain ? 1 : 0)) {
      throw new Error(`the park kept ${held} runtimes; expected ${+retain}`);
    }
  };

  const close = async () => {
    if (reader !== undefined) await closeClient(reader);
    reader = undefined;
    await host.close();
    await server.close();
  };

  // The first visit runs the pieces on the space's first tenure.
  await revisit();
  return { park, revisit, close };
}

const fixtures: Promise<Fixture>[] = [];

for (const pieces of [10, 30]) {
  for (const retain of [true, false]) {
    let fixture: Promise<Fixture> | undefined;
    Deno.bench({
      name: `${pieces} pieces, ${retain ? "kept" : "rebuilt"}`,
      group: "park and reactivate",
      baseline: !retain,
      n: 10,
      warmup: 1,
      async fn(b) {
        if (fixture === undefined) {
          fixture = buildFixture(pieces, retain);
          fixtures.push(fixture);
        }
        const { park, revisit } = await fixture;
        await park();
        b.start();
        await revisit();
        b.end();
      },
    });
  }
}

globalThis.addEventListener("unload", () => {
  for (const fixture of fixtures) void fixture.then(({ close }) => close());
});
