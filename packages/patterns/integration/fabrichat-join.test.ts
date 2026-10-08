/**
 * FabriChat's way in, driven through the page alone by two people, each in a
 * browser of their own, on a home that holds the real FabriChat manager. Each
 * person opens the manager as a page of its own, at its path in home's result.
 * The second person creates a profile and reads their chat address off their
 * manager. The first creates a profile, starts a direct chat with that address,
 * sees the room listed in their manager, and follows the link their notice
 * shows to the room's page. The second opens that page and adds the room to
 * their chats, after which each sees the other among the room's participants,
 * before either has written. The second sends a message, which the first sees
 * on the room's page; the second's manager then lists the room too. Last, the
 * first opens their manager again, creates a group from the group controls of
 * that new page, and starts another chat, whose row's link opens the new room.
 */

import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  waitForRuntimeIdle,
  waitForSettledText,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { clickButtonWithExactText } from "./note-button-helpers.ts";
import { initializePiecesController } from "./pieces-controller.ts";
import { clickCellLink } from "./topics-navigation-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

// Trusted action names: the runtime's profile create form, and FabriChat's
// chat start and message write (`fabrichat/schemas.tsx`).
const PROFILE_CREATE_ACTION = "CreateProfile";
const START_ACTION = "ChatStart";
const SEND_ACTION = "ChatSend";

// What a direct room calls itself, which is also what a link to it shows.
const DIRECT_ROOM_NAME = "Direct chat";

// What a room with no messages shows in place of them.
const EMPTY_ROOM_TEXT = "No messages yet";

describe("fabrichat-join", () => {
  const firstShell = new ShellIntegration();
  firstShell.bindLifecycle();
  const secondShell = new ShellIntegration();
  secondShell.bindLifecycle();

  let firstIdentity: Identity;
  let secondIdentity: Identity;

  // Someone the first person chats with second, who never opens a page.
  let thirdIdentity: Identity;

  beforeAll(async () => {
    firstIdentity = await Identity.generate({ implementation: "noble" });
    secondIdentity = await Identity.generate({ implementation: "noble" });
    thirdIdentity = await Identity.generate({ implementation: "noble" });
  });

  it("lets two people start a direct chat from home, join it from its link, and exchange a message", async () => {
    const first = firstShell.page();
    const second = secondShell.page();

    // The second person's address, as their own manager shows it. It is
    // the principal their profile attests, which is their identity's DID.
    await gotoHome(secondShell, secondIdentity);
    await createProfileAtHome(second, "Grace Hopper");
    await openChatManager(secondShell, secondIdentity);
    const address = await readChatAddress(second);
    expect(address).toBe(secondIdentity.did());

    // The first person starts a direct chat with that address, and their
    // manager lists it.
    await gotoHome(firstShell, firstIdentity);
    await createProfileAtHome(first, "Ada Lovelace");
    await openChatManager(firstShell, firstIdentity);
    await fillCfInput(first, "#fabrichat-start-direct", address);
    await clickTrustedAction(first, START_ACTION);
    await waitForSettledText(first, "#fabrichat-rooms", `With ${address}`);

    // The notice for the second person links to the room, and following it
    // opens the room's page.
    const roomId = await clickCellLink(first, DIRECT_ROOM_NAME);
    const roomView = await waitForPieceSelected(first, roomId);
    expect(roomView.spaceDid).not.toBe(firstIdentity.did());
    await waitForSettledText(first, "#fabrichat-messages", EMPTY_ROOM_TEXT);

    // The second person opens the room's page, which their manager does not
    // list yet, adds it to their chats, and the offer to do so goes away.
    await secondShell.goto({
      frontendUrl: FRONTEND_URL,
      view: roomView,
      identity: secondIdentity,
    });
    await waitForSettledText(second, "#fabrichat-messages", EMPTY_ROOM_TEXT);
    await clickButtonWithExactText(second, "Add to my chats");
    await waitForUnrendered(second, "#fabrichat-add-to-chats");

    // Each person is among the room's participants before either has written:
    // the first joined it by creating it, and the second by adding it. A page
    // shows its own viewer's badge whatever the room lists, so each checks for
    // the other.
    await waitForSettledText(second, "cf-profile-badge", "Ada Lovelace");
    await waitForSettledText(first, "cf-profile-badge", "Grace Hopper");

    // Both people are now looking at the room. What each runtime does while
    // nothing more happens says whether their views of it fight.
    await reportChurn(first, second, "both viewing the room");

    // The second person sends, and the first sees the message on the room's
    // page.
    const body = "Hello from Grace";
    await fillCfInput(second, "#fabrichat-message", body);
    await clickTrustedAction(second, SEND_ACTION);
    await waitForText(second, "#fabrichat-messages", body);
    await waitForSettledText(first, "#fabrichat-messages", body);

    // The second person's manager lists the room they added, under the first
    // person's address.
    await openChatManager(secondShell, secondIdentity);
    await waitForSettledText(
      second,
      "#fabrichat-rooms",
      `With ${firstIdentity.did()}`,
    );

    // The first person starts a second chat, whose row's link opens the new
    // room. The manager renders no room, so its start control is the only one
    // on the page, where a room would offer a chat with each of its
    // participants as well.
    await openChatManager(firstShell, firstIdentity);
    await waitForSettledText(first, "#fabrichat-rooms", `With ${address}`);

    // A reloaded page is a new session, whose group draft starts out empty,
    // and a group composed there is created with the title typed into it.
    const groupTitle = "Reload team";
    await fillCfInput(first, "#fabrichat-group-title", groupTitle);
    await clickButtonWithExactText(first, "Create group");
    await waitForSettledText(first, "#fabrichat-rooms", groupTitle);

    const thirdAddress = thirdIdentity.did();
    await fillCfInput(first, "#fabrichat-start-direct", thirdAddress);
    await clickTrustedAction(first, START_ACTION);
    await waitForSettledText(first, "#fabrichat-rooms", `With ${thirdAddress}`);
    const newRoomId = await clickCellLink(first, `With ${thirdAddress}`);
    const newRoomView = await waitForPieceSelected(first, newRoomId);
    expect(newRoomView.spaceDid).not.toBe(roomView.spaceDid);
    expect(newRoomView.spaceDid).not.toBe(firstIdentity.did());
  });
});

/** Opens `identity`'s home on `shell`. */
async function gotoHome(
  shell: ShellIntegration,
  identity: Identity,
): Promise<void> {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
}

/**
 * Opens `identity`'s chat manager on `shell`, as a page of its own at its path
 * in home's result. Home must already exist.
 */
async function openChatManager(
  shell: ShellIntegration,
  identity: Identity,
): Promise<void> {
  const controller = await initializePiecesController({
    space: identity.did(),
    apiUrl: new URL(API_URL),
    identity,
  });
  let pieceId: string;
  try {
    const home = await controller.getDefaultPattern(false);
    if (home === undefined) {
      throw new Error("The home space has no default pattern.");
    }
    pieceId = home.getAsNormalizedFullLink().id;
  } finally {
    await controller.dispose();
  }
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { spaceDid: identity.did(), pieceId, piecePath: ["chatManager"] },
    identity,
  });
}

/** Creates the viewer's profile from their home's Profile tab. */
async function createProfileAtHome(page: Page, name: string): Promise<void> {
  await clickCfButton(page, 'cf-tab[value="profile"]');
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
  await waitForText(page, "#home-profile-summary", name);
}

/** Waits for the manager to show the viewer's chat address, and reads it. */
async function readChatAddress(page: Page): Promise<string> {
  const address = await waitForCondition(page, (probe) => {
    for (const element of probe.collect("#fabrichat-my-address")) {
      const found = probe.deepText(element).match(
        /did:key:z[1-9A-HJ-NP-Za-km-z]+/,
      );
      if (found) return found[0];
    }
    return false;
  });
  if (typeof address !== "string") {
    throw new Error("The chat address wait resolved with no address.");
  }
  return address;
}

/**
 * Waits for the shell to select the piece `pieceId` names, in whatever space,
 * and returns the view it selected. A piece is addressed both bare (`fid1:…`)
 * and in storage form (`of:fid1:…`); either spelling matches.
 */
async function waitForPieceSelected(
  page: Page,
  pieceId: string,
): Promise<{ spaceDid: DID; pieceId: string }> {
  const view = await waitForCondition(
    page,
    (_probe, expectedPieceId: string) => {
      const fid = (id: string | undefined) => id?.replace(/^of:/, "");
      const view = (globalThis.app?.serialize() as
        | { view?: { spaceDid?: string; pieceId?: string } }
        | undefined)?.view;
      return view?.spaceDid !== undefined &&
          view.pieceId !== undefined &&
          fid(view.pieceId) === fid(expectedPieceId)
        ? { spaceDid: view.spaceDid, pieceId: view.pieceId }
        : false;
    },
    { args: [pieceId] },
  );
  if (view === undefined) {
    throw new Error("The piece view wait resolved with no view.");
  }
  return { spaceDid: view.spaceDid as DID, pieceId: view.pieceId };
}

/** Waits until every element matching `selector` is present and unrendered. */
async function waitForUnrendered(page: Page, selector: string): Promise<void> {
  await waitForRuntimeIdle(page);
  await waitForCondition(
    page,
    (probe, target: string) => {
      const found = probe.collect(target);
      return found.length > 0 &&
        found.every((element) => !probe.isRendered(element));
    },
    { args: [selector] },
  );
}

/**
 * Logs how much each page's runtime ran and conflicted across a settle of
 * both pages with no stimulus between, so that two runtimes overwriting each
 * other's view of a shared room shows as counts that keep climbing.
 */
async function reportChurn(
  first: Page,
  second: Page,
  label: string,
): Promise<void> {
  const churnOf = async (page: Page, name: string) =>
    (await collectBrowserLoadSummary(page, name)).churn;
  const before = [
    await churnOf(first, "first"),
    await churnOf(second, "second"),
  ];
  await waitForRuntimeIdle(first);
  await waitForRuntimeIdle(second);
  const after = [
    await churnOf(first, "first"),
    await churnOf(second, "second"),
  ];
  ["first", "second"].forEach((name, index) => {
    const was = before[index];
    const now = after[index];
    console.log(
      `[fabrichat-join] ${label}, ${name} page: ` +
        `actionRuns ${was.actionRuns} -> ${now.actionRuns}, ` +
        `commitConflicts ${was.commitConflicts} -> ${now.commitConflicts}, ` +
        `commitReverts ${was.commitReverts} -> ${now.commitReverts}, ` +
        `scheduleRunErrors ${was.scheduleRunErrors} -> ` +
        `${now.scheduleRunErrors}`,
    );
  });
}
