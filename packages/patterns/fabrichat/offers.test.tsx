/**
 * Offering a new FabriChat room through a member's share inbox. Bob starts a
 * direct chat with Alice naming her profile, which points at her private
 * inbox; the room is offered there, in the envelope a loom share inbox takes,
 * and a notice is queued for her all the same. A request naming a profile
 * other than the counterpart's is refused. Each person writes their own
 * profile here, so its label names them, as a Fabric profile's does.
 */
import {
  action,
  assert,
  type Cell,
  currentPrincipal,
  handler,
  isWellFormedDID,
  multiUserTest,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";
import PrivateInbox, { type Offer } from "../system/private-inbox.tsx";
import type { ShareInboxPiece } from "../system/profile-home.tsx";
import type { SharedSpaceCatalogStorage } from "../system/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  type ActivityCounters,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_ROOM_OFFER_KIND,
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

/** The gesture writing a profile takes. */
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

/** Whether `value` is an origin written as its own canonical origin. */
const isOrigin = (value: string): boolean => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

/** The room's records, which every participant's room shares. */
interface Records {
  messages: Writable<MessagesValue>;
  reactionLists: Writable<ReactionList[]>;
  requests: Writable<RequestMemo[]>;
  usedTimes: Writable<UsedTime[]>;
  activity: Writable<SentActivity[]>;
  counters: Writable<ActivityCounters[]>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;

  /** Alice's principal, as her own run of a handler finds it. */
  aliceDid: Writable<string>;

  /** Bob's principal, as his own run of a handler finds it. */
  bobDid: Writable<string>;
}

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
  },
  aliceDid: Writable.of<string>(""),
  bobDid: Writable.of<string>(""),
}));

// Points her profile at her private inbox, and sends a message, which makes
// her one of the room's participants and hands Bob her profile. Then finds
// Bob's room offered in her inbox.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const inbox = PrivateInbox({ offers: [] });
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Alice",
    inbox: inboxLinkOf(inbox),
  });
  const action_note_principal = action(() =>
    setup.aliceDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
  } as RoomArg);

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      {
        action: room.composerSend,
        event: typed("Hello from Alice"),
        trustedUi: sendGesture,
      },
      // Nothing is offered yet.
      { assertion: assert(() => inbox.offers.length === 0) },
      { label: "alice-sent" },
      { await: "bob-done" },
      // Bob's room is offered once, keyed by his request, from him, naming
      // the room's space and the host serving it.
      {
        assertion: assert(() => {
          const offers = inbox.offers as readonly (Offer | undefined)[];
          const offer = offers[0];
          return offers.length === 1 && offer !== undefined &&
            offer.kind === CHAT_ROOM_OFFER_KIND && offer.id === "d-alice" &&
            setup.bobDid.get() !== "" && offer.from === setup.bobDid.get() &&
            isWellFormedDID(offer.space) && isOrigin(offer.host) &&
            offer.ownerOrigin === offer.host && offer.title === "";
        }),
      },
    ],
  };
});

// Starts a direct chat with Alice naming her profile, after a request naming
// a profile other than hers is refused.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const action_note_principal = action(() =>
    setup.bobDid.set(currentPrincipal() ?? "")
  );
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {},
      offers: {},
    }),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
  } as ManagerArg);
  // Alice's profile, reached as a room reaches it: through her message.
  const aliceProfile = profileOf(
    setup.records.messages.key(0).key("authorProfile"),
  );
  const ownProfile = profileOf(profile);

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { await: "alice-sent" },
      {
        action: manager.openDirect,
        event: {
          requestId: "not-hers",
          counterpart: setup.aliceDid,
          profile: ownProfile,
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() => {
          const outcome = requests.get()["not-hers"];
          return outcome?.status === "refused" &&
            outcome.reason === "The profile is not the counterpart's." &&
            manager.rooms.length === 0;
        }),
      },
      {
        action: manager.openDirect,
        event: {
          requestId: "d-alice",
          counterpart: setup.aliceDid,
          profile: aliceProfile,
        },
        trustedUi: startGesture,
      },
      // The room is created, and a notice is queued for Alice as well.
      {
        assertion: assert(() =>
          setup.aliceDid.get() !== "" && manager.rooms.length === 1 &&
          manager.rooms[0]?.counterpart === setup.aliceDid.get() &&
          notices.get().length === 1 &&
          notices.get()[0]?.recipient === setup.aliceDid.get()
        ),
      },
      { label: "bob-done" },
    ],
    // TODO(danfuzz): The first run of the event offering the room fails to
    // commit, and the runner drops the offer that run sent with a warning,
    // though the event's next run sends the offer again. Expect no warnings
    // once the runner drops it quietly, or the first run commits.
    allowConsoleWarnings: true,
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
