/**
 * Writing in a FabriChat room joins it, which makes it one of the writer's
 * chats. Each viewer's catalog is confidential, so room writes ask the
 * manager to join through a separate event. Alice's listed room stays saved
 * without a new manager request. Bob reached the room by its link, so his
 * manager doesn't list it: his first message tells his manager he joined the
 * room, which lists it and adds him to its roster, and a later join leaves
 * its request history unchanged. Once he forgets the room, a reaction lists
 * it again, and so, once he forgets it again, does a message.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  computed,
  type Confidential,
  equals,
  handler,
  multiUserTest,
  pattern,
  SELF,
  spaceOf,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import {
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
} from "../system/shared-space-catalog.ts";
import { FabriChatManagerCore, type ManagerStreamEvent } from "./manager.tsx";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ComposerState,
  type JoinRoomRequest,
  type MessagesValue,
  type RoomStreamEvent,
} from "./room-records.tsx";
import {
  type ChatRoomOutput,
  FabriChatRoomCore,
  type RoomManager,
} from "./room.tsx";
import {
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_ROOM_OFFER_KIND,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

/** The viewer's catalog, whose confidentiality room writes must preserve. */
type PrivateCatalog = Confidential<
  SharedSpaceCatalogStorage,
  readonly ["fabrichat-private-catalog"]
>;

// A stand-in for a person's `#profile`, labeled, as a Fabric profile is,
// because a room's participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A room's records, which every viewer's room over them shares. */
interface Setup {
  messages: Writable<MessagesValue>;

  /** Those who joined the room. */
  roster: Writable<ParticipantRoster>;
}

export const setup = pattern(() => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  roster: Writable.of<ParticipantRoster>({}),
}));

/** What `listRoom` and `forgetRoom` are bound to. */
interface EntryState {
  /** The manager's catalog. */
  catalog: Writable<SharedSpaceCatalogStorage>;

  /** The room. */
  room: Cell<ChatRoomLink>;

  /** The manager's `forget`. */
  forget?: Stream<ManagerStreamEvent>;
}

/** Lists the room in the catalog, as creating it does. */
const listRoom = handler<unknown, EntryState>((_event, { catalog, room }) => {
  registerSharedSpaceIn(catalog, {
    space: spaceOf(room) ?? "",
    host: "http://localhost:8000",
    kind: CHAT_ROOM_OFFER_KIND,
  });
});

/** Forgets the room, at the revision its catalog entry holds. */
const forgetRoom = handler<unknown, EntryState>((
  _event,
  { catalog, room, forget },
) => {
  forget?.send({
    room,
    revision: readSharedSpaceCatalog(catalog).entries[spaceOf(room) ?? ""]
      ?.revision,
  });
});

/** A viewer's own result, as the link a manager names the room by. */
function roomLinkOf(room: unknown): Cell<ChatRoomLink>;
function roomLinkOf(room: unknown): unknown {
  return room;
}

/** What `countJoins` is bound to. */
interface CountJoinsState {
  /** How many joins the room has sent. */
  joins: Writable<number>;

  /** The manager's `joinRoom`, which each join is handed on to. */
  joinRoom: Stream<ManagerStreamEvent>;
}

/** Counts a join the room sends, and hands it on to the manager. */
const countJoins = handler<JoinRoomRequest, CountJoinsState>((
  event,
  { joins, joinRoom },
) => {
  joins.set(joins.get() + 1);
  joinRoom.send(event);
});

/** What a viewer of the room needs. */
interface ViewerInput {
  setup: Setup;

  /** The viewer's profile. */
  profile: Writable<TestProfile>;
}

/** What a viewer of the room does, and what their manager holds. */
interface ViewerOutput {
  /** The room's `about`, which the manager reads the room's kind from. */
  about: ChatRoomOutput["about"];

  /** The room's `addParticipant`, which the manager joins the viewer through. */
  addParticipant: ChatRoomOutput["addParticipant"];

  /** Sends a message as the viewer. */
  sendMessage: Stream<RoomStreamEvent>;

  /** Adds the viewer's reaction to the room's first message. */
  reactToFirst: Stream<RoomStreamEvent>;

  /** Lists the room in the viewer's catalog, as creating it does. */
  list: Stream<unknown>;

  /** Has the viewer's manager forget the room. */
  forget: Stream<unknown>;

  /** How many of the manager's requests are done. */
  doneCount: number;

  /** How many requests the viewer's manager has recorded. */
  requestCount: number;

  /** How many joins the room has sent the viewer's manager. */
  joinCount: number;

  /** The state of the room's entry in the viewer's catalog. */
  entryState?: string;
}

/**
 * A viewer of the group room, with a manager of their own. The room names
 * itself to that manager by the viewer's own result, as `FabriChatRoom` does,
 * and the viewer reacts from the row of the room's first message.
 */
const Viewer = pattern<ViewerInput, ViewerOutput>((input) => {
  const { setup, profile } = input;
  const catalog = Writable.of<PrivateCatalog>({
    entries: {},
    offers: {},
  });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const self = roomLinkOf(input[SELF]);
  const joins = Writable.of<number>(0);
  const counted = countJoins({ joins, joinRoom: manager.joinRoom });
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.messages,
    roster: setup.roster,
    self,
    manager: {
      offerRoom: manager.offerRoom,
      requests: manager.requests,
      people: manager.people,
      joinRoom: counted,
    } as RoomManager,
  } as RoomArg);
  const first = FabriChatMessageRow({
    message: setup.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    messages: setup.messages,
    canJoin: true,
    manager: { joinRoom: counted },
    self,
  } as RowArg);

  return {
    addParticipant: room.addParticipant,
    about: room.about,
    sendMessage: room.sendMessage,
    reactToFirst: first.sendReaction,
    list: listRoom({ catalog, room: self }),
    forget: forgetRoom({ catalog, room: self, forget: manager.forget }),
    doneCount: computed(() =>
      Object.values(requests.get() ?? {}).filter((outcome) =>
        outcome.status === "done"
      ).length
    ),
    requestCount: computed(() => Object.keys(requests.get() ?? {}).length),
    joinCount: computed(() => joins.get()),
    entryState: computed(() =>
      readSharedSpaceCatalog(catalog).entries[spaceOf(self) ?? ""]?.state
    ),
  };
});

// Writes in a room her manager lists already.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const viewer = Viewer({
    setup,
    profile: Writable.of<TestProfile>({ name: "Alice" }),
  });

  return {
    [TESTS]: [
      { action: viewer.list, event: {} },
      { assertion: assert(() => viewer.entryState === "saved") },
      {
        action: viewer.sendMessage,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      {
        action: viewer.reactToFirst,
        event: { emoji: "🎉" },
        trustedUi: reactGesture,
      },
      // Both writes landed; their joins left the listed room unchanged.
      {
        assertion: assert(() =>
          setup.messages.get().length === 1 &&
          (setup.messages.key(0).get()?.reactions?.get() ?? []).length === 1 &&
          viewer.requestCount === 0 &&
          viewer.joinCount === 2 &&
          viewer.entryState === "saved"
        ),
      },
      { label: "alice-wrote" },
      { await: "bob-done" },
    ],
  };
});

// Reached the room by its link, and writes in it.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const viewer = Viewer({ setup, profile });

  return {
    [TESTS]: [
      { await: "alice-wrote" },
      { assertion: assert(() => viewer.entryState === undefined) },
      // His first message has his manager list the room, and join him to its
      // roster.
      {
        action: viewer.sendMessage,
        event: typed("Hi, I followed the link"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          viewer.entryState === "saved" &&
          viewer.requestCount === 1 &&
          viewer.doneCount === 1 &&
          (setup.roster.get()?.items ?? []).some((known) =>
            equals(known, profile)
          )
        ),
      },
      // A later join leaves the listed room and its request history unchanged.
      {
        action: viewer.sendMessage,
        event: typed("Still here"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          setup.messages.get().length === 3 &&
          viewer.requestCount === 1 &&
          viewer.joinCount === 2
        ),
      },
      // A reaction lists a room he forgot again.
      { action: viewer.forget, event: {} },
      {
        assertion: assert(() => viewer.entryState === "archived"),
      },
      {
        action: viewer.reactToFirst,
        event: { emoji: "👍" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() => viewer.entryState === "saved"),
      },
      // So does a message.
      { action: viewer.forget, event: {} },
      {
        assertion: assert(() => viewer.entryState === "archived"),
      },
      {
        action: viewer.sendMessage,
        event: typed("Back again"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => viewer.entryState === "saved"),
      },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
