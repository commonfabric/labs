/**
 * Retitling a FabriChat room, as its space's access list decides who may: a
 * member who isn't an OWNER, with WRITE, sets the title of a group room and of
 * a direct room, and every member's view shows it; a reader with READ is
 * refused, with a reason and a code in their own `titleRequests`, and the
 * title stays as it was.
 *
 * The test lane doesn't enforce the list, so what this checks is what the room
 * decides from the level `spaceAccess()` reports, not what the memory server
 * would refuse.
 */
import {
  type AddIntegrity,
  assert,
  multiUserTest,
  NAME,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import { type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  type ChatProfile,
  type SetTitleOutcome,
  type TitleRecord,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const retitleGesture = {
  surface: CHAT_RETITLE_SURFACE,
  action: CHAT_RETITLE_ACTION,
};

/** One room's records, which every participant's room over them shares. */
interface Records {
  messages: Writable<MessagesValue>;
  titles: Writable<TitleRecord[]>;
}

/** What every session receives from the setup: a group room and a direct one. */
interface Setup {
  group: Records;
  direct: Records;
}

/** A room's records, with none of them holding anything yet. */
const freshRecords = () => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  titles: Writable.of<TitleRecord[]>([]),
});

/** The outcome `outcomes` records under `id`, as `status` or `status/code`. */
const outcomeOf = (
  outcomes: Record<string, SetTitleOutcome> | undefined,
  id: string,
): string => {
  const outcome = outcomes?.[id];
  return outcome === undefined
    ? "none"
    : outcome.status === "refused"
    ? `refused/${outcome.code}`
    : outcome.status;
};

/** What makes a room over the records a group room of its own. */
const groupRoom = { about: { kind: "group" as const, title: "Team" } };

/** What makes a room over the records a direct room of its own. */
const directRoom = { about: { kind: "direct" as const } };

export const setup = pattern(() => ({
  group: freshRecords(),
  direct: freshRecords(),
}));

// The OWNER: the first participant, who created the rooms.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const group = FabriChatRoomCore({
    myProfile: profile,
    ...groupRoom,
    messages: setup.group.messages,
    titles: setup.group.titles,
  } as RoomArg);
  const direct = FabriChatRoomCore({
    myProfile: profile,
    ...directRoom,
    messages: setup.direct.messages,
    titles: setup.direct.titles,
  } as RoomArg);

  return {
    [TESTS]: [
      { await: "bob-retitled" },
      // Bob's titles are the rooms' titles, for Alice too.
      {
        assertion: assert(() =>
          group[VIEWS].room.about.title === "Weekend plans" &&
          group[NAME] === "Weekend plans" &&
          direct[VIEWS].room.about.title === "Alice and Bob" &&
          direct[NAME] === "Alice and Bob"
        ),
      },
      { label: "alice-read" },
      { await: "carol-refused" },
      {
        assertion: assert(() =>
          group[VIEWS].room.about.title === "Weekend plans"
        ),
      },
    ],
  };
});

// A member with WRITE, who isn't an OWNER.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const group = FabriChatRoomCore({
    myProfile: profile,
    ...groupRoom,
    messages: setup.group.messages,
    titles: setup.group.titles,
  } as RoomArg);
  const direct = FabriChatRoomCore({
    myProfile: profile,
    ...directRoom,
    messages: setup.direct.messages,
    titles: setup.direct.titles,
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: group[VIEWS].room.setTitle,
        event: { requestId: "bob-group", title: "Weekend plans" },
        trustedUi: retitleGesture,
      },
      {
        action: direct[VIEWS].room.setTitle,
        event: { requestId: "bob-direct", title: "Alice and Bob" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(group[VIEWS].room.titleRequests, "bob-group") === "done" &&
          outcomeOf(direct[VIEWS].room.titleRequests, "bob-direct") ===
            "done" &&
          group[VIEWS].room.about.title === "Weekend plans" &&
          direct[VIEWS].room.about.title === "Alice and Bob"
        ),
      },
      { label: "bob-retitled" },
      { await: "carol-refused" },
    ],
  };
});

// A reader with READ, who can't write in the rooms.
export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Carol" });
  const group = FabriChatRoomCore({
    myProfile: profile,
    ...groupRoom,
    messages: setup.group.messages,
    titles: setup.group.titles,
  } as RoomArg);

  return {
    [TESTS]: [
      { await: "alice-read" },
      {
        action: group[VIEWS].room.setTitle,
        event: { requestId: "carol-group", title: "Carol's room" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() => {
          const recorded = group[VIEWS].room.titleRequests["carol-group"];
          return recorded?.status === "refused" &&
            recorded.code === "not-member" &&
            recorded.reason === "You can't write in this chat." &&
            group[VIEWS].room.about.title === "Weekend plans";
        }),
      },
      { label: "carol-refused" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    carol: { pattern: carol, access: "READ" },
  },
});
