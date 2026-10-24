import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("pattern-pointer-followed");
const space = signer.did();

const V1 = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v1' };",
  "});",
  "",
].join("\n");

const V2 = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v2' };",
  "});",
  "",
].join("\n");

const V3 = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v3' };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

type PieceCell = Cell<Record<string, unknown>>;

const markerOf = (cell: PieceCell): string =>
  (cell.getAsQueryResult() as { marker: string }).marker;

describe("Runner.patternPointerFollowed()", () => {
  // Each case moves a running piece's pointer to a pattern its runtime has
  // never evaluated, so the watcher loads it from the store and names what it
  // reads before it swaps. The naming step is held open through the runner's
  // `dependencySyncer` test seam, which keeps the watcher's follow in flight
  // for as long as a case needs it to be.

  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let rt: Runtime;
  // Releases a naming step a case held open, so teardown can settle the
  // watcher chain even when an assertion failed before the case released it.
  let releaseHeld: (() => void) | undefined;

  beforeEach(() => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });

  afterEach(async () => {
    rt.runner.accessForTestingOnly.dependencySyncer = undefined;
    releaseHeld?.();
    releaseHeld = undefined;
    await rt.runner.idlePointerMaintenance();
    await rt.dispose();
    await manager.close();
    await server.close();
  });

  // The pattern is compiled and persisted by a runtime of its own, through a
  // replica of its own, so `rt` has never evaluated it.
  const persistV2 = (): Promise<string> => persist(V2);
  const persist = async (contents: string): Promise<string> => {
    const otherManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const other = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherManager,
    });
    try {
      const tx = other.edit();
      const pattern = await other.patternManager.compilePattern(
        programOf(contents),
        { space, tx },
      );
      const identity =
        other.patternManager.getArtifactEntryRef(pattern)!.identity;
      other.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await other.idle();
      await other.patternManager.flushCompileCacheWrites();
      await other.storageManager.synced();
      return identity;
    } finally {
      await other.dispose();
      await otherManager.close();
    }
  };

  const runV1 = async (cause: string): Promise<PieceCell> => {
    const tx = rt.edit();
    const v1 = await rt.patternManager.compilePattern(programOf(V1), {
      space,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, {}, cell);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await running.pull();
    expect(markerOf(cell)).toBe("v1");
    return cell;
  };

  // Holds the next naming step open. `entered` resolves once the step has
  // been entered, and `release` lets it proceed.
  const holdNextNaming = () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let held = false;
    rt.runner.accessForTestingOnly.dependencySyncer = async (
      target,
      pattern,
      inputs,
      sync,
    ) => {
      if (held) return sync(target, pattern, inputs);
      held = true;
      enter();
      await released;
      return sync(target, pattern, inputs);
    };
    releaseHeld = release;
    return { entered, release };
  };

  // Holds every naming step open. `entered(n)` resolves once the step of
  // index `n` has been entered, and `release` lets them all proceed.
  const holdEveryNaming = () => {
    const released = Promise.withResolvers<void>();
    const steps: PromiseWithResolvers<void>[] = [];
    const step = (n: number) => (steps[n] ??= Promise.withResolvers<void>());
    let entries = 0;
    rt.runner.accessForTestingOnly.dependencySyncer = async (
      target,
      pattern,
      inputs,
      sync,
    ) => {
      step(entries++).resolve();
      await released.promise;
      return sync(target, pattern, inputs);
    };
    releaseHeld = released.resolve;
    return {
      entered: (n: number) => step(n).promise,
      release: released.resolve,
    };
  };

  // Moves the pointer and lets the watcher observe the move.
  const repoint = async (cell: PieceCell, identity: string) => {
    const tx = rt.edit();
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity,
      symbol: "default",
    }, rawMetaWriteAuthorization);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
  };

  // Whether `promise` has settled, read through a flag its settlement sets.
  const settlementOf = (promise: Promise<void>) => {
    const state = { settled: false };
    void promise.then(() => {
      state.settled = true;
    });
    return state;
  };

  it("resolves once the watcher has swapped in the pattern the pointer moved to", async () => {
    const v2Identity = await persistV2();
    const cell = await runV1("followed-after-swap");
    const hold = holdNextNaming();
    await repoint(cell, v2Identity);

    // The follow is in flight with its naming step held. A call that returned
    // without waiting would have settled by the time the step was entered,
    // which is several turns after the call.
    const followed = rt.runner.patternPointerFollowed(cell);
    const state = settlementOf(followed);
    await hold.entered;
    await rt.idle();
    expect(state.settled).toBe(false);
    expect(markerOf(cell)).toBe("v1");

    hold.release();
    await followed;
    await cell.pull();
    expect(markerOf(cell)).toBe("v2");
  });

  it("resolves for a piece whose pointer has not moved while another piece's follow is in flight", async () => {
    const v2Identity = await persistV2();
    const moved = await runV1("followed-moved");
    const unmoved = await runV1("followed-unmoved");
    const hold = holdNextNaming();
    await repoint(moved, v2Identity);
    await hold.entered;

    const state = settlementOf(rt.runner.patternPointerFollowed(unmoved));
    await rt.idle();
    expect(state.settled).toBe(true);

    // The moved piece's follow was still held when that settled.
    expect(markerOf(moved)).toBe("v1");
  });

  it("resolves when the piece is stopped with a follow in flight", async () => {
    const v2Identity = await persistV2();
    const cell = await runV1("followed-stopped-mid-follow");
    const hold = holdNextNaming();
    await repoint(cell, v2Identity);
    await hold.entered;

    const state = settlementOf(rt.runner.patternPointerFollowed(cell));
    await clock.settle();
    expect(state.settled).toBe(false);

    // The naming step stays held, so the follow has not settled when the
    // wait does.
    rt.runner.stop(cell);
    await clock.settle();
    expect(state.settled).toBe(true);
  });

  it("resolves at once for a piece stopped with a follow in flight", async () => {
    const v2Identity = await persistV2();
    const cell = await runV1("followed-after-stop-mid-follow");
    const hold = holdNextNaming();
    await repoint(cell, v2Identity);
    await hold.entered;
    rt.runner.stop(cell);

    // The naming step stays held, so the stopped watcher's follow is still
    // in flight when the wait is asked for.
    const state = settlementOf(rt.runner.patternPointerFollowed(cell));
    await clock.settle();
    expect(state.settled).toBe(true);
  });

  it("stays pending for a piece stopped and started again whose new watcher has a follow in flight", async () => {
    // The restart goes through a cell whose transaction read the pointer
    // before it moved, so it instantiates the pattern the piece was running
    // while the pointer names one the runtime has never evaluated. The new
    // watcher begins its follow as it is installed, in the turn of the stop,
    // which is before the wait's continuation runs.

    const v2Identity = await persistV2();
    const v3Identity = await persist(V3);
    const cell = await runV1("followed-restarted-mid-follow");
    const readTx = rt.edit();
    try {
      const stale = cell.withTx(readTx);
      const pointerBefore = stale.getMetaRaw("patternIdentity");
      const hold = holdEveryNaming();
      await repoint(cell, v2Identity);
      await hold.entered(0);

      const followed = rt.runner.patternPointerFollowed(cell);
      const state = settlementOf(followed);

      // No turn passes between the pointer's second move and the restart,
      // so the stopped watcher never observes that move.
      const tx = rt.edit();
      cell.withTx(tx).setMetaRaw("patternIdentity", {
        identity: v3Identity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
      rt.prepareTxForCommit(tx);
      const committed = tx.commit().settled;
      expect(stale.getMetaRaw("patternIdentity")).toEqual(pointerBefore);
      rt.runner.stop(stale);
      const started = rt.runner.start(stale);

      expect((await committed).error).toBeUndefined();
      expect(await started).toBe(true);
      await hold.entered(1);
      await clock.settle();
      expect(state.settled).toBe(false);
      expect(markerOf(cell)).toBe("v1");

      hold.release();
      await followed;
      await cell.pull();
      expect(markerOf(cell)).toBe("v3");
    } finally {
      readTx.abort();
    }
  });

  it("resolves for a piece that is not running", async () => {
    const cell = await runV1("followed-stopped");
    rt.runner.stop(cell);

    const state = settlementOf(rt.runner.patternPointerFollowed(cell));
    await rt.idle();
    expect(state.settled).toBe(true);
  });
});
