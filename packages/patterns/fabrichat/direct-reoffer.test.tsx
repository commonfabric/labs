/**
 * Offering a FabriChat direct room that was created with no profile to offer
 * it through, and so queued a notice for its counterpart instead. Bob starts
 * direct chats with Alice, Carol, and Dave by principal alone, which queues a
 * notice for each. Once a later start with Alice names her profile, which
 * points at her private inbox, the room is offered there, she is added to its
 * participants, the notice for her is withdrawn, and the start's outcome is
 * the room found, listed again though Bob had forgotten it. A start before
 * that whose id is too long to key an offer by sends none. A start after that
 * sends no second offer, and neither does one from another manager whose
 * notice for her a client reported delivered, though she hasn't joined its
 * room. Carol has joined her room before Bob names her profile, so she is
 * offered nothing, and Dave's profile points at no inbox, so he is offered
 * nothing either; both keep their notices, though the manager lists only
 * Dave's, since Carol is on her room's roster. Each person writes their own
 * profile here, so its label names them, as a Fabric profile's does.
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
  spaceOf,
  type Stream,
  TESTS,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";
import {
  readSharedSpaceCatalog,
  type SharedSpaceCatalogStorage,
} from "../system/shared-space-catalog.ts";
import PrivateInbox, {
  type Offer,
  OFFER_ID_MAX_LENGTH,
  type OfferEvent,
} from "../system/private-inbox.tsx";
import type { ShareInboxPiece } from "../system/profile-home.tsx";
import { FabriChatManagerCore } from "./manager.tsx";
import { type MessagesValue } from "./room-records.tsx";
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
  type ChatRoomLink,
  type ProfileCell,
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

/** A room, as the test reads it: a link, and its participants. */
type HeldRoom = ChatRoomLink & { participants?: ProfileCell[] };

/** The room's records, which every participant's room shares. */
interface Records {
  messages: Writable<MessagesValue>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;

  /** Alice's principal, as her own run of a handler finds it. */
  aliceDid: Writable<string>;

  /** Carol's principal, as her own run of a handler finds it. */
  carolDid: Writable<string>;

  /** Dave's principal, as his own run of a handler finds it. */
  daveDid: Writable<string>;

  /** The direct room Bob created with Carol, once he has. */
  carolRoom: Writable<{ room?: Cell<HeldRoom> }>;
}

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
  },
  aliceDid: Writable.of<string>(""),
  carolDid: Writable.of<string>(""),
  daveDid: Writable.of<string>(""),
  carolRoom: Writable.of<{ room?: Cell<HeldRoom> }>({}),
}));

/** A request id longer than a share inbox keeps an offer's `id`. */
const LONG_REQUEST_ID = "d-alice-".padEnd(OFFER_ID_MAX_LENGTH + 1, "x");

/** The ids of the notices in `notices` waiting for `recipient`. */
const noticeIdsFor = (
  notices: Cell<ChatManagerNotice[]>,
  recipient: Cell<string>,
): string[] =>
  notices.get().filter((notice) => notice.recipient === recipient.get())
    .map((notice) => notice.id);

/** The participants of the room `held` holds. */
const participantsOf = (
  held: Cell<{ room?: Cell<HeldRoom> }>,
): readonly ProfileCell[] => held.key("room").get()?.get()?.participants ?? [];

// Points her profile at her private inbox, and sends the first message. Then
// finds Bob's room offered in her inbox once, by his second start.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const inbox = PrivateInbox({ offers: [] });
  const counting = CountingInbox({ inbox });
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Alice",
    inbox: inboxLinkOf(counting),
  });
  const action_note_principal = action(() =>
    setup.aliceDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.records.messages,
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
      { label: "alice-sent" },
      { await: "bob-done" },
      // The room is offered once, keyed by the start that named her profile,
      // and kept as a direct room's offer is.
      {
        assertion: assert(() => {
          const offers = inbox.offers as readonly (Offer | undefined)[];
          const offer = offers[0];
          return offers.length === 1 && offer !== undefined &&
            offer.kind === CHAT_ROOM_OFFER_KIND &&
            offer.id === "d-alice-again" && offer.title === "";
        }),
      },
      // And it was sent once, not merely kept once.
      {
        assertion: assert(() =>
          counting.received.length === 1 &&
          counting.received[0] === "d-alice-again"
        ),
      },
    ],
  };
});

// Points her profile at an inbox of her own, sends the second message, and
// joins the direct room Bob creates with her before he names her profile.
export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const inbox = PrivateInbox({ offers: [] });
  const counting = CountingInbox({ inbox });
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({
    profile,
    name: "Carol",
    inbox: inboxLinkOf(counting),
  });
  const action_note_principal = action(() =>
    setup.carolDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.records.messages,
  } as RoomArg);
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const action_join = action(() =>
    manager.joinRoom.send({
      requestId: "j-carol",
      room: setup.carolRoom.key("room").resolveAsCell(),
    })
  );

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { await: "alice-sent" },
      {
        action: room.composerSend,
        event: typed("Hello from Carol"),
        trustedUi: sendGesture,
      },
      { label: "carol-sent" },
      { await: "carol-room" },
      // Joining the room lists her among its participants.
      { action: action_join },
      {
        assertion: assert(() =>
          requests.get()["j-carol"]?.status === "done" &&
          (setup.carolRoom.key("room").get()?.get()?.participants ?? [])
            .some((known) => equals(known, profile))
        ),
      },
      { label: "carol-joined" },
      { await: "bob-done" },
      { assertion: assert(() => counting.received.length === 0) },
    ],
  };
});

// Writes a profile pointing at no inbox, and sends the third message.
export const dave = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Dave" });
  const action_note_principal = action(() =>
    setup.daveDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.records.messages,
  } as RoomArg);

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { await: "carol-sent" },
      {
        action: room.composerSend,
        event: typed("Hello from Dave"),
        trustedUi: sendGesture,
      },
      { label: "dave-sent" },
    ],
  };
});

// Starts a direct chat with each of the others by principal alone, then again
// naming each one's profile.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const catalog = emptyCatalog();
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
  } as ManagerArg);
  // Each person's profile, reached as a room reaches it: through their
  // message.
  const aliceProfile = profileOf(
    setup.records.messages.key(0).key("authorProfile"),
  );
  const carolProfile = profileOf(
    setup.records.messages.key(1).key("authorProfile"),
  );
  const daveProfile = profileOf(
    setup.records.messages.key(2).key("authorProfile"),
  );
  // A manager of Bob's whose notice for Alice a client reports delivered.
  const otherRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const otherNotices = Writable.of<ChatManagerNotice[]>([]);
  const other = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: otherRequests,
    outgoingNotices: otherNotices,
  } as ManagerArg);
  const action_report_delivered = action(() =>
    other.delivered.send({
      requestId: "delivered-alice",
      id: otherNotices.get()[0]?.id,
    })
  );
  const otherRoom = Writable.of<{ room?: Cell<HeldRoom> }>({});
  const action_hold_other = action(() =>
    otherRoom.key("room").set(
      otherRequests.key("d-alice-other").key("entry").key("room")
        .resolveAsCell(),
    )
  );
  const aliceRoom = Writable.of<{ room?: Cell<HeldRoom> }>({});
  const action_forget_alice = action(() =>
    manager.forget.send({
      requestId: "forget-alice",
      room: aliceRoom.key("room").resolveAsCell(),
      revision: readSharedSpaceCatalog(catalog)
        .entries[spaceOf(aliceRoom.key("room")) ?? ""]?.revision,
    })
  );
  const action_hold = action(() => {
    aliceRoom.key("room").set(
      requests.key("d-alice").key("entry").key("room").resolveAsCell(),
    );
    setup.carolRoom.key("room").set(
      requests.key("d-carol").key("entry").key("room").resolveAsCell(),
    );
  });

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { await: "dave-sent" },
      {
        action: manager.openDirect,
        event: { requestId: "d-alice", counterpart: setup.aliceDid },
        trustedUi: startGesture,
      },
      {
        action: manager.openDirect,
        event: { requestId: "d-carol", counterpart: setup.carolDid },
        trustedUi: startGesture,
      },
      {
        action: manager.openDirect,
        event: { requestId: "d-dave", counterpart: setup.daveDid },
        trustedUi: startGesture,
      },
      { action: action_hold },
      // Each start named no profile, so each room has a notice for its
      // counterpart, and Alice isn't among her room's participants.
      {
        assertion: assert(() =>
          manager.rooms.length === 3 && notices.get().length === 3 &&
          noticeIdsFor(notices, setup.aliceDid).length === 1 &&
          !participantsOf(aliceRoom).some((known) =>
            equals(known, aliceProfile)
          )
        ),
      },
      { label: "carol-room" },
      { await: "carol-joined" },
      // A start whose id is too long to key an offer by offers nothing, and
      // leaves her notice waiting.
      {
        action: manager.openDirect,
        event: {
          requestId: LONG_REQUEST_ID,
          counterpart: setup.aliceDid,
          profile: aliceProfile,
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          requests.get()[LONG_REQUEST_ID]?.status === "done" &&
          noticeIdsFor(notices, setup.aliceDid).length === 1
        ),
      },
      // Bob forgets the room, which leaves it in `direct`.
      { action: action_forget_alice },
      {
        assertion: assert(() =>
          requests.get()["forget-alice"]?.status === "done" &&
          manager.rooms.length === 2
        ),
      },
      // Naming Alice's profile lists the room the first start created again,
      // offers it to her, and withdraws her notice. It takes no gesture: the
      // start that created the room, and granted her access, was one.
      {
        action: manager.openDirect,
        event: {
          requestId: "d-alice-again",
          counterpart: setup.aliceDid,
          profile: aliceProfile,
        },
      },
      {
        assertion: assert(() => {
          const outcome = requests.get()["d-alice-again"];
          return outcome?.status === "done" &&
            equals(outcome.entry?.room, aliceRoom.key("room")) &&
            outcome.delivery === undefined && manager.rooms.length === 3 &&
            noticeIdsFor(notices, setup.aliceDid).length === 0;
        }),
      },
      // She was added to its participants, beside Bob, as an offered member
      // of a new room is.
      {
        assertion: assert(() =>
          participantsOf(aliceRoom).length === 2 &&
          participantsOf(aliceRoom).some((known) =>
            equals(known, aliceProfile)
          ) &&
          participantsOf(aliceRoom).some((known) => equals(known, profile))
        ),
      },
      // Carol has joined her room, and Dave's profile points at no inbox, so
      // neither is offered anything, and each keeps the notice their room's
      // creation queued.
      {
        action: manager.openDirect,
        event: {
          requestId: "d-carol-again",
          counterpart: setup.carolDid,
          profile: carolProfile,
        },
        trustedUi: startGesture,
      },
      {
        action: manager.openDirect,
        event: {
          requestId: "d-dave-again",
          counterpart: setup.daveDid,
          profile: daveProfile,
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          requests.get()["d-carol-again"]?.status === "done" &&
          requests.get()["d-dave-again"]?.status === "done" &&
          noticeIdsFor(notices, setup.carolDid).join() ===
            JSON.stringify([setup.carolDid.get(), "d-carol"]) &&
          noticeIdsFor(notices, setup.daveDid).join() ===
            JSON.stringify([setup.daveDid.get(), "d-dave"])
        ),
      },
      // Carol is on her room's roster, so the manager lists no notice for
      // her, though it still holds one. Dave isn't on his, and his is listed.
      {
        assertion: assert(() => {
          const listed = manager.outgoingNotices.map((notice) =>
            notice.recipient
          );
          return !listed.includes(setup.carolDid.get()) &&
            listed.includes(setup.daveDid.get());
        }),
      },
      // She has no notice waiting now, and is on the room's roster, so
      // naming her profile again offers her nothing more.
      {
        action: manager.openDirect,
        event: {
          requestId: "d-alice-thrice",
          counterpart: setup.aliceDid,
          profile: aliceProfile,
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          requests.get()["d-alice-thrice"]?.status === "done" &&
          notices.get().length === 2
        ),
      },
      // A room whose notice for her a client has delivered has none waiting,
      // so naming her profile offers her nothing, though she isn't on its
      // roster.
      {
        action: other.openDirect,
        event: { requestId: "d-alice-other", counterpart: setup.aliceDid },
        trustedUi: startGesture,
      },
      { action: action_hold_other },
      { action: action_report_delivered },
      {
        assertion: assert(() =>
          otherRequests.get()["d-alice-other"]?.status === "done" &&
          otherNotices.get().length === 0
        ),
      },
      {
        action: other.openDirect,
        event: {
          requestId: "d-alice-delivered",
          counterpart: setup.aliceDid,
          profile: aliceProfile,
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          otherRequests.get()["d-alice-delivered"]?.status === "done" &&
          participantsOf(otherRoom).length === 1 &&
          !participantsOf(otherRoom).some((known) =>
            equals(known, aliceProfile)
          )
        ),
      },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: { alice, carol, dave, bob },
});
