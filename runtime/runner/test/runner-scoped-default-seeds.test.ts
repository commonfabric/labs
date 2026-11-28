/**
 * The seed of the defaults a viewer's instances are owed when the viewer's
 * demand for a piece arrives on a serving runtime: when the piece's root
 * cannot be read for it, and the repeat of a seed that a serving wave
 * dropped — when it seeds again, when it gives up without a word, and when it
 * reports the seed lost.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { waveSettlementOf } from "../src/executor/wave.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("runner scoped default retry");
const alice = await Identity.fromPassphrase("scoped default retry Alice");
const space = service.did();

/** A piece that owns a per-session note whose default is `"blank"`. */
const NOTE_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, Writable } from 'commonfabric';",
      "export default pattern<{ n?: number }, { note: Writable<string> }>(",
      "  () => ({ note: new Writable.perSession<string>('blank') }),",
      ");",
    ].join("\n"),
  }],
};

type Settlement = NonNullable<ReturnType<typeof waveSettlementOf>>;

/** A wave settlement that dropped the seed's contribution. */
function dropped(
  cause: "contribution-dropped" | "wave-abandoned" = "contribution-dropped",
): Settlement {
  return Promise.resolve({
    error: {
      name: "StoreError",
      message: "the wave dropped the seed",
      cause: new Error("the wave dropped the seed"),
      waveWithdrawalCause: cause,
    },
  });
}

describe("Runner", () => {
  const viewer = { principal: alice.did(), sessionId: "Alice's session" };
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let lease: ExecutionLeaseCycle;
  let pattern: Pattern;
  let result: Cell<unknown>;
  let note: Cell<unknown>;

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const holder = executionLeaseHolder(service.did());
    storage = EmulatedStorageManager.connectTo(server, {
      as: service,
      id: holder,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);
    lease = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space,
      holder,
    });
    expect(await lease.acquire()).toBe(true);
    pattern = await runtime.patternManager.compilePattern(NOTE_PROGRAM, {
      space,
    });
    result = runtime.getCell(space, "piece owning a per-session note");
    await runtime.runSynced(result, pattern, {});
    const [descriptor] = pattern.derivedInternalCells!;
    expect(descriptor.scope).toBe("session");
    note = getDerivedInternalCell(result, descriptor);
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    await runtime.dispose();
    await lease.release();
    await storage.close();
    await server.close();
  });

  /**
   * Runs `run`, and returns what it returned and the owed cells of each seed
   * transaction it opened.
   */
  async function seedsOpenedBy<T>(
    run: () => Promise<T>,
  ): Promise<{ returned: T; seeds: string[] }> {
    const seeds: string[] = [];
    const stamp = runtime.stampServerRun.bind(runtime);
    using _stamps = stub(runtime, "stampServerRun", (tx, info) => {
      if (info.actionId.startsWith("scoped-default/")) {
        seeds.push(info.actionId.slice("scoped-default/".length));
      }
      stamp(tx, info);
    });
    return { returned: await run(), seeds };
  }

  /**
   * Repeats the seed for `viewer` after `settlement`, with `isCurrent`
   * answering from `answers` in turn, and returns how often the seed was
   * reported lost, how often `isCurrent` was asked, and the owed cells of
   * each seed transaction the repeat opened.
   */
  async function seedAgain(
    settlement: Settlement,
    answers: boolean[],
    instancePattern = pattern,
  ): Promise<{ lost: number; asked: number; seeds: string[] }> {
    let lost = 0;
    let asked = 0;
    const { seeds } = await seedsOpenedBy(() =>
      runtime.runner.accessForTestingOnly.seedAgainIfDropped(
        settlement,
        { pattern: instancePattern, resultCell: result },
        [note.getAsNormalizedFullLink()],
        viewer,
        () => answers[asked++] ?? true,
        { retry: true, onLost: () => lost++ },
      )
    );
    return { lost, asked, seeds };
  }

  describe("instance members", () => {
    describe("seedOwedDefaultsFor()", () => {
      it("seeds the viewer's instance of an owed cell, and returns `true`", async () => {
        expect(
          await seedsOpenedBy(() =>
            runtime.runner.seedOwedDefaultsFor(result, viewer)
          ),
        ).toEqual({
          returned: true,
          seeds: [note.getAsNormalizedFullLink().id],
        });
      });

      it("seeds nothing where the replica no longer covers the piece's root", async () => {
        const replica = runtime.storageManager.open(space).replica;
        const root = result.getAsNormalizedFullLink().id;
        using _uncovered = stub(
          replica,
          "hasLocalDocumentCoverage",
          (id) => id !== root,
        );

        expect(runtime.runner.isRunning(result)).toBe(true);
        expect(
          await seedsOpenedBy(() =>
            runtime.runner.seedOwedDefaultsFor(result, viewer)
          ),
        ).toEqual({ returned: false, seeds: [] });
      });

      it("rejects with a failure of the replica's read of the piece's root", async () => {
        const replica = runtime.storageManager.open(space).replica;
        const failure = new Error("Replica read failed");
        using _reads = stub(replica, "getDocument", () => {
          throw failure;
        });

        await expect(runtime.runner.seedOwedDefaultsFor(result, viewer)).rejects
          .toBe(failure);
      });
    });

    describe("accessForTestingOnly", () => {
      describe("seedAgainIfDropped()", () => {
        it("seeds the viewer's instance again once the wave dropped the first seed", async () => {
          expect(await seedAgain(dropped(), [])).toMatchObject({
            lost: 0,
            seeds: [note.getAsNormalizedFullLink().id],
          });
        });

        it("gives up without seeding or reporting a loss when the runtime moved on while it loaded the instance", async () => {
          // Before the instance's load.
          expect(await seedAgain(dropped(), [false])).toEqual({
            lost: 0,
            asked: 1,
            seeds: [],
          });

          // After the instance's load, before the seed.
          expect(await seedAgain(dropped(), [true, false])).toEqual({
            lost: 0,
            asked: 2,
            seeds: [],
          });
        });

        it("reports the seed lost when the repeat leaves a default unseeded", async () => {
          // The piece no longer runs what the instance names, so the seed
          // transaction the repeat opens writes nothing.
          const elsewhere = { ...pattern };
          expect(await seedAgain(dropped(), [], elsewhere)).toMatchObject({
            lost: 1,
            seeds: [note.getAsNormalizedFullLink().id],
          });
        });

        it("reports the seed lost, and warns, when the repeat fails", async () => {
          const failure = new Error("the instance could not be loaded");
          using _load = stub(
            runtime.storageManager,
            "syncCell",
            () => Promise.reject(failure),
          );
          using warn = stub(console, "warn");

          expect(await seedAgain(dropped(), [])).toMatchObject({
            lost: 1,
            seeds: [],
          });
          const warning = warn.calls.find((call) =>
            call.args.some((arg) =>
              String(arg).includes("dropped the first seed")
            )
          );
          expect(warning?.args).toContain(failure);
        });

        it("reports a seed lost without repeating it for a settlement that is no conflict drop", async () => {
          expect(await seedAgain(dropped("wave-abandoned"), [])).toEqual({
            lost: 1,
            asked: 0,
            seeds: [],
          });
        });
      });
    });
  });
});
