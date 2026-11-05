/**
 * A FabriChat manager and rooms whose spaces are deleted, as the catalog says
 * (`ChatManagerOutput.md`, "Facts"): `rooms` leaves such a room out,
 * `outgoingNotices` leaves out its notice, and `deletedRooms` lists it by the
 * membership the manager recorded when it created the room, which outlives
 * the catalog's finding of it. A direct room
 * the catalog alone calls deleted is still the one `openDirect` finds:
 * `openDirect` replaces a held room only on the memory server's word, since
 * reading the catalog there would bring its entries' labels into the
 * transaction that creates the replacement.
 * `../../integration/home-shared-space-catalog.test.ts` covers the memory
 * server's own word, and the replacement it brings.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import { type SharedSpaceCatalogStorage } from "../shared-space/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for this user's `#profile`, labeled, as a Fabric profile is.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** The gesture a start takes, as a client's start control makes it. */
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

/** A stand-in for a principal, a base58btc key as a principal's is. */
const BOB = "did:key:z6MkBob";

/** The room a request's outcome names, as a cell. */
const roomOf = (
  requests: Cell<Record<string, ChatRequestOutcome>>,
  id: string,
) => requests.key(id).key("entry").key("room").resolveAsCell();

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
  // The catalog's word that a listed room's space is deleted, as Home's
  // `markDeleted` records it: its entry moves to the `deleted` state.
  const action_catalog_deletes_group = action(() => {
    const space = spaceOf(
      manager.rooms.find((entry) => entry.kind === "group")?.room,
    );
    if (space !== undefined) {
      catalog.key("entries").key(space).key("state").set("deleted");
    }
  });
  const action_catalog_deletes_direct = action(() => {
    const space = spaceOf(
      manager.rooms.find((entry) => entry.kind === "direct")?.room,
    );
    if (space !== undefined) {
      catalog.key("entries").key(space).key("state").set("deleted");
    }
  });
  const assert_both_listed = assert(() =>
    manager.rooms.length === 2 && manager.deletedRooms.length === 0
  );
  // The direct room's counterpart has been told nothing, so a notice waits.
  const assert_notice_listed = assert(() =>
    manager.outgoingNotices.length === 1 &&
    manager.outgoingNotices[0]?.recipient === BOB
  );
  const assert_notice_gone = assert(() => manager.outgoingNotices.length === 0);
  const assert_group_deleted = assert(() =>
    manager.rooms.length === 1 && manager.rooms[0]?.counterpart === BOB &&
    manager.deletedRooms.length === 1 &&
    manager.deletedRooms[0]?.kind === "group"
  );
  // Newest first: the group was created after the direct room.
  const assert_both_deleted = assert(() =>
    manager.rooms.length === 0 && manager.deletedRooms.length === 2 &&
    manager.deletedRooms[0]?.kind === "group" &&
    manager.deletedRooms[1]?.kind === "direct" &&
    manager.deletedRooms[1]?.counterpart === BOB
  );
  const assert_direct_found_again = assert(() =>
    requests.get()?.["d-2"]?.status === "done" &&
    equals(roomOf(requests, "d-2"), roomOf(requests, "d-1")) &&
    manager.rooms.length === 0 && manager.deletedRooms.length === 2 &&
    equals(manager.deletedRooms[1]?.room, roomOf(requests, "d-1"))
  );
  return {
    [TESTS]: [
      {
        action: manager.openDirect,
        event: { requestId: "d-1", counterpart: BOB },
        trustedUi: startGesture,
      },
      {
        action: manager.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
        trustedUi: startGesture,
      },
      { assertion: assert_both_listed },
      { assertion: assert_notice_listed },
      { action: action_catalog_deletes_group },
      { assertion: assert_group_deleted },
      { assertion: assert_notice_listed },
      { action: action_catalog_deletes_direct },
      { assertion: assert_both_deleted },
      { assertion: assert_notice_gone },
      {
        action: manager.openDirect,
        event: { requestId: "d-2", counterpart: BOB },
        trustedUi: startGesture,
      },
      { assertion: assert_direct_found_again },
    ],
  };
});
