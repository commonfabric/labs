/**
 * Joining a FabriChat room. A room in a space of its own is that space's root,
 * and keeps the space's participants itself: a viewer who isn't among them is
 * offered the control that joins them, and anyone added through
 * `addParticipant` is listed before they write anything, once. A space's own
 * chat lists its space's participants, of which `#default` resolves none here,
 * then those who joined the chat itself, and offers no control, since joining
 * it is its space's business.
 */
import {
  action,
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import {
  clickButton,
  findNodeById,
  propValue,
  readValue,
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
import type { ChatProfile } from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A stand-in for a viewer's `#profile`, labeled, as a Fabric profile is,
// because the participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

// How the room's join control is displayed.
const joinDisplay = (root: unknown): unknown =>
  readValue(
    (propValue(findNodeById(root, "fabrichat-join"), "style") as {
      display?: unknown;
    })?.display,
  );

/** A room's records, with none of them holding anything yet. */
const freshRecords = () => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
  requests: Writable.of<RequestMemo[]>([]),
  usedTimes: Writable.of<UsedTime[]>([]),
  activity: Writable.of<SentActivity[]>([]),
  counters: Writable.of<ActivityCounters[]>([]),
  roster: Writable.of<ParticipantRoster>({}),
});

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const pendingProfile = Writable.of<TestProfile | undefined>(undefined);

  // A room in a space of its own, as a manager creates it, with `about`.
  const own = {
    about: { kind: "group" as const, title: "Team" },
    ...freshRecords(),
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...own } as RoomArg,
  );
  const pending = FabriChatRoomCore(
    { myProfile: pendingProfile, ...own } as RoomArg,
  );
  const action_alice_joins = action(() =>
    clickButton(alice[UI], "Join this chat")
  );
  const action_add_bob = action(() =>
    alice.addParticipant.send({ profile: bobProfile })
  );

  // A space's own chat, which has no `about`.
  const chat = FabriChatRoomCore(
    { myProfile: aliceProfile, ...freshRecords() } as RoomArg,
  );
  const action_add_bob_to_chat = action(() =>
    chat.addParticipant.send({ profile: bobProfile })
  );

  return {
    [TESTS]: [
      // Nobody has joined, so the viewer is offered the control, and a viewer
      // whose profile hasn't resolved is not.
      {
        assertion: assert(() =>
          alice.participants.length === 0 &&
          joinDisplay(alice[UI]) === "flex" &&
          joinDisplay(pending[UI]) === "none"
        ),
      },
      { action: action_alice_joins },
      {
        assertion: assert(() =>
          alice.participants.length === 1 &&
          equals(alice.participants[0], aliceProfile) &&
          joinDisplay(alice[UI]) === "none"
        ),
      },
      // Anyone may add a profile, which is listed once however often it is
      // added.
      { action: action_add_bob },
      { action: action_add_bob },
      {
        assertion: assert(() =>
          alice.participants.length === 2 &&
          equals(alice.participants[1], bobProfile)
        ),
      },

      // A space's own chat offers no control, and lists whoever joined it.
      {
        assertion: assert(() =>
          chat.participants.length === 0 && joinDisplay(chat[UI]) === "none"
        ),
      },
      { action: action_add_bob_to_chat },
      {
        assertion: assert(() =>
          chat.participants.length === 1 &&
          equals(chat.participants[0], bobProfile) &&
          joinDisplay(chat[UI]) === "none"
        ),
      },
    ],
  };
});
