import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { selectCurrencyPiece } from "@commonfabric/memory/v2/currency-index";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../../src/cell.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import type { CurrencyIndexMode } from "../../src/executor/store-currency.ts";
import { readWatermarkSeq } from "../../src/executor/watermark-engine.ts";
import { waitForSettledThroughHead } from "../../src/executor/watermark.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";

const space = (await Identity.fromPassphrase(
  "space-server currency upstream space",
)).did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server currency upstream service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server currency upstream setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server currency upstream alice",
);

/** A program with one pattern, whose body is `lines`. */
const program = (lines: string[]): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, PerUser } from 'commonfabric';",
      ...lines,
    ].join("\n"),
  }],
});

/** Derives `a` as the tens of its input, so that some changes leave it. */
const FIRST_PROGRAM = program([
  "export default pattern<{ n: number }, { a: number }>(",
  "  ({ n }) => ({ a: computed(() => Math.floor(n / 10)) }),",
  ");",
]);

const MIDDLE_PROGRAM = program([
  "export default pattern<{ from: number }, { b: string }>(",
  "  ({ from }) => ({ b: computed(() => 'b:' + from) }),",
  ");",
]);

/** Derives `b` once for each viewer who demands it. */
const MIDDLE_PER_USER_PROGRAM = program([
  "export default pattern<{ from: number }, { b: string }>(({ from }) => {",
  "  const b = computed((): PerUser<string> => 'b:' + from);",
  "  return { b };",
  "});",
]);

const LAST_PROGRAM = program([
  "export default pattern<{ from: string }, { c: string }>(",
  "  ({ from }) => ({ c: computed(() => 'c:' + from) }),",
  ");",
]);

/** Longer than the memory server keeps the session of a client that left. */
const DETACHED_SESSION_MS = 31_000;

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let cycles: ArrivalLog<unknown>;

  /** The runtimes the host made, one for each tenure it has served. */
  let servingRuntimes: Runtime[];
  const opened: { runtime: Runtime; manager: EmulatedStorageManager }[] = [];

  /** A client runtime over the shared server, acting for `as`. */
  const openRuntime = (as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
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

  /** A host that keeps the currency index as `mode` says. */
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
        currencyEpoch: "test-epoch",
      },
      onWaveCycle: cycles.record,
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    cycles = new ArrivalLog();
    servingRuntimes = [];
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

  /** Whether a serving runtime runs the piece rooted at `root`. */
  const serves = (root: NormalizedFullLink) =>
    servingRuntimes.some((runtime) =>
      runtime.runner.isRunning(runtime.getCellFromLink(root))
    );

  /**
   * Runs `source` as the client `runtime`, with `argument` as its argument,
   * and returns its argument and result cells. The client watches the
   * result.
   */
  const run = async <Result>(
    runtime: Runtime,
    name: string,
    source: RuntimeProgram,
    argument: (tx: ReturnType<Runtime["edit"]>) => Record<string, unknown>,
  ) => {
    const compiled = await runtime.patternManager.compilePattern(source, {
      space,
    });
    const argumentCell = runtime.getCell<Record<string, unknown>>(
      space,
      `currency upstream ${name} argument`,
      compiled.argumentSchema,
    );
    const result = runtime.getCell<Result>(
      space,
      `currency upstream ${name} result`,
      compiled.resultSchema,
    );
    await argumentCell.sync();
    await result.sync();
    const tx = runtime.edit();
    argumentCell.withTx(tx).set(argument(tx));
    runtime.run(tx, compiled, argumentCell, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    result.sink(() => {});
    return { argumentCell, result, compiled };
  };

  /**
   * Resolves once `runtime` holds `value` in `cell` as the serving loop
   * derived it, with nothing of its own still speculative: a run that links
   * to the cell then commits against what the store holds.
   */
  const served = async <T>(runtime: Runtime, cell: Cell<T>, value: T) => {
    await waitForCellValue(
      runtime,
      cell,
      (held: T | undefined) => held === value,
      { stuckLabel: `the setup client to read ${String(value)}` },
    );
    const engine = await server.engineForSpace(space);
    await waitForSettledThroughHead(runtime, space, Engine.serverSeq(engine));
    await host!.whenQuiescent();
  };

  /**
   * Stands the three pieces up as a client that then leaves, each reading
   * the output of the one before it, and parks the space once each is
   * recorded. `middle` is the program of the one between. With `viewer`,
   * that viewer watches the last piece before the space is parked, so that
   * each piece is recorded for them too. Returns the pieces' roots, the id
   * of the first piece's argument, the id of the document that holds the
   * last piece's output, and the schema of the last piece's result.
   */
  const standUpAndPark = async (
    mode: CurrencyIndexMode,
    middle: RuntimeProgram = MIDDLE_PROGRAM,
    viewer?: Identity,
  ) => {
    host = newHost(mode);
    const setup = openRuntime(setupSigner);
    const a = await run<{ a: number }>(
      setup,
      "first",
      FIRST_PROGRAM,
      () => ({ n: 10 }),
    );
    await served(setup, a.result.key("a"), 1);
    const b = await run<{ b: string }>(
      setup,
      "middle",
      middle,
      (tx) => ({ from: a.result.withTx(tx).key("a") }),
    );
    await served(setup, b.result.key("b"), "b:1");
    const c = await run<{ c: string }>(
      setup,
      "last",
      LAST_PROGRAM,
      (tx) => ({ from: b.result.withTx(tx).key("b") }),
    );
    await waitForCellValue(
      setup,
      c.result.key("c"),
      (value: string | undefined) => value === "c:b:1",
      { stuckLabel: "the last piece to derive from the first" },
    );
    await host!.whenQuiescent();
    const roots = {
      first: a.result.getAsNormalizedFullLink(),
      middle: b.result.getAsNormalizedFullLink(),
      last: c.result.getAsNormalizedFullLink(),
    };
    const input = a.argumentCell.getAsNormalizedFullLink().id;
    const output = c.result.key("c").resolveAsCell().getAsNormalizedFullLink()
      .id;
    const resultSchema = c.compiled.resultSchema;
    await closeLastRuntime();
    if (viewer !== undefined) {
      const viewing = openRuntime(viewer);
      const viewed = viewing.getCell<{ c: string }>(
        space,
        "currency upstream last result",
        resultSchema,
      );
      await viewed.sync();
      viewed.sink(() => {});
      await served(viewing, viewed.key("c"), "c:b:1");
      await closeLastRuntime();
    }
    await host!.whenQuiescent();
    await clock.tick(DETACHED_SESSION_MS);
    await host!.whenQuiescent();
    await host!.spaceServer(space)?.park("test-park");
    return { roots, input, output, resultSchema };
  };

  /** Changes the first piece's input to `n` with no client. */
  const changeInput = async (input: string, n: number) => {
    const held = await server.readDocument(space, input);
    await server.writeDocument(space, input, {
      ...(held?.value as Record<string, unknown>),
      n,
    });
    await server.idle();
  };

  /** Has alice watch the last piece's result, and returns her cell of it. */
  const watchLast = async (
    resultSchema: Awaited<ReturnType<typeof standUpAndPark>>["resultSchema"],
  ) => {
    const alice = openRuntime(aliceSigner);
    const result = alice.getCell<{ c: string }>(
      space,
      "currency upstream last result",
      resultSchema,
    );
    await result.sync();
    result.sink(() => {});
    return { alice, result: result as Cell<{ c: string }> };
  };

  /** Resolves once alice reads `value` from the last piece. */
  const reads = (alice: Runtime, result: Cell<{ c: string }>, value: string) =>
    waitForCellValue(
      alice,
      result.key("c"),
      (held: string | undefined) => held === value,
      { stuckLabel: `alice to read ${value} from the last piece` },
    );

  /** The mark the `space` slice of the piece rooted at `root` holds. */
  const markOf = async (root: NormalizedFullLink) =>
    selectCurrencyPiece(await server.engineForSpace(space), {
      piece: root.id,
    })?.mark;

  describe("instance members", () => {
    describe("serving the last of three pieces in one space, each reading the one before, with none running", () => {
      it("starts the two pieces before it when an input of the first changed, and brings the viewer the value derived from it, under `start-upstream`", async () => {
        const { roots, input, resultSchema } = await standUpAndPark(
          "start-upstream",
        );
        await changeInput(input, 20);
        expect([serves(roots.first), serves(roots.middle), serves(roots.last)])
          .toEqual([false, false, false]);

        const { alice, result } = await watchLast(resultSchema);

        await reads(alice, result, "c:b:2");
        expect([serves(roots.first), serves(roots.middle)]).toEqual([
          true,
          true,
        ]);
        expect(host!.stats().currency.upstreamAbandoned).toBe(0);
      });

      it("starts the first piece alone, and leaves the last unstarted, when the first derives the value it held, under `start-upstream`", async () => {
        const { roots, input, resultSchema } = await standUpAndPark(
          "start-upstream",
        );
        await changeInput(input, 15);

        const { result } = await watchLast(resultSchema);
        await awaitEach(cycles, () => serves(roots.first));
        await host!.whenQuiescent();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore > 0,
        );

        expect([serves(roots.middle), serves(roots.last)]).toEqual([
          false,
          false,
        ]);
        expect([
          await markOf(roots.first),
          await markOf(roots.middle),
          await markOf(roots.last),
        ]).toEqual([0, 0, 0]);
        expect(result.key("c").get()).toBe("c:b:1");
        expect(host!.stats().currency.heldUpstream).toBe(1);
        expect(host!.stats().currency.upstreamAbandoned).toBe(0);
      });

      it("keeps the watermark below a change to the first piece's input until the viewer's piece is current, under `start-upstream`", async () => {
        const { roots, input, output, resultSchema } = await standUpAndPark(
          "start-upstream",
        );
        const { alice, result } = await watchLast(resultSchema);
        await reads(alice, result, "c:b:1");
        await host!.whenQuiescent();
        expect(serves(roots.last)).toBe(false);

        await changeInput(input, 20);
        // The watermark, read at the end of each cycle in which the store
        // does not hold what the last piece derives from the change, never
        // reaches the commit that made it.
        const engine = await server.engineForSpace(space);
        const changedAt = Engine.serverSeq(engine);
        const stored = () =>
          (Engine.read(engine, { id: output, scopeKey: "space" }) as
            | { value?: unknown }
            | null)?.value;
        const covered: number[] = [];
        await awaitEach(cycles, () => {
          if (stored() === "c:b:2") return true;
          covered.push(readWatermarkSeq(engine));
          return false;
        });

        expect(covered.every((seq) => seq < changedAt)).toBe(true);
        await reads(alice, result, "c:b:2");
      });

      it("starts the piece between for a returning viewer, whose own instance of its output the last piece reads, under `start-upstream`", async () => {
        const { input, resultSchema } = await standUpAndPark(
          "start-upstream",
          MIDDLE_PER_USER_PROGRAM,
          aliceSigner,
        );
        await changeInput(input, 20);

        const { alice, result } = await watchLast(resultSchema);

        await reads(alice, result, "c:b:2");
      });

      it("starts the piece between for a viewer it never ran for, whose own instance of its output the last piece reads, under `start-upstream`", async () => {
        const { resultSchema } = await standUpAndPark(
          "start-upstream",
          MIDDLE_PER_USER_PROGRAM,
        );

        const { alice, result } = await watchLast(resultSchema);

        await reads(alice, result, "c:b:1");
      });

      it("starts the last piece alone, on what the store holds of the piece before it, when an input of the first changed, under `skip`", async () => {
        const { roots, input, resultSchema } = await standUpAndPark("skip");
        await changeInput(input, 20);
        const engine = await server.engineForSpace(space);
        const changedAt = Engine.serverSeq(engine);

        const { alice, result } = await watchLast(resultSchema);
        await awaitEach(cycles, () => serves(roots.last));
        await waitForSettledThroughHead(alice, space, changedAt);
        await host!.whenQuiescent();

        expect([serves(roots.first), serves(roots.middle), serves(roots.last)])
          .toEqual([false, false, true]);
        expect(result.key("c").get()).toBe("c:b:1");
        const { currency } = host!.stats();
        expect(currency.refused["stale-upstream"]).toBe(1);
        expect([
          currency.heldUpstream,
          currency.upstreamAbandoned,
          currency.servedFromStore,
          currency.carried,
        ]).toEqual([0, 0, 0, 0]);
        expect(await markOf(roots.last)).toBe(1);
      });

      it("leaves the two pieces before it unstarted for a last piece that runs already, under `skip`", async () => {
        const { roots, input, resultSchema } = await standUpAndPark("skip");
        await changeInput(input, 15);
        const { alice, result } = await watchLast(resultSchema);
        await awaitEach(cycles, () => serves(roots.last));
        await host!.whenQuiescent();

        await changeInput(input, 20);
        const engine = await server.engineForSpace(space);
        await waitForSettledThroughHead(alice, space, Engine.serverSeq(engine));
        await host!.whenQuiescent();

        expect([serves(roots.first), serves(roots.middle), serves(roots.last)])
          .toEqual([false, false, true]);
        expect(result.key("c").get()).toBe("c:b:1");
        const { currency } = host!.stats();
        expect([currency.heldUpstream, currency.upstreamAbandoned]).toEqual([
          0,
          0,
        ]);
      });

      it("starts the two pieces before it for a last piece that runs already, under `record`", async () => {
        const { roots, input, resultSchema } = await standUpAndPark("record");
        const { alice, result } = await watchLast(resultSchema);
        await reads(alice, result, "c:b:1");
        await host!.whenQuiescent();
        expect([serves(roots.first), serves(roots.middle), serves(roots.last)])
          .toEqual([false, false, true]);

        await changeInput(input, 20);

        await reads(alice, result, "c:b:2");
      });
    });
  });
});
