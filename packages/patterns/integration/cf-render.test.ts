import {
  env,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickNthCfButton,
  readTextProbe,
  settleView,
  waitForSettledText,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { debugStr } from "@commonfabric/data-model";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

/**
 * Opens `piece`'s view in `shell`'s page as `identity`.
 *
 * Every test that drives the view calls this, and calls it inside its own
 * body. A run can be given one test of this file and none of its neighbors,
 * and the suite's console-error check covers the shell's bootstrap and login
 * only for a navigation a test performs: `ShellIntegration` clears what it has
 * collected before each test and inspects it after.
 */
function gotoPiece(
  shell: ShellIntegration,
  piece: PieceController,
  identity: Identity,
): Promise<void> {
  return shell.goto({
    frontendUrl: FRONTEND_URL,
    view: {
      spaceName: SPACE_NAME,
      pieceId: piece.id,
    },
    identity,
  });
}

describe("cf-render integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let pieceSinkCancel: (() => void) | undefined;
  // The piece's committed result value, tracked by the result-cell sink below,
  // and a one-shot waiter the sink resolves when the value reaches a target.
  let latestResultValue: number | undefined;
  let resultWaiter: { target: number; deferred: Deferred } | undefined;

  // Resolve once the piece's committed result value equals `target`. The sink
  // fires with the current value on registration and on every committed change,
  // so a value already at the target resolves immediately; otherwise the sink
  // resolves the waiter when the target lands.
  const awaitResultValue = (target: number): Promise<void> => {
    if (latestResultValue === target) return Promise.resolve();
    const deferred = defer();
    resultWaiter = { target, deferred };
    return deferred.promise;
  };

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    piece = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "cf-render.tsx",
        ),
      ),
      // We operate on the piece in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the piece reactive when inputs
    // change. The sink also drives awaitResultValue: it records the latest
    // committed value and resolves a pending waiter when its target is
    // reached.
    const resultCell = cc.getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink((value) => {
      latestResultValue = (value as { value?: number } | undefined)?.value;
      if (resultWaiter && latestResultValue === resultWaiter.target) {
        resultWaiter.deferred.resolve();
        resultWaiter = undefined;
      }
    });
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("should load the nested counter piece and verify initial state", async () => {
    const page = shell.page();
    await gotoPiece(shell, piece, identity);

    await waitForText(page, "#counter-result", "Counter is the 0th number");

    // Verify via direct operations that the cf-render structure works
    assertEquals(await piece.result.get(["value"]), 0);
  });

  it("should click the increment button and update the counter", async () => {
    const page = shell.page();
    await gotoPiece(shell, piece, identity);

    // Click increment button (second button - first is decrement)
    await clickNthCfButton(page, "[data-cf-button]", 1);

    // Wait for the piece result to reflect the increment.
    await awaitResultValue(1);
    assertEquals(await piece.result.get(["value"]), 1);
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();
    await gotoPiece(shell, piece, identity);
    // `gotoPiece` returns once the view matches and the login lands, which is
    // before the view is drawn. Settling is what puts the write after a drawn
    // view rather than racing it.
    await settleView(page);

    await piece.result.set(5, ["value"]);

    // Verify we can read the value back via operations
    assertEquals(
      await piece.result.get(["value"]),
      5,
      "Value should be 5 in backend",
    );

    // The display is the effect of a write this page did not make, so the wait
    // settles the page on each check rather than only watching the DOM. The
    // counter is at 0 or at 1 when this test starts, so the wait has a change
    // to observe.
    await waitForSettledText(
      page,
      "#counter-result",
      "Counter is the 5th number",
    );
  });

  it("should verify exactly THREE counters display", async () => {
    const page = shell.page();

    // The view is opened and drawn before the write, and the order matters on
    // both counts. Under server execution a write issued before this suite has
    // navigated is refused, its read basis naming speculative overlay layers
    // that exist only in this process. And a wait reads its condition once
    // when it is installed, so a write that landed first would leave nothing
    // for the wait below to observe. 7 is this test's own value, which no
    // other test in the file writes.
    await gotoPiece(shell, piece, identity);
    await settleView(page);
    await piece.result.set(7, ["value"]);

    // The piece renders one counter three ways: inline, as a component, and
    // through cf-render. All three read the same cell, so all three are
    // present and reading the written value, which is what makes the
    // cf-render route equivalent to the other two.
    const expected = "Counter is the 7th number";
    try {
      await waitForCondition(page, async (probe: ProbeApi, want: string) => {
        const settle = (globalThis as typeof globalThis & {
          commonfabric?: { viewSettled?: () => Promise<void> };
        }).commonfabric?.viewSettled;
        if (!settle) return false;
        await settle();
        const results = probe.collect("#counter-result");
        return results.length === 3 &&
          results.every((result) => probe.deepText(result).trim() === want);
      }, { args: [expected] });
    } catch (cause) {
      const seen = await readTextProbe(page, "#counter-result")
        .catch(() => undefined);
      throw new Error(
        debugStr`Expected three #counter-result elements reading $quote${expected}; saw $quote,indent,long${seen}`,
        { cause },
      );
    }
  });
});

/**
 * Tests for cf-render subpath behavior.
 *
 * This tests the fix where subpath cells like .key("sidebarUI") that
 * intentionally return undefined were being incorrectly blocked by the
 * async-loading detection logic.
 *
 * Root cells (path=[]) wait for undefined to become defined (async loading).
 * Subpath cells (path=["key"]) render immediately even if undefined.
 */
describe("cf-render subpath handling", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    piece = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "cf-render-subpath.tsx",
        ),
      ),
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should render main UI without blocking on undefined sidebarUI", async () => {
    // This test verifies the fix for the cf-render regression.
    // Before the fix, cf-render would wait forever for undefined subpath cells
    // like .key("sidebarUI") to become defined, blocking the main UI.
    const page = shell.page();
    await gotoPiece(shell, piece, identity);

    // The main UI should render despite sidebarUI being undefined
    await waitForText(page, "#main-ui", "This is the main UI");

    // Verify the title is rendered
    await waitForText(page, "h1", "Test Pattern");
  });

  it("should verify [TILE_UI] exists in the pattern", async () => {
    // Verify the tile variant exists (a valid subpath property)
    const tileUI = await piece.result.get(["$TILE_UI"]);
    assertEquals(
      typeof tileUI,
      "object",
      "[TILE_UI] should be a VNode object",
    );
  });

  it("should render correctly without sidebarUI property", async () => {
    // This test verifies that the pattern renders even though sidebarUI
    // is not defined (or defined as undefined). The cf-render fix ensures
    // that subpath cells like .key("sidebarUI") don't block the main render.
    const page = shell.page();
    await gotoPiece(shell, piece, identity);

    // The main UI should be visible - this proves rendering wasn't blocked
    await waitForText(page, "#main-ui", "This is the main UI");

    // Verify the paragraph is visible
    await waitForText(page, "p", "sidebarUI is intentionally undefined");
  });
});
