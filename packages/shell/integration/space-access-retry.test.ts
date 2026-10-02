/**
 * A member removed from a space, and then granted it again, coming back to
 * the space's piece in the shell without reloading. The memory server refuses
 * the member's runtime the space at the removal and sends nothing at the
 * grant, so what brings the piece back is the shell asking again: through the
 * Retry button on the renderer's "Access unavailable" placeholder, or on the
 * page regaining focus.
 */

import { join, resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { type DID, Identity } from "@commonfabric/identity";
import {
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
 * Waits until the page shows the piece, which it does only while the space
 * admits the member: the marker is there and no placeholder stands in for it.
 */
async function waitForPiece(page: Page): Promise<void> {
  await waitForCondition(
    page,
    (probe) =>
      probe.collect("#refused-space-marker").some((el) =>
        probe.deepText(el).trim() === "refused space piece"
      ) && probe.collect("[data-space-access-lost]").length === 0,
  );
}

/**
 * Waits until the page shows the refusal in the piece's place: the placeholder
 * with its Retry button, and no marker.
 */
async function waitForRefusal(page: Page): Promise<void> {
  await waitForCondition(
    page,
    (probe) =>
      probe.collect("[data-space-access-lost]").some((el) =>
        probe.deepText(el).includes("Access unavailable") &&
        el.querySelector("[data-space-access-retry]") !== null
      ) && probe.collect("#refused-space-marker").length === 0,
  );
}

describe("shell space access retry", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  /**
   * Shows the owner's piece to a member in the shell, removes the member from
   * the space and waits for the refusal, then grants the member the space
   * again, and hands the page and the space to `recover`.
   */
  async function refuseThenRegrant(
    recover: (page: Page) => Promise<void>,
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
      await waitForPiece(page);

      await acl.remove(member.did());
      await waitForRefusal(page);

      await acl.set(member.did(), "WRITE");
      await recover(page);
      await waitForPiece(page);
    } finally {
      await controller.dispose();
    }
  }

  it("shows the piece again once the member presses Retry", async () => {
    await refuseThenRegrant(async (page) => {
      await clickPierce(page, "[data-space-access-retry]");
    });
  });

  it("shows the piece again once the page regains focus", async () => {
    await refuseThenRegrant(async (page) => {
      await page.evaluate(() => {
        globalThis.dispatchEvent(new Event("focus"));
      });
    });
  });
});
