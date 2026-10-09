/**
 * A room read through the link a manager holds to it, `ChatRoomLink`: how many
 * messages the room holds, and when the newest was sent.
 */
import {
  action,
  type AddIntegrity,
  assert,
  FabricEpochNsec,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { testRoomAbout, testRoomStorage } from "./room-test-fixture.ts";
import { FabriChatRoom } from "./room.tsx";
import { type ChatProfile, type ChatRoomLink } from "./schemas.tsx";

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** Where a manager holds its link to the room. */
interface HeldLink {
  room?: Writable<ChatRoomLink>;
}

const sendGesture = {
  surface: "ChatSendSurface",
  action: "ChatSend",
};

/** What the room held in `held` says of its messages through the link. */
const linkedMessages = (held: Writable<HeldLink>): string => {
  const messages = held.key("room").get()?.get()?.messages;
  return `count:${messages?.count ?? "none"} ` +
    `newestAt:${messages?.newestAt === undefined ? "none" : "set"}`;
};

export default pattern(() => {
  const version = new Writable({
    body: "Hello",
    sentAt: new FabricEpochNsec(0n),
  });
  const initializeVersion = action(() =>
    version.key("sentAt").set(
      new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    )
  );
  const description = testRoomAbout({ kind: "group", standalone: false });
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoom({
    myProfile: aliceProfile,
    about: description.about,
    ...testRoomStorage({}),
  });
  const held = Writable.of<HeldLink>({});
  const action_hold_link = action(() => held.key("room").set(alice));

  return {
    [TESTS]: [
      { action: description.initialize },
      { action: initializeVersion },
      { action: action_hold_link },
      {
        assertion: assert(() =>
          linkedMessages(held) === "count:0 newestAt:none"
        ),
      },
      {
        action: alice.sendMessage,
        event: { requestId: "first", version },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          linkedMessages(held) === "count:1 newestAt:set"
        ),
      },
    ],
  };
});
