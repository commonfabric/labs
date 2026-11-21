/**
 * A container's conversation follows the container's entry in its member's
 * catalog. A room a container declares, which a member's manager lists through
 * the container's membership, is left out of their rooms while their catalog
 * archives the container, and listed again once it is restored, at the
 * membership revision it had: the manager writes nothing either way. Joining
 * the room while the container is archived, by a visit, a message or an
 * explicit join, leaves it out. A catalog with no entry for the container
 * leaves the room listed, and a room the member forgot stays forgotten
 * across the container's archive and restore. Each member's catalog is their
 * own, so one member archiving the container leaves the room in another's
 * rooms.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  handler,
  multiUserTest,
  pattern,
  spaceOf,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import {
  changeSharedSpaceMembershipIn,
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  removeSharedSpaceIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceMembership,
} from "../shared-space/shared-space-catalog.ts";
import { FabriChatManagerCore, type ManagerStreamEvent } from "./manager.tsx";
import FabriChatRoom from "./room.tsx";
import type {
  ChatContainer,
  ChatIndexEntry,
  ChatManagerNotice,
  ChatProfile,
  ChatRequestOutcome,
  ChatRoomLink,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for a person's `#profile`, labeled, as a Fabric profile is,
// because a room's participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** What every session receives from the setup. */
interface Setup {
  /** The container, which declares the room once Alice has created it. */
  container: Writable<ChatContainer>;
}

export const setup = pattern(() => ({
  container: Writable.of<ChatContainer>({}),
}));

/** What `declareRoom` is bound to. */
interface DeclareState {
  /** The container. */
  container: Writable<ChatContainer>;
}

/**
 * Has the container declare a new room in its own space, as a loom's own chat
 * is: not the space's root, and with no `about` of its own.
 */
const declareRoom = handler<unknown, DeclareState>((_event, { container }) => {
  container.key("chatRoom").set(roomLinkOf(FabriChatRoom({})));
});

/** A new room, as the link a container names it by. */
function roomLinkOf(room: unknown): Cell<ChatRoomLink>;
function roomLinkOf(room: unknown): unknown {
  return room;
}

/** What the catalog handlers are bound to. */
interface CatalogState {
  /** The person's catalog. */
  catalog: Writable<SharedSpaceCatalogStorage>;

  /** The container. */
  container: Writable<ChatContainer>;
}

/** Lists the container's space in the catalog, saved. */
const listContainer = handler<unknown, CatalogState>((
  _event,
  { catalog, container },
) => {
  registerSharedSpaceIn(catalog, {
    space: spaceOf(container) ?? "",
    host: "http://localhost:8000",
    kind: "loom",
    title: "Workshop",
  });
});

/** What `setContainerState` is bound to. */
interface ChangeState extends CatalogState {
  /** The change's id, unique to the change. */
  id: string;

  /** The state the change gives the container's entry. */
  state: SharedSpaceMembership;
}

/**
 * Archives or restores the container's entry, at the revision the catalog
 * holds, as Home does when the person chooses.
 */
const setContainerState = handler<unknown, ChangeState>((
  _event,
  { catalog, container, id, state },
) => {
  const space = spaceOf(container) ?? "";
  changeSharedSpaceMembershipIn(catalog, {
    space,
    id,
    expectedRevision: readSharedSpaceCatalog(catalog).entries[space]
      ?.revision ?? "",
    state,
  });
});

/** Removes the container's entry from the catalog. */
const removeContainer = handler<unknown, CatalogState>((
  _event,
  { catalog, container },
) => {
  const space = spaceOf(container) ?? "";
  removeSharedSpaceIn(catalog, {
    space,
    expectedRevision: readSharedSpaceCatalog(catalog).entries[space]
      ?.revision ?? "",
  });
});

/** What `joinThroughContainer` is bound to. */
interface JoinState {
  /** The manager's `joinRoom`. */
  joinRoom: Stream<ManagerStreamEvent>;

  /** The container, whose declared room is joined. */
  container: Writable<ChatContainer>;

  /** The request's id; empty, the join names none, as a visit's does. */
  requestId: string;

  /** Whether the join comes from a message sent in the room. */
  messageAct: boolean;
}

/** Joins the container's declared room through the container. */
const joinThroughContainer = handler<unknown, JoinState>((
  _event,
  { joinRoom, container, requestId, messageAct },
) => {
  joinRoom.send({
    room: container.key("chatRoom").resolveAsCell(),
    container,
    ...(requestId === "" ? {} : { requestId }),
    ...(messageAct ? { messageAct } : {}),
  });
});

/** What `forgetListed` is bound to. */
interface ForgetState {
  /** The manager's `forget`. */
  forget: Stream<ManagerStreamEvent>;

  /** The container, whose declared room is forgotten. */
  container: Writable<ChatContainer>;

  /** The manager's rooms, whose first entry holds the room's revision. */
  rooms: Cell<ChatIndexEntry[]>;
}

/**
 * Forgets the container's declared room, at the revision the first listed
 * room's entry holds.
 */
const forgetListed = handler<unknown, ForgetState>((
  _event,
  { forget, container, rooms },
) => {
  const revision = rooms.get()?.[0]?.revision;
  forget.send({
    requestId: "f-1",
    room: container.key("chatRoom").resolveAsCell(),
    ...(revision === undefined ? {} : { revision }),
  });
});

// Creates the room, has the container declare it, and joins it through the
// container. Her catalog archives the container, which takes the room out of
// her rooms and nothing else, and restores it.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
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
  const { container } = setup;
  // The membership's revision once she has joined, which nothing that
  // follows changes.
  const joinedRevision = Writable.of<string>("");
  const action_note_revision = action(() =>
    joinedRevision.set(manager.roomMembership[0]?.revision ?? "")
  );
  const action_archive = setContainerState({
    catalog,
    container,
    id: "c-archive",
    state: "archived",
  });
  const action_restore = setContainerState({
    catalog,
    container,
    id: "c-restore",
    state: "saved",
  });
  const action_archive_again = setContainerState({
    catalog,
    container,
    id: "c-archive-again",
    state: "archived",
  });
  const action_restore_again = setContainerState({
    catalog,
    container,
    id: "c-restore-again",
    state: "saved",
  });

  return {
    [TESTS]: [
      { action: declareRoom({ container }) },
      { action: listContainer({ catalog, container }) },
      {
        action: joinThroughContainer({
          joinRoom: manager.joinRoom,
          container,
          requestId: "j-1",
          messageAct: false,
        }),
      },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 &&
          equals(manager.rooms[0]?.room, container.key("chatRoom")) &&
          manager.roomMembership[0]?.container !== undefined &&
          manager.roomMembership[0]?.catalogRevision === undefined
        ),
      },
      { action: action_note_revision },

      // Archiving the container takes the room out of her rooms, and writes
      // nothing of its membership.
      { action: action_archive },
      {
        assertion: assert(() =>
          readSharedSpaceCatalog(catalog).entries[spaceOf(container) ?? ""]
            ?.state === "archived"
        ),
      },
      { assertion: assert(() => manager.rooms.length === 0) },
      {
        assertion: assert(() =>
          manager.roomMembership.length === 1 &&
          manager.roomMembership[0]?.state === "saved" &&
          joinedRevision.get() !== "" &&
          manager.roomMembership[0]?.revision === joinedRevision.get()
        ),
      },
      { label: "alice-archived" },
      { await: "bob-listed" },

      // A visit, a message, and an explicit join leave it out.
      {
        action: joinThroughContainer({
          joinRoom: manager.joinRoom,
          container,
          requestId: "",
          messageAct: false,
        }),
      },
      {
        action: joinThroughContainer({
          joinRoom: manager.joinRoom,
          container,
          requestId: "",
          messageAct: true,
        }),
      },
      {
        action: joinThroughContainer({
          joinRoom: manager.joinRoom,
          container,
          requestId: "j-2",
          messageAct: false,
        }),
      },
      { assertion: assert(() => manager.rooms.length === 0) },
      {
        assertion: assert(() =>
          manager.roomMembership.length === 1 &&
          manager.roomMembership[0]?.state === "saved" &&
          joinedRevision.get() !== "" &&
          manager.roomMembership[0]?.revision === joinedRevision.get()
        ),
      },

      // Restoring the container lists the room again, at the revision it had.
      { action: action_restore },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 &&
          manager.rooms[0]?.revision === joinedRevision.get()
        ),
      },

      // A catalog with no entry for the container leaves the room listed.
      { action: removeContainer({ catalog, container }) },
      {
        assertion: assert(() =>
          readSharedSpaceCatalog(catalog).entries[spaceOf(container) ?? ""] ===
            undefined
        ),
      },
      { assertion: assert(() => manager.rooms.length === 1) },
      { action: listContainer({ catalog, container }) },

      // A forgotten room stays forgotten across the container's archive and
      // restore.
      {
        action: forgetListed({
          forget: manager.forget,
          container,
          rooms: manager.rooms,
        }),
      },
      {
        assertion: assert(() =>
          manager.rooms.length === 0 &&
          manager.roomMembership[0]?.state === "archived"
        ),
      },
      { action: action_archive_again },
      { action: action_restore_again },
      {
        assertion: assert(() =>
          readSharedSpaceCatalog(catalog).entries[spaceOf(container) ?? ""]
            ?.state === "saved"
        ),
      },
      {
        assertion: assert(() =>
          manager.rooms.length === 0 &&
          manager.roomMembership[0]?.state === "archived"
        ),
      },
    ],
  };
});

// His catalog holds the container saved, so the room stays in his rooms while
// Alice's catalog archives it.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
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
  const { container } = setup;

  return {
    [TESTS]: [
      { await: "alice-archived" },
      { action: listContainer({ catalog, container }) },
      {
        action: joinThroughContainer({
          joinRoom: manager.joinRoom,
          container,
          requestId: "j-bob",
          messageAct: false,
        }),
      },
      {
        assertion: assert(() =>
          readSharedSpaceCatalog(catalog).entries[spaceOf(container) ?? ""]
              ?.state === "saved" &&
          manager.rooms.length === 1 &&
          equals(manager.rooms[0]?.room, container.key("chatRoom"))
        ),
      },
      { label: "bob-listed" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: { alice, bob },
});
