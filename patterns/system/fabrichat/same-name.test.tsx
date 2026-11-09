/**
 * Telling apart two people a manager lists under the same name. Ada and
 * another Ada, each under a principal of her own, and Grace each write a
 * profile pointing at an inbox of their own, and send a message in a lobby, in
 * that order, which hands Bob their profiles. Bob starts a direct chat with the first Ada and with Grace, and
 * his manager's group picker lists both with nothing beside their names. Once
 * he starts one with the other Ada too, it lists each Ada beside the end of
 * her principal, and Grace still with nothing. Each person writes their own
 * profile here, so its label names them, as a Fabric profile's does.
 */
import {
  action,
  assert,
  type Cell,
  currentPrincipal,
  handler,
  multiUserTest,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import PrivateInbox from "../private-inbox/private-inbox.tsx";
import type { ShareInboxPiece } from "../profile-home/profile-home.tsx";
import type { SharedSpaceCatalogStorage } from "../shared-space/shared-space-catalog.ts";
import { SAME_NAME_MARK_LENGTH } from "./logic.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import { type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerProfile,
  type ChatRequestOutcome,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "FabriChatTestProfileSurface";
const PROFILE_ACTION = "FabriChatTestWriteProfile";

const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };
const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatManagerProfile,
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  /** The profile to write. */
  profile: Writable<OwnProfile>;

  /** The name to write into it. */
  name: string;

  /** The inbox the profile points at, if any. */
  inbox?: Cell<ShareInboxPiece>;
}

/** Writes the acting person's own profile, under `name`. */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name, inbox },
) => {
  profile.set(
    (inbox === undefined
      ? { name }
      : { name, inbox: { piece: inbox } }) as OwnProfile,
  );
});

/** An inbox's result, as the link a profile holds. */
function inboxLinkOf(inbox: unknown): Cell<ShareInboxPiece>;
function inboxLinkOf(inbox: unknown): unknown {
  return inbox;
}

/** A person's own profile, as the profile an event names. */
function profileOf(profile: unknown): Cell<ChatManagerProfile>;
function profileOf(profile: unknown): unknown {
  return profile;
}

/** The text the manager's group picker shows, under its view `ui`. */
const pickerText = (ui: unknown): string =>
  textContent(findNodeById(ui, "fabrichat-group-people"));

/** The mark that tells apart the person whose principal is `did`. */
const markOf = (did: string): string => `…${did.slice(-SAME_NAME_MARK_LENGTH)}`;

/** What every session receives from the setup. */
interface Setup {
  /** The records of the lobby everyone but Bob writes in. */
  lobby: { messages: Writable<MessagesValue> };

  /** Each writer's principal, as their own run of a handler finds it. */
  adaDid: Writable<string>;
  otherAdaDid: Writable<string>;
  graceDid: Writable<string>;
}

export const setup = pattern(() => ({
  lobby: { messages: Writable.of<MessagesValue>([] as MessagesValue) },
  adaDid: Writable.of<string>(""),
  otherAdaDid: Writable.of<string>(""),
  graceDid: Writable.of<string>(""),
}));

// Writes her profile, then the lobby's first message.
export const ada = pattern<{ setup: Setup }>(({ setup }) => {
  const inbox = PrivateInbox({ offers: [] });
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Ada Lovelace",
    inbox: inboxLinkOf(inbox),
  });
  const action_note_principal = action(() =>
    setup.adaDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.lobby.messages,
  } as RoomArg);
  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      {
        action: room.composerSend,
        event: typed("Hello from Ada Lovelace"),
        trustedUi: sendGesture,
      },
      { label: "ada-sent" },
    ],
  };
});

// Writes her profile, under the first Ada's name, then the second message.
export const otherAda = pattern<{ setup: Setup }>(({ setup }) => {
  const inbox = PrivateInbox({ offers: [] });
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Ada Lovelace",
    inbox: inboxLinkOf(inbox),
  });
  const action_note_principal = action(() =>
    setup.otherAdaDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.lobby.messages,
  } as RoomArg);
  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { await: "ada-sent" },
      {
        action: room.composerSend,
        event: typed("Hello from Ada Lovelace"),
        trustedUi: sendGesture,
      },
      { label: "other-sent" },
    ],
  };
});

// Writes her profile, then the third message.
export const grace = pattern<{ setup: Setup }>(({ setup }) => {
  const inbox = PrivateInbox({ offers: [] });
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Grace Hopper",
    inbox: inboxLinkOf(inbox),
  });
  const action_note_principal = action(() =>
    setup.graceDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.lobby.messages,
  } as RoomArg);
  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { await: "other-sent" },
      {
        action: room.composerSend,
        event: typed("Hello from Grace Hopper"),
        trustedUi: sendGesture,
      },
      { label: "grace-sent" },
    ],
  };
});

// Chats with each writer, and reads how his group picker lists them.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sessionProfile: profile,
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {},
      offers: {},
    }),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  // Each writer's profile, reached through their lobby message, in the order
  // they sent.
  const adaProfile = profileOf(
    setup.lobby.messages.key(0).key("authorProfile"),
  );
  const otherAdaProfile = profileOf(
    setup.lobby.messages.key(1).key("authorProfile"),
  );
  const graceProfile = profileOf(
    setup.lobby.messages.key(2).key("authorProfile"),
  );

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { await: "grace-sent" },
      {
        action: manager.openDirect,
        event: {
          requestId: "d-ada",
          type: "click",
          target: { name: adaProfile },
        },
        trustedUi: startGesture,
      },
      {
        action: manager.openDirect,
        event: {
          requestId: "d-grace",
          type: "click",
          target: { name: graceProfile },
        },
        trustedUi: startGesture,
      },
      // One Ada and Grace: no name is shared, so neither is marked.
      {
        assertion: assert(() =>
          Object.keys(manager.people).length === 2 &&
          !pickerText(manager[UI]).includes("…")
        ),
      },
      {
        action: manager.openDirect,
        event: {
          requestId: "d-other-ada",
          type: "click",
          target: { name: otherAdaProfile },
        },
        trustedUi: startGesture,
      },
      // Two Adas: each is marked by her own principal, and Grace is not.
      {
        assertion: assert(() => {
          const shown = pickerText(manager[UI]);
          const adaDid = setup.adaDid.get();
          const otherAdaDid = setup.otherAdaDid.get();
          return Object.keys(manager.people).length === 3 &&
            adaDid !== "" && otherAdaDid !== "" && adaDid !== otherAdaDid &&
            shown.includes(markOf(adaDid)) &&
            shown.includes(markOf(otherAdaDid)) &&
            !shown.includes(markOf(setup.graceDid.get())) &&
            shown.split("…").length === 3;
        }),
      },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: { ada, otherAda, grace, bob },
});
