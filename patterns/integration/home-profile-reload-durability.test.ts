import { env, Page } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
  waitForText,
} from "./cfc-browser-helpers.ts";

// Durability of home profile creation across a reload, using ONLY
// `waitForRuntimeIdle` between steps — never `waitForRuntimeSynced`. This
// mirrors what a user does: create a profile, then quickly reload or create
// another, before the create's cross-space commit has been confirmed.
//
// The mechanism these tests guard: a profile create is an event-handler commit
// that is deliberately not awaited (scheduler/events.ts: "Do not await event
// commits here"), and a full page reload tears down the runtime worker at the
// browser level with no graceful dispose, dropping any commit the server has
// not yet confirmed. The client-facing idle is therefore required to include
// commit durability: the worker's idle handler waits on the storage manager's
// pending-commit barrier (Scheduler.idleWithPendingCommits) in addition to
// reactive quiescence, so once `waitForRuntimeIdle` returns the create is
// durable and the reload cannot lose it. Without that guarantee, a reload
// drops whichever create's commit is still in flight — the profile created
// just before the reload, or the most recent of several rapid creates, whose
// commit has had the least time to confirm.
//
// These tests read durable truth by fully settling AFTER the flow (so each
// surviving profile's own cross-space space loads and its name renders) and
// asserting every created name is present.

const { FRONTEND_URL } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

async function profileTabHidden(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const deepFind = (sel: string): Element | null => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const e of root.querySelectorAll("*")) {
          const sr =
            (e as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) stack.push(sr);
        }
      }
      return null;
    };
    const panel = deepFind('cf-tab-panel[value="profile"]') as
      | HTMLElement
      | null;
    return !panel || getComputedStyle(panel).display === "none";
  });
}

async function ensureProfileTabActive(page: Page) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForRuntimeIdle(page);
    if (!(await profileTabHidden(page))) return;
    await clickCfButton(page, 'cf-tab[value="profile"]');
  }
}

async function createProfile(page: Page, name: string) {
  await ensureProfileTabActive(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  // The runtime-idle checkpoint includes commit durability: once this returns,
  // the create is server-confirmed — the property the reload tests assert.
  await waitForRuntimeIdle(page);
}

// Fully settle so every surviving profile's own space is loaded and its name
// renders. This is the durability read: a lost profile's name never appears
// here, because no space was ever durably created for it.
async function thoroughSettle(page: Page) {
  for (let round = 0; round < 6; round++) {
    await waitForRuntimeSynced(page);
    await waitForRuntimeIdle(page);
  }
}

async function gotoHome(
  shell: ShellIntegration,
  page: Page,
  identity: Identity,
) {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
  await clickCfButton(page, 'cf-tab[value="profile"]');
}

describe("home profile durability across reload", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identityA: Identity;
  let identityB: Identity;

  beforeAll(async () => {
    identityA = await Identity.generate({ implementation: "noble" });
    identityB = await Identity.generate({ implementation: "noble" });
  });

  it("a profile created before a reload survives the reload", async () => {
    const page = shell.page();

    // Session 1: create a profile; settle only the scheduler, then reload.
    await gotoHome(shell, page, identityA);
    await createProfile(page, "Ada Lovelace");

    // Reload (new session on the same home space).
    await gotoHome(shell, page, identityA);
    await thoroughSettle(page);

    // The profile created before the reload must still be present.
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
  });

  it("the most recent of several rapid creates survives a following reload", async () => {
    const page = shell.page();

    // Create two profiles in quick succession (only scheduler settles between),
    // then reload immediately — the second create's commit is still in flight.
    await gotoHome(shell, page, identityB);
    await createProfile(page, "Grace Hopper");
    await createProfile(page, "Alan Turing");

    // Reload, then settle so surviving profiles render.
    await gotoHome(shell, page, identityB);
    await thoroughSettle(page);

    // Both must be durably present; today the trailing one ("Alan Turing") is
    // lost because its commit had the least time to confirm before the reload.
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    await waitForText(page, "#home-profile-summary", "Alan Turing");
  });
});
