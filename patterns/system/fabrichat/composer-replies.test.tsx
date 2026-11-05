/**
 * FabriChat's composers validate a selected quote when it is sent, including
 * when the message was deleted or obliterated after selection. Refusals append
 * nothing and keep the selected quote until it is canceled. A thread remains
 * usable after its root is deleted, and live messages in it remain quotable.
 */
import {
  action,
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  findNodeById,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ComposerState,
  type MessageRecord,
  type MessagesValue,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A message, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const },
    ownersMayObliterate: true,
    messages,
  } as RoomArg);

  const rowRecords = {
    myProfile: aliceProfile,
    kind: "group" as const,
    inThread: false,
    composer: Writable.of<ComposerState>({}),
    places: {},
    cannotWrite: false,
    rowFacts: {},
    ownersMayObliterate: true,
    messages,
  };
  const mainDeleted = FabriChatMessageRow({
    ...rowRecords,
    message: messages.key(0),
  } as RowArg);
  const mainObliterated = FabriChatMessageRow({
    ...rowRecords,
    message: messages.key(1),
  } as RowArg);
  const threadRoot = FabriChatMessageRow({
    ...rowRecords,
    message: messages.key(2),
  } as RowArg);
  const threadDeleted = FabriChatMessageRow({
    ...rowRecords,
    message: messages.key(3),
  } as RowArg);
  const threadObliterated = FabriChatMessageRow({
    ...rowRecords,
    message: messages.key(4),
  } as RowArg);

  const continuing = FabriChatMessageRow({
    ...rowRecords,
    message: messages.key(5),
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Main deletion target"),
        trustedUi: sendGesture,
      },
      { action: action(() => clickButton(alice[UI], "Reply")) },
      {
        assertion: assert(() =>
          hasText(alice[UI], "Replying to: Main deletion target")
        ),
      },
      {
        action: mainDeleted.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        action: alice.composerSend,
        event: typed("Stale main quote"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          messages.get().length === 1 &&
          typeof (messages.get() as MessageRecord[])[0]?.body !== "string" &&
          hasText(alice[UI], "Replying to: This message was deleted.")
        ),
      },
      { action: action(() => clickInRow(alice[UI], "Replying to:", "Cancel")) },
      {
        action: alice.composerSend,
        event: typed("Main obliteration target"),
        trustedUi: sendGesture,
      },
      {
        action: action(() =>
          clickInRow(alice[UI], "Main obliteration target", "Reply")
        ),
      },
      {
        assertion: assert(() =>
          hasText(alice[UI], "Replying to: Main obliteration target")
        ),
      },
      {
        action: mainObliterated.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          typeof (messages.get() as MessageRecord[])[1]?.body !== "string"
        ),
      },
      {
        action: alice.composerSend,
        event: typed("Obliterated main quote"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          messages.get().length === 2 &&
          (messages.get() as MessageRecord[])[1]?.authorProfile === undefined
        ),
      },
      { action: action(() => clickInRow(alice[UI], "Replying to:", "Cancel")) },
      {
        action: alice.composerSend,
        event: typed("Thread root"),
        trustedUi: sendGesture,
      },
      {
        action: action(() => clickInRow(alice[UI], "Thread root", "Thread")),
      },
      {
        action: alice.threadComposerSend,
        event: typed("Thread deletion target"),
        trustedUi: sendGesture,
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-thread"),
            "Thread deletion target",
            "Reply",
          )
        ),
      },
      {
        assertion: assert(() =>
          hasText(
            findNodeById(alice[UI], "fabrichat-thread"),
            "Replying to: Thread deletion target",
          )
        ),
      },
      {
        action: threadDeleted.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        action: alice.threadComposerSend,
        event: typed("Stale thread quote"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          messages.get().length === 4 &&
          hasText(
            findNodeById(alice[UI], "fabrichat-thread"),
            "Replying to: This message was deleted.",
          )
        ),
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-thread"),
            "Replying to:",
            "Cancel",
          )
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("Thread obliteration target"),
        trustedUi: sendGesture,
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-thread"),
            "Thread obliteration target",
            "Reply",
          )
        ),
      },
      {
        action: threadObliterated.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        action: alice.threadComposerSend,
        event: typed("Obliterated thread quote"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          messages.get().length === 5 &&
          (messages.get() as MessageRecord[])[4]?.authorProfile === undefined
        ),
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-thread"),
            "Replying to:",
            "Cancel",
          )
        ),
      },
      {
        action: threadRoot.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      // Joining a thread and quoting its root are separate acts.
      {
        action: alice.threadComposerSend,
        event: typed("Continuing the thread"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const stored = messages.get() as MessageRecord[];
          return stored.length === 6 &&
            typeof stored[2]?.body !== "string" &&
            stored[5]?.body === "Continuing the thread" &&
            stored[5]?.replyTo?.quotes === undefined &&
            Writable.equalLinks(
              stored[5]?.replyTo?.thread,
              messages.key(2).resolveAsCell(),
            );
        }),
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-thread"),
            "Continuing the thread",
            "Reply",
          )
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("Live thread quote"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const stored = messages.get() as MessageRecord[];
          return stored.length === 7 &&
            stored[6]?.body === "Live thread quote" &&
            Writable.equalLinks(
              stored[6]?.replyTo?.thread,
              messages.key(2).resolveAsCell(),
            ) &&
            Writable.equalLinks(
              stored[6]?.replyTo?.quotes,
              messages.key(5).resolveAsCell(),
            );
        }),
      },
      // Row-bound send controls enforce the same quote rules, even when
      // their target disappears after a control was obtained.
      {
        action: mainDeleted.replyInMain,
        event: typed("Deleted row quote"),
        trustedUi: sendGesture,
      },
      {
        action: mainObliterated.replyInThread,
        event: typed("Obliterated root quote"),
        trustedUi: sendGesture,
      },
      {
        action: threadObliterated.replyInBoth,
        event: typed("Obliterated thread row quote"),
        trustedUi: sendGesture,
      },
      {
        action: continuing.replyInMain,
        event: typed("Thread-only quote in main"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => messages.get().length === 7) },
      {
        action: continuing.replyInBoth,
        event: typed("Live quote in both"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const stored = messages.get() as MessageRecord[];
          return stored.length === 8 &&
            stored[7]?.replyTo?.shownIn === "both" &&
            Writable.equalLinks(
              stored[7]?.replyTo?.quotes,
              messages.key(5).resolveAsCell(),
            );
        }),
      },
      // The raw stream leaves quote liveness to its client. Composer checks
      // must not silently alter that separate public contract.
      {
        action: alice.sendMessage,
        event: {
          body: "Raw client quote",
          replyTo: { quotes: messageOf(messages.key(0)), shownIn: "main" },
        },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const stored = messages.get() as MessageRecord[];
          return stored.length === 9 &&
            stored[8]?.body === "Raw client quote" &&
            Writable.equalLinks(
              stored[8]?.replyTo?.quotes,
              messages.key(0).resolveAsCell(),
            );
        }),
      },
    ],
    expectRuntimeErrors: [
      "That message was deleted.",
      "That message was deleted.",
      "That message was deleted.",
      "That message was deleted.",
      "That message was deleted.",
      "That message was deleted.",
      "That message was deleted.",
      "A reply in the conversation can quote only a message shown there.",
    ],
  };
});
