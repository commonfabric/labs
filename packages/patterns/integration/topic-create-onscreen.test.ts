/**
 * What one more topic costs, with and without a browser rendering the board.
 *
 * Two boards in one space, filled one topic at a time in lockstep: the browser
 * is routed at the first and never at the second, so a pair of measurements
 * taken back to back differ only in whether a live view had to keep up. The
 * alternation is what makes the pair readable on a machine whose background
 * load drifts — batching one board and then the other would charge the second
 * for whatever else the machine started doing meanwhile.
 *
 * Each on-screen create is split where the work changes hands: the write and
 * the authoring runtime's settle, then the additional wait until the new card's
 * title is in the browser's DOM. So the same run answers both "does a live view
 * slow the write down" and "how long after the write does the card appear".
 *
 * `CF_TOPICS_ONSCREEN_SIZE` sets how many topics each board ends up with, and
 * `CF_TOPICS_ONSCREEN_RENDER=0` is the control: the browser sits on the space
 * root and renders neither board, so the same run says what the harness costs
 * with nothing on screen and the rendered run is read against it.
 * `CF_TOPICS_ONSCREEN_DEMAND` decides what the authoring client holds live
 * while it files — the one knob here that can make the harness measure itself
 * rather than the product.
 *
 * Measurements are emitted as single parseable lines carrying the index they
 * were taken at, so a sweep across sizes can be collected without re-reading
 * logs by eye.
 */

import { type DID, Identity } from "@commonfabric/identity";
import { createTestSpace, env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  collectBrowserLoadSummary,
  logBrowserLoadSummary,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { demandTopicBoard } from "./topic-board-fixture.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

/**
 * Topics per board. Small by default; an investigation asks for more.
 *
 * The default is what CI pays on every pull request, and this scenario is
 * superlinear by construction — ten per board is 24 seconds of measured steps
 * on an M3 Max, against a sixty-second per-test budget that a slower runner has
 * to fit inside too. Five keeps the pair and the shape of the curve well inside
 * it.
 */
const SIZE = Number(Deno.env.get("CF_TOPICS_ONSCREEN_SIZE") ?? "5");

/**
 * Whether the browser is routed at the first board at all.
 *
 * Off, it sits on the space root and renders neither board, which turns this
 * file into its own control: the two measurements per iteration then differ
 * only in their position in the iteration, so whatever separates them is the
 * ordering, not the rendering. Subtracting that control from the ordinary run
 * is what leaves the render cost by itself.
 */
const RENDER = Deno.env.get("CF_TOPICS_ONSCREEN_RENDER") !== "0";

/**
 * What the authoring client keeps demanded while it files topics.
 *
 * This is a knob rather than a constant because the choice changes the
 * measurement more than anything else here does. `index` is the realistic one
 * and the default: it is the bounded discovery surface the board publishes for
 * exactly this — a row is its topic, declared through a scalar schema — so
 * holding it live keeps each create landing against a current list without
 * expanding a single topic's prose, thread, or verbs.
 *
 * `full` is a sink on the piece cell with no schema at all, which demands the
 * whole result and re-materializes every topic on every change. It is here to
 * be measured against, not to be used.
 *
 * `none` demands nothing and answers whether any demand is needed at all.
 */
const DEMAND = Deno.env.get("CF_TOPICS_ONSCREEN_DEMAND") ?? "index";

const AGENT_NAME = "On-screen create measurement";

/**
 * Titles differ per board so a wait for one board's newest card cannot be
 * satisfied by the other board's, and carry the index so the emitted line and
 * the DOM name the same create.
 */
const title = (board: "on" | "off", index: number): string =>
  `${board === "on" ? "Onscreen" : "Offscreen"} topic ${
    String(index).padStart(4, "0")
  }`;

describe("Topics create, on screen against off screen", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let rendered: PieceController;
  let unrendered: PieceController;
  const sinkCancels: Array<() => void> = [];

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    spaceDid = await createTestSpace(identity);
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity,
      cfcFlowLabels: "persist",
    });
    await cc.ensureDefaultPattern();

    const sourcePath = join(import.meta.dirname!, "..", "topics", "main.tsx");
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    rendered = await cc.create(program, { start: true });
    unrendered = await cc.create(program, { start: true });

    // Both boards stay demanded for the whole run, so each create lands against
    // an up-to-date list rather than waking a cold one — through the narrowest
    // surface that does that. See DEMAND.
    for (const board of [rendered, unrendered]) {
      const cancel = demandBoard(board);
      if (cancel) sinkCancels.push(cancel);
    }

    // Both boards reach the server before any browser asks for one. A piece
    // this process has created but not yet synced is one the shell answers for
    // with "No data at cell", and the run then spends its whole budget in a
    // wait for a card that was never going to arrive.
    await cc.synced();
  });

  afterAll(async () => {
    for (const cancel of sinkCancels) cancel();
    await cc?.dispose();
  });

  it("times one more topic on a rendered board against an unrendered one", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: RENDER ? { spaceDid, pieceId: rendered.id } : { spaceDid },
      identity,
    });
    // Routed and loaded before anything is timed. Asserting the view here is
    // what makes a piece that cannot load fail as a failed load, rather than
    // as every subsequent text wait running to its safety net.
    if (RENDER) await waitForPieceView(page, spaceDid, rendered.id);
    await waitForRuntimeIdle(page);

    for (let index = 0; index < SIZE; index++) {
      // The board nobody is looking at. Same space, same authoring runtime, so
      // the only thing this one is missing is a view.
      const offStart = performance.now();
      await unrendered.result.set(
        { title: title("off", index), agentName: AGENT_NAME },
        ["addTopic"],
      );
      await cc.runtime.idle();
      const offMs = performance.now() - offStart;

      // The board on screen. The write half is the same operation as above; the
      // render half is what the browser adds.
      const onStart = performance.now();
      const onTitle = title("on", index);
      await rendered.result.set(
        { title: onTitle, agentName: AGENT_NAME },
        ["addTopic"],
      );
      await cc.runtime.idle();
      const onWriteMs = performance.now() - onStart;
      // `waitForText` rather than `waitForSettledText`, and the difference is
      // the measurement: this waits for the card to appear, where the settling
      // variant would drive the page until it did. The board is mounted here,
      // so the shell holds its own subscription and renders the remote write
      // without help — which is the property under test. A wait that had to
      // drive the page would report a render tail no reader would ever see, and
      // would hide a live view that had stopped updating itself.
      //
      // Nothing renders this board in the control, so there is no card to wait
      // for and the two halves of the measurement collapse into one.
      if (RENDER) await waitForText(page, "body", onTitle);
      const onTotalMs = performance.now() - onStart;

      console.log(
        `TOPIC_CREATE render=${RENDER ? 1 : 0} size=${SIZE} i=${index} ` +
          `off=${offMs.toFixed(0)} onWrite=${onWriteMs.toFixed(0)} ` +
          `onTotal=${onTotalMs.toFixed(0)} ` +
          `render=${(onTotalMs - onWriteMs).toFixed(0)}`,
      );
    }

    logBrowserLoadSummary(
      await collectBrowserLoadSummary(
        page,
        `topic-create size=${SIZE} render=${RENDER ? 1 : 0}`,
      ),
    );
  });
});

/** Hold the authoring demand selected for the on-screen comparison. */
function demandBoard(board: PieceController): (() => void) | undefined {
  if (DEMAND === "none") return undefined;
  if (DEMAND !== "index" && DEMAND !== "full") {
    throw new Error(
      `CF_TOPICS_ONSCREEN_DEMAND must be one of index, full, none: ${DEMAND}`,
    );
  }
  return demandTopicBoard(board, DEMAND);
}
