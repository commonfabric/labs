/**
 * A member removed from a space, and then granted it again, coming back to
 * the space's piece in the shell without reloading. The memory server refuses
 * the member's runtime the space at the removal and sends nothing at the
 * grant, so what brings the piece back is the shell asking again: through the
 * Retry button on the renderer's "Access unavailable" placeholder, or on the
 * page regaining focus.
 */

import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { type DID, Identity } from "@commonfabric/identity";
import {
  awaitViewSettled,
  createTestSpace,
  env,
  type Page,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { ACLManager } from "@commonfabric/runner";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import "../src/globals.ts";

import { clickPierce } from "./shadow-dom.ts";

const { API_URL, FRONTEND_URL } = env;
const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const PIECE_SOURCE = join(
  import.meta.dirname!,
  "fixtures",
  "refused-space-piece.tsx",
);
const decoder = new TextDecoder();

/** Files the fixture piece in `space` as the identity at `identityPath`. */
async function filePiece(identityPath: string, space: DID): Promise<string> {
  // Through the temporary lock, because a nested Deno resolves dependencies of
  // its own and would refresh the repository's `deno.lock` as a side effect.
  const result = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--lock",
      lockPath,
      "-A",
      join(REPO_ROOT, "packages", "cli", "mod.ts"),
      "piece",
      "new",
      PIECE_SOURCE,
      "--identity",
      identityPath,
      "--api-url",
      API_URL,
      "--space",
      space,
    ],
    env: { CF_LOG_LEVEL: "error" },
  });
  const stdout = decoder.decode(result.stdout);
  if (!result.success) {
    throw new Error(
      `cf piece new failed with ${result.code}\nstdout:\n${stdout}` +
        `\nstderr:\n${decoder.decode(result.stderr)}`,
    );
  }
  const pieceId = stdout.match(/fid1:[^\s]+/)?.[0];
  if (!pieceId) {
    throw new Error(`cf piece new did not print a fid1 id:\n${stdout}`);
  }
  return pieceId;
}

/**
 * Waits until the page shows the refusal in the piece's place, the placeholder
 * with its Retry button and no marker, and returns how many retries of the
 * space the placeholder says have settled.
 */
async function waitForRefusal(page: Page): Promise<number> {
  const refusal = await waitForCondition(page, (probe) => {
    if (probe.collect("#refused-space-marker").length > 0) return false;
    const placeholder = probe.collect("[data-space-access-lost]").find((el) =>
      probe.deepText(el).includes("Access unavailable") &&
      el.querySelector("[data-space-access-retry]") !== null
    );
    return placeholder === undefined ? false : {
      retries: Number(placeholder.getAttribute("data-space-access-retries")),
    };
  });
  if (refusal === undefined) throw new Error("No refusal was shown");
  return refusal.retries;
}

/**
 * Waits until the page shows the piece, or shows the placeholder counting more
 * than `retries` settled retries and no longer busy, and returns which:
 * `piece` or `refused`. Either way a retry asked for after the
 * page counted `retries` has settled, so the answer is that retry's verdict.
 */
async function waitForRetryOutcome(
  page: Page,
  retries: number,
): Promise<string | undefined> {
  return await waitForCondition(page, (probe, before) => {
    const placeholders = probe.collect("[data-space-access-lost]");
    if (
      placeholders.length === 0 &&
      probe.collect("#refused-space-marker").some((el) =>
        probe.deepText(el).trim() === "refused space piece"
      )
    ) {
      return "piece";
    }
    const settledRefused = placeholders.some((el) =>
      Number(el.getAttribute("data-space-access-retries")) > before &&
      el.getAttribute("aria-busy") === "false"
    );
    return settledRefused ? "refused" : false;
  }, { args: [retries] });
}

/**
 * Returns whether the page shows a retry under way or past, given that it
 * showed `retries` settled ones when the space was refused: the placeholder
 * busy and reading "Retrying…", a higher settled count, or the piece in the
 * placeholder's place. Reads the page once, as it stands.
 */
async function retryHasStarted(page: Page, retries: number): Promise<boolean> {
  // A predicate that always answers with an object holds at its first check,
  // so this wait returns that check's reading rather than waiting for one.
  const reading = await waitForCondition(page, (probe, before) => {
    const placeholders = probe.collect("[data-space-access-lost]");
    const started = placeholders.length === 0 ||
      placeholders.some((el) =>
        Number(el.getAttribute("data-space-access-retries")) > before ||
        (el.getAttribute("aria-busy") === "true" &&
          probe.deepText(el).includes("Retrying…"))
      );
    return { started };
  }, { args: [retries] });
  return reading?.started === true;
}

describe("shell space access retry", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  /**
   * Shows the owner's piece to a member in the shell, removes the member from
   * the space and waits for the refusal, grants the member the space again,
   * and hands `recover` the page, the space, and the settled retries the
   * refusal showed, to bring the piece back with. Then waits for the retry
   * that brings about to settle, and requires that it left the piece rather
   * than the refusal.
   */
  async function refuseThenRegrant(
    recover: (page: Page, space: DID, retries: number) => Promise<void>,
  ): Promise<void> {
    await using ownerFile = await writeTempIdentity({
      implementation: "noble",
    });
    const owner = ownerFile.identity;
    const member = await Identity.generate({ implementation: "noble" });
    const space = await createTestSpace(owner, {
      grants: { [member.did()]: "WRITE" },
    });
    const pieceId = await filePiece(ownerFile.path, space);
    const controller = await PiecesController.initialize({
      space,
      apiUrl: new URL(API_URL),
      identity: owner,
    });
    try {
      const acl = new ACLManager(controller.runtime, space);
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceDid: space, pieceId },
        identity: member,
      });
      expect(await waitForRetryOutcome(page, 0)).toBe("piece");

      await acl.remove(member.did());
      const retries = await waitForRefusal(page);

      await acl.set(member.did(), "WRITE");
      await recover(page, space, retries);
      expect(await waitForRetryOutcome(page, retries)).toBe("piece");
    } finally {
      await controller.dispose();
    }
  }

  it("shows the piece again once the member presses Retry", async () => {
    await refuseThenRegrant(async (page, _space, retries) => {
      await clickPierce(page, "[data-space-access-retry]");
      // The click reaches the worker before the settle request does, and the
      // worker marks the retry in flight while handling it, so once the view
      // has settled the page shows the retry under way or past.
      await awaitViewSettled(page);
      expect(await retryHasStarted(page, retries)).toBe(true);
    });
  });

  it("shows the piece again once the page regains focus", async () => {
    await refuseThenRegrant(async (page, space) => {
      // The shell asks the runtime from inside the `focus` handler, so the
      // retries it asked for are the calls made while the event is
      // dispatched.
      const asked = await page.evaluate((space) => {
        const rt = globalThis.commonfabric?.rt;
        if (rt === undefined) throw new Error("No runtime client exposed");
        const asked: string[] = [];
        const retrySpaceAccess = rt.retrySpaceAccess;
        rt.retrySpaceAccess = (retried) => {
          asked.push(retried);
          return retrySpaceAccess.call(rt, retried);
        };
        try {
          globalThis.dispatchEvent(new Event("focus"));
        } finally {
          Reflect.deleteProperty(rt, "retrySpaceAccess");
        }
        return asked.filter((retried) => retried === space);
      }, { args: [space] });
      expect(asked).toEqual([space]);
    });
  });

  it("keeps keyboard focus on the Retry button through a retry that is refused", async () => {
    await using ownerFile = await writeTempIdentity({
      implementation: "noble",
    });
    const owner = ownerFile.identity;
    const member = await Identity.generate({ implementation: "noble" });
    const space = await createTestSpace(owner, {
      grants: { [member.did()]: "WRITE" },
    });
    const pieceId = await filePiece(ownerFile.path, space);
    const controller = await PiecesController.initialize({
      space,
      apiUrl: new URL(API_URL),
      identity: owner,
    });
    try {
      const acl = new ACLManager(controller.runtime, space);
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceDid: space, pieceId },
        identity: member,
      });
      expect(await waitForRetryOutcome(page, 0)).toBe("piece");
      await acl.remove(member.did());
      const retries = await waitForRefusal(page);

      // Focus the control from the page, and press it from the keyboard, as
      // someone tabbing to it would.
      await waitForCondition(page, (probe) => {
        const button = probe.collect("[data-space-access-retry]").at(-1);
        if (!(button instanceof HTMLElement)) return false;
        button.focus();
        return true;
      });
      await page.keyboard.press("Enter");
      expect(await waitForRetryOutcome(page, retries)).toBe("refused");

      const focused = await waitForCondition(page, () => {
        let active: Element | null = document.activeElement;
        while (active?.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        return {
          retry: active?.hasAttribute("data-space-access-retry") ?? false,
        };
      });
      expect(focused).toEqual({ retry: true });
    } finally {
      await controller.dispose();
    }
  });
});
