import { debugStr } from "@commonfabric/data-model";
import {
  awaitViewSettled,
  env,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import { clickCfButton } from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

// In-page predicate: the page has soft-navigated away from `urlBefore`.
const urlChangedFrom = (_probe: ProbeApi, urlBefore: string): boolean =>
  globalThis.location.href !== urlBefore;

describe("instantiate-pattern integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let pieceId: string;
  let identity: Identity;
  let cc: PiecesController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const piece = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "instantiate-pattern.tsx",
        ),
      ),
      { start: true },
    );
    pieceId = piece.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should deploy pattern, click button, and navigate to counter", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId,
      },
      identity,
    });

    // Wait for piece to load by waiting for first interactive element
    await page.waitForSelector("[data-cf-input]", { strategy: "pierce" });

    // Store the current URL before any action
    const urlBefore = await page.evaluate(() => globalThis.location.href);

    // Type into the factory's message input with real key events, then press
    // its Add button; the handler instantiates a counter piece and navigates
    // to it. The view is settled before the click so the send handler is
    // bound when the single click lands.
    const input = await page.waitForSelector("[data-cf-input]", {
      strategy: "pierce",
    });
    await input.type("New counter");
    await awaitViewSettled(page);
    await clickCfButton(page, "[data-cf-button]");

    // Wait for the page to soft navigate
    try {
      await waitForCondition(page, urlChangedFrom, { args: [urlBefore] });
    } catch (cause) {
      const seen = await page.evaluate(() => ({
        url: globalThis.location.href,
        bodyText: (document.body?.innerText ?? "").slice(0, 400),
      })).catch(() => undefined);
      throw new Error(
        `Clicking Add did not navigate away from ${urlBefore}. ` +
          debugStr`Last probe: $quote,indent,long${seen}`,
        { cause },
      );
    }

    const urlAfter = await page.evaluate(() => globalThis.location.href);

    // Verify navigation happened (URL should have changed)
    assert(
      urlBefore !== urlAfter,
      "Should navigate to a new URL after clicking Add button",
    );

    // Verify we're now on a counter page by checking for counter-specific elements
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    assert(
      counterResult,
      "Should find counter-result element after navigation",
    );
  });
});
