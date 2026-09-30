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
  StepTimer,
  waitForRuntimeIdle,
  waitForSettledText,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

describe("cfc render policy demo integration test", () => {
  const shell = new ShellIntegration({
    presentation: { label: "Policy demo", color: "#7c3aed" },
  });
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
      cfcFlowLabels: "persist",
    });

    // Pre-create the space-root (default) pattern so the browser's
    // `pattern:getSpaceRoot` storage-RESUMEs it instead of taking the create
    // path and cold-compiling default-app inside its worker — see the
    // beforeAll comment in lunch-poll-vote.test.ts.
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-render-policy-demo",
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

  it("blocks raw confidential content and reveals it through the trusted surface", async () => {
    const timeline = new StepTimer();
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceDid: cc.getSpace(),
        pieceId: piece.id,
      },
      identity,
      // The subject is the pattern's own declassification: the trusted
      // surface's render boundary names the health label, and the reveal below
      // is that boundary letting the value through. The render ceiling denies
      // author-supplied declassification, so this case runs the profile
      // without it; the case below runs the same page with it.
      renderCeiling: false,
    });
    await waitForRuntimeIdle(page);

    await timeline.run(
      "Confidential data starts hidden on every untrusted surface",
      async () => {
        await waitForText(
          page,
          "#raw-health-attempt",
          "Content hidden by policy",
        );
        await waitForText(
          page,
          "#trusted-health-surface",
          "Content hidden by policy",
        );
        await waitForTextAbsent(
          page,
          "#raw-health-attempt",
          "Sensitive health data:",
        );
      },
    );

    await timeline.run(
      "A trusted action reveals the approved value only inside its trusted surface",
      () =>
        clickTrustedActionAndWaitForText(
          page,
          "TrustedRevealHealthData",
          "#trusted-health-visible",
          "Sensitive health data: migraine treatment plan",
        ),
    );
    await timeline.run(
      "The raw pattern output remains hidden after the trusted reveal",
      () =>
        waitForTextAbsent(
          page,
          "#raw-health-attempt",
          "Sensitive health data:",
        ),
    );
  });

  it("denies the trusted surface's declassification under the render ceiling", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceDid: cc.getSpace(),
        pieceId: piece.id,
      },
      identity,
      renderCeiling: true,
    });
    await waitForRuntimeIdle(page);

    // The reveal switch is a cell of the piece and every case in this file
    // drives the same piece, so this case sets it rather than reading whatever
    // the case before it left. Concealing first is what makes the reveal a
    // transition; `clickTrustedActionAndWaitForText` returns without clicking
    // when the text it waits for is already on the page.
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedConcealHealthData",
      "#reveal-state",
      "Reveal disabled",
    );
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedRevealHealthData",
      "#reveal-state",
      "Reveal enabled",
    );

    // With the reveal on, the pattern's own "Content hidden by policy" node is
    // `display: none` and `deepText` skips it, so the text below is the
    // reconciler's blocked placeholder: the ceiling denied the
    // declassification the trusted surface declares for
    // `SensitiveHealthRecord`, which is outside the §8.10.6 display profile.
    await waitForSettledText(
      page,
      "#trusted-health-surface",
      "Content hidden by policy",
    );

    // The value the reveal would have shown reaches no part of the document.
    await waitForTextAbsent(page, "cf-screen", "Sensitive health data:");

    // Each surface is a sub-pattern taking the health record as an argument,
    // and the ceiling reaches the value inside each rather than the card
    // around it. So the untrusted card is on the page, carrying the authored
    // text it is built from, with its own boundary holding the value back —
    // the same shape the trusted surface is left in above.
    await waitForText(
      page,
      "#raw-health-attempt",
      "Untrusted direct render attempt",
    );
    await waitForSettledText(
      page,
      "#raw-health-attempt",
      "Content hidden by policy",
    );
  });
});
