/**
 * Telling the person a FabriChat room's add admits, through the adder's
 * manager. Bob, who holds OWNER on the test's space, starts a direct chat with
 * Alice from her message in a lobby, so his manager's people list her. In a
 * group room, an add his manager refuses, made before its catalog lists the
 * room, reads `access-only`. Once it lists the room, an add of Alice by her
 * chat address alone is offered to her through the inbox her profile points
 * at, joins her to the room's roster, and reads `offered`; an add of Carol by
 * a profile pointing at no inbox queues a notice for her, and reads `noticed`.
 * An add naming a profile that attests no one, or someone other than the
 * address it names, is refused. To a viewer with no manager, or one whose
 * manager hasn't resolved, an add reads `access-only` at once. The manager
 * refuses to offer anything but a group room, and an add whose id is too long
 * to key an offer by, which then reads `access-only` with the manager's
 * reason; an access list it doesn't hold yet doesn't read as one refusing its
 * user. A group named by both of Alice's profiles,
 * which point at two inboxes, is offered once to each, and lists her once;
 * one named by two of her profiles pointing at one inbox is offered there
 * once; and one naming profiles of Alice and Carol that point at the same
 * inbox is refused whole. Each person writes their own profiles here, so their labels
 * name them, as a Fabric profile's do.
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
  SELF,
  spaceOf,
  type Stream,
  TESTS,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import {
  countElements,
  findNodeById,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import PrivateInbox, { type OfferEvent } from "../system/private-inbox.tsx";
import type { ShareInboxPiece } from "../system/profile-home.tsx";
import {
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
} from "../system/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import { type MessagesValue } from "./room-records.tsx";
import {
  type ChatRoomOutput,
  FabriChatRoomCore,
  type RoomManager,
} from "./room.tsx";
import {
  addMemberOfferId,
  type AddMemberOutcome,
  CHAT_ADD_MEMBER_ACTION,
  CHAT_ADD_MEMBER_SURFACE,
  CHAT_ROOM_OFFER_KIND,
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

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "FabriChatTestProfileSurface";
const PROFILE_ACTION = "FabriChatTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };
const addGesture = {
  surface: CHAT_ADD_MEMBER_SURFACE,
  action: CHAT_ADD_MEMBER_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/**
 * A space no runtime here holds anything of, whose access list is therefore
 * not known to anyone asking.
 */
const UNSEEN_SPACE = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

/** A link to a room in `UNSEEN_SPACE`, as an event carries one. */
const UNSEEN_ROOM = {
  "/": {
    "link@1": { id: "of:fid1:unseen-room", path: [], space: UNSEEN_SPACE },
  },
};

/** An add's id longer than an offer's may be, once a room's space keys it. */
const LONG_ID = "x".repeat(320);

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

/**
 * Writes the acting person's own profile, under `name`, pointing at the inbox
 * itself rather than at whatever link reached it, so that two profiles
 * pointing at one inbox hold the same pointer.
 */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name, inbox },
) => {
  profile.set(
    (inbox === undefined
      ? { name }
      : { name, inbox: { piece: inbox.resolveAsCell() } }) as OwnProfile,
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

/** What a room telling its adds through a manager needs. */
interface ManagedRoomInput extends Records {
  /** The viewer's profile. */
  myProfile: Writable<OwnProfile>;

  /** Those who joined the room. */
  roster: Writable<ParticipantRoster>;

  /** The viewer's adds' outcomes. */
  addRequests: Writable<Record<string, AddMemberOutcome>>;

  /** The viewer's manager, when they have one. */
  manager?: RoomManager;
}

/** What a room telling its adds through a manager offers. */
interface ManagedRoomOutput {
  [UI]: ChatRoomOutput[typeof UI];
  about: ChatRoomOutput["about"];
  addParticipant: ChatRoomOutput["addParticipant"];
  addMember: ChatRoomOutput["addMember"];
  addRequests: ChatRoomOutput["addRequests"];
  participantPrincipals: ChatRoomOutput["participantPrincipals"];
}

/**
 * A group room that names itself to its viewer's manager by its own result,
 * as `FabriChatRoom` does.
 */
const ManagedRoom = pattern<ManagedRoomInput, ManagedRoomOutput>(
  (input) => {
    const room = FabriChatRoomCore({
      myProfile: input.myProfile,
      about: { kind: "group" as const, title: "Team" },
      messages: input.messages,
      roster: input.roster,
      addRequests: input.addRequests,
      self: input[SELF],
      manager: input.manager,
    } as RoomArg);
    return {
      [UI]: room[UI],
      about: room.about,
      addParticipant: room.addParticipant,
      addMember: room.addMember,
      addRequests: room.addRequests,
      participantPrincipals: room.participantPrincipals,
    };
  },
);

/** How the room's picker of people to add is displayed, and how many it shows. */
const pickerOf = (root: unknown): string => {
  const picker = findNodeById(root, "fabrichat-add-member-people");
  const style = propValue(picker, "style") as { display?: unknown };
  return `${readValue(style?.display)}:${
    countElements(picker, "cf-profile-badge")
  }`;
};

/** What the room shows the session about its latest add. */
const shownOf = (root: unknown): string =>
  textContent(findNodeById(root, "fabrichat-add-member-outcome")).trim();

/** A room's records, which every participant's room over them shares. */
interface Records {
  messages: Writable<MessagesValue>;
}

/** A room's records, every one empty. */
const emptyRecords = (): Records => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
});

/** What every session receives from the setup. */
interface Setup {
  /** The records of the lobby Alice writes in, which hands Bob her profile. */
  lobby: Records;

  /** The records of the group room Bob adds people to. */
  room: Records;

  /** Those who joined the group room. */
  roster: Writable<ParticipantRoster>;

  /** The inbox Alice's first profile, and Carol's second, point at. */
  shared: { received: string[]; receive: Stream<OfferEvent> };

  /** The inbox Alice's second profile points at. */
  second: { received: string[]; receive: Stream<OfferEvent> };

  /** Alice's principal, as her own run of a handler finds it. */
  aliceDid: Writable<string>;

  /** Carol's principal, as her own run of a handler finds it. */
  carolDid: Writable<string>;

  /** A second profile of Alice's, pointing at `second`. */
  aliceSecond: Writable<OwnProfile>;

  /** A third profile of Alice's, pointing at `shared`, as her first does. */
  aliceThird: Writable<OwnProfile>;

  /** A profile of Carol's pointing at no inbox. */
  carolPlain: Writable<OwnProfile>;

  /** A profile of Carol's pointing at `shared`, as Alice's first does. */
  carolShared: Writable<OwnProfile>;

  /** The DID of the test's space, which holds the group room. */
  roomSpace: Writable<string>;
}

export const setup = pattern(() => ({
  lobby: emptyRecords(),
  room: emptyRecords(),
  roster: Writable.of<ParticipantRoster>({}),
  shared: CountingInbox({ inbox: PrivateInbox({ offers: [] }) }),
  second: CountingInbox({ inbox: PrivateInbox({ offers: [] }) }),
  aliceDid: Writable.of<string>(""),
  carolDid: Writable.of<string>(""),
  aliceSecond: Writable.of<OwnProfile>(),
  aliceThird: Writable.of<OwnProfile>(),
  carolPlain: Writable.of<OwnProfile>(),
  carolShared: Writable.of<OwnProfile>(),
  roomSpace: Writable.of<string>(""),
}));

// Adds Alice and Carol to a group room, and names them for new groups.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const catalog = Writable.of<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
  } as ManagerArg);
  const room = ManagedRoom({
    myProfile: profile,
    messages: setup.room.messages,
    roster: setup.roster,
    addRequests: Writable.of<Record<string, AddMemberOutcome>>({}),
    manager: {
      offerRoom: manager.offerRoom,
      requests: manager.requests,
      people: manager.people,
    } as RoomManager,
  });
  // The same room, to a viewer known to have no manager.
  const unmanaged = ManagedRoom({
    myProfile: profile,
    messages: setup.room.messages,
    roster: setup.roster,
    addRequests: Writable.of<Record<string, AddMemberOutcome>>({}),
  });
  // Alice's profile, reached as a room reaches it: through her message.
  const aliceProfile = profileOf(
    setup.lobby.messages.key(0).key("authorProfile"),
  );
  const aliceSecond = profileOf(setup.aliceSecond);
  const aliceThird = profileOf(setup.aliceThird);
  const carolPlain = profileOf(setup.carolPlain);
  const carolShared = profileOf(setup.carolShared);
  // A profile no one's label names: no principal wrote it as their own.
  const unattested = Writable.of<ChatManagerProfile>({ name: "Nobody" });
  const action_note_space = action(() =>
    setup.roomSpace.set(spaceOf(setup.room.messages) ?? "")
  );
  const action_list_room = action(() => {
    registerSharedSpaceIn(catalog, {
      space: setup.roomSpace.get(),
      host: "http://localhost:8000",
      kind: CHAT_ROOM_OFFER_KIND,
    });
  });
  const action_list_unseen = action(() => {
    registerSharedSpaceIn(catalog, {
      space: UNSEEN_SPACE,
      host: "http://localhost:8000",
      kind: CHAT_ROOM_OFFER_KIND,
    });
  });
  const held = Writable.of<{ room?: Cell<ChatRoomLink> }>({});
  const action_hold = action(() =>
    held.key("room").set(
      requests.key("g-two").key("entry").key("room").resolveAsCell(),
    )
  );

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_space },
      { await: "alice-ready" },
      { await: "carol-ready" },
      // A direct chat with Alice, started from her message, lists her among
      // the people Bob's rooms hold.
      {
        action: manager.openDirect,
        event: {
          requestId: "d-alice",
          type: "click",
          target: { name: aliceProfile },
        },
        trustedUi: startGesture,
      },
      // Bob's manager doesn't list the group room yet, so it refuses to tell
      // Alice of it, and the add, done, reads as access alone.
      {
        action: room.addMember,
        event: { requestId: "add-unlisted", target: { value: setup.aliceDid } },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() => {
          const outcome = room.addRequests["add-unlisted"];
          const verdict = requests
            .get()[addMemberOfferId(setup.roomSpace.get(), "add-unlisted")];
          return outcome?.status === "done" &&
            outcome.delivery === "access-only" &&
            outcome.deliveryRefusal ===
              "The room isn't among this user's chats." &&
            verdict?.status === "refused" &&
            shownOf(room[UI]) ===
              `Added ${setup.aliceDid.get()}, who couldn't be told of this chat: The room isn't among this user's chats. Send them its link.`;
        }),
      },
      { action: action_list_room },
      // The room's picker offers Alice, whom Bob's people list and the room
      // doesn't.
      { assertion: assert(() => pickerOf(room[UI]) === "block:1") },
      // An offer names a group room, and nothing else in its space.
      {
        action: manager.offerRoom,
        event: {
          requestId: "o-not-room",
          room: setup.room.messages,
          member: setup.aliceDid,
        },
      },
      {
        assertion: assert(() => {
          const refused = requests.get()["o-not-room"];
          return refused?.status === "refused" &&
            refused.reason === "The request names no group room.";
        }),
      },
      // An add whose id is too long to key an offer by tells no one, and
      // says why.
      {
        action: room.addMember,
        event: {
          requestId: LONG_ID,
          target: { value: setup.aliceDid },
        },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() => {
          const outcome = room.addRequests[LONG_ID];
          return outcome?.status === "done" &&
            outcome.delivery === "access-only" &&
            outcome.deliveryRefusal ===
              "The request's id is too long to key an offer by.";
        }),
      },
      // Named by her chat address alone, Alice is offered the room through the
      // profile Bob's people list for her, and joins its roster.
      {
        action: room.addMember,
        event: { requestId: "add-alice", target: { value: setup.aliceDid } },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() => {
          const outcome = room.addRequests["add-alice"];
          return outcome?.status === "done" &&
            outcome.delivery === "offered" &&
            room.participantPrincipals.includes(setup.aliceDid.get()) &&
            pickerOf(room[UI]) === "none:0" &&
            shownOf(room[UI]) ===
              `Added ${setup.aliceDid.get()}, and offered them this chat.` &&
            !notices.get().some((notice) =>
              notice.recipient === setup.aliceDid.get()
            );
        }),
      },
      // Carol, named by a profile pointing at no inbox, gets a notice.
      {
        action: room.addMember,
        event: { requestId: "add-carol", profile: carolPlain },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() => {
          const outcome = room.addRequests["add-carol"];
          return outcome?.status === "done" &&
            outcome.delivery === "noticed" &&
            notices.get().some((notice) =>
              notice.recipient === setup.carolDid.get()
            );
        }),
      },
      // A profile has to name the person the add does, and has to name
      // someone.
      {
        action: room.addMember,
        event: {
          requestId: "add-mismatch",
          profile: carolPlain,
          target: { value: setup.aliceDid },
        },
        trustedUi: addGesture,
      },
      {
        action: room.addMember,
        event: { requestId: "add-nobody", profile: unattested },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() => {
          const mismatch = room.addRequests["add-mismatch"];
          const nobody = room.addRequests["add-nobody"];
          return mismatch?.status === "refused" &&
            mismatch.reason === "That profile isn't theirs." &&
            nobody?.status === "refused" &&
            nobody.reason === "That profile doesn't say whose it is.";
        }),
      },
      // A viewer with no manager admits the person, and the add reads as
      // access alone.
      {
        action: unmanaged.addMember,
        event: { requestId: "add-alone", target: { value: setup.carolDid } },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() => {
          const outcome = unmanaged.addRequests["add-alone"];
          return outcome?.status === "done" &&
            outcome.delivery === "access-only" &&
            outcome.deliveryRefusal === undefined &&
            shownOf(unmanaged[UI]) ===
              `Added ${setup.carolDid.get()}. Send them this chat's link.`;
        }),
      },
      // A group named by both of Alice's profiles is offered to each of her
      // inboxes, and lists her once.
      {
        action: manager.createGroup,
        event: {
          requestId: "g-two",
          title: "Two inboxes",
          members: [],
          profiles: [aliceProfile, aliceSecond],
        },
        trustedUi: startGesture,
      },
      { action: action_hold },
      {
        assertion: assert(() => {
          const roster = held.key("room").get()?.get()?.roster ?? [];
          return requests.get()["g-two"]?.status === "done" &&
            roster.length === 2 &&
            roster.some((known) => equals(known, aliceProfile)) &&
            roster.some((known) => equals(known, profile));
        }),
      },
      // Two profiles of hers pointing at one inbox offer it there once.
      {
        action: manager.createGroup,
        event: {
          requestId: "g-one",
          title: "One inbox",
          members: [],
          profiles: [aliceProfile, aliceThird],
        },
        trustedUi: startGesture,
      },
      // Profiles of Alice and Carol pointing at one inbox refuse the group
      // whole.
      {
        action: manager.createGroup,
        event: {
          requestId: "g-shared",
          title: "Shared inbox",
          members: [],
          profiles: [aliceProfile, carolShared],
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() => {
          const refused = requests.get()["g-shared"];
          return refused?.status === "refused" &&
            refused.code === "shared-inbox" &&
            manager.rooms.length === 3;
        }),
      },
      // Each inbox was sent each offer meant for it once, and nothing else.
      {
        assertion: assert(() => {
          const shared = [...setup.shared.received].sort();
          const expected = [
            "d-alice",
            "g-one",
            "g-two",
            addMemberOfferId(setup.roomSpace.get(), "add-alice"),
          ].sort();
          return shared.length === 4 &&
            shared.every((id, index) => id === expected[index]) &&
            setup.second.received.length === 1 &&
            setup.second.received[0] === "g-two";
        }),
      },
      // An access list not known yet doesn't read as one refusing this user:
      // the offer goes on to the checks after it.
      { action: action_list_unseen },
      {
        action: manager.offerRoom,
        event: {
          requestId: "o-unseen",
          room: UNSEEN_ROOM,
          member: setup.aliceDid,
        },
      },
      {
        assertion: assert(() => {
          const refused = requests.get()["o-unseen"];
          return refused?.status === "refused" &&
            refused.reason === "The request names no group room.";
        }),
      },
      { label: "bob-done" },
    ],
  };
});

// Writes her two profiles, and sends a message in the lobby, which hands Bob
// the first.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Alice",
    inbox: inboxLinkOf(setup.shared),
  });
  const writeSecond = writeOwnProfile({
    profile: setup.aliceSecond,
    name: "Alice, again",
    inbox: inboxLinkOf(setup.second),
  });
  const writeThird = writeOwnProfile({
    profile: setup.aliceThird,
    name: "Alice, once more",
    inbox: inboxLinkOf(setup.shared),
  });
  const action_note_principal = action(() =>
    setup.aliceDid.set(currentPrincipal() ?? "")
  );
  const lobby = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.lobby.messages,
  } as RoomArg);

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: writeSecond, event: {}, trustedUi: profileGesture },
      { action: writeThird, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      {
        action: lobby.composerSend,
        event: typed("Hello from Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-ready" },
      { await: "bob-done" },
    ],
  };
});

// Writes her two profiles, the second pointing at the inbox Alice's first
// points at.
export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const writePlain = writeOwnProfile({
    profile: setup.carolPlain,
    name: "Carol",
  });
  const writeShared = writeOwnProfile({
    profile: setup.carolShared,
    name: "Carol, sharing",
    inbox: inboxLinkOf(setup.shared),
  });
  const action_note_principal = action(() =>
    setup.carolDid.set(currentPrincipal() ?? "")
  );

  return {
    [TESTS]: [
      { action: writePlain, event: {}, trustedUi: profileGesture },
      { action: writeShared, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { label: "carol-ready" },
      { await: "bob-done" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: { alice, bob: { pattern: bob, access: "OWNER" }, carol },
});
