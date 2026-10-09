/**
 * A FabriChat room's add control: shown to an OWNER of a group room the
 * manager created in a space of its own, and refusing what it can refuse
 * before it grants anything. That an add admits someone to the room's space is
 * something only a space other than the test's own shows, so
 * `../integration/fabrichat-spaces-multi-runtime.test.ts` checks it.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  VIEWS,
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
  type AddMemberOutcome,
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

// The add control delivers its field's text on the trusted click; a client
// that draws natively names the add as well.
const typed = (text: string, requestId?: string) => ({
  type: "click",
  ...(requestId === undefined ? {} : { requestId }),
  target: { value: text },
});

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
  addRequests: Writable.of<Record<string, AddMemberOutcome>>({}),
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
  // A direct room a manager created, which keeps its two members.
  const directRoom = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "direct" as const },
    ...emptyRecords(),
  } as RoomArg);
  // A space's own chat, which has no `about`.
  const sharedRoom = FabriChatRoomCore({
    myProfile: profile,
    ...emptyRecords(),
  } as RoomArg);

  return {
    [TESTS]: [
      // The viewer is an OWNER of the test's space, so a group room in a
      // space of its own offers them the control once their profile has
      // resolved, and neither a direct room nor a space's own chat does.
      {
        assertion: assert(() =>
          displayOf(ownRoom[UI], "fabrichat-add-member") === "flex" &&
          displayOf(unresolvedRoom[UI], "fabrichat-add-member") === "none" &&
          displayOf(directRoom[UI], "fabrichat-add-member") === "none" &&
          displayOf(sharedRoom[UI], "fabrichat-add-member") === "none" &&
          shownOutcome(ownRoom[UI]) === "none:"
        ),
      },
      // A client that draws natively reads the same through the room's views:
      // the viewer can add to a group room, and not to a direct room or a
      // space's own chat.
      {
        assertion: assert(() =>
          ownRoom[VIEWS].room.canAdd === true &&
          directRoom[VIEWS].room.canAdd === false &&
          sharedRoom[VIEWS].room.canAdd === false
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
      // A direct room refuses an add, whatever reaches its stream, a
      // principal's address included, and records the refusal under the
      // add's `requestId`, with a code a client can act on.
      {
        action: directRoom.addMember,
        event: typed(BOB, "add-1"),
        trustedUi: addGesture,
      },
      {
        assertion: assert(() => {
          const recorded = directRoom[VIEWS].room.addRequests["add-1"];
          return shownOutcome(directRoom[UI]) ===
              "block:A direct chat keeps its two members." &&
            recorded?.status === "refused" &&
            recorded.code === "direct-room" &&
            recorded.reason === "A direct chat keeps its two members.";
        }),
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
