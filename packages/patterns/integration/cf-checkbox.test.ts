import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { ANYONE_USER } from "@commonfabric/memory/acl";
import { ACLManager } from "@commonfabric/runner";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButtonAndWaitForText,
  waitForDisabled,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const testComponents = [
  { name: "cf-checkbox-cell", file: "examples/cf-checkbox-cell.tsx" },
];

/**
 * Opens a piece's view in the browser. Each case that reads a rendered piece
 * calls this for itself, so that the case runs alone and so that whatever its
 * page reports while loading belongs to that case.
 */
const openPiece = async (
  shell: ShellIntegration,
  pieceId: string,
  identity: Identity,
) => {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: {
      spaceName: SPACE_NAME,
      pieceId,
    },
    identity,
  });
};

testComponents.forEach(({ name, file }) => {
  describe(`${name} integration test`, () => {
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
            file,
          ),
        ),
        { start: false },
      );
      pieceId = piece.id;

      await new ACLManager(cc.runtime, cc.getSpace()).set(ANYONE_USER, "WRITE");
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });

    it(`should load the ${name} piece`, async () => {
      await openPiece(shell, pieceId, identity);

      await shell.page().waitForSelector("cf-checkbox", { strategy: "pierce" });
    });

    it("should show disabled content initially", async () => {
      await openPiece(shell, pieceId, identity);

      await waitForText(
        shell.page(),
        "#feature-status",
        "⚠ Feature is disabled",
      );
    });

    it("toggles the bound content on and back off when the checkbox is clicked", async () => {
      // The first cf-checkbox in the piece is bound to the cell that
      // #feature-status reflects; the click helper settles the view, clicks
      // the host element once, and waits for the bound text to update. One
      // case covers both clicks: the second click's expectation is the state
      // the first click leaves. The helper returns without clicking when the
      // text it waits for is already present, so each step asserts the state
      // it starts from, and the first step asserts it here.

      await openPiece(shell, pieceId, identity);

      await waitForText(
        shell.page(),
        "#feature-status",
        "⚠ Feature is disabled",
      );

      await clickCfButtonAndWaitForText(
        shell.page(),
        "cf-checkbox",
        "#feature-status",
        "✓ Feature is enabled!",
      );
      await clickCfButtonAndWaitForText(
        shell.page(),
        "cf-checkbox",
        "#feature-status",
        "⚠ Feature is disabled",
      );
    });
  });
});

// `waitForDisabled` resolves a control's disabled state from an inner <button>
// when one exists. A cf-checkbox has no inner button — its shadow root holds an
// <input type="checkbox"> — and expresses disabled through the host's attribute
// and `aria-disabled`. This exercises the helper against that control so the
// fallback keeps resolving both readings instead of hanging until timeout.
describe("cf-checkbox waitForDisabled fallback integration test", () => {
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
      identity,
    });
    const piece = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "fixtures",
          "cf-checkbox-disabled.tsx",
        ),
      ),
      { start: false },
    );
    pieceId = piece.id;
    await new ACLManager(cc.runtime, cc.getSpace()).set(ANYONE_USER, "WRITE");
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("resolves both the enabled and disabled readings of a control with no inner button", async () => {
    const page = shell.page();
    await openPiece(shell, pieceId, identity);
    await page.waitForSelector("#probe-checkbox", { strategy: "pierce" });

    // The checkbox starts enabled; the helper must read the host fallback and
    // resolve the false reading rather than time out looking for a button.
    await waitForText(page, "#checkbox-disabled-status", "Checkbox enabled");
    await waitForDisabled(page, "#probe-checkbox", false);

    // Toggle to disabled; the helper resolves the true reading.
    await clickCfButtonAndWaitForText(
      page,
      "#toggle-disabled",
      "#checkbox-disabled-status",
      "Checkbox disabled",
    );
    await waitForDisabled(page, "#probe-checkbox", true);

    // Toggle back to enabled; the helper resolves the false reading again.
    await clickCfButtonAndWaitForText(
      page,
      "#toggle-disabled",
      "#checkbox-disabled-status",
      "Checkbox enabled",
    );
    await waitForDisabled(page, "#probe-checkbox", false);
  });
});
