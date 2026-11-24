import {
  createTestSpace,
  type ElementHandle,
  env,
  type Page,
} from "@commonfabric/integration";
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
import { waitForText } from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

type Result = { rows?: { name: string }[]; dragged?: string[] };

/** The center of an element's box, in the viewport. */
async function centerOf(
  element: ElementHandle,
): Promise<{ x: number; y: number }> {
  const box = await element.boundingBox();
  if (!box) throw new Error("the element has no box to aim at");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The `selector` element whose text is `text`, once one shows it. */
async function elementShowing(
  page: Page,
  selector: string,
  text: string,
): Promise<ElementHandle> {
  await waitForText(page, selector, text);
  for (const element of await page.$$(selector, { strategy: "pierce" })) {
    if ((await element.innerText()).trim() === text) return element;
  }
  throw new Error(`no ${selector} shows "${text}"`);
}

describe("drag-reorder-list", () => {
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
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "fixtures", "drag-reorder-list.tsx"),
      },
    );
    piece = await cc.create(program, { start: true });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("drags the row a source shows after the list has been reordered", async () => {
    // A `.map()` row keeps its drag source while the list moves a different
    // entry into that row. The source has to drag the entry it shows now, not
    // the one it was first bound to, so the second drag below, of the row that
    // the first drag moved to the top, must name that row as dragged.

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: cc.getSpace(), pieceId: piece.id },
      identity,
    });
    const page = shell.page();

    let latest: Result = {};
    let reached: {
      done: (result: Result) => boolean;
      deferred: ReturnType<typeof defer<Result>>;
    } | undefined;
    const cancelSink = cc.getResult(piece.getCell()).sink((value) => {
      const result = value as Result | undefined;
      latest = {
        rows: result?.rows?.map(({ name }) => ({ name })),
        dragged: result?.dragged ? [...result.dragged] : undefined,
      };
      if (reached?.done(latest)) reached.deferred.resolve(latest);
    });
    /** The result once it has had `count` drops. */
    const afterDrops = (count: number): Promise<Result> => {
      const deferred = defer<Result>();
      const done = (result: Result) => (result.dragged?.length ?? 0) >= count;
      reached = { done, deferred };
      if (done(latest)) deferred.resolve(latest);
      return deferred.promise;
    };
    const onPageError = (event: Event) =>
      reached?.deferred.reject(
        new Error(
          `the page threw during the drop: ${
            (event as CustomEvent<{ message: string }>).detail.message
          }`,
        ),
      );
    page.addEventListener("pageerror", onPageError);

    /** Drags the row showing `from` onto the row showing `to`. */
    const drag = async (from: string, to: string) => {
      const start = await centerOf(
        await elementShowing(page, "cf-drag-source", from),
      );
      const end = await centerOf(
        await elementShowing(page, "cf-drop-zone", to),
      );
      const mouse = page.astralPage.mouse;
      await mouse.move(start.x, start.y);
      await mouse.down();
      await mouse.move(end.x, end.y, { steps: 10 });
      await mouse.up();
    };

    try {
      await drag("C", "A");
      const first = await afterDrops(1);
      expect(first.dragged).toEqual(["C"]);
      expect(first.rows).toEqual([{ name: "C" }, { name: "A" }, {
        name: "B",
      }]);

      // The top row now shows C, in the row that A was rendered into.
      await waitForText(page, "cf-drag-source", "C");
      await drag("C", "B");
      const second = await afterDrops(2);
      expect(second.dragged).toEqual(["C", "C"]);
      expect(second.rows).toEqual([{ name: "A" }, { name: "B" }, {
        name: "C",
      }]);
    } finally {
      page.removeEventListener("pageerror", onPageError);
      cancelSink();
    }
  });
});
