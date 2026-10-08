/**
 * Joining a FabriChat room. A room in a space of its own is that space's root,
 * and keeps the space's participants itself: anyone added through
 * `addParticipant` is listed before they write anything, once. A space's own
 * chat lists its space's participants, of which `#default` resolves none here,
 * then those who joined the chat itself.
 */
import {
  action,
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
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

  // A room in a space of its own, as a manager creates it, with `about`.
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const, title: "Team" },
    ...freshRecords(),
  } as RoomArg);
  const action_add_alice = action(() =>
    alice.addParticipant.send({ profile: aliceProfile })
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
      { assertion: assert(() => alice.participants.length === 0) },
      // Anyone may add a profile, which is listed once however often it is
      // added, in the order each was first added.
      { action: action_add_alice },
      { action: action_add_bob },
      { action: action_add_bob },
      {
        assertion: assert(() =>
          alice.participants.length === 2 &&
          equals(alice.participants[0], aliceProfile) &&
          equals(alice.participants[1], bobProfile)
        ),
      },

      // A space's own chat lists whoever joined it.
      { assertion: assert(() => chat.participants.length === 0) },
      { action: action_add_bob_to_chat },
      {
        assertion: assert(() =>
          chat.participants.length === 1 &&
          equals(chat.participants[0], bobProfile)
        ),
      },
    ],
  };
});
