import { createTestSpace, env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickTrustedActionAndWaitForText,
  fillCfInput,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

describe("cfc staged publish integration test", () => {
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
      "cfc-staged-publish",
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

  it("drives save, review, and publish through trusted UI actions", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceDid: cc.getSpace(),
        pieceId: piece.id,
      },
      identity,
    });

    await fillCfInput(
      page,
      "#trusted-save-draft-title-input",
      "Launch checklist",
    );
    await fillCfInput(
      page,
      "#trusted-save-draft-body-input",
      "Ship the staged publish demo with trusted UI gates.",
    );

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedSaveDraft",
      "#saved-title",
      "Launch checklist",
    );
    // Settled waits throughout: each pill/body text is the EFFECT of the
    // trusted click's served round trip, and a plain DOM watch cannot
    // pump the page's own pending pull work — the state can sit one
    // settle away from being drawn until the stuck-condition net fires
    // (docs/development/waiting-in-tests.md; the ON-lane "#stage-pill →
    // saved" 5 m timeouts in the 2026-08-20 attribution ledger were this
    // wait). The settle is the pump; absent server state still fails.
    await waitForSettledText(page, "#stage-pill", "saved");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedReviewSnapshot",
      "#reviewed-title",
      "Launch checklist",
    );
    await waitForSettledText(page, "#stage-pill", "reviewed");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPublishSnapshot",
      "#published-title",
      "Launch checklist",
    );
    await waitForSettledText(page, "#stage-pill", "published");
    await waitForSettledText(
      page,
      "#published-body",
      "Ship the staged publish demo with trusted UI gates.",
    );
  });
});
