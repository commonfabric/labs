/**
 * A person's chat manager in a browser after the counterpart of a direct room
 * they started removes them from its access list, as `cf acl remove` does,
 * and the person starts a chat with the counterpart again. The start finds the
 * room the counterpart removed them from, as `ChatManagerOutput.md` says of a
 * `direct` entry whose space is not deleted, and the room's notice still
 * draws, on a page whose runtime has been refused the room.
 */

import { debugStr } from "@commonfabric/data-model";
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
  collectBrowserLoadSummary,
  fillCfInput,
  readCfInputProbe,
  readTrustedActionProbe,
  waitForRuntimeIdle,
  waitForSettledText,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { directRoomLabel } from "./fabrichat-room-fixture.ts";
import { initializePiecesController } from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;

// Trusted action names: the runtime's profile create form, and FabriChat's
// chat start (`system/fabrichat/schemas.tsx`).
const PROFILE_CREATE_ACTION = "CreateProfile";
const START_ACTION = "ChatStart";

/** What a notice says of its recipient, on either side of their address. */
const NOTICE_TEXT = "may not know of this chat yet";

/** Waits until the page shows a notice for `listed`, named by their address. */
async function waitForNotice(page: Page, listed: string): Promise<void> {
  await waitForCondition(
    page,
    (probe, listed, notice) => {
      const text = probe.collect("x-root-view")
        .map((element) => probe.deepText(element))
        .join(" ").replace(/\s+/g, " ");
      return text.includes(`${listed} ${notice}`);
    },
    { args: [listed, NOTICE_TEXT] },
  );
}

describe("fabrichat-refused-room", () => {
  const first = new ShellIntegration();
  first.bindLifecycle();
  const second = new ShellIntegration();
  second.bindLifecycle();

  it("draws a room's notice after the person, removed from the room, starts the chat again", async () => {
    const firstPage = first.page();
    const secondPage = second.page();
    const identity = await Identity.generate({ implementation: "noble" });
    const counterpart = await Identity.generate({ implementation: "noble" });
    const remover = counterpart.did();

    await first.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });
    await clickCfButton(firstPage, 'cf-tab[value="profile"]');
    await fillCfInput(
      firstPage,
      "#wish-profile-picker-name-input",
      "Ada Lovelace",
    );
    await clickTrustedAction(firstPage, PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(firstPage);
    await waitForText(firstPage, "#home-profile-summary", "Ada Lovelace");

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
      await first.goto({
        frontendUrl: FRONTEND_URL,
        view: managerView,
        identity,
      });
      await fillCfInput(firstPage, "#fabrichat-start-direct", remover);
      await clickTrustedAction(firstPage, START_ACTION);
      await waitForSettledText(
        firstPage,
        "#fabrichat-rooms",
        directRoomLabel(remover),
      );
      await waitForNotice(firstPage, remover);

      const manager = home.key("chatManager" as never) as unknown as Cell<{
        direct: Record<string, { room: unknown }>;
        requests: Record<string, { status: string }>;
      }>;
      const roomOf = () =>
        manager.key("direct").key(remover).key("room").resolveAsCell()
          .getAsNormalizedFullLink().space;
      await waitForCellValue(
        controller.runtime,
        manager.key("direct").key(remover),
        (value) => value !== undefined,
        { stuckLabel: "the room held in `direct`" },
      );
      const space = roomOf();

      // With no page of the person's open, the counterpart, made an owner,
      // removes them.
      await first.disposeRuntime();
      await firstPage.goto("about:blank");
      const granter = await initializePiecesController({
        space,
        apiUrl: new URL(API_URL),
        identity,
      });
      try {
        await new ACLManager(granter.runtime, space).set(remover, "OWNER");
      } finally {
        await granter.dispose();
      }
      const removing = await initializePiecesController({
        space,
        apiUrl: new URL(API_URL),
        identity: counterpart,
      });
      try {
        const acl = new ACLManager(removing.runtime, space);
        await acl.remove(identity.did());
        expect(Object.keys((await acl.get()) ?? {})).toEqual([remover]);
      } finally {
        await removing.dispose();
      }

      // The person comes back to Home, then to the manager, which draws the
      // notice, and starts the chat again.
      await second.goto({
        frontendUrl: FRONTEND_URL,
        view: { builtin: "home" },
        identity,
      });
      await waitForRuntimeIdle(secondPage);
      await second.goto({
        frontendUrl: FRONTEND_URL,
        view: managerView,
        identity,
      });
      await waitForNotice(secondPage, remover);
      await fillCfInput(secondPage, "#fabrichat-start-direct", remover);
      await clickTrustedAction(secondPage, START_ACTION);
      const outcomes = await waitForCellValue<
        Record<string, { status: string }>
      >(
        controller.runtime,
        manager.key("requests"),
        (value) =>
          Object.values(value ?? {}).filter(({ status }) =>
            status !== "pending"
          ).length === 2,
        { stuckLabel: "both starts' outcomes" },
      ).catch(async (cause) => {
        const diagnostics = await Promise.allSettled([
          readCfInputProbe(secondPage, "#fabrichat-start-direct"),
          readTrustedActionProbe(secondPage, START_ACTION),
          collectBrowserLoadSummary(secondPage, "second chat start"),
        ]);
        throw new Error(
          debugStr`Second chat start diagnostics: $quote,indent,xlong${diagnostics}`,
          { cause },
        );
      });
      expect(Object.values(outcomes).map(({ status }) => status)).toEqual([
        "done",
        "done",
      ]);
      expect(roomOf()).toBe(space);

      await waitForNotice(secondPage, remover);
    } finally {
      await controller.dispose();
    }
  });
});
