/**
 * A room read through the link a manager holds to it, `ChatRoomLink`: how many
 * messages the room holds, and when the newest was sent.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type ChatRoomLink,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

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
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** What the room held in `held` says of its messages through the link. */
const linkedMessages = (held: Cell<HeldLink>): string => {
  const messages = held.key("room").get()?.get()?.messages;
  return `count:${messages?.count ?? "none"} ` +
    `newestAt:${messages?.newestAt === undefined ? "none" : "set"}`;
};

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const },
    messages,
  } as RoomArg);
  const held = Writable.of<HeldLink>({});
  const action_hold_link = action(() => held.key("room").set(alice));

  return {
    [TESTS]: [
      { action: action_hold_link },
      {
        assertion: assert(() =>
          linkedMessages(held) === "count:0 newestAt:none"
        ),
      },
      {
        action: alice.composerSend,
        event: typed("Hello"),
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
