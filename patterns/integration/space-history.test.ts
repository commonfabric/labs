import {
  createTestSpace,
  env,
  type Page,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import { clickCfButton, waitForSettledText } from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

/** Waits for the counter to read as the `ordinal` number. */
const waitForCounter = (page: Page, ordinal: string): Promise<void> =>
  waitForSettledText(
    page,
    "#counter-result",
    `Counter is the ${ordinal} number`,
  );

/**
 * Opens the history panel and returns the seq the newest step it lists began
 * at. A step is named by where it began: its own seq is that of its last
 * commit, which moves while the step is still growing.
 */
async function newestStep(page: Page): Promise<string> {
  await page.evaluate("globalThis.app.setConfig('showHistoryView', true)");
  const seq = await waitForCondition<[], string>(
    page,
    (probe) =>
      probe.collect(".step[data-start-seq]")[0]?.getAttribute(
        "data-start-seq",
      ) ||
      false,
  );
  if (seq === undefined) throw new Error("the newest step names no start");
  return seq;
}

/** Opens, in the history panel, the step that began at `startSeq`. */
async function openStep(page: Page, startSeq: string): Promise<void> {
  const step = await page.waitForSelector(
    `.step[data-start-seq="${startSeq}"]`,
    { strategy: "pierce" },
  );
  await step.click();
}

describe("space history", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: await createTestSpace(identity),
      apiUrl: new URL(API_URL),
      identity: identity,
    });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  /**
   * Creates a counter, opens it in the shell and increments it three times
   * from the page, opening the history panel after the first. Returns the
   * page and the seq the step that left the counter at one began at. The
   * panel keeps the steps it has listed as the space moves on, so that step
   * stays listed whichever side computes the space.
   */
  async function openCountedToThree(): Promise<{ page: Page; first: string }> {
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(
          import.meta.dirname!,
          "..",
          "examples",
          "counter",
          "counter.tsx",
        ),
      },
    );
    const piece = await cc.create(program, { start: true });
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: cc.getSpace(), pieceId: piece.id },
      identity,
    });
    const page = shell.page();
    await waitForCounter(page, "0th");
    await clickCfButton(page, "#counter-increment");
    await waitForCounter(page, "1st");
    const first = await newestStep(page);
    for (const ordinal of ["2nd", "3rd"]) {
      await clickCfButton(page, "#counter-increment");
      await waitForCounter(page, ordinal);
    }
    return { page, first };
  }

  it("lists a pattern change on its step, and restores that pattern version with the data kept", async () => {
    // The two versions of the pattern word the counter differently, so the
    // text says which one the piece runs and what count it holds.
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(
          import.meta.dirname!,
          "..",
          "examples",
          "counter",
          "counter.tsx",
        ),
      },
    );
    // The piece is left for the shell to start: a pattern running here would
    // compute ahead of the server, and a source change cannot commit on top
    // of values this process only speculated.
    const piece = await cc.create(program, { start: false });
    await piece.setPattern({
      ...program,
      files: program.files.map((file) => ({
        ...file,
        contents: file.contents.replace("Counter is the", "Count is the"),
      })),
    });
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: cc.getSpace(), pieceId: piece.id },
      identity,
    });
    const page = shell.page();
    await waitForSettledText(
      page,
      "#counter-result",
      "Count is the 0th number",
    );
    await clickCfButton(page, "#counter-increment");
    await waitForSettledText(
      page,
      "#counter-result",
      "Count is the 1st number",
    );

    await page.evaluate("globalThis.app.setConfig('showHistoryView', true)");
    await clickCfButton(page, ".pattern-restore");
    await waitForCounter(page, "1st");
  });

  it("lists the steps the space takes while the panel is open", async () => {
    // The panel opened after the first increment, so a first step that is
    // not the one it opened on is one it listed as the space moved on.
    const { page, first } = await openCountedToThree();
    await page.waitForSelector(
      `ol > li:first-child > .step:not([data-start-seq="${first}"])`,
      { strategy: "pierce" },
    );
    await page.waitForSelector(`.step[data-start-seq="${first}"]`, {
      strategy: "pierce",
    });
  });

  it("shows the piece as an earlier step left it, and returns to now", async () => {
    const { page, first } = await openCountedToThree();

    await openStep(page, first);
    await waitForCounter(page, "1st");

    await clickCfButton(page, "#counter-increment");
    await waitForCounter(page, "2nd");

    await clickCfButton(page, "#history-back");
    await waitForCounter(page, "3rd");
  });

  it("restores the space to the step a fork shows, without what was done in the fork", async () => {
    // The fork is taken to "0th", which neither the step ("1st") nor the
    // space ("3rd") holds, so the text after the restore says which of the
    // three the space was set to.

    const { page, first } = await openCountedToThree();

    await openStep(page, first);
    await waitForCounter(page, "1st");
    await clickCfButton(page, "#counter-decrement");
    await waitForCounter(page, "0th");

    await clickCfButton(page, "#history-restore");
    await page.waitForSelector('.step[data-kind="restore"]', {
      strategy: "pierce",
    });
    await waitForCounter(page, "1st");

    await clickCfButton(page, "#counter-increment");
    await waitForCounter(page, "2nd");
  });
});
