// Plan B end-to-end: a renderer $value keystroke write to a cell a pattern
// watches has its subscriber wake routed through the cell-notification shaper
// (held out of the scheduler, released coarsened), while an ordinary internal
// write is not shaped. Either way the dependent computed re-runs with the latest
// value after idle() — nothing is lost, only the wake timing is coarsened.
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import { markRendererInputTx, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

const ROOT = join(import.meta.dirname!, "..");

describe("cell-flip shaping (plan B)", () => {
  let cc: PiecesController;
  let cancel: (() => void) | undefined;

  beforeEach(async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = createSession({
      identity,
      spaceDid: (await Identity.generate({ implementation: "noble" })).did(),
    });
    const runtime = new Runtime({
      apiUrl: new URL("http://localhost:8000/"),
      storageManager: StorageManager.emulate({ as: session.as }),
      trustSnapshotProvider: () => ({
        id: `principal:${session.as.did()}`,
        actingPrincipal: session.as.did(),
      }),
    });
    cc = new PiecesController(session, runtime);
    await cc.synced();
  });

  afterEach(async () => {
    cancel?.();
    await cc.dispose();
  });

  it("shapes a renderer-input write's wake but not an internal write's", async () => {
    const runtime = cc.runtime;
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: join(ROOT, "integration/fixtures/shape-input-echo.tsx"),
        root: ROOT,
      },
    );
    const piece = await cc.create(program, { start: true });
    const result = cc.getResult(piece.getCell());
    cancel = result.sink(() => {}); // materialize the computed
    await runtime.idle();
    const doubled = () => result.key("doubled").get();
    const nCell = result.key("n");

    // --- Internal (non-renderer) write: NOT shaped. ---
    const itx = runtime.edit();
    nCell.withTx(itx).set(3);
    itx.commit();
    expect(runtime.scheduler.hasPendingShapedCellNotifications()).toBe(false);
    await runtime.idle();
    expect(doubled()).toBe(6);

    // --- Renderer-input write: the dependent computed's wake is shaped. ---
    const rtx = runtime.edit();
    markRendererInputTx(rtx);
    nCell.withTx(rtx).set(5);
    rtx.commit();
    // The wake is held out of the scheduler; the computed has not re-run yet.
    expect(runtime.scheduler.hasPendingShapedCellNotifications()).toBe(true);
    expect(doubled()).toBe(6);
    // idle() waits for the shaper to release; the computed then re-runs current.
    await runtime.idle();
    expect(runtime.scheduler.hasPendingShapedCellNotifications()).toBe(false);
    expect(doubled()).toBe(10);
  });
});
