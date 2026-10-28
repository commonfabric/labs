/**
 * Browser-level multiplayer coverage for Firebreak Commons.
 *
 * The guest is an opaque-origin iframe, so the shell document cannot inspect
 * it directly. This test attaches a second CDP client, creates an isolated
 * world in the real guest frame, and clicks the ordinary accessible controls.
 * No command listener or test-only state surface is shipped in the pattern.
 */

import { createTestSpace, env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { type DID, Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { waitForRuntimeIdle } from "./cfc-browser-helpers.ts";
import { GuestDomDriver, waitForGuestFrame } from "./iframe-guest-driver.ts";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;

interface GuestSummary {
  ready: boolean;
  turn: string;
  status: string;
  crewName: string;
  crewColor: string;
  selectedTool: string;
  actionCount: number;
  actionText: string;
  hasCanvas: boolean;
}

function guestSummaryReader(condition = "true"): string {
  return `() => {
    const app = document.querySelector('#firebreak-app');
    const selected = document.querySelector('[data-tool][aria-pressed="true"]');
    const actions = [...document.querySelectorAll('#action-log li[data-action-id]')];
    const summary = {
      ready: app?.getAttribute('data-ready') === 'true',
      turn: app?.getAttribute('data-turn') ?? '',
      status: app?.getAttribute('data-status') ?? '',
      crewName: document.querySelector('#crew-name')?.value ?? '',
      crewColor: app?.getAttribute('data-crew-color') ?? '',
      selectedTool: selected?.getAttribute('data-tool') ?? '',
      actionCount: actions.length,
      actionText: actions.map((item) => item.textContent ?? '').join(' '),
      hasCanvas: document.querySelector('#game canvas') !== null,
    };
    return (${condition}) ? summary : false;
  }`;
}

function guestSummary(driver: GuestDomDriver): Promise<GuestSummary> {
  return driver.evaluate<GuestSummary>(`(${guestSummaryReader()})()`);
}

/** Clicks the first enabled tile matching `selector` and returns its id. */
function clickFirstTile(
  driver: GuestDomDriver,
  selector: string,
): Promise<string> {
  return driver.evaluate<string>(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLButtonElement)) {
      throw new Error('Missing tile control: ' + ${JSON.stringify(selector)});
    }
    if (control.disabled) {
      throw new Error('Disabled tile control: ' + ${JSON.stringify(selector)});
    }
    control.click();
    return control.dataset.tileId ?? '';
  })()`);
}

function readySummary(driver: GuestDomDriver): Promise<GuestSummary> {
  return driver.waitFor<GuestSummary>(guestSummaryReader("summary.ready"));
}

function waitForActionCount(
  driver: GuestDomDriver,
  count: number,
): Promise<GuestSummary> {
  return driver.waitFor<GuestSummary>(
    guestSummaryReader(`summary.ready && summary.actionCount >= ${count}`),
  );
}

function waitForTurn(
  driver: GuestDomDriver,
  turn: number,
): Promise<GuestSummary> {
  return driver.waitFor<GuestSummary>(
    guestSummaryReader(
      `summary.ready && summary.turn === ${JSON.stringify(String(turn))}`,
    ),
  );
}

function waitForEnabledButton(
  driver: GuestDomDriver,
  selector: string,
): Promise<boolean> {
  return driver.waitFor<boolean>(`() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    return control instanceof HTMLButtonElement && !control.disabled;
  }`);
}

describe("iframe Firebreak Commons", () => {
  const aliceShell = new ShellIntegration();
  const bobShell = new ShellIntegration();
  const shells = [aliceShell, bobShell];
  shells.forEach((shell) => shell.bindLifecycle());

  let aliceIdentity: Identity;
  let bobIdentity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let pieceId: string;
  let resultSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    [aliceIdentity, bobIdentity] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    spaceDid = await createTestSpace(aliceIdentity, {
      grants: { [bobIdentity.did()]: "WRITE" },
    });
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity: aliceIdentity,
    });
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "iframe-firebreak-commons",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    resultSinkCancel = cc.getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    await cc?.dispose();
  });

  it("merges crew actions while isolating user preferences and local dispatch selections", async () => {
    const view = { spaceDid, pieceId };
    await Promise.all([
      aliceShell.goto({
        frontendUrl: FRONTEND_URL,
        view,
        identity: aliceIdentity,
      }),
      bobShell.goto({
        frontendUrl: FRONTEND_URL,
        view,
        identity: bobIdentity,
      }),
    ]);
    const pages = [aliceShell.page(), bobShell.page()];
    await Promise.all(pages.map((page) => waitForRuntimeIdle(page)));
    await Promise.all(pages.map((page) => waitForGuestFrame(page)));

    const [alice, bob] = await Promise.all([
      GuestDomDriver.connect(aliceShell.wsEndpoint(), "#firebreak-app"),
      GuestDomDriver.connect(bobShell.wsEndpoint(), "#firebreak-app"),
    ]);
    try {
      const initial = await Promise.all([
        readySummary(alice),
        readySummary(bob),
      ]);
      expect(initial.map((value) => value.turn)).toEqual(["1", "1"]);
      expect(initial.every((value) => value.hasCanvas)).toBe(true);

      await bob.click('[data-tool="firebreak"]');
      expect((await guestSummary(bob)).selectedTool).toBe("firebreak");
      expect((await guestSummary(alice)).selectedTool).toBe("water");

      await alice.setValue("#crew-name", "Cedar One");
      await alice.setValue("#crew-color", "blue");
      await alice.click("#save-profile");
      await alice.waitFor<string>(`() => {
        const status = document.querySelector('#sync-status')?.textContent ?? '';
        return status.includes('Ready · Cedar One') ? status : false;
      }`);
      expect((await guestSummary(alice)).crewName).toBe("Cedar One");
      expect((await guestSummary(alice)).crewColor).toBe("blue");
      expect((await guestSummary(bob)).crewName).toBe("Commons crew");
      expect((await guestSummary(bob)).crewColor).toBe("amber");

      const [waterTile, firebreakTile] = await Promise.all([
        clickFirstTile(alice, '.mirror-tile[data-fire="true"]'),
        clickFirstTile(
          bob,
          '.mirror-tile[data-fire="false"][data-terrain="forest"], ' +
            '.mirror-tile[data-fire="false"][data-terrain="grass"]',
        ),
      ]);
      expect(waterTile).not.toBe("");
      expect(firebreakTile).not.toBe("");
      expect(firebreakTile).not.toBe(waterTile);

      await Promise.all([
        alice.click("#deploy"),
        bob.click("#deploy"),
      ]);
      const shared = await Promise.all([
        waitForActionCount(alice, 2),
        waitForActionCount(bob, 2),
      ]);
      for (const summary of shared) {
        expect(summary.actionText).toContain("sent water to");
        expect(summary.actionText).toContain("cut a firebreak at");
        expect(summary.actionText).not.toContain("Rejected");
      }

      await alice.setValue("#crew-name", "Unsaved lookout");
      await waitForEnabledButton(bob, "#advance");
      await bob.click("#advance");
      const advanced = await Promise.all([
        waitForTurn(alice, 2),
        waitForTurn(bob, 2),
      ]);
      expect(advanced.map((value) => value.turn)).toEqual(["2", "2"]);
      expect(advanced.every((value) => value.actionCount >= 3)).toBe(true);
      expect(advanced.every((value) => value.actionText.includes("advanced")))
        .toBe(true);
      expect(advanced[0].crewName).toBe("Unsaved lookout");
      expect(advanced[1].crewName).toBe("Commons crew");
    } finally {
      alice.close();
      bob.close();
    }
  });
});
