import { type DID, Identity } from "@commonfabric/identity";
import { createTestSpace, env } from "@commonfabric/integration";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { waitForRuntimeIdle, waitForText } from "./cfc-browser-helpers.ts";
import {
  clickCellLink,
  waitForPieceView,
} from "./topics-navigation-helpers.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const FIRST_TITLE = "Navigation target";
const SECOND_TITLE = "Navigation neighbour";

describe("Topics durable navigation", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let board: PieceController;
  let boardSinkCancel: (() => void) | undefined;
  let topicFids: string[];

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
    board = await cc.create(program, { start: true });

    const resultCell = cc.getResult(board.getCell());
    boardSinkCancel = resultCell.sink(() => {});

    await board.result.set(
      { title: FIRST_TITLE, agentName: "Topics navigation test" },
      ["addTopic"],
    );
    await board.result.set(
      { title: SECOND_TITLE, agentName: "Topics navigation test" },
      ["addTopic"],
    );
    // Barrier the fid capture on the topics actually holding both created
    // topics (sink-driven, predicate at quiescence — waiting-in-tests.md's
    // non-browser shape). Under server execution the set() above resolves
    // before the SERVED consequence arrives, and when the client's echo run
    // is dropped (the stream-action validation guard racing `$ctx`
    // materialization — the OW60 echo-drop smell) nothing covers the gap:
    // an unbarriered capture read a pre-arrival `topics` and recorded wrong
    // fids while the board itself was correct (the OW33 triage's 2/10 red,
    // ow33-triage-report.md §6). In the echo-covered path the ids converge
    // by cause, so waiting until both titles are readable is correct in
    // both arms.
    await waitForCellValue(
      cc.runtime,
      resultCell.key("topics"),
      (topics: Array<{ title?: string } | undefined> | undefined) => {
        if (!Array.isArray(topics) || topics.length < 2) return false;
        const titles = topics.map((topic) => topic?.title);
        return titles.includes(FIRST_TITLE) && titles.includes(SECOND_TITLE);
      },
    );
    topicFids = [
      (await topicAt(board, 0)).id,
      (await topicAt(board, 1)).id,
    ];
  });

  afterAll(async () => {
    boardSinkCancel?.();
    await cc?.dispose();
  });

  it("opens a topic after a cold browser load without scheduler handlers", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid, pieceId: board.id },
      identity,
    });
    await waitForRuntimeIdle(page);
    await Promise.all([
      waitForText(page, "body", FIRST_TITLE),
      waitForText(page, "body", SECOND_TITLE),
    ]);

    // The browser worker has never run this board before. This is the exact
    // cold-load boundary where pattern-owned click streams used to be present
    // in persisted VDOM without a registered handler.
    const openedPieceId = await clickCellLink(page, "Open");
    assertEquals(
      topicFids.map((fid) => `of:${fid}`).includes(openedPieceId),
      true,
      `Open navigated to ${openedPieceId}, which is neither board topic`,
    );
    await waitForPieceView(page, spaceDid, openedPieceId);

    const droppedEvents = await page.evaluate(() =>
      ((globalThis as typeof globalThis & {
        __cfConsoleTail?: Array<{ method: string; text: string }>;
      }).__cfConsoleTail ?? []).filter((entry) =>
        entry.text.includes("scheduler Event dropped: no handler registered")
      )
    );
    assertEquals(droppedEvents, []);
  });
});

async function topicAt(
  board: PieceController,
  index: number,
): Promise<PieceController> {
  const result = await board.result.getCell();
  await result.pull();
  return new PieceController(
    board.pieces(),
    result.key("topics").key(index).resolveAsCell(),
  );
}
