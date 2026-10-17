/**
 * FabriChat's way in, driven through the page alone by two people, each in a
 * browser of their own, on a home that holds the real FabriChat manager. Each
 * person opens the manager as a page of its own, at its path in home's result.
 * The second person creates a profile and reads their chat address off their
 * manager. The first creates a profile, starts a direct chat with that address,
 * sees the room listed in their manager, and follows the link their notice
 * shows to the room's page. The second opens that page and sends a message,
 * which the first sees on the room's page. Sending it joins the second to the
 * room, so each sees the other among its participants, and the second's
 * manager then lists the room too. Last, the
 * first opens their manager again, creates a group from the group controls of
 * that new page, and starts another chat, whose row's link opens the new room.
 * Then someone who shares a group with another person adds them to a second
 * group from its page, by address alone; their manager offers it to the
 * person through the profile it lists for them, the room's page shows it was
 * offered, and the person's own manager lists it once they open it. And
 * someone a group names by address alone, who is offered nothing, finds it in
 * their chats once they have only opened its page, which joins them to it.
 */

import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  fillCfTextarea,
  waitForRuntimeIdle,
  waitForSettledText,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { clickButtonWithExactText } from "./note-button-helpers.ts";
import { initializePiecesController } from "./pieces-controller.ts";
import { clickCellLink } from "./topics-navigation-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

// Trusted action names: the runtime's profile create form, and FabriChat's
// chat start, message write and member add (`fabrichat/schemas.tsx`).
const PROFILE_CREATE_ACTION = "CreateProfile";
const START_ACTION = "ChatStart";
const SEND_ACTION = "ChatSend";
const ADD_MEMBER_ACTION = "ChatAddMember";

// What a direct room calls itself, which is also what a link to it shows.
const DIRECT_ROOM_NAME = "Direct chat";

// Whether this run's servers serve handlers from a serving loop.
const SERVER_EXECUTION = (() => {
  const raw = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
  return raw === undefined ? SERVER_EXECUTION_DEFAULT_ENABLED : raw === "true";
})();

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

  // Two people who share a group room and nothing else, so that a direct chat
  // between them is new.
  let groupOwnerIdentity: Identity;
  let groupMemberIdentity: Identity;

  // Two people who share a group room, one of whom adds the other to a second.
  let adderIdentity: Identity;
  let addedIdentity: Identity;

  // A group's owner, and someone named in it by address, who only opens it.
  let visitedOwnerIdentity: Identity;
  let visitorIdentity: Identity;

  beforeAll(async () => {
    firstIdentity = await Identity.generate({ implementation: "noble" });
    secondIdentity = await Identity.generate({ implementation: "noble" });
    thirdIdentity = await Identity.generate({ implementation: "noble" });
    groupOwnerIdentity = await Identity.generate({ implementation: "noble" });
    groupMemberIdentity = await Identity.generate({ implementation: "noble" });
    adderIdentity = await Identity.generate({ implementation: "noble" });
    addedIdentity = await Identity.generate({ implementation: "noble" });
    visitedOwnerIdentity = await Identity.generate({ implementation: "noble" });
    visitorIdentity = await Identity.generate({ implementation: "noble" });
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
    // list yet, and sends, and the first sees the message on the room's page.
    await secondShell.goto({
      frontendUrl: FRONTEND_URL,
      view: roomView,
      identity: secondIdentity,
    });
    await waitForSettledText(second, "#fabrichat-messages", EMPTY_ROOM_TEXT);
    const body = "Hello from Grace";
    await fillCfInput(second, "#fabrichat-message", body);
    await clickTrustedAction(second, SEND_ACTION);
    await waitForText(second, "#fabrichat-messages", body);
    await waitForSettledText(first, "#fabrichat-messages", body);

    // Each person is among the room's participants: the first joined it by
    // creating it, and the second by writing in it. A page shows its own
    // viewer's badge whatever the room lists, so each checks for the other.
    await waitForSettledText(second, "cf-profile-badge", "Ada Lovelace");
    await waitForSettledText(first, "cf-profile-badge", "Grace Hopper");

    // Both people are now looking at the room. What each runtime does while
    // nothing more happens says whether their views of it fight.
    await reportChurn(first, second, "both viewing the room");

    // The second person's manager lists the room they joined, under the first
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

  it("starts a direct chat from a participant's chip in a group room", async () => {
    const owner = firstShell.page();
    const member = secondShell.page();

    await gotoHome(secondShell, groupMemberIdentity);
    await createProfileAtHome(member, "Grace Hopper");
    await openChatManager(secondShell, groupMemberIdentity);
    const memberAddress = await readChatAddress(member);

    // The owner creates a group with the member, and opens its page.
    const groupTitle = "Chip team";
    await gotoHome(firstShell, groupOwnerIdentity);
    await createProfileAtHome(owner, "Ada Lovelace");
    await openChatManager(firstShell, groupOwnerIdentity);
    await fillCfInput(owner, "#fabrichat-group-title", groupTitle);
    // The group's members field is the manager page's one textarea.
    await fillCfTextarea(owner, "cf-textarea", memberAddress);
    await clickButtonWithExactText(owner, "Create group");
    await waitForSettledText(owner, "#fabrichat-rooms", groupTitle);
    const roomId = await clickCellLink(owner, groupTitle);
    const roomView = await waitForPieceSelected(owner, roomId);

    // The member opens the group's page, and sees the owner among its
    // participants.
    await secondShell.goto({
      frontendUrl: FRONTEND_URL,
      view: roomView,
      identity: groupMemberIdentity,
    });
    await waitForSettledText(member, "#fabrichat-messages", EMPTY_ROOM_TEXT);
    await waitForSettledText(member, "cf-profile-badge", "Ada Lovelace");

    // The owner's chip is the page's one chat start: the member's own chip
    // offers none. Its click names the owner by their profile, and the
    // member's manager lists the direct room it starts under the owner's
    // address, which it reads off that profile.
    await clickTrustedAction(member, START_ACTION);
    await openChatManager(secondShell, groupMemberIdentity);
    await waitForSettledText(
      member,
      "#fabrichat-rooms",
      `With ${groupOwnerIdentity.did()}`,
    );
  });

  it("offers a group to someone its owner adds from the room, through the owner's manager", async () => {
    const adder = firstShell.page();
    const added = secondShell.page();

    await gotoHome(secondShell, addedIdentity);
    await createProfileAtHome(added, "Grace Hopper");
    await openChatManager(secondShell, addedIdentity);
    const addedAddress = await readChatAddress(added);

    // The adder creates a group with the person they will add, who writes in
    // it, which joins them to it: it puts them on its roster, and so among the
    // adder's people.
    const firstTitle = "Met team";
    await gotoHome(firstShell, adderIdentity);
    await createProfileAtHome(adder, "Ada Lovelace");
    await openChatManager(firstShell, adderIdentity);
    await fillCfInput(adder, "#fabrichat-group-title", firstTitle);
    await fillCfTextarea(adder, "cf-textarea", addedAddress);
    await clickButtonWithExactText(adder, "Create group");
    await waitForSettledText(adder, "#fabrichat-rooms", firstTitle);
    const firstRoomId = await clickCellLink(adder, firstTitle);
    const firstRoomView = await waitForPieceSelected(adder, firstRoomId);
    await secondShell.goto({
      frontendUrl: FRONTEND_URL,
      view: firstRoomView,
      identity: addedIdentity,
    });
    await waitForSettledText(added, "#fabrichat-messages", EMPTY_ROOM_TEXT);
    await fillCfInput(added, "#fabrichat-message", "Hello from Grace");
    await clickTrustedAction(added, SEND_ACTION);
    await waitForText(added, "#fabrichat-messages", "Hello from Grace");
    await waitForSettledText(adder, "cf-profile-badge", "Grace Hopper");

    // The adder creates a second group, of their own alone, and opens it. Its
    // add control offers the person from their chats.
    const secondTitle = "Added team";
    await openChatManager(firstShell, adderIdentity);
    await waitForSettledText(adder, "#fabrichat-group-people", "Grace Hopper");
    await fillCfInput(adder, "#fabrichat-group-title", secondTitle);
    await clickButtonWithExactText(adder, "Create group");
    await waitForSettledText(adder, "#fabrichat-rooms", secondTitle);
    const secondRoomId = await clickCellLink(adder, secondTitle);
    const secondRoomView = await waitForPieceSelected(adder, secondRoomId);
    await waitForSettledText(
      adder,
      "#fabrichat-add-member-people",
      "Grace Hopper",
    );

    // Added by their address alone, the person is offered the room through
    // the profile the adder's manager lists for them, which points at their
    // Home's private inbox, and the room's page, reading the manager's verdict
    // from the adder's home, says so. Under server execution the session's
    // `people` lists nobody: deriving it has the serving runtime read each
    // room's space at session scope, which it refuses for a space other than
    // the one it serves. So the served handler finds no profile for them, and
    // queues a notice instead.
    // TODO(danfuzz): Expect `offered` under server execution too, and the
    // room in the person's chats below, once deriving `people` takes no
    // per-session read of a room's space.
    await fillCfInput(adder, "#fabrichat-add-member-address", addedAddress);
    await clickTrustedAction(adder, ADD_MEMBER_ACTION);
    await waitForSettledText(
      adder,
      "#fabrichat-add-member-outcome",
      SERVER_EXECUTION
        ? `Added ${addedAddress}. Your chats remind you to send them this chat's link.`
        : `Added ${addedAddress}, and offered them this chat.`,
    );

    // The adds the room records are the adder's own: the adder reads theirs
    // through the room, and the person added, a member of the room now, reads
    // none of them.
    expect(
      Object.values(
        await addRequestsAs(adderIdentity, secondRoomView),
      ).map((outcome) => (outcome as { delivery?: string }).delivery),
    ).toEqual([SERVER_EXECUTION ? "noticed" : "offered"]);
    expect(await addRequestsAs(addedIdentity, secondRoomView)).toEqual({});

    // The person opens their manager in a page that never asks for their
    // Home's root, and finds the room offered to them in their chats: the
    // shell brings their Home up there once the page has settled, which starts
    // the share intake that registers the offer for their manager to accept.
    // A room that is only noticed has nothing to register.
    if (!SERVER_EXECUTION) {
      await openChatManager(secondShell, addedIdentity);
      await waitForSettledText(added, "#fabrichat-rooms", secondTitle);
    }
  });
  it("lists a group in the chats of someone who only opens its page", async () => {
    const owner = firstShell.page();
    const visitor = secondShell.page();

    await gotoHome(secondShell, visitorIdentity);
    await createProfileAtHome(visitor, "Grace Hopper");
    await openChatManager(secondShell, visitorIdentity);
    const visitorAddress = await readChatAddress(visitor);

    // The owner names the visitor by address alone, so their manager is
    // offered nothing, and opens the group's page.
    const title = "Visited team";
    await gotoHome(firstShell, visitedOwnerIdentity);
    await createProfileAtHome(owner, "Ada Lovelace");
    await openChatManager(firstShell, visitedOwnerIdentity);
    await fillCfInput(owner, "#fabrichat-group-title", title);
    await fillCfTextarea(owner, "cf-textarea", visitorAddress);
    await clickButtonWithExactText(owner, "Create group");
    await waitForSettledText(owner, "#fabrichat-rooms", title);
    const roomId = await clickCellLink(owner, title);
    const roomView = await waitForPieceSelected(owner, roomId);

    // The visitor opens the group's page and writes nothing there. Visiting it
    // joins them to it, so their manager then lists it.
    await secondShell.goto({
      frontendUrl: FRONTEND_URL,
      view: roomView,
      identity: visitorIdentity,
    });
    await waitForSettledText(visitor, "#fabrichat-messages", EMPTY_ROOM_TEXT);
    await openChatManager(secondShell, visitorIdentity);
    await waitForSettledText(visitor, "#fabrichat-rooms", title);
  });
});

/** The room's `addRequests`, as `identity` reads it through the room. */
async function addRequestsAs(
  identity: Identity,
  roomView: { spaceDid: DID; pieceId: string },
): Promise<Record<string, unknown>> {
  const controller = await initializePiecesController({
    space: roomView.spaceDid,
    apiUrl: new URL(API_URL),
    identity,
  });
  try {
    const room = await controller.get(roomView.pieceId, true);
    return (await room.result.get(["addRequests"])) as Record<string, unknown>;
  } finally {
    await controller.dispose();
  }
}

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
