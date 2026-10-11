/**
 * A manager's people, and the group members it offers a new group to. Bob
 * starts a direct chat with Alice from her participant chip, which offers her
 * the room and adds her to its roster; his manager then lists her among its
 * people, by the principal her profile attests, and leaves him out. He picks
 * her for a group from his draft and creates it, which offers her the group
 * and adds her to its roster with no notice queued; a pick taken back, and a
 * draft emptied by creating its group, offer her nothing, and so does a pick
 * taken back through another profile of hers. A group whose
 * request names her profile on its event is offered to her too, and one
 * naming a profile that attests no principal is refused. Each person writes
 * their own profile here, so its label names them, as a Fabric profile's does.
 */
import {
  action,
  assert,
  type Cell,
  currentPrincipal,
  equals,
  handler,
  multiUserTest,
  pattern,
  principalOf,
  type RepresentsCurrentUser,
  type Stream,
  TESTS,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";
import type { SharedSpaceCatalogStorage } from "../system/shared-space-catalog.ts";
import PrivateInbox, { type OfferEvent } from "../system/private-inbox.tsx";
import type { ShareInboxPiece } from "../system/profile-home.tsx";
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
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

/** An empty shared-space catalog, as a manager lists its rooms from. */
const emptyCatalog = () =>
  Writable.of<SharedSpaceCatalogStorage>({ entries: {}, offers: {} });

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

/** What `countAndForward` is bound to. */
interface CountingState {
  /** The id of every offer received, in order, repeats included. */
  received: Writable<string[]>;

  /** The inbox each offer is forwarded to. */
  inbox: { receive: Stream<OfferEvent> };
}

/** Records the offer's id, then hands the offer to the inbox it wraps. */
const countAndForward = handler<OfferEvent, CountingState>((
  event,
  { received, inbox },
) => {
  received.push(event?.id ?? "");
  inbox.receive.send(event);
});

/**
 * A share inbox that counts every offer sent to it, repeats included, before
 * the inbox it wraps keeps one per sender and `id`.
 */
const CountingInbox = pattern<
  { inbox: { receive: Stream<OfferEvent> } },
  { received: string[]; receive: Stream<OfferEvent> }
>(({ inbox }) => {
  const received = Writable.of<string[]>([]);
  return { received, receive: countAndForward({ received, inbox }) };
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

  /** A second profile of Alice's, which she writes as her own. */
  aliceSecond: Writable<OwnProfile>;
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
  aliceSecond: Writable.of<OwnProfile>(),
}));

// Points her profile at her private inbox, and sends a message, which hands
// Bob her profile. Then counts the rooms offered to her.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const inbox = PrivateInbox({ offers: [] });
  const counting = CountingInbox({ inbox });
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Alice",
    inbox: inboxLinkOf(counting),
  });
  const writeSecond = writeOwnProfile({
    profile: setup.aliceSecond,
    name: "Alice, again",
    inbox: inboxLinkOf(counting),
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
      { action: writeSecond, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      {
        action: room.composerSend,
        event: typed("Hello from Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-sent" },
      { await: "bob-done" },
      // The direct room, the group she was picked for, and the group whose
      // event named her are offered to her, each once, and nothing else is.
      {
        assertion: assert(() => {
          const received = [...counting.received].sort();
          return received.length === 3 && received[0] === "d-alice" &&
            received[1] === "g-event" && received[2] === "g-picked";
        }),
      },
    ],
  };
});

// Chats with Alice, then finds her among his manager's people, and names her
// for groups by her profile.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
  } as ManagerArg);
  // Alice's profile, reached as a room reaches it: through her message.
  const aliceProfile = profileOf(
    setup.records.messages.key(0).key("authorProfile"),
  );
  // A profile no one's label names: no principal wrote it as their own.
  const unattested = Writable.of<ChatManagerProfile>({ name: "Nobody" });
  const held = Writable.of<{ room?: Cell<ChatRoomLink> }>({});
  const action_hold = action(() =>
    held.key("room").set(
      requests.key("g-picked").key("entry").key("room").resolveAsCell(),
    )
  );
  const pick = { action: manager.pickMember, event: { profile: aliceProfile } };
  const aliceSecond = profileOf(setup.aliceSecond);

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { await: "alice-sent" },
      {
        action: manager.openDirect,
        event: {
          requestId: "d-alice",
          type: "click",
          target: { name: aliceProfile },
        },
        trustedUi: startGesture,
      },
      // The direct room's roster holds Bob and Alice; his people hold only
      // her, by the principal her profile attests, through her profile.
      {
        assertion: assert(() => {
          const people = manager.people;
          const did = setup.aliceDid.get();
          const hers = people[did] ?? [];
          return did !== "" && Object.keys(people).length === 1 &&
            hers.length === 1 && equals(hers[0], aliceProfile);
        }),
      },
      // A pick taken back offers her nothing.
      pick,
      pick,
      {
        action: manager.createDraftedGroup,
        event: { requestId: "g-unpicked", title: "g-unpicked", members: [] },
        trustedUi: startGesture,
      },
      // A pick taken back through her other profile offers her nothing
      // either: both name her.
      {
        assertion: assert(() =>
          principalOf(aliceSecond, "represents-principal") ===
            setup.aliceDid.get()
        ),
      },
      pick,
      { action: manager.pickMember, event: { profile: aliceSecond } },
      {
        action: manager.createDraftedGroup,
        event: { requestId: "g-swapped", title: "g-swapped", members: [] },
        trustedUi: startGesture,
      },
      // A pick kept offers her the group, so no notice is queued for her.
      pick,
      {
        action: manager.createDraftedGroup,
        event: { requestId: "g-picked", title: "g-picked", members: [] },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() => {
          const outcome = requests.get()["g-picked"];
          return outcome?.status === "done" &&
            outcome.entry?.kind === "group" && notices.get().length === 0;
        }),
      },
      // She is on the group's roster, beside Bob, without a step of her own.
      { action: action_hold },
      {
        assertion: assert(() => {
          const roster = held.key("room").get()?.get()?.roster ?? [];
          return roster.length === 2 &&
            roster.some((known) => equals(known, aliceProfile)) &&
            roster.some((known) => equals(known, profile));
        }),
      },
      // Creating the group emptied the draft, so the next offers her nothing.
      {
        action: manager.createDraftedGroup,
        event: { requestId: "g-after", title: "g-after", members: [] },
        trustedUi: startGesture,
      },
      // A group's event can name her by her profile instead.
      {
        action: manager.createGroup,
        event: {
          requestId: "g-event",
          title: "By event",
          members: [],
          profiles: [aliceProfile],
        },
        trustedUi: startGesture,
      },
      // A profile attesting no principal names no one, and is refused.
      {
        action: manager.createGroup,
        event: {
          requestId: "g-nobody",
          title: "Nobody's",
          members: [],
          profiles: [unattested],
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() => {
          const outcomes = requests.get();
          const refused = outcomes["g-nobody"];
          return outcomes["g-event"]?.status === "done" &&
            outcomes["g-unpicked"]?.status === "done" &&
            outcomes["g-swapped"]?.status === "done" &&
            outcomes["g-after"]?.status === "done" &&
            refused?.status === "refused" &&
            refused.reason === "A member's profile attests no principal.";
        }),
      },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
