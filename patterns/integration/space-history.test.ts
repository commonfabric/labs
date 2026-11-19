import { createTestSpace, env, type Page } from "@commonfabric/integration";
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
 * Opens the history panel and returns the seq of the newest step it lists,
 * which is the point of history holding the space as it stands.
 */
async function newestStep(page: Page): Promise<string> {
  await page.evaluate("globalThis.app.setConfig('showHistoryView', true)");
  const step = await page.waitForSelector(".step[data-seq]", {
    strategy: "pierce",
  });
  const seq = await step.evaluate((el: Element) => el.getAttribute("data-seq"));
  if (seq === null) throw new Error("the newest step names no seq");
  return seq;
}

/** Opens, in the history panel, the step whose seq is `seq`. */
async function openStep(page: Page, seq: string): Promise<void> {
  const step = await page.waitForSelector(`.step[data-seq="${seq}"]`, {
    strategy: "pierce",
  });
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
   * page and the seq of the step that left the counter at one. The panel
   * lists history as it stood when it opened, so that step stays listed
   * while the space moves on, whichever side computes the space.
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
