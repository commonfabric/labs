/**
 * One FabriChat room instance viewed by two people, each in a runtime of
 * their own: the windows each session opens onto the messages are its own.
 */
import {
  type AddIntegrity,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { type ChatMessageWindow, type MessagesValue } from "./room-records.tsx";
import { type ChatRoomOutput, FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room's stored records, shared by everyone in the space. */
interface Records {
  messages: Writable<MessagesValue>;
}

/** What every session receives from the setup. */
interface Setup {
  shared: ChatRoomOutput;
  records: Records;
}

/** The bodies the window `id` of `windows` shows, or `none` for no window. */
const shown = (
  windows: Readonly<Record<string, ChatMessageWindow>> | undefined,
  id: string,
): string => {
  const window = windows?.[id];
  return window === undefined
    ? "none"
    : window.messages.map((message) => String(message?.get()?.body)).join(
      " ",
    );
};

// One room instance over the records, which both sessions view. It has no
// viewer's profile, and opening a window needs none; Alice sends through a
// core of her own over the same records.
export const setup = pattern(() => {
  const records = {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
  };
  return {
    shared: FabriChatRoomCore(
      {
        myProfile: undefined,
        about: { kind: "group" as const },
        ...records,
      } as RoomArg,
    ),
    records,
  };
});

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.records.messages,
  } as RoomArg);

  return {
    [TESTS]: [
      { action: room.sendMessage, event: typed("A"), trustedUi: sendGesture },
      { action: room.sendMessage, event: typed("B"), trustedUi: sendGesture },
      {
        action: setup.shared.messages.openWindow,
        event: {
          requestId: "alice",
          windowId: "main",
          from: { before: "end" },
          count: 2,
        },
      },
      {
        assertion: assert(() =>
          shown(setup.shared.messages.windows.get(), "main") === "A B"
        ),
      },
      { label: "alice-opened" },
      { await: "bob-opened" },
      // The window Bob's session set under the same `windowId` leaves
      // Alice's as it was.
      {
        assertion: assert(() =>
          shown(setup.shared.messages.windows.get(), "main") === "A B" &&
          setup.shared.messages.windows.get()?.main?.requestId === "alice"
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  return {
    [TESTS]: [
      { await: "alice-opened" },
      // The window Alice's session opened is no window of Bob's.
      {
        assertion: assert(() =>
          shown(setup.shared.messages.windows.get(), "main") === "none"
        ),
      },
      {
        action: setup.shared.messages.openWindow,
        event: {
          requestId: "bob",
          windowId: "main",
          from: { after: "start" },
          count: 1,
        },
      },
      {
        assertion: assert(() =>
          shown(setup.shared.messages.windows.get(), "main") === "A"
        ),
      },
      { label: "bob-opened" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
