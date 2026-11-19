import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { selectCurrencyPiece } from "@commonfabric/memory/v2/currency-index";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { ExecutorHost } from "../../src/executor/host.ts";
import type { CurrencyIndexMode } from "../../src/executor/store-currency.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";
import { sessionDemandOf } from "../support/session-demand.ts";

const spaceSigner = await Identity.fromPassphrase(
  "space-server currency space",
);
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server currency service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server currency setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server currency alice",
);

// A piece with one derived output, `out`, three times its `value`.
const TRIPLER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "",
      "export default pattern<{ value: number }, { out: number }>(",
      "  ({ value }) => ({ out: computed(() => value * 3) }),",
      ");",
    ].join("\n"),
  }],
};

/** One demanded document: a watch root, or a document a selector reaches. */
type Demanded = { link: NormalizedFullLink; root: boolean };

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let servingRuntime: Runtime | undefined;
  let cycles: ArrivalLog<unknown>;
  let demanded: Demanded[];
  const opened: { runtime: Runtime; manager: EmulatedStorageManager }[] = [];

  /** A runtime over the shared server, acting for `as`, that runs nothing. */
  const openRuntime = (as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: false },
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
    servingRuntime = undefined;
    cycles = new ArrivalLog();
    demanded = [];
    // The demand is the documents each case names, as one session of alice's
    // demands them.
    (server as { demandForSpace: unknown }).demandForSpace = () =>
      sessionDemandOf(
        demanded.map(({ link, root }) => ({
          id: link.id,
          scope: "space" as const,
          scopeKey: "space" as const,
          root,
          identity: { principal: aliceSigner.did(), sessionId: "viewer" },
        })),
      );
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
  const newHost = (mode: CurrencyIndexMode | undefined): ExecutorHost =>
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
        servingRuntime = runtime;
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
        ...(mode !== undefined && { currencyIndex: mode }),
      },
      onWaveCycle: cycles.record,
    });

  /**
   * Makes `documents` the space's whole demand, once the host serves the
   * space, and has its serving loop read it.
   */
  const demand = async (...documents: Demanded[]) => {
    await awaitEach(cycles, () => host?.spaceServer(space) !== undefined);
    demanded = documents;
    host!.spaceServer(space)!.noteDemandChanged();
  };

  /** Whether the serving runtime runs the piece rooted at `root`. */
  const serves = (root: NormalizedFullLink) =>
    servingRuntime?.runner.isRunning(servingRuntime.getCellFromLink(root)) ===
      true;

  /** What the currency index holds of the piece rooted at `root`. */
  const recordOf = async (root: NormalizedFullLink) =>
    selectCurrencyPiece(await server.engineForSpace(space), {
      piece: root.id,
    });

  /** Resolves once the serving loop is at rest with its records stored. */
  const settled = async () => {
    await host!.spaceServer(space)!.whenQuiescent();
  };

  /**
   * Sets up the tripler with `value` 2 as a runtime that then stops it, so
   * the store holds `out` as 6 with nothing running. Returns its root and
   * the document that holds `out`.
   */
  const setUpTripler = async (): Promise<
    { root: NormalizedFullLink; out: NormalizedFullLink }
  > => {
    const setup = openRuntime(setupSigner);
    const compiled = await setup.patternManager.compilePattern(
      TRIPLER_PROGRAM,
      { space },
    );
    const argument = setup.getCell<{ value: number }>(
      space,
      "currency tripler argument",
      compiled.argumentSchema,
    );
    const result = setup.getCell<{ out: number }>(
      space,
      "currency tripler result",
      compiled.resultSchema,
    );
    const tx = setup.edit();
    argument.withTx(tx).set({ value: 2 });
    setup.run(tx, compiled, argument, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    const out = result.key("out").resolveAsCell().getAsNormalizedFullLink();
    setup.runner.stop(result);
    await setup.idle();
    await setup.storageManager.synced();
    await closeLastRuntime();
    return {
      root: result.getAsNormalizedFullLink(),
      out: { ...out, path: [] } as NormalizedFullLink,
    };
  };

  /** Sets the tripler's `value`, as a runtime that runs nothing. */
  const setValue = async (value: number) => {
    const writer = openRuntime(setupSigner);
    const argument = writer.getCell<{ value: number }>(
      space,
      "currency tripler argument",
      { type: "object", properties: { value: { type: "number" } } },
    );
    await argument.sync();
    const tx = writer.edit();
    argument.withTx(tx).key("value").set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /** Resolves with the tripler's stored `out` once it is `expected`. */
  const outIs = async (expected: number) => {
    const reader = openRuntime(aliceSigner);
    const result = reader.getCell<{ out: number }>(
      space,
      "currency tripler result",
      { type: "object", properties: { out: { type: "number" } } },
    );
    await result.sync();
    await waitForCellValue(
      reader,
      result.key("out"),
      (out: number | undefined) => out === expected,
      { stuckLabel: `the tripler's \`out\` to be ${expected}` },
    );
    await closeLastRuntime();
  };

  let touches = 0;

  /** Commits a write to a document no piece reads. */
  const touchSpace = async () => {
    const writer = openRuntime(setupSigner);
    const cell = writer.getCell<number>(space, "currency touch", {
      type: "number",
    });
    await cell.sync();
    const tx = writer.edit();
    cell.withTx(tx).set(++touches);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /**
   * Serves the tripler until it has settled with `out` demanded, then parks
   * the space, so the next tenure starts from what the first one recorded.
   */
  const serveAndPark = async (
    piece: { root: NormalizedFullLink; out: NormalizedFullLink },
  ) => {
    await demand(
      { link: piece.root, root: true },
      { link: piece.out, root: false },
    );
    await awaitEach(cycles, () => serves(piece.root));
    await settled();
    await host!.spaceServer(space)!.park("test-park");
  };

  describe("instance members", () => {
    describe("serving a session's own watches", () => {
      it("judges servable a settled piece that a session watches through its result schema, and finds no false judgment, under `record`", async () => {
        // The demand here is the memory server's own reading of a client's
        // watches, where every other case hands the loop its rows.

        delete (server as { demandForSpace?: unknown }).demandForSpace;
        host = newHost("record");
        const manager = EmulatedStorageManager.connectTo(server, {
          as: aliceSigner,
        });
        const alice = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        opened.push({ runtime: alice, manager });
        const compiled = await alice.patternManager.compilePattern(
          TRIPLER_PROGRAM,
          { space },
        );
        const argument = alice.getCell<{ value: number }>(
          space,
          "currency watched argument",
          compiled.argumentSchema,
        );
        const result = alice.getCell<{ out: number }>(
          space,
          "currency watched result",
          compiled.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const tx = alice.edit();
        argument.withTx(tx).set({ value: 2 });
        alice.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        const root = result.getAsNormalizedFullLink();
        await awaitEach(
          cycles,
          () => host!.stats().currency.recordsStored > 0 && serves(root),
        );
        await settled();
        expect(await recordOf(root)).toEqual({ mark: 0, epoch: "" });
        await host.spaceServer(space)!.park("test-park");

        await touchSpace();
        await awaitEach(cycles, () => serves(root));
        await settled();

        expect(host.stats().currency.servable).toBe(1);
        expect(host.stats().currency.falseClean).toBe(0);
        cancel();
      });
    });

    describe("noteDemandChanged()", () => {
      it("records nothing of a piece it starts where the policy keeps no currency index", async () => {
        host = newHost(undefined);
        const piece = await setUpTripler();
        await demand(
          { link: piece.root, root: true },
          { link: piece.out, root: false },
        );

        await awaitEach(cycles, () => serves(piece.root));
        await settled();

        expect(await recordOf(piece.root)).toBeUndefined();
        expect(host.stats().currency).toEqual({
          recordsStored: 0,
          servable: 0,
          servedFromStore: 0,
          rearmed: 0,
          falseClean: 0,
        });
      });

      it("records clean a piece that settled, under `record`", async () => {
        host = newHost("record");
        const piece = await setUpTripler();
        await demand(
          { link: piece.root, root: true },
          { link: piece.out, root: false },
        );

        await awaitEach(cycles, () => serves(piece.root));
        await settled();

        expect(await recordOf(piece.root)).toEqual({ mark: 0, epoch: "" });
        expect(host.stats().currency.servable).toBe(0);
      });

      it("starts a piece the store could serve, counts it, and finds no false judgment, under `record`", async () => {
        host = newHost("record");
        const piece = await setUpTripler();
        await serveAndPark(piece);

        await touchSpace();
        await awaitEach(cycles, () => serves(piece.root));
        await settled();

        expect(host.stats().currency.servable).toBe(1);
        expect(host.stats().currency.servedFromStore).toBe(0);
        expect(host.stats().currency.falseClean).toBe(0);
      });

      it("leaves unstarted a piece whose record is clean and vouches for what is demanded, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);

        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        await settled();

        expect(serves(piece.root)).toBe(false);
        await outIs(6);
      });

      it("starts a recorded piece whose input changed while nothing served the space, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);

        await setValue(5);
        await awaitEach(cycles, () => serves(piece.root));

        expect(host.stats().currency.servedFromStore).toBe(0);
        await outIs(15);
      });

      it("starts a piece left unstarted when an input of it changes, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);
        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        expect(serves(piece.root)).toBe(false);

        await setValue(5);
        await awaitEach(cycles, () => serves(piece.root));

        expect(host.stats().currency.rearmed).toBe(1);
        await outIs(15);
      });

      it("starts a recorded piece when a session demands an output it never vouched for, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await demand({ link: piece.root, root: true });
        await awaitEach(cycles, () => serves(piece.root));
        await settled();
        await host.spaceServer(space)!.park("test-park");

        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        expect(serves(piece.root)).toBe(false);
        await demand(
          { link: piece.root, root: true },
          { link: piece.out, root: false },
        );

        await awaitEach(cycles, () => serves(piece.root));
        expect(host.stats().currency.rearmed).toBe(1);
      });
    });
  });
});
