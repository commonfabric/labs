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
 * Opens, in the history panel, the step that the `nth` newest event began,
 * counting from zero.
 */
async function openEventStep(page: Page, nth: number): Promise<void> {
  const step = await page.waitForSelector(
    `.step[data-event-index="${nth}"]`,
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
   * Creates a counter, opens it in the shell, increments it three times from
   * the page, and opens the history panel. Returns the page.
   */
  async function openCountedToThree(): Promise<Page> {
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
    for (const ordinal of ["1st", "2nd", "3rd"]) {
      await clickCfButton(page, "#counter-increment");
      await waitForCounter(page, ordinal);
    }
    await page.evaluate(
      "globalThis.app.setConfig('showHistoryView', true)",
    );
    return page;
  }

  it("shows the piece as an earlier step left it, and returns to now", async () => {
    const page = await openCountedToThree();

    await openEventStep(page, 2);
    await waitForCounter(page, "1st");

    await clickCfButton(page, "#counter-increment");
    await waitForCounter(page, "2nd");

    await clickCfButton(page, "#history-back");
    await waitForCounter(page, "3rd");
  });

  it("restores the space to what a fork holds", async () => {
    const page = await openCountedToThree();

    await openEventStep(page, 2);
    await waitForCounter(page, "1st");
    await clickCfButton(page, "#counter-decrement");
    await waitForCounter(page, "0th");

    await clickCfButton(page, "#history-restore");
    await page.waitForSelector('.step[data-kind="restore"]', {
      strategy: "pierce",
    });
    await waitForCounter(page, "0th");

    await clickCfButton(page, "#counter-increment");
    await waitForCounter(page, "1st");
  });
});
