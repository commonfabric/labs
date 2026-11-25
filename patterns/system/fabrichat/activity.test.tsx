/**
 * Where a room's conversation stands, as its entry in a FabriChat manager's
 * `rooms` holds it: the room's message count and newest message time as the
 * manager last heard them, so a list shows them reading no room. A visit to
 * the room brings them up to the room's, and a message the person sends in it
 * carries them to their manager. A reaction changes neither, and another
 * member's message reaches the entry only once the person next visits, all
 * with the entry's revision as it was.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  computed,
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
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
} from "../shared-space/shared-space-catalog.ts";
import { FabriChatManagerCore, type ManagerStreamEvent } from "./manager.tsx";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ComposerState,
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
  type ChatRoomActivity,
  type ChatRoomLink,
  nsecOf,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

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

/** What `listRoom` and `visitRoom` are bound to. */
interface EntryState {
  /** The manager's catalog. */
  catalog: Writable<SharedSpaceCatalogStorage>;

  /** The room. */
  room: Cell<ChatRoomLink>;

  /** The manager's `joinRoom`. */
  joinRoom?: Stream<ManagerStreamEvent>;
}

/** Lists the room in the catalog, as creating it does. */
const listRoom = handler<unknown, EntryState>((_event, { catalog, room }) => {
  registerSharedSpaceIn(catalog, {
    space: spaceOf(room) ?? "",
    host: "http://localhost:8000",
    kind: CHAT_ROOM_OFFER_KIND,
  });
});

/** Sends what a client sends when the person opens the room. */
const visitRoom = handler<unknown, EntryState>((_event, { room, joinRoom }) => {
  joinRoom?.send({ room });
});

/** A viewer's own result, as the link a manager names the room by. */
function roomLinkOf(room: unknown): Cell<ChatRoomLink>;
function roomLinkOf(room: unknown): unknown {
  return room;
}

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

  /** The room's messages, which the manager reads where they stand from. */
  messages: ChatRoomOutput["messages"];

  /** The room's `addParticipant`, which the manager joins the viewer through. */
  addParticipant: ChatRoomOutput["addParticipant"];

  /** Sends a message as the viewer. */
  sendMessage: Stream<RoomStreamEvent>;

  /** Adds the viewer's reaction to the room's first message. */
  reactToFirst: Stream<RoomStreamEvent>;

  /** Lists the room in the viewer's catalog, as creating it does. */
  list: Stream<unknown>;

  /** Has the viewer's client tell the manager the viewer opened the room. */
  visit: Stream<unknown>;

  /** The room's entry in the viewer's `rooms`. */
  entry?: ChatIndexEntry;
}

/**
 * A viewer of the group room, with a manager of their own. The room names
 * itself to that manager by the viewer's own result, as `FabriChatRoom` does,
 * and the viewer reacts from the row of the room's first message.
 */
const Viewer = pattern<ViewerInput, ViewerOutput>((input) => {
  const { setup, profile } = input;
  const catalog = Writable.of<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sessionProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const self = roomLinkOf(input[SELF]);
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
      joinRoom: manager.joinRoom,
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
    rowFacts: {},
    messages: setup.messages,
    canJoin: true,
    manager: { joinRoom: manager.joinRoom },
    self,
  } as RowArg);

  return {
    about: room.about,
    messages: room.messages,
    addParticipant: room.addParticipant,
    sendMessage: room.sendMessage,
    reactToFirst: first.sendReaction,
    list: listRoom({ catalog, room: self }),
    visit: visitRoom({ catalog, room: self, joinRoom: manager.joinRoom }),
    entry: computed(() =>
      manager.rooms.find((entry) => equals(entry.room, self))
    ),
  };
});

/**
 * Whether `activity` counts `count` messages, the newest of them the room's
 * message at `newest`.
 */
const holds = (
  activity: ChatRoomActivity | undefined,
  count: number,
  messages: Writable<MessagesValue>,
  newest: number,
): boolean => {
  const sentAt = messages.key(newest).get()?.sentAt;
  return activity?.count === count && activity.newestAt !== undefined &&
    sentAt !== undefined && nsecOf(activity.newestAt) === nsecOf(sentAt);
};

/** What `keepRevision` is bound to. */
interface KeepRevisionState {
  /** Where the revision is kept. */
  revision: Writable<string | undefined>;

  /** The room's entry. */
  entry?: ChatIndexEntry;
}

/** Keeps the revision the room's entry holds now. */
const keepRevision = handler<unknown, KeepRevisionState>(
  (_event, { revision, entry }) => revision.set(entry?.revision),
);

// Lists the room and writes in it, and hears of Bob's message on her visit.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const viewer = Viewer({
    setup,
    profile: Writable.of<TestProfile>({ name: "Alice" }),
  });
  // The entry's revision once she has visited, which what follows leaves as
  // it is.
  const revision = Writable.of<string | undefined>(undefined);
  const noteRevision = keepRevision({ revision, entry: viewer.entry });

  return {
    [TESTS]: [
      { action: viewer.list, event: {} },
      // Her first visit lists the room, which holds no message yet.
      { action: viewer.visit, event: {} },
      {
        assertion: assert(() =>
          viewer.entry?.activity?.count === 0 &&
          viewer.entry.activity.newestAt === undefined
        ),
      },
      { action: noteRevision, event: {} },
      // Her message carries where it leaves the conversation to her manager.
      {
        action: viewer.sendMessage,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          holds(viewer.entry?.activity, 1, setup.messages, 0) &&
          viewer.entry?.revision === revision.get()
        ),
      },
      { label: "alice-wrote" },
      { await: "bob-wrote" },
      // Bob's message is in the room, and her entry has not heard of it, nor
      // does her reaction tell it.
      {
        action: viewer.reactToFirst,
        event: { emoji: "🎉" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          setup.messages.get().length === 2 &&
          holds(viewer.entry?.activity, 1, setup.messages, 0)
        ),
      },
      // Her next visit brings it up to the room's.
      { action: viewer.visit, event: {} },
      {
        assertion: assert(() =>
          holds(viewer.entry?.activity, 2, setup.messages, 1) &&
          viewer.entry?.revision === revision.get()
        ),
      },
    ],
  };
});

// Writes in the room once Alice has.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const viewer = Viewer({
    setup,
    profile: Writable.of<TestProfile>({ name: "Bob" }),
  });

  return {
    [TESTS]: [
      { await: "alice-wrote" },
      {
        action: viewer.sendMessage,
        event: typed("Hi"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => setup.messages.get().length === 2) },
      { label: "bob-wrote" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
