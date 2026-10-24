/**
 * A FabriChat room shared by two people, each in a runtime of their own with
 * an identity of their own: each one's message, and each one's reaction,
 * reaches the other.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { FabriChatMessageRow } from "./message-row.tsx";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type ChatReaction,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room's stored records, shared by everyone in the space. */
interface Records {
  messages: Writable<MessagesValue>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;
}

// The messages' bodies, in the order they were recorded.
const bodies = (messages: Cell<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string" ? message.body : "<gone>"
  ).join(" | ");

const reactionsOnFirst = (messages: Cell<MessagesValue>): number => {
  const first = ((messages.get() ?? []) as MessageRecord[])[0];
  return ((first?.reactions?.get() ?? []) as ChatReaction[]).length;
};

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
  },
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.records.messages,
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: room.composerSend,
        event: typed("Hello from Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-sent" },
      { await: "bob-reacted" },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "Hello from Alice | Hi Alice, Bob here"
        ),
      },
      {
        assertion: assert(() => reactionsOnFirst(setup.records.messages) === 1),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.records.messages,
  } as RoomArg);
  const onFirst = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    messages: setup.records.messages,
  } as RowArg);

  return {
    [TESTS]: [
      { await: "alice-sent" },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) === "Hello from Alice"
        ),
      },
      {
        action: room.composerSend,
        event: typed("Hi Alice, Bob here"),
        trustedUi: sendGesture,
      },
      {
        action: onFirst.sendReaction,
        event: { emoji: "👍" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "Hello from Alice | Hi Alice, Bob here" &&
          reactionsOnFirst(setup.records.messages) === 1
        ),
      },
      { label: "bob-reacted" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
