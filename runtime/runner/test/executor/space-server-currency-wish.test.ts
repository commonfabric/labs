import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { scopeOfScopeKey } from "@commonfabric/memory/v2";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { selectCurrencyPiece } from "@commonfabric/memory/v2/currency-index";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { ExecutorHost } from "../../src/executor/host.ts";
import type { CurrencyIndexMode } from "../../src/executor/store-currency.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import type {
  PieceCurrencySlice,
  PieceCurrencySnapshot,
} from "../../src/scheduler/piece-currency.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";
import { sessionDemandOf } from "../support/session-demand.ts";

const spaceSigner = await Identity.fromPassphrase(
  "space-server currency wish space",
);
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server currency wish service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server currency wish setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server currency wish alice",
);
const home = aliceSigner.did() as MemorySpace;

/** The tag alice's one favorite carries. */
const FAVORITE_TAG = "currency_wish_favorite";

/** The interval, in seconds, of the clock the interval cases wish for. */
const INTERVAL_SECONDS = 60;

/**
 * A piece with one wish, called with `options`, and one derived output,
 * `reader`, that holds what the wish resolved to.
 */
const wishProgram = (options: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, wish } from 'commonfabric';",
      "export default pattern<{ n?: number }, { reader: string }>(() => {",
      `  const found = wish<any>(${options});`,
      "  return {",
      "    reader: computed(() => JSON.stringify(found.result ?? null)),",
      "  };",
      "});",
    ].join("\n"),
  }],
});

// A piece with one derived output, `out`, and one computation that writes
// twice its `value` through `sink`, a cell the piece was handed.
const SIDE_WRITER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, Writable } from 'commonfabric';",
      "export default pattern<",
      "  { value: number; sink: Writable<number> },",
      "  { out: number }",
      ">(({ value, sink }) => {",
      "  computed(() => {",
      "    sink.set(value * 2);",
      "  });",
      "  return { out: computed(() => value * 3) };",
      "});",
    ].join("\n"),
  }],
};

/** The epoch the hosts of these tests record under. */
const EPOCH = "test-epoch";

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  // The host makes a serving runtime for each space it serves, and it serves
  // alice's home space as well as the one the pieces are in.
  let servingRuntimes: Runtime[];
  let cycles: ArrivalLog<unknown>;
  const opened: { runtime: Runtime; manager: EmulatedStorageManager }[] = [];

  /**
   * A runtime over the shared server, acting for `as`. It runs the pieces it
   * is handed where `serverExecution` is `true`, as a browser client does.
   */
  const openRuntime = (as: Identity, serverExecution: boolean): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution },
    });
    opened.push({ runtime, manager });
    return runtime;
  };

  /** Disposes the runtime `openRuntime()` returned last. */
  const closeLastRuntime = async () => {
    const { runtime, manager } = opened.pop()!;
    await runtime.dispose();
    await manager.close();
  };

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    servingRuntimes = [];
    cycles = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const { runtime, manager } of opened.splice(0)) {
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  /** A host serving the space, keeping the currency index as `mode` says. */
  const newHost = (mode: CurrencyIndexMode): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntimes.push(runtime);
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: {
        idleParkMs: 600_000,
        currencyIndex: mode,
        currencyEpoch: EPOCH,
      },
      onWaveCycle: cycles.record,
    });

  /** Whether a serving runtime runs the piece rooted at `root`. */
  const serves = (root: NormalizedFullLink) =>
    servingRuntimes.some((runtime) =>
      runtime.runner.isRunning(runtime.getCellFromLink(root))
    );

  /** What the scheduler that runs the piece would record of it now. */
  const snapshotOf = (root: NormalizedFullLink) => {
    for (const runtime of servingRuntimes) {
      const taken = runtime.scheduler.pieceCurrencySnapshot(space, root.id);
      if (taken !== undefined) return taken;
    }
    return undefined;
  };

  /** The slices of `taken` at a key of `scope`. */
  const slicesAt = (
    taken: PieceCurrencySnapshot | undefined,
    scope: "space" | "user" | "session",
  ) =>
    (taken?.slices ?? []).filter((slice) =>
      scopeOfScopeKey(slice.key) === scope
    );

  /** The spaces other than the pieces' own that `slice` read. */
  const otherSpacesReadBy = (slice: PieceCurrencySlice): MemorySpace[] => [
    ...new Set(
      slice.reads.filter((read) => read.space !== space).map((read) =>
        read.space
      ),
    ),
  ];

  /** What the currency index holds of the `space` slice of the piece. */
  const recordOf = async (root: NormalizedFullLink) =>
    selectCurrencyPiece(await server.engineForSpace(space), {
      piece: root.id,
    });

  /** Commits a write to a document no piece reads. */
  const touchSpace = async () => {
    const writer = openRuntime(setupSigner, false);
    const cell = writer.getCell<number>(space, "currency wish touch", {
      type: "number",
    });
    await cell.sync();
    const tx = writer.edit();
    cell.withTx(tx).set(1);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /** Gives alice's home space one favorite, tagged `FAVORITE_TAG`. */
  const seedHome = async () => {
    const writer = openRuntime(aliceSigner, false);
    const tx = writer.edit();
    const favorite = writer.getCell(home, "favorite", undefined, tx);
    favorite.set({ name: "a favorite" });
    writer.getCell(home, home, undefined, tx).set({
      defaultPattern: {
        favorites: [{ cell: favorite, tags: [FAVORITE_TAG] }],
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /**
   * Runs `program` as alice's own client, which watches its result, and
   * resolves with the piece's root once the serving loop runs it and has
   * stored a record. `argument` makes the piece's argument inside the
   * transaction that starts it.
   */
  const watch = async (
    program: RuntimeProgram,
    argument: (
      alice: Runtime,
      tx: ReturnType<Runtime["edit"]>,
    ) => Record<string, unknown> = () => ({}),
  ): Promise<{ alice: Runtime; root: NormalizedFullLink }> => {
    const alice = openRuntime(aliceSigner, true);
    const compiled = await alice.patternManager.compilePattern(program, {
      space,
    });
    const argumentCell = alice.getCell<Record<string, unknown>>(
      space,
      "currency wish argument",
      compiled.argumentSchema,
    );
    const result = alice.getCell<Record<string, unknown>>(
      space,
      "currency wish result",
      compiled.resultSchema,
    );
    await argumentCell.sync();
    await result.sync();
    const tx = alice.edit();
    argumentCell.withTx(tx).set(argument(alice, tx));
    alice.run(tx, compiled, argumentCell, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    result.sink(() => {});
    const root = result.getAsNormalizedFullLink();
    await awaitEach(
      cycles,
      () => host!.stats().currency.recordsStored > 0 && serves(root),
    );
    return { alice, root };
  };

  describe("instance members", () => {
    describe("recording a piece whose wish reads the viewer's home space", () => {
      for (
        const [target, options] of [
          ["#favorites", "{ query: '#favorites' }"],
          [
            "a hashtag among the viewer's favorites",
            `{ query: '#${FAVORITE_TAG}', scope: ['~'] }`,
          ],
          ["#profileName", "{ query: '#profileName' }"],
        ]
      ) {
        it(`files the reads in the home space under the viewer's slice, and gives no other reason not to vouch, for ${target}`, async () => {
          await seedHome();
          host = newHost("record");
          const { root } = await watch(wishProgram(options));
          await awaitEach(
            cycles,
            () =>
              slicesAt(snapshotOf(root), "user").some((slice) =>
                slice.reads.some((read) => read.space === home)
              ),
          );
          await host.whenQuiescent();

          const taken = snapshotOf(root)!;
          const [viewer] = slicesAt(taken, "user");
          const others = taken.slices.filter((slice) => slice !== viewer);
          expect(taken.unvouched).toEqual([]);
          expect(viewer.unvouched).toEqual(["foreign-read"]);
          expect(otherSpacesReadBy(viewer)).toEqual([home]);
          expect(others.flatMap((slice) => slice.unvouched)).toEqual([]);
          expect(others.flatMap(otherSpacesReadBy)).toEqual([]);
          expect(Object.keys(host.stats().currency.unvouched)).toEqual([
            "foreign-read",
          ]);
          expect(await recordOf(root)).toEqual({ mark: 0, epoch: EPOCH });
        });
      }
    });

    describe("recording a piece whose wish reads nothing outside its space", () => {
      for (
        const [target, options] of [
          ["#default", "{ query: '#default' }"],
          ["the space's root", "{ query: '/' }"],
          ["the one-shot `#now`", "{ query: '#now' }"],
        ]
      ) {
        it(`vouches for every slice, for ${target}`, async () => {
          host = newHost("record");
          const { root } = await watch(wishProgram(options));
          await host.whenQuiescent();

          const taken = snapshotOf(root)!;
          expect(taken.unvouched).toEqual([]);
          expect(taken.slices.flatMap((slice) => slice.unvouched)).toEqual(
            [],
          );
          expect(host.stats().currency.unvouched).toEqual({});
          expect(await recordOf(root)).toEqual({ mark: 0, epoch: EPOCH });
        });
      }
    });

    describe("recording a piece whose wish reads the interval clock", () => {
      /** The time the interval clock holds at `at`, as `reader` shows it. */
      const tickAt = (at: number) =>
        JSON.stringify(
          Math.floor(at / (INTERVAL_SECONDS * 1000)) *
            (INTERVAL_SECONDS * 1000),
        );

      /**
       * Sets the clock piece up as a runtime that then stops it, so the
       * store holds its outputs with nothing running. Returns its root and
       * the document that holds `reader`.
       */
      const setUpClock = async (): Promise<
        { root: NormalizedFullLink; reader: NormalizedFullLink }
      > => {
        const setup = openRuntime(setupSigner, false);
        const compiled = await setup.patternManager.compilePattern(
          wishProgram(`{ query: '#now/${INTERVAL_SECONDS}' }`),
          { space },
        );
        const argument = setup.getCell<Record<string, unknown>>(
          space,
          "currency wish clock argument",
          compiled.argumentSchema,
        );
        const result = setup.getCell<Record<string, unknown>>(
          space,
          "currency wish clock result",
          compiled.resultSchema,
        );
        const tx = setup.edit();
        argument.withTx(tx).set({});
        setup.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        await result.pull();
        const reader = result.key("reader").resolveAsCell()
          .getAsNormalizedFullLink();
        setup.runner.stop(result);
        await setup.idle();
        await setup.storageManager.synced();
        await closeLastRuntime();
        return {
          root: result.getAsNormalizedFullLink(),
          reader: { ...reader, path: [] } as NormalizedFullLink,
        };
      };

      /** Resolves once the clock piece's stored `reader` is `expected`. */
      const readerIs = async (expected: string) => {
        const reader = openRuntime(aliceSigner, false);
        const result = reader.getCell<{ reader: string }>(
          space,
          "currency wish clock result",
          { type: "object", properties: { reader: { type: "string" } } },
        );
        await result.sync();
        await waitForCellValue(
          reader,
          result.key("reader"),
          (value: string | undefined) => value === expected,
          { stuckLabel: `the clock piece's \`reader\` to be ${expected}` },
        );
        await closeLastRuntime();
      };

      it("gives the read of the clock as the reason its slice is not vouched for", async () => {
        host = newHost("record");
        const { root } = await watch(
          wishProgram(`{ query: '#now/${INTERVAL_SECONDS}' }`),
        );
        await host.whenQuiescent();

        const taken = snapshotOf(root)!;
        expect(slicesAt(taken, "space")[0].unvouched).toEqual(["clock-read"]);
        expect(await recordOf(root)).toEqual({ mark: 2, epoch: EPOCH });
      });

      it("starts the piece for a session that runs nothing, once the interval has passed, under `skip`", async () => {
        // The session's demand is handed to the loop as rows, so no client
        // runtime holds the wish's timer, and only a start moves the clock.

        let piece:
          | { root: NormalizedFullLink; reader: NormalizedFullLink }
          | undefined = undefined;
        (server as { demandForSpace: unknown }).demandForSpace = () =>
          sessionDemandOf(
            (piece === undefined ? [] : [piece.root, piece.reader]).map(
              (link) => ({
                id: link.id,
                scope: link.scope ?? "space",
                scopeKey: "space",
                root: link === piece!.root,
                identity: {
                  principal: aliceSigner.did(),
                  sessionId: "viewer",
                },
              }),
            ),
          );
        host = newHost("skip");
        const { root, reader } = await setUpClock();
        await awaitEach(cycles, () => host?.spaceServer(space) !== undefined);
        piece = { root, reader };
        host.spaceServer(space)!.noteDemandChanged();
        await awaitEach(cycles, () => serves(root));
        await host.whenQuiescent();
        await host.spaceServer(space)!.park("test-park");

        await clock.tick(2 * INTERVAL_SECONDS * 1000);
        await touchSpace();

        await awaitEach(cycles, () => serves(root));
        await readerIs(tickAt(Date.now()));
        expect(host.stats().currency.servedFromStore).toBe(0);
      });
    });

    describe("recording a piece with a computation that writes through a cell it was handed", () => {
      it("records the piece clean, with no write row for the cell", async () => {
        // The cell is in the computation's envelope and not in its write
        // surface, which is where a record's write rows come from
        // (docs/plans/stored-output-currency-across-spaces.md, "Computations
        // that run without demand").

        host = newHost("record");
        let sink: NormalizedFullLink | undefined;
        const { root } = await watch(SIDE_WRITER_PROGRAM, (alice, tx) => {
          const cell = alice.getCell<number>(
            space,
            "currency wish sink",
            { type: "number" },
            tx,
          );
          cell.set(0);
          sink = cell.getAsNormalizedFullLink();
          return { value: 2, sink: cell };
        });
        await host.whenQuiescent();

        const taken = snapshotOf(root)!;
        expect(taken.slices.flatMap((slice) => slice.unvouched)).toEqual([]);
        expect(taken.writes).not.toContain(sink!.id);
        expect(
          slicesAt(taken, "space")[0].reads.map((read) => read.id),
        ).toContain(sink!.id);
        expect(await recordOf(root)).toEqual({ mark: 0, epoch: EPOCH });
      });
    });
  });
});
