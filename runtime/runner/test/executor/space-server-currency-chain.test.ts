import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { selectCurrencyPiece } from "@commonfabric/memory/v2/currency-index";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../../src/cell.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import type { CurrencyIndexMode } from "../../src/executor/store-currency.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";

/** The space of the first piece, which derives `a` from its input. */
const first = (await Identity.fromPassphrase(
  "space-server currency chain first",
)).did() as MemorySpace;

/** The space of the middle piece, which derives `b` from `a`. */
const middle = (await Identity.fromPassphrase(
  "space-server currency chain middle",
)).did() as MemorySpace;

/** The space of the last piece, which derives `c` from `b`. */
const last = (await Identity.fromPassphrase(
  "space-server currency chain last",
)).did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server currency chain service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server currency chain setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server currency chain alice",
);

/** A program with one pattern, whose body is `lines`. */
const program = (lines: string[]): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: ["import { computed, pattern } from 'commonfabric';", ...lines]
      .join("\n"),
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

  beforeEach(() => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      delegatingDids: [serviceSigner.did()],
    });
    cycles = new ArrivalLog();
    servingRuntimes = [];
  });

  /** A host that keeps the currency index as `mode` says. */
  const newHost = (mode: CurrencyIndexMode): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (space) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
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
   * Runs `source` in `space` as the client `runtime`, with `argument` as
   * its argument, and returns its argument and result cells. The client
   * watches the result.
   */
  const run = async <Result>(
    runtime: Runtime,
    space: MemorySpace,
    name: string,
    source: RuntimeProgram,
    argument: (tx: ReturnType<Runtime["edit"]>) => Record<string, unknown>,
  ) => {
    const compiled = await runtime.patternManager.compilePattern(source, {
      space,
    });
    const argumentCell = runtime.getCell<Record<string, unknown>>(
      space,
      `currency chain ${name} argument`,
      compiled.argumentSchema,
    );
    const result = runtime.getCell<Result>(
      space,
      `currency chain ${name} result`,
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
   * Stands the three pieces up as a client that then leaves, each reading
   * the output of the one before it, and parks all three spaces once each
   * piece is recorded, under a host that keeps the index as `mode` says.
   * Returns the pieces' roots and the id of the first piece's argument.
   */
  const standUpAndPark = async (
    mode: CurrencyIndexMode = "start-upstream",
  ) => {
    host = newHost(mode);
    const setup = openRuntime(setupSigner);
    const a = await run<{ a: number }>(
      setup,
      first,
      "first",
      FIRST_PROGRAM,
      () => ({ n: 10 }),
    );
    const b = await run<{ b: string }>(
      setup,
      middle,
      "middle",
      MIDDLE_PROGRAM,
      (tx) => ({ from: a.result.withTx(tx).key("a") }),
    );
    const c = await run<{ c: string }>(
      setup,
      last,
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
    const resultSchema = c.compiled.resultSchema;
    await closeLastRuntime();
    await host!.whenQuiescent();
    await clock.tick(DETACHED_SESSION_MS);
    await host!.whenQuiescent();
    for (const space of [last, middle, first]) {
      await host!.spaceServer(space)?.park("test-park");
    }
    return { roots, input, resultSchema };
  };

  /**
   * Changes the first piece's input to `n` with no client, so that nothing
   * demands anything in its space.
   */
  const changeInput = async (input: string, n: number) => {
    const held = await server.readDocument(first, input);
    await server.writeDocument(first, input, {
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
      last,
      "currency chain last result",
      resultSchema,
    );
    await result.sync();
    result.sink(() => {});
    return { alice, result: result as Cell<{ c: string }> };
  };

  /** The mark the `space` slice of the piece rooted at `root` holds. */
  const markOf = async (root: NormalizedFullLink) =>
    selectCurrencyPiece(await server.engineForSpace(root.space), {
      piece: root.id,
    })?.mark;

  describe("instance members", () => {
    describe("serving the last of three pieces in three spaces, each reading the one before, with none running", () => {
      it("starts the two pieces before it when an input of the first changed, and brings the viewer the value derived from it", async () => {
        // The viewer holds no grant on the two spaces before the last, so
        // what reaches them is demand with no pair, for the piece that
        // writes what was read.

        const { roots, input, resultSchema } = await standUpAndPark();
        await changeInput(input, 20);
        expect([serves(roots.first), serves(roots.middle), serves(roots.last)])
          .toEqual([false, false, false]);

        const { alice, result } = await watchLast(resultSchema);

        await waitForCellValue(
          alice,
          result.key("c"),
          (value: string | undefined) => value === "c:b:2",
          { stuckLabel: "alice to read what derives from the new input" },
        );
      });

      it("clears the marks of the two pieces after the first when the first derives the value it held", async () => {
        const { roots, input, resultSchema } = await standUpAndPark();
        await changeInput(input, 15);

        const { result } = await watchLast(resultSchema);
        await awaitEach(cycles, () => serves(roots.first));
        await host!.whenQuiescent();

        expect([
          await markOf(roots.first),
          await markOf(roots.middle),
          await markOf(roots.last),
        ]).toEqual([0, 0, 0]);
        expect(result.key("c").get()).toBe("c:b:1");
        expect(host!.stats().currency.falseClean).toBe(0);
      });

      it("starts nothing when the last is demanded and no input changed", async () => {
        const { roots, resultSchema } = await standUpAndPark();

        const { alice, result } = await watchLast(resultSchema);
        await waitForCellValue(
          alice,
          result.key("c"),
          (value: string | undefined) => value === "c:b:1",
          { stuckLabel: "alice to read the stored value" },
        );
        await host!.whenQuiescent();

        expect([serves(roots.first), serves(roots.middle), serves(roots.last)])
          .toEqual([false, false, false]);
      });

      it("starts the last piece alone when an input of the first changed, on what the store holds of the piece before it, and carries nothing, under `skip`", async () => {
        // A loop that keeps no index starts the same piece and derives the
        // same value.

        const { roots, input, resultSchema } = await standUpAndPark("skip");
        await changeInput(input, 20);

        const { alice, result } = await watchLast(resultSchema);
        await awaitEach(cycles, () => serves(roots.last));
        await waitForCellValue(
          alice,
          result.key("c"),
          (value: string | undefined) => value === "c:b:1",
          { stuckLabel: "alice to read what derives from the stored value" },
        );
        await host!.whenQuiescent();

        expect([serves(roots.first), serves(roots.middle)])
          .toEqual([false, false]);
        expect(host!.stats().currency.carried).toBe(0);
      });
    });
  });
});
