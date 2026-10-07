/**
 * A FabriChat room's add control: shown to an OWNER of a room the manager
 * created in a space of its own, and refusing what it can refuse before it
 * grants anything. That an add admits someone to the room's space is
 * something only a space other than the test's own shows, so
 * `../integration/fabrichat-spaces-multi-runtime.test.ts` checks it.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
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
  CHAT_ADD_MEMBER_ACTION,
  CHAT_ADD_MEMBER_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A stand-in for a viewer's `#profile`, labeled as a Fabric profile is.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const addGesture = {
  surface: CHAT_ADD_MEMBER_SURFACE,
  action: CHAT_ADD_MEMBER_ACTION,
};

// A stand-in for a principal, a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";

// The add control delivers its field's text on the trusted click.
const typed = (text: string) => ({ type: "click", target: { value: text } });

// How the element `id` under `root` is displayed.
const displayOf = (root: unknown, id: string): unknown =>
  readValue(
    (propValue(findNodeById(root, id), "style") as { display?: unknown })
      ?.display,
  );

// What a room shows about the session's latest add: how it is displayed, and
// what it says.
const shownOutcome = (root: unknown): string =>
  `${displayOf(root, "fabrichat-add-member-outcome")}:` +
  textContent(findNodeById(root, "fabrichat-add-member-outcome"));

/** A room's records, every one empty. */
const emptyRecords = () => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
  requests: Writable.of<RequestMemo[]>([]),
  usedTimes: Writable.of<UsedTime[]>([]),
  activity: Writable.of<SentActivity[]>([]),
  counters: Writable.of<ActivityCounters[]>([]),
});

export default pattern(() => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  // A room a manager created, which says what it is.
  const ownRoom = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    ...emptyRecords(),
  } as RoomArg);
  // The same kind of room, to a viewer whose profile hasn't resolved.
  const unresolvedRoom = FabriChatRoomCore({
    myProfile: Writable.of<TestProfile | undefined>(undefined),
    about: { kind: "group" as const, title: "Team" },
    ...emptyRecords(),
  } as RoomArg);
  // A space's own chat, which has no `about`.
  const sharedRoom = FabriChatRoomCore({
    myProfile: profile,
    ...emptyRecords(),
  } as RoomArg);

  return {
    [TESTS]: [
      // The viewer is an OWNER of the test's space, so a room in a space of
      // its own offers them the control once their profile has resolved, and
      // a space's own chat does not.
      {
        assertion: assert(() =>
          displayOf(ownRoom[UI], "fabrichat-add-member") === "flex" &&
          displayOf(unresolvedRoom[UI], "fabrichat-add-member") === "none" &&
          displayOf(sharedRoom[UI], "fabrichat-add-member") === "none" &&
          shownOutcome(ownRoom[UI]) === "none:"
        ),
      },
      // Text that isn't a principal's DID admits no one.
      {
        action: ownRoom.addMember,
        event: typed(`${BOB}/of:fid1:profile`),
        trustedUi: addGesture,
      },
      {
        assertion: assert(() =>
          shownOutcome(ownRoom[UI]) === "block:That isn't a chat address."
        ),
      },
      // A space's own chat refuses an add, whatever reaches its stream.
      {
        action: sharedRoom.addMember,
        event: typed(BOB),
        trustedUi: addGesture,
      },
      {
        assertion: assert(() =>
          shownOutcome(sharedRoom[UI]) ===
            "block:Members of this chat are added by its space."
        ),
      },
    ],
  };
});
