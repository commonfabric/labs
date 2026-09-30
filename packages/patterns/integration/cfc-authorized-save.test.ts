import { createTestSpace, env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickTrustedActionAndWaitForText,
  fillCfInput,
  waitForRuntimeIdle,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

describe("cfc authorized save integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: Awaited<ReturnType<PiecesController["create"]>>;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: await createTestSpace(identity),
      apiUrl: new URL(API_URL),
      identity,
    });

    // Pre-create the space-root (default) pattern so the browser's
    // `pattern:getSpaceRoot` storage-RESUMEs it instead of taking the create
    // path and cold-compiling default-app inside its worker — see the
    // beforeAll comment in lunch-poll-vote.test.ts.
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-authorized-save",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    piece = await cc.create(program, { start: true });

    const resultCell = cc.getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("accepts the trusted surface and rejects a lookalike host button", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceDid: cc.getSpace(),
        pieceId: piece.id,
      },
      identity,
    });

    await fillCfInput(page, "#trusted-save-draft-input", "Saved from UI");

    const legacyButton = await page.waitForSelector("#legacy-save-button", {
      strategy: "pierce",
    });
    await legacyButton.click();

    await waitForRuntimeIdle(page);
    await waitForTextAbsent(page, "#saved-title", "Saved from UI");
    const savedTitleBeforeTrustedClick = await page.waitForSelector(
      "#saved-title",
      { strategy: "pierce" },
    );
    assertEquals((await savedTitleBeforeTrustedClick.innerText())?.trim(), "");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedSaveTitle",
      "#saved-title",
      "Saved from UI",
    );
  });
});
