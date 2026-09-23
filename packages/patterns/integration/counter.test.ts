import { env, type Page } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
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
import { waitForText } from "./cfc-browser-helpers.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

/**
 * Opens the piece `pieceId` in the shell and waits until its counter has
 * rendered, answering the page it landed on.
 *
 * Every test that drives the page opens it here, which is what makes two
 * things true of each of them: no test depends on another having navigated,
 * and the errors a navigation raises fall inside the test that caused them.
 *
 * Waiting for the counter is what keeps this from answering mid-load. A test
 * handed a page that has not subscribed yet would write a value, see it on the
 * first paint, and take that for live propagation.
 */
async function openPiece(
  shell: ShellIntegration,
  pieceId: string,
  identity: Identity,
): Promise<Page> {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { spaceName: SPACE_NAME, pieceId },
    identity,
  });
  const page = shell.page();
  await page.waitForSelector("#counter-result", { strategy: "pierce" });
  return page;
}

describe("counter direct operations test", () => {
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
      "counter",
      "counter.tsx",
    );
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath },
    );
    piece = await cc.create(
      program, // We operate on the piece in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the piece reactive when inputs change.
    // Without this, setting values won't trigger pattern re-computation. The
    // sink also drives awaitResultValue: it records the latest committed value
    // and resolves a pending waiter when its target is reached.
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

  it("should load the counter piece and verify initial state", async () => {
    const page = await openPiece(shell, piece.id, identity);

    // Verify initial value is 0
    await waitForText(page, "#counter-result", "Counter is the 0th number");

    assertEquals(await piece.result.get(["value"]), 0);
  });

  it("should update counter value via direct operation (live)", async () => {
    const page = await openPiece(shell, piece.id, identity);

    await piece.result.set(42, ["value"]);

    await waitForText(page, "#counter-result", "Counter is the 42nd number");

    // Verify we can also read the value back
    await awaitResultValue(42);
  });

  it("should update counter value and verify after page refresh", async () => {
    let page = await openPiece(shell, piece.id, identity);

    await piece.result.set(42, ["value"]);
    await awaitResultValue(42);

    // The open page has already taken the write live, so it reads "42nd"
    // before the reload and a reload that did not happen would satisfy the
    // assertion below as well as one that did. Stamp the document and require
    // the stamp to be gone, so what is read afterwards is a document built
    // from what was stored rather than the one that was already showing it.
    await page.evaluate("globalThis.__beforeReload = true");
    page = await openPiece(shell, piece.id, identity);
    assertEquals(
      await page.evaluate("globalThis.__beforeReload === true") as boolean,
      false,
      "Reloading should have replaced the document",
    );

    await waitForText(page, "#counter-result", "Counter is the 42nd number");
  });
});
