import { env, Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import {
  clickNthCfButton,
  settleView,
  waitForSettledText,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("nested counter integration test", () => {
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
  // resolves the waiter when the target lands. A fresh deferred per call keeps
  // the sequential value checks independent.
  const awaitResultValue = (target: number): Promise<void> => {
    if (latestResultValue === target) return Promise.resolve();
    const deferred = defer();
    resultWaiter = { target, deferred };
    return deferred.promise;
  };

  // Load the piece's view in the browser. Every test calls this for itself,
  // because each has to pass as the only test running in its file. Calling it
  // from a test rather than from a suite hook also keeps the console errors
  // the load reports under that test's check: `ShellIntegration` clears them
  // in a `beforeEach`, which runs after a suite's `beforeAll`.
  const showPiece = (): Promise<void> =>
    shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "examples",
      "nested-counter.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );

    piece = await cc.create(
      program, // We operate on the piece in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the piece reactive when inputs change.
    // The sink also drives awaitResultValue: it records the latest committed
    // value and resolves a pending waiter when its target is reached.
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
    await showPiece();

    await waitForText(page, "#counter-result", "Counter is the 0th number");

    // Verify via direct operations that the nested structure works
    assertEquals(await piece.result.get(["value"]), 0);
  });

  it("should click the increment button and update the counter", async () => {
    const page = shell.page();
    await showPiece();
    await settleView(page);

    // The text below counts up from this value, so the test writes it rather
    // than reading whatever the counter happens to hold. The write follows the
    // navigation: one that precedes it is refused on the server-execution arm
    // for naming this process's own speculation.
    await piece.result.set(0, ["value"]);
    await waitForCounter(page, "Counter is the 0th number");

    // Click increment button (second button - first is decrement)
    await clickNthCfButton(page, "[data-cf-button]", 1);

    // Wait for the piece result to reflect the increment.
    await awaitResultValue(1);
    await waitForCounter(page, "Counter is the 1st number");
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();
    await showPiece();
    await settleView(page);

    // Set value to 5 via direct operation
    await piece.result.set(5, ["value"]);

    // Verify we can read the value back via operations
    assertEquals(
      await piece.result.get(["value"]),
      5,
      "Value should be 5 in backend",
    );

    // The counter was on screen before the write, so this is the write
    // reaching an open view rather than a fresh load reading stored state.
    await waitForCounter(page, "Counter is the 5th number");
  });

  it("should verify nested counter has multiple counter displays", async () => {
    const page = shell.page();
    await showPiece();
    await settleView(page);

    // A number no other test writes, so both displays carrying it is this
    // test's own doing.
    await piece.result.set(7, ["value"]);

    // The pattern renders one counter twice over one cell, so both displays
    // reach the written value. Two displays agreeing on a number neither of
    // them moved to would not show that they share a cell. The predicate
    // settles the view on each check, the rendering being the effect of the
    // write above and nothing else driving the page between checks.
    await waitForCondition(page, async (probe, expected) => {
      const settle = (globalThis as typeof globalThis & {
        commonfabric?: { viewSettled?: () => Promise<void> };
      }).commonfabric?.viewSettled;
      if (!settle) return false;
      await settle();
      const results = probe.collect("#counter-result");
      return results.length === 2 &&
        results.every((el) => probe.deepText(el).trim() === expected);
    }, { args: ["Counter is the 7th number"] });
  });
});

// The counter text every test below waits for is the effect of a write or a
// click, so each check settles the view rather than watching the DOM alone.
async function waitForCounter(page: Page, text: string) {
  await waitForSettledText(page, "#counter-result", text);
}
