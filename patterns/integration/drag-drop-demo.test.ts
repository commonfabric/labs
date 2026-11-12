import { createTestSpace, env, type Page } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;

type Item = { title: string };

/** The center of the first element `selector` pierces to, in the viewport. */
async function centerOf(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number }> {
  const element = await page.waitForSelector(selector, { strategy: "pierce" });
  const box = await element.boundingBox();
  if (!box) throw new Error(`"${selector}" has no box to aim at`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe("drag-drop-demo", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: await createTestSpace(identity),
      apiUrl: new URL(API_URL),
      identity,
    });
    // The demo imports the counter example beside it, so the program is
    // rooted at the patterns tree rather than at the demo's own directory.
    const rootPath = join(import.meta.dirname!, "..");
    const sourcePath = join(
      rootPath,
      "examples",
      "drag-drop-demo",
      "drag-drop-demo.tsx",
    );
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    piece = await cc.create(program, { start: true });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("hands the drop handler the dragged item's cell when an item is dropped with the pointer", async () => {
    // The drop crosses from the page to the worker as a `cf-drop` event whose
    // detail names the dragged cell, and the handler reads that cell to append
    // the item it holds. The drag is a real pointer gesture, so the event goes
    // through the drop zone's own detail, the applicator's listener, and the
    // connection's encoding; a page exception on the way would mean the
    // handler never ran, so one ends the wait rather than leaving it to time
    // out.
    //
    // The demo's items are a `computed()`, so the dragged cell is a computed
    // cell's element rather than a stored one.

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: cc.getSpace(), pieceId: piece.id },
      identity,
    });
    const page = shell.page();

    const dropped = defer<Item[]>();
    const cancelSink = cc.getResult(piece.getCell()).sink((value) => {
      const items = (value as { droppedItems?: Item[] } | undefined)
        ?.droppedItems;
      if (items && items.length > 0) {
        dropped.resolve(items.map(({ title }) => ({ title })));
      }
    });
    const onPageError = (event: Event) =>
      dropped.reject(
        new Error(
          `the page threw during the drop: ${
            (event as CustomEvent<{ message: string }>).detail.message
          }`,
        ),
      );
    page.addEventListener("pageerror", onPageError);

    try {
      const from = await centerOf(page, "cf-drag-source:nth-of-type(3)");
      const to = await centerOf(page, "cf-drop-zone");
      const mouse = page.astralPage.mouse;
      await mouse.move(from.x, from.y);
      await mouse.down();
      await mouse.move(to.x, to.y, { steps: 10 });
      await mouse.up();

      expect(await dropped.promise).toEqual([{ title: "Item C" }]);
    } finally {
      page.removeEventListener("pageerror", onPageError);
      cancelSink();
    }
  });
});
