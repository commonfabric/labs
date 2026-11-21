/**
 * A `joinRoom` sent for a notice that a room changed, as the user's host
 * sends one when their share inbox holds such a notice. For a room the user's
 * chats list as saved, it brings the title the catalog lists the room under
 * up to the room's own and marks the notice acted on in the catalog, under
 * its sender and `id`, replacing the mark an earlier notice from them left.
 * For a room the user has forgotten, or one the catalog lists with no
 * membership, it does nothing: the entry keeps its state and its title, no
 * mark is written, and no membership is recorded.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  handler,
  pattern,
  spaceOf,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import {
  readSharedSpaceCatalog,
  type SharedSpaceCatalogStorage,
} from "../shared-space/shared-space-catalog.ts";
import {
  FabriChatManagerCore,
  type ManagerStreamEvent,
  type RoomMembership,
} from "./manager.tsx";
import {
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for this user's `#profile`, labeled, as a Fabric profile is.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** The gesture a start takes, as a client's start control makes it. */
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

/** The sender every notice names. */
const SENDER = "did:key:z6MkjCYAbDn93qatTyLh59ZaWvpRWVXJY4nFRfwKhBiSmdQG";

/** The title the catalog is made to list a room under, unlike the room's. */
const STALE = "Stale";

/** The room a request's outcome names, as a cell. */
const roomOf = (
  requests: Cell<Record<string, ChatRequestOutcome>>,
  id: string,
) => requests.key(id).key("entry").key("room").resolveAsCell();

/**
 * Drops the membership of the room the request `unjoined` created, as when a
 * room reaches the catalog before the manager records it, which the catalog
 * keeps listing.
 */
const dropUnjoinedMembership = handler<void, {
  memberships: Writable<RoomMembership[]>;
  requests: Writable<Record<string, ChatRequestOutcome>>;
}>((_, { memberships, requests }) => {
  const space = spaceOf(roomOf(requests, "unjoined"));
  memberships.set(
    (memberships.get() ?? []).filter((membership) =>
      spaceOf(membership.room) !== space
    ),
  );
});

/** The catalog's key for the sender's notice that the room in `space` changed. */
const noticeKey = (space: string | undefined): string =>
  JSON.stringify([SENDER, `changed:${space}`]);

/** The entry `catalog` lists `room` under. */
const entryOf = (
  catalog: Cell<SharedSpaceCatalogStorage>,
  room: Cell<ChatRoomLink>,
) => readSharedSpaceCatalog(catalog).entries[spaceOf(room) ?? ""];

/** The `sharedAt` `catalog` marks the sender's notice that `room` changed with. */
const markOf = (
  catalog: Cell<SharedSpaceCatalogStorage>,
  room: Cell<ChatRoomLink>,
) => readSharedSpaceCatalog(catalog).notices?.[noticeKey(spaceOf(room))];

/** Has `catalog` list `room` under {@link STALE}, in whatever state. */
const makeStale = (
  catalog: Writable<SharedSpaceCatalogStorage>,
  room: Cell<ChatRoomLink>,
) => {
  catalog.key("entries").key(spaceOf(room) ?? "").key("title").set(STALE);
};

/**
 * Sends `joinRoom` the sender's notice that `room` changed, shared at
 * `sharedAt`, as the user's host does.
 */
const notify = (
  joinRoom: Stream<ManagerStreamEvent>,
  room: Cell<ChatRoomLink>,
  sharedAt: number,
) => {
  joinRoom.send({
    room,
    notice: { from: SENDER, id: `changed:${spaceOf(room)}`, sharedAt },
  });
};

export default pattern(() => {
  const profile = Writable.of<TestProfile>({ name: "Tester" });
  const catalog = Writable.of<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sessionProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const action_stale_kept = action(() =>
    makeStale(catalog, roomOf(requests, "kept"))
  );
  const action_notify_kept_first = action(() =>
    notify(manager.joinRoom, roomOf(requests, "kept"), 1_000)
  );
  const action_notify_kept_second = action(() =>
    notify(manager.joinRoom, roomOf(requests, "kept"), 2_000)
  );
  const action_notify_kept_third = action(() =>
    notify(manager.joinRoom, roomOf(requests, "kept"), 3_000)
  );
  const action_forget_kept = action(() => {
    const room = roomOf(requests, "kept");
    manager.forget.send({ room, revision: entryOf(catalog, room)?.revision });
  });

  const action_drop_unjoined_membership = dropUnjoinedMembership({
    memberships: manager.roomMembership,
    requests,
  });
  const action_stale_unjoined = action(() =>
    makeStale(catalog, roomOf(requests, "unjoined"))
  );
  const action_notify_unjoined = action(() =>
    notify(manager.joinRoom, roomOf(requests, "unjoined"), 1_000)
  );

  const assert_kept_stale = assert(() =>
    entryOf(catalog, roomOf(requests, "kept"))?.state === "saved" &&
    entryOf(catalog, roomOf(requests, "kept"))?.title === STALE &&
    markOf(catalog, roomOf(requests, "kept")) === undefined
  );
  const assert_kept_first = assert(() =>
    entryOf(catalog, roomOf(requests, "kept"))?.state === "saved" &&
    entryOf(catalog, roomOf(requests, "kept"))?.title === "Team" &&
    markOf(catalog, roomOf(requests, "kept")) === 1_000
  );
  const assert_kept_second = assert(() =>
    entryOf(catalog, roomOf(requests, "kept"))?.state === "saved" &&
    entryOf(catalog, roomOf(requests, "kept"))?.title === "Team" &&
    markOf(catalog, roomOf(requests, "kept")) === 2_000
  );
  const assert_kept_forgotten = assert(() =>
    entryOf(catalog, roomOf(requests, "kept"))?.state === "archived" &&
    entryOf(catalog, roomOf(requests, "kept"))?.title === STALE &&
    markOf(catalog, roomOf(requests, "kept")) === 2_000
  );
  const assert_unjoined_unchanged = assert(() =>
    entryOf(catalog, roomOf(requests, "unjoined"))?.state === "saved" &&
    entryOf(catalog, roomOf(requests, "unjoined"))?.title === STALE &&
    markOf(catalog, roomOf(requests, "unjoined")) === undefined &&
    manager.roomMembership.length === 1
  );

  return {
    [TESTS]: [
      {
        action: manager.createGroup,
        event: { requestId: "kept", title: "Team", members: [] },
        trustedUi: startGesture,
      },
      {
        action: manager.createGroup,
        event: { requestId: "unjoined", title: "Others", members: [] },
        trustedUi: startGesture,
      },
      { action: action_stale_kept },
      { assertion: assert_kept_stale },
      { action: action_notify_kept_first },
      { assertion: assert_kept_first },
      // A second notice from the sender replaces the mark the first left.
      { action: action_stale_kept },
      { action: action_notify_kept_second },
      { assertion: assert_kept_second },
      { action: action_forget_kept },
      { action: action_stale_kept },
      { action: action_notify_kept_third },
      { assertion: assert_kept_forgotten },
      { action: action_drop_unjoined_membership },
      { action: action_stale_unjoined },
      { action: action_notify_unjoined },
      { assertion: assert_unjoined_unchanged },
    ],
  };
});
