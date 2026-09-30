import { env, Page } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickTrustedAction,
  fillCfInput,
  fillCfTextarea,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
// The `#profile` wish fallback surface (rendered by the embed when no profile
// resolves) is the shared trusted create surface: it forwards `inputId:
// "wish-profile-name-input"` to its inner input and exposes the trusted
// `CreateProfile` action (see packages/runner/src/builtins/wish.ts). Same
// surface the shared-profile integration test drives.
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";
const CREATE_INPUT = "#wish-profile-name-input";

/**
 * Browser integration coverage for the CT-1833 profile-embed pattern's
 * RESOLVED-profile path (CT-1846).
 *
 * The lane-2 unit test (packages/patterns/system/profile-embed.test.tsx) can
 * only cover the fallback branch + the amend contract against a raw ProfileHome,
 * because `#profile` cannot be satisfied in the console-error-gated pattern-unit
 * lane (a valid profile needs a cross-space create the lane forbids). This test
 * closes that gap end-to-end in a real browser:
 *
 *   1. Deploy profile-embed as a piece and visit it. The pattern wishes
 *      `#profile` itself, so it renders the logged-in identity's own profile —
 *      no profile input.
 *   2. With no profile yet, the embed renders the wish fallback (the trusted
 *      create surface). Create a profile through it, satisfying `#profile`.
 *   3. Assert the RESOLVED presentation: the hero `cf-profile-badge` (name) and,
 *      after a bio amend, the bio paragraph — and that the ProfileHome
 *      developer chrome ("Pin a piece" form / elements grid) is NOT rendered
 *      (the embed hides it).
 *   4. Enter edit mode, amend the name, save; assert the badge updates. The save
 *      dispatches through the resolved profile's exported owner-protected
 *      `setName` / `setBio` streams on `profileWish.result`.
 */
describe("profile-embed integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let spaceDid: string;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
      cfcFlowLabels: "persist",
    });
    spaceDid = cc.getSpace();

    // Pre-create the space-root (default) pattern so the browser's
    // `pattern:getSpaceRoot` storage-RESUMEs it instead of taking the create
    // path and cold-compiling default-app inside its worker — see the
    // beforeAll comment in lunch-poll-vote.test.ts.
    await cc.ensureDefaultPattern();

    // Resolve the profile-embed system pattern through the harness (content-
    // addressed program) and create from that, mirroring shared-profile.test.ts.
    // profile-embed.tsx imports its sibling ./profile-home.tsx, so the resolver
    // root must be the patterns package so that relative import resolves.
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "system",
      "profile-embed.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    // Keep the result cell subscribed so the started piece's data stays live
    // and durable when the shell loads it (see shared-profile.test.ts note).
    const resultCell = cc.getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("renders the resolved profile and amends it through the exported streams", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: spaceDid as `did:${string}:${string}`, pieceId },
      identity,
    });

    // No profile yet: the embed renders the wish fallback (create surface), not
    // the resolved presentation.
    await waitForSelector(
      page,
      '[data-ui-region="profile-embed-fallback"]',
    );

    // Create a profile through the fallback surface, satisfying `#profile`.
    await createProfileFromFallback(page, "Ada Lovelace");

    // Resolved presentation: the hero badge renders the name.
    await waitForText(page, "#profile-embed-badge", "Ada Lovelace");
    // The presentation region is present.
    await waitForSelector(
      page,
      '[data-ui-region="profile-embed-presentation"]',
    );

    // The embed HIDES the ProfileHome developer chrome: the "Pin a piece" form
    // (a ProfileHome-only affordance) must not render anywhere in the embed.
    await waitForTextAbsent(
      page,
      '[data-ui-pattern="ProfileEmbed"]',
      "Pin a piece",
    );

    // Enter edit mode: the "Edit profile" button flips `editing` and seeds the
    // draft inputs from the resolved values.
    await clickSaveByLabel(page, "Edit profile");
    await waitForRuntimeIdle(page);
    await waitForSelector(page, '[data-ui-region="profile-embed-edit"]');

    // Amend the name: fill the draft and click "Save name". The save reads the
    // draft, suppresses empty, and dispatches { name } into the resolved
    // profile's exported owner-protected setName stream.
    await fillCfInput(
      page,
      '[data-ui-region="profile-embed-edit"] cf-input',
      "Grace Hopper",
    );
    await clickSaveByLabel(page, "Save name");
    // The save dispatches into the resolved profile's owner-protected setName
    // stream — a cross-space write into the profile space this session created
    // and still holds open. `waitForRuntimeIdle` awaits the pending-commit
    // barrier, so the write is server-confirmed before the next edit.
    await waitForRuntimeIdle(page);

    // Amend the bio too (bio is clearable; the embed sends the trimmed draft).
    // cf-textarea wraps a native <textarea> (not an <input>), so fillCfInput —
    // which only drives inner <input>s — does not apply.
    await fillCfTextarea(
      page,
      '[data-ui-region="profile-embed-edit"] cf-textarea',
      "Countess of computing.",
    );
    await clickSaveByLabel(page, "Save bio");
    // As with the name save, the bio dispatches into the resolved profile's
    // owner-protected setBio stream; `waitForRuntimeIdle` confirms the write
    // through the pending-commit barrier before edit mode is left.
    await waitForRuntimeIdle(page);

    // Leave edit mode and assert the RESOLVED presentation reflects the amends:
    // the hero badge shows the new name and the bio paragraph renders.
    await clickSaveByLabel(page, "Done");
    await waitForRuntimeIdle(page);

    await waitForText(page, "#profile-embed-badge", "Grace Hopper");
    await waitForText(
      page,
      '[data-ui-region="profile-embed-bio"]',
      "Countess of computing.",
    );
  });
});

async function waitForSelector(page: Page, selector: string) {
  try {
    await page.waitForSelector(selector, {
      strategy: "pierce",
    });
  } catch (cause) {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "")
      .catch(() => "");
    throw new Error(
      `Unable to find ${selector}. Body: ${bodyText.slice(0, 1000)}`,
      { cause },
    );
  }
}

// Create a profile through the embed's fallback surface. Mirrors
// shared-profile.test.ts: fill the create input like a user, then fire the
// trusted CreateProfile click carrying the typed name.
async function createProfileFromFallback(page: Page, name: string) {
  await fillCfInput(page, CREATE_INPUT, name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  // Creating a profile satisfies `#profile` by committing into a new cross-space
  // child space, issued fire-and-forget by the trusted action's handler.
  // `waitForRuntimeIdle` awaits the storage manager's pending-commit barrier
  // alongside scheduler quiescence, so the create is server-confirmed before the
  // caller reads the resolved profile back. The read renders in this same
  // session, so the child space stays open and subscribed and the reactive read
  // resolves from already-open state without a separate cross-space sync.
  await waitForRuntimeIdle(page);
}

// Click the save/done cf-button whose accessible text matches `label`. Each of
// the embed's edit-mode buttons has distinct visible text ("Save name",
// "Save avatar", "Save bio", "Done"), so matching by text picks exactly one.
async function clickSaveByLabel(page: Page, label: string) {
  await waitForRuntimeIdle(page);
  const token = `profile-embed-save-${crypto.randomUUID()}`;
  await markCfButtonByText(page, label, token);
  const button = await page.waitForSelector(`[data-cfc-mark="${token}"]`, {
    strategy: "pierce",
  });
  await button.click();
}

// Tag the inner click target of the cf-button whose trimmed text equals `label`
// so a single pierce click lands on it. cf-button renders a <div data-cf-button>
// click target inside its shadow root (see docs/development/UI_TESTING.md and
// project_cf_button_div_decision).
async function markCfButtonByText(page: Page, label: string, token: string) {
  const marked = await page.evaluate((targetLabel, targetToken) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) collect(element.shadowRoot, result);
      }
    }
    const elements: Element[] = [];
    collect(document, elements);
    for (const element of elements) {
      if (element.tagName.toLowerCase() !== "cf-button") continue;
      const text = (element.textContent ?? "").trim();
      if (text !== targetLabel) continue;
      const host = element as HTMLElement;
      const clickTarget = (host.shadowRoot?.querySelector("[data-cf-button]") as
        | HTMLElement
        | null) ?? host;
      clickTarget.setAttribute("data-cfc-mark", targetToken);
      return true;
    }
    return false;
  }, { args: [label, token] });
  assert(marked, `No cf-button with text "${label}" found to click`);
}
