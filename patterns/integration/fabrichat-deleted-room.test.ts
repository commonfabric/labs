/**
 * A person's chat manager in a browser after a room they started is really
 * deleted, as `cf space delete` deletes it: the room's notice is gone from the
 * page, and the notice of a live room stays, on the page that was open at the
 * deletion and on one opened after it. Home's catalog records the deletion,
 * through Home's own handler, and leaves the live room's entry as it was.
 */

import { Identity } from "@commonfabric/identity";
import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { ACLManager, type Cell } from "@commonfabric/runner";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForSettledText,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { initializePiecesController } from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;

// Trusted action names: the runtime's profile create form, and FabriChat's
// chat start (`system/fabrichat/schemas.tsx`).
const PROFILE_CREATE_ACTION = "CreateProfile";
const START_ACTION = "ChatStart";

/** What a notice says of its recipient, on either side of their address. */
const NOTICE_TEXT = "may not know of this chat yet";

/**
 * Waits until the page shows a notice for `listed`, and none for `withheld`,
 * each named by their address.
 */
async function waitForNotices(
  page: Page,
  listed: string,
  withheld: string,
): Promise<void> {
  await waitForCondition(
    page,
    (probe, listed, withheld, notice) => {
      const text = probe.collect("x-root-view")
        .map((element) => probe.deepText(element))
        .join(" ").replace(/\s+/g, " ");
      return text.includes(`${listed} ${notice}`) &&
        !text.includes(`${withheld} ${notice}`);
    },
    { args: [listed, withheld, NOTICE_TEXT] },
  );
}

describe("fabrichat-deleted-room", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("takes a deleted room's notice off the page, and leaves a live room's", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });
    const goner = (await Identity.generate({ implementation: "noble" })).did();
    const friend = (await Identity.generate({ implementation: "noble" })).did();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });
    await clickCfButton(page, 'cf-tab[value="profile"]');
    await fillCfInput(page, "#wish-profile-picker-name-input", "Ada Lovelace");
    await clickTrustedAction(page, PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    const controller = await initializePiecesController({
      space: identity.did(),
      apiUrl: new URL(API_URL),
      identity,
    });
    try {
      const home = (await controller.getDefaultPattern(false))!;
      const managerView = {
        spaceDid: identity.did(),
        pieceId: home.getAsNormalizedFullLink().id,
        piecePath: ["chatManager"],
      };
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: managerView,
        identity,
      });
      for (const counterpart of [goner, friend]) {
        await fillCfInput(page, "#fabrichat-start-direct", counterpart);
        await clickTrustedAction(page, START_ACTION);
        await waitForSettledText(
          page,
          "#fabrichat-rooms",
          `With ${counterpart}`,
        );
      }

      const manager = home.key("chatManager" as never) as unknown as Cell<{
        direct: Record<string, { room: unknown }>;
      }>;
      await waitForCellValue(
        controller.runtime,
        manager.key("direct").key(goner),
        (value) => value !== undefined,
        { stuckLabel: "the first room held in `direct`" },
      );
      const space = manager.key("direct").key(goner).key("room")
        .resolveAsCell().getAsNormalizedFullLink().space;
      await waitForCellValue(
        controller.runtime,
        manager.key("direct").key(friend),
        (value) => value !== undefined,
        { stuckLabel: "the second room held in `direct`" },
      );
      const liveSpace = manager.key("direct").key(friend).key("room")
        .resolveAsCell().getAsNormalizedFullLink().space;

      // Its sole member deletes it, once the other is removed.
      const deleter = await initializePiecesController({
        space,
        apiUrl: new URL(API_URL),
        identity,
      });
      try {
        const acl = new ACLManager(deleter.runtime, space);
        await acl.remove(goner);
        await acl.delete(identity.did());
      } finally {
        await deleter.dispose();
      }

      await waitForNotices(page, friend, goner);

      // The runtime that heard of the deletion has Home's own handler record
      // it, which asks the memory server itself, and the live room is left.
      const catalog = home.key(
        "sharedSpaceCatalog" as never,
      ) as unknown as Cell<
        { entries: Record<string, { state: string }> }
      >;
      const entries = await waitForCellValue<Record<string, { state: string }>>(
        controller.runtime,
        catalog.key("entries"),
        (value) => value?.[space]?.state === "deleted",
        { stuckLabel: "the deleted room's catalog entry marked deleted" },
      );
      expect(entries[liveSpace]?.state).toBe("saved");

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: managerView,
        identity,
      });
      await waitForNotices(page, friend, goner);
    } finally {
      await controller.dispose();
    }
  });
});
