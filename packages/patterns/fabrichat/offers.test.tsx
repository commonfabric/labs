/**
 * Offering a FabriChat room through a person's private inbox. Bob starts a
 * direct chat from Alice's chip, which hands his manager her profile; the new
 * room is offered through the inbox her profile points at, and a notice is
 * queued for her all the same. Alice's manager lists the offer, from Bob as
 * her inbox recorded him, and adding it to her chats accepts the room. An
 * offer of another kind is not listed, nor is one whose `entry` isn't a room
 * its sender created, and a dismissed offer is listed no more, though another
 * that arrived with it is. Each person writes their own profile here, so its label names them,
 * as a Fabric profile's does.
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
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import PrivateInbox, { type OfferEntry } from "../system/private-inbox.tsx";
import {
  clickButton,
  findNodeById,
  textContent,
} from "../test/vnode-helpers.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  type ActivityCounters,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
import { FabriChatRoomCore, ParticipantChip } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatInbox,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerProfile,
  type ChatOfferHandling,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];
type ChipArg = Parameters<typeof ParticipantChip>[0];

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "FabriChatTestProfileSurface";
const PROFILE_ACTION = "FabriChatTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };

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
  inbox?: Cell<ChatInbox>;
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
function inboxLinkOf(inbox: unknown): Cell<ChatInbox>;
function inboxLinkOf(inbox: unknown): unknown {
  return inbox;
}

/** A link, as an offer's `entry`, which names a piece of any kind. */
function entryOf(link: unknown): Cell<OfferEntry>;
function entryOf(link: unknown): unknown {
  return link;
}

/** A person's own profile, as the profile an event names. */
function profileOf(profile: unknown): Cell<ChatManagerProfile>;
function profileOf(profile: unknown): unknown {
  return profile;
}

/** Where a piece that isn't a room is kept, once created. */
interface PieceHolder {
  piece?: Cell<OfferEntry>;
}

/**
 * Creates a piece that isn't a room, a second inbox, and keeps it in
 * `holder`: an offer links its result document, which exists only once the
 * piece's creation has committed.
 */
const holdNotARoom = handler<void, { holder: Writable<PieceHolder> }>(
  (_event, { holder }) => {
    holder.set({ piece: entryOf(PrivateInbox({ offers: [] })) });
  },
);

/** A room held apart from the index, which forgetting it changes. */
interface HeldRoom {
  room?: Writable<ChatRoomLink>;
}

/** What a manager's offer rows say. */
const offersShown = (root: unknown): string =>
  textContent(findNodeById(root, "fabrichat-offers"));

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
// her one of the room's participants. Then finds Bob's room offered, and
// adds it to her chats.
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
  const rooms = Writable.of<ChatIndexEntry[]>([]);
  const handledOffers = Writable.of<Record<string, ChatOfferHandling>>({});
  const manager = FabriChatManagerCore({
    myProfile: profile,
    rooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
    handledOffers,
  } as ManagerArg);
  // A room of her own, which she forgets and is then offered.
  const held = Writable.of<HeldRoom>({});
  const action_create_own = action(() =>
    manager.createGroup.send({ requestId: "own", title: "Mine", members: [] })
  );
  // Held as the room's own result document, which a link into her labeled
  // inbox has to name.
  const action_hold_own = action(() =>
    held.key("room").set(rooms.get()[1]?.room.resolveAsCell())
  );
  const action_forget_own = action(() =>
    manager.forget.send({
      requestId: "forget-own",
      room: held.key("room").resolveAsCell(),
    })
  );
  // A piece that isn't a room, offered as one.
  const notARoom = Writable.of<PieceHolder>({});
  const createNotARoom = holdNotARoom({ holder: notARoom });
  const action_create_not_a_room = action(() => createNotARoom.send());
  const action_receive_others = action(() => {
    const own = held.get().room?.resolveAsCell();
    inbox.receive.send({ kind: "another-thing", entry: entryOf(own) });
    inbox.receive.send({
      kind: "fabrichat-room",
      entry: notARoom.get().piece?.resolveAsCell(),
    });
    // The same room twice, in the same second: two offers all the same.
    inbox.receive.send({ kind: "fabrichat-room", entry: entryOf(own) });
    inbox.receive.send({ kind: "fabrichat-room", entry: entryOf(own) });
  });

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
      { assertion: assert(() => manager.offers.length === 0) },
      { label: "alice-sent" },
      { await: "bob-done" },
      // Bob's room is offered, from Bob as her inbox recorded him.
      {
        assertion: assert(() =>
          setup.bobDid.get() !== "" && manager.offers.length === 1 &&
          manager.offers[0]?.from === setup.bobDid.get() &&
          offersShown(manager[UI]).includes(
            `${setup.bobDid.get()} offered you a chat`,
          )
        ),
      },
      { action: action(() => clickButton(manager[UI], "Add to my chats")) },
      {
        assertion: assert(() =>
          rooms.get().length === 1 && rooms.get()[0]?.kind === "direct" &&
          rooms.get()[0]?.counterpart === setup.bobDid.get() &&
          manager.offers.length === 0 &&
          Object.values(handledOffers.get()).join() === "accepted"
        ),
      },
      { action: action_create_own },
      { action: action_hold_own },
      { action: action_forget_own },
      { assertion: assert(() => rooms.get().length === 1) },
      { action: action_create_not_a_room },
      // Of the four offers, the room's two are listed, each until it is
      // dismissed, though they arrived together from one sender.
      { action: action_receive_others },
      {
        assertion: assert(() =>
          manager.offers.length === 2 &&
          manager.offers.every((offer) =>
            offer?.from === setup.aliceDid.get() &&
            equals(offer?.room, held.get().room)
          ) &&
          manager.offers[0]?.key !== manager.offers[1]?.key
        ),
      },
      { action: action(() => clickButton(manager[UI], "Dismiss")) },
      { assertion: assert(() => manager.offers.length === 1) },
      { action: action(() => clickButton(manager[UI], "Dismiss")) },
      {
        assertion: assert(() =>
          manager.offers.length === 0 && rooms.get().length === 1 &&
          Object.values(handledOffers.get()).sort().join() ===
            "accepted,dismissed,dismissed"
        ),
      },
      { label: "alice-done" },
    ],
  };
});

// Starts a chat from Alice's chip, which offers her the room, after a request
// naming a profile other than the counterpart's is refused.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const action_note_principal = action(() =>
    setup.bobDid.set(currentPrincipal() ?? "")
  );
  const rooms = Writable.of<ChatIndexEntry[]>([]);
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const manager = FabriChatManagerCore({
    myProfile: profile,
    rooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
    handledOffers: Writable.of<Record<string, ChatOfferHandling>>({}),
  } as ManagerArg);
  // Alice's profile, reached as the room reaches it: through her message.
  const aliceChip = ParticipantChip({
    participant: setup.records.messages.key(0).key("authorProfile"),
    myProfile: profile,
    startsDirect: true,
    startDirect: manager.openDirect,
  } as ChipArg);
  const action_open_with_own_profile = action(() =>
    manager.openDirect.send({
      requestId: "not-hers",
      counterpart: setup.aliceDid.get(),
      profile: profileOf(profile),
    })
  );

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { await: "alice-sent" },
      { action: action_open_with_own_profile },
      {
        assertion: assert(() => {
          const outcome = requests.get()["not-hers"];
          return outcome?.status === "refused" &&
            outcome.reason === "The profile is not the counterpart's." &&
            rooms.get().length === 0;
        }),
      },
      { action: aliceChip.chat, event: {} },
      // The room is created, and a notice is queued for Alice as well.
      {
        assertion: assert(() =>
          setup.aliceDid.get() !== "" && rooms.get().length === 1 &&
          rooms.get()[0]?.counterpart === setup.aliceDid.get() &&
          notices.get().length === 1 &&
          notices.get()[0]?.recipient === setup.aliceDid.get()
        ),
      },
      { label: "bob-done" },
      { await: "alice-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
