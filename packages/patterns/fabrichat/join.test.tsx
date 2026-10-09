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
import { testRoomAbout, testRoomStorage } from "./room-test-fixture.ts";
import { FabriChatRoom } from "./room.tsx";
import type { ChatProfile } from "./schemas.tsx";

// A stand-in for a viewer's `#profile`, labeled, as a Fabric profile is,
// because the participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });

  const ownDescription = testRoomAbout({ kind: "group", standalone: true });
  const sharedDescription = testRoomAbout({ kind: "group", standalone: false });
  // A room in a space of its own, as a manager creates it, with `about`.
  const alice = FabriChatRoom({
    myProfile: aliceProfile,
    about: ownDescription.about,
    ...testRoomStorage({}),
  });
  const action_add_alice = action(() =>
    alice.addParticipant.send({ profile: aliceProfile })
  );
  const action_add_bob = action(() =>
    alice.addParticipant.send({ profile: bobProfile })
  );

  // A space's own chat, which has no `about`.
  const chat = FabriChatRoom(
    {
      myProfile: aliceProfile,
      about: sharedDescription.about,
      ...testRoomStorage({}),
    },
  );
  const action_add_bob_to_chat = action(() =>
    chat.addParticipant.send({ profile: bobProfile })
  );

  return {
    [TESTS]: [
      { action: ownDescription.initialize },
      { action: sharedDescription.initialize },
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
