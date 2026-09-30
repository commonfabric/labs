import { createTestSpace, env } from "@commonfabric/integration";
import { type DID, Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButton,
  clickCfButtonAndWaitForText,
  clickTrustedAction,
  fillCfInput,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

describe("parking coordinator admin view integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    spaceDid = await createTestSpace(identity);
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity,
      cfcFlowLabels: "persist",
    });

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "factory-outputs",
      "parking-coordinator",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, {
      start: true,
      input: {
        spots: [
          {
            spotNumber: "1",
            label: "Near entrance",
            notes: "",
            active: true,
          },
          { spotNumber: "5", label: "", notes: "", active: true },
          {
            spotNumber: "12",
            label: "Compact only",
            notes: "Tight, no large vehicles",
            active: true,
          },
        ],
        people: [
          {
            name: "Alice",
            email: "alice@example.test",
            commuteMode: "drive",
            spotPreferences: [],
            defaultSpot: "",
            priorityRank: 1,
          },
        ],
        requests: [],
      },
    });
    pieceId = piece.id;
    const resultCell = cc.getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("offers no admin control until an identity has resolved", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceDid,
        pieceId,
      },
      identity,
    });
    await waitForRuntimeIdle(page);

    await waitForText(page, "#parking-admin-access", "Alice");
    await waitForText(page, "#parking-admin-access", "Cannot manage admins");
    await waitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      "Make admin",
    );
    await waitForDisabled(page, "#parking-enable-admin-manager", false);
    // A role binds to an identity, and a fresh identity has no profile, so
    // Alice's row cannot be granted one and the card offers the wish's own
    // create surface instead.
    await waitForDisabled(page, '[data-parking-admin-toggle="Alice"]', true);
    await waitForDisabled(page, "#parking-admin-mode-toggle", true);
    await waitForTextAbsent(page, "#parking-admin-people-section", "People");
  });

  it("grants admin once a profile is created and the row claimed", async () => {
    // Navigates itself rather than inheriting the step above's page: a step
    // the ON arm skips has to be runnable on its own, which is how anyone
    // debugging the skip will run it.
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceDid,
        pieceId,
      },
      identity,
    });
    await waitForRuntimeIdle(page);

    // Creating a profile is the only path in — there is no typed-name
    // fallback. Creation is a cross-space commit the runner drives through
    // pending/retry cycles; runtime idle is its completion signal.
    await fillCfInput(page, "#wish-profile-name-input", "Alice");
    await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(page);

    // Claiming the row binds it to that identity, which is what makes it a
    // row a role can name.
    await clickCfButton(page, '[data-parking-admin-claim="Alice"]');
    await waitForRuntimeIdle(page);

    await clickCfButtonAndWaitForText(
      page,
      "#parking-enable-admin-manager",
      "#parking-admin-access",
      "Can manage admins",
    );
    await waitForRuntimeIdle(page);
    await waitForDisabled(page, "#parking-enable-admin-manager", true);
    await waitForDisabled(page, '[data-parking-admin-toggle="Alice"]', false);

    await clickCfButtonAndWaitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      '[data-parking-admin-row="Alice"]',
      "Admin",
    );
    await waitForRuntimeIdle(page);
    await waitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      "Remove admin",
    );
    await waitForDisabled(page, "#parking-admin-mode-toggle", false);
    await waitForText(page, "#parking-admin-mode-toggle", "Admin: OFF");

    await clickCfButtonAndWaitForText(
      page,
      "#parking-admin-mode-toggle",
      "#parking-admin-mode-toggle",
      "Admin: ON",
    );
    await waitForRuntimeIdle(page);
    await waitForText(page, "#parking-admin-people-section", "People");
    await waitForText(page, "#parking-admin-add-person-open", "+ Add Person");
  });
});
