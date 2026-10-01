import {
  env,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  submitViaEnter,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { FRONTEND_URL } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

/**
 * Whether the picker shows its default-profile marker as `shown` says, once
 * the view has settled. The marker is a span reading exactly "default", which
 * takes the place of a row's "Set default" button while home's
 * `defaultProfile` holds that row's profile, so it shows that a "Set default"
 * write landed. The renderer also wraps reactive regions in spans of no size,
 * whose text holds every row's buttons, so only a rendered span counts.
 */
const defaultMarkerShownIs = async (
  probe: ProbeApi,
  shown: boolean,
): Promise<boolean> => {
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) return false;
  await settle();
  return probe.collect("#profile-picker span").some((element) =>
    probe.isRendered(element) && probe.deepText(element).trim() === "default"
  ) === shown;
};

/**
 * Whether, once the view has settled, the picker shows exactly one
 * default-profile marker (see `defaultMarkerShownIs`), in the row of the
 * profile named `name`.
 */
const defaultRowNames = async (
  probe: ProbeApi,
  name: string,
): Promise<boolean> => {
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) return false;
  await settle();
  const markers = probe.collect("#profile-picker span").filter((element) =>
    probe.isRendered(element) && probe.deepText(element).trim() === "default"
  );
  if (markers.length !== 1) return false;
  let row: Element | null = markers[0]!;
  while (row && row.tagName.toLowerCase() !== "cf-hstack") {
    row = row.parentElement;
  }
  return row !== null && probe.deepText(row).includes(name);
};

// Workaround for a flaky activeTab regression (tracked in Linear CT-1666):
// navigating to the home view with profile data already persisted sometimes
// resets the active tab from "profile" back to its "spaces" default. That hides
// the whole `profile` tab-panel (`display:none`), so the profile picker + its
// create surface collapse to 0×0 and the trusted "Create profile" click times
// out — even though the picker rendered correctly. Until the activeTab
// rehydration race is fixed, defensively re-activate the profile tab (up to 5×,
// warning each time) before touching the create surface.
// deno-lint-ignore no-explicit-any
async function profileTabHidden(page: any): Promise<boolean> {
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

// deno-lint-ignore no-explicit-any
async function ensureProfileTabActive(page: any) {
  // Settle FIRST so a late activeTab revert has time to land, THEN probe; if the
  // profile tab fell back to its default, re-activate it (up to 5×, warning).
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForRuntimeIdle(page);
    if (!(await profileTabHidden(page))) return;
    console.warn(
      `[home-profile] activeTab fell back off "profile" (picker hidden); ` +
        `re-activating profile tab (attempt ${attempt}/5)`,
    );
    await clickCfButton(page, 'cf-tab[value="profile"]');
  }
}

// deno-lint-ignore no-explicit-any
async function createProfile(
  page: any,
  name: string,
  { viaEnter = false }: { viaEnter?: boolean } = {},
) {
  await ensureProfileTabActive(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  // Submit either by clicking the trusted "Create profile" button or by
  // pressing Enter in the field. Both ride a trusted gesture that carries the
  // typed name as event.target.value with the surface's UI integrity.
  if (viaEnter) {
    await submitViaEnter(page, "#wish-profile-picker-name-input");
  } else {
    await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  }
  // Each profile lives in its own `inSpace` child space, so appending one is a
  // cross-space commit issued fire-and-forget by the event handler.
  // `waitForRuntimeIdle` now includes commit durability: it awaits the storage
  // manager's pending-commit barrier as well as scheduler quiescence, so the
  // append is server-confirmed before the caller navigates or appends again.
  await waitForRuntimeIdle(page);
}

// Regression coverage for creating a profile directly from the home space's
// Profile tab (the `{ builtin: "home" }` root view). The existing
// shared-profile test only exercises creation through the `#profile` wish UI
// rendered by a *piece*; that path passes the profile cell as a schema-less
// link, so it never hit the bug. Creating from home rendered ProfileCreate with
// the owner-protected (IFC) profile cell, which materialized the cross-space
// `inSpace` child during the handler's own `.set()` and tripped the
// single-space write-isolation guard ("cross-space writes" error) — so the
// profile was never created and the form stayed put.
describe("home-space profile creation", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
  });

  it("creates a profile from the home Profile tab without a cross-space write error", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });

    // Open the Profile tab and create a profile through the picker's inline
    // create surface (the trusted create action). The home Profile tab is the
    // profile picker.
    await clickCfButton(page, 'cf-tab[value="profile"]');
    await createProfile(page, "Ada Lovelace");
    await waitForRuntimeIdle(page);

    // The new profile is appended to the home `profiles` list and rendered in
    // the picker. This exercises the cross-space `inSpace` append as an array
    // element (the #3812 multi-space-commit path applied to a push, not a set).
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
  });

  it("creates a second profile from the picker (multi-profile append)", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });

    await clickCfButton(page, 'cf-tab[value="profile"]');

    // First profile.
    await createProfile(page, "Ada Lovelace");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    // Second profile — must append, not overwrite.
    await createProfile(page, "Alan Turing");
    await waitForRuntimeIdle(page);

    // Both profiles are now listed in the picker.
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
    await waitForText(page, "#home-profile-summary", "Alan Turing");
  });

  it("lets an owner edit a non-default profile", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });

    await clickCfButton(page, 'cf-tab[value="profile"]');

    // Retain Ada as the explicit default, then open Alan. This is the case that
    // regressed when `#profile` exposed only its selected default as a
    // candidate: ProfileHome must recognize the viewer owns Alan as well.
    await createProfile(page, "Ada Lovelace");
    await createProfile(page, "Alan Turing");
    await waitForText(page, "#home-profile-summary", "Alan Turing");
    await waitForCondition(page, defaultMarkerShownIs, { args: [false] });
    await clickTrustedAction(page, "SetDefaultProfile");
    await waitForRuntimeIdle(page);
    // The marker shows the "Set default" write landed. It does not show the
    // declared writer was consulted: the picker writes a cell that carries
    // none of `TrustedDefaultProfile`'s labels.
    await waitForCondition(page, defaultMarkerShownIs, { args: [true] });

    await clickProfileLink(page, "Alan Turing");
    await waitForRuntimeIdle(page);

    // The profile page must expose the owner-only affordance and the real
    // trusted click must reveal its edit form, not merely render its label.
    await waitForText(
      page,
      '[data-ui-region="profile-presentation"]',
      "Edit profile",
    );
    await clickProfileEditToggle(page);
    await waitForRuntimeIdle(page);
    await page.waitForSelector('[data-ui-region="profile-edit"]', {
      strategy: "pierce",
    });
  });

  it("moves the default from one profile to another", async () => {
    // A home of its own, so the first "Set default" in the picker is the
    // first profile this test creates.
    const page = shell.page();
    const ownIdentity = await Identity.generate({ implementation: "noble" });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity: ownIdentity,
    });

    await clickCfButton(page, 'cf-tab[value="profile"]');
    await createProfile(page, "Katherine Johnson");
    await createProfile(page, "Dorothy Vaughan");
    await waitForText(page, "#home-profile-summary", "Dorothy Vaughan");

    await clickTrustedAction(page, "SetDefaultProfile");
    await waitForRuntimeIdle(page);
    await waitForCondition(page, defaultRowNames, {
      args: ["Katherine Johnson"],
    });

    // Katherine's row shows the marker, so the "Set default" left is
    // Dorothy's. Choosing it re-points the default rather than writing into
    // the profile chosen first.
    await clickTrustedAction(page, "SetDefaultProfile");
    await waitForRuntimeIdle(page);
    await waitForCondition(page, defaultRowNames, {
      args: ["Dorothy Vaughan"],
    });
  });

  it("creates a profile by pressing Enter in the field (keyboard submit)", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });

    await clickCfButton(page, 'cf-tab[value="profile"]');

    // Submitting with Enter (no button click) must create the profile too: the
    // browser's implicit form submission fires a trusted click on the field's
    // hidden submit button, carrying the typed name to the create handler.
    await createProfile(page, "Grace Hopper", { viaEnter: true });
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
  });
});

// `cf-cell-link` renders its visible, interactive target inside two shadow
// roots (`cf-cell-link` -> `cf-chip` -> native button). Tag that native target
// by its profile name, then use one browser click to exercise normal shell
// navigation to the profile piece.
// deno-lint-ignore no-explicit-any
async function clickProfileLink(page: any, name: string) {
  const token = `profile-link-${crypto.randomUUID()}`;
  const marked = await page.evaluate(
    (targetName: string, targetToken: string) => {
      const collect = (root: Document | ShadowRoot, result: Element[]) => {
        for (const element of root.querySelectorAll("*")) {
          result.push(element);
          if (element.shadowRoot) collect(element.shadowRoot, result);
        }
      };
      const elements: Element[] = [];
      collect(document, elements);
      for (const element of elements) {
        if (element.tagName.toLowerCase() !== "cf-cell-link") continue;
        const chip = element.shadowRoot?.querySelector("cf-chip");
        // The profile name is the light-DOM slot content of the nested chip.
        // A host element's `textContent` excludes its shadow tree, so inspect
        // the chip itself rather than the outer `cf-cell-link`.
        if (!(chip?.textContent ?? "").includes(targetName)) continue;
        const clickTarget = chip?.shadowRoot?.querySelector("button") ?? chip ??
          element;
        clickTarget.setAttribute("data-profile-link-click", targetToken);
        return true;
      }
      return false;
    },
    { args: [name, token] },
  );
  if (!marked) throw new Error(`No profile link for "${name}" found`);
  const target = await page.waitForSelector(
    `[data-profile-link-click="${token}"]`,
    { strategy: "pierce" },
  );
  await target.click();
}

// ProfileHome rerenders its owner-gated control immediately after the test
// runner marks a cf-button's inner click target, so the generic CDP helper can
// lose that transient marker before it clicks. This toggle writes only local
// view state (not CFC-protected profile data), so invoke its stable native
// target within the browser DOM and assert the resulting edit form below.
// deno-lint-ignore no-explicit-any
async function clickProfileEditToggle(page: any) {
  const clicked = await page.evaluate(() => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length > 0) {
      const root = stack.pop()!;
      const button = root.querySelector("#profile-edit-toggle");
      if (button) {
        const target = button.shadowRoot?.querySelector("[data-cf-button]") ??
          button;
        (target as HTMLElement).click();
        return true;
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) stack.push(element.shadowRoot);
      }
    }
    return false;
  });
  if (!clicked) throw new Error("Profile edit toggle was not rendered");
}
