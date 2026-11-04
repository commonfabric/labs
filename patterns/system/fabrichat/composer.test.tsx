/**
 * A FabriChat room's own composers: the main composer's send, a reply it
 * composes, and the thread composer's reply in the open thread.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  findNodeById,
  findNodeByProp,
  hasText,
  propsOf,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
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

const typed = (text: string, revision?: string) => ({
  type: "click",
  target: { value: text, dataset: { draftRevision: revision } },
});

/** Resolves the draft reference as the renderer does for a bound input. */
const draftBinding = (root: unknown, inputId: string): unknown => {
  const input = findNodeByProp(root, "inputId", inputId);
  if (input === undefined) return undefined;
  const binding = propsOf(input)?.["$draft"];
  if (
    typeof binding !== "object" || binding === null ||
    !("resolveAsCell" in binding) || typeof binding.resolveAsCell !== "function"
  ) {
    throw new Error("The composer has no draft binding.");
  }
  return binding.resolveAsCell();
};

/** Writes the binding the main or thread input edits. */
const fillDraft = (
  root: unknown,
  inputId: string,
  value: string,
  revision: string,
): void => {
  const binding = draftBinding(root, inputId);
  if (
    typeof binding !== "object" || binding === null || !("set" in binding) ||
    typeof binding.set !== "function"
  ) throw new Error("The composer has no writable draft binding.");
  binding.set({ value, revision });
};

/** The text the main or thread input reads through its draft binding. */
const draftText = (root: unknown, inputId: string): unknown => {
  const draft = readValue(draftBinding(root, inputId));
  return typeof draft === "object" && draft !== null && "value" in draft
    ? draft.value
    : undefined;
};

// Each stored message, as `body@shownIn`.
const summary = (messages: Cell<MessagesValue>): string =>
  (messages.get() as MessageRecord[]).map((message) =>
    `${message?.body}@${message?.replyTo?.shownIn ?? "-"}`
  ).join(" | ");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const },
    messages,
  } as RoomArg);
  const pendingProfile = Writable.of<TestProfile | undefined>(undefined);
  const pending = FabriChatRoomCore({
    myProfile: pendingProfile,
    about: { kind: "group" as const },
    messages,
  } as RoomArg);
  const capturedThreadKey = Writable.of("");
  const staleThreadSend = action(() => {
    const event = {
      target: {
        value: "newer reply",
        dataset: {
          draftRevision: "next",
          threadKey: capturedThreadKey.get(),
        },
      },
    };
    alice.threadComposerSend.send(event);
  });

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => summary(messages) === "Hello@-") },
      // "Reply" on the message composes a reply to it in the conversation.
      { action: action(() => clickButton(alice[UI], "Reply")) },
      { assertion: assert(() => hasText(alice[UI], "Replying to: Hello")) },
      {
        action: alice.composerSend,
        event: typed("Quoting"),
        trustedUi: sendGesture,
      },
      // "Thread" opens the message's thread, where the thread composer
      // replies.
      { action: action(() => clickButton(alice[UI], "Thread")) },
      {
        assertion: assert(() =>
          (propsOf(
            findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
          )?.disabled as { schema?: { default?: unknown } } | undefined)?.schema
            ?.default === true
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("In the thread"),
        trustedUi: sendGesture,
      },
      // The reply once sent, the main composer composes none.
      {
        action: alice.composerSend,
        event: typed("Plain"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          summary(messages) ===
            "Hello@- | Quoting@main | In the thread@thread | Plain@-"
        ),
      },
      {
        action: action(() =>
          fillDraft(pending[UI], "fabrichat-message", "  retained  ", "first")
        ),
      },
      {
        action: pending.composerSend,
        event: typed("  retained  ", "first"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          messages.get().length === 4 &&
          draftText(pending[UI], "fabrichat-message") === "  retained  "
        ),
      },
      { action: action(() => pendingProfile.set({ name: "Alice" })) },
      {
        action: pending.composerSend,
        event: typed("  retained  ", "first"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          messages.get().length === 5 &&
          (messages.get() as MessageRecord[])[4]?.body === "  retained  " &&
          draftText(pending[UI], "fabrichat-message") === ""
        ),
      },
      {
        action: action(() =>
          fillDraft(alice[UI], "fabrichat-message", "newer text", "second")
        ),
      },
      {
        action: alice.composerSend,
        event: typed("submitted text", "first"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-message") === "newer text" &&
          (messages.get() as MessageRecord[])[5]?.body === "submitted text"
        ),
      },
      {
        action: action(() =>
          fillDraft(alice[UI], "fabrichat-message", "submitted text", "third")
        ),
      },
      {
        action: alice.composerSend,
        event: typed("submitted text", "first"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-message") === "submitted text" &&
          messages.get().length === 7
        ),
      },
      {
        action: action(() =>
          fillDraft(
            alice[UI],
            "fabrichat-thread-message",
            "  reply  ",
            "thread",
          )
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("  reply  ", "thread"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-thread-message") === "" &&
          draftText(alice[UI], "fabrichat-message") === "submitted text" &&
          (messages.get() as MessageRecord[])[7]?.body === "  reply  "
        ),
      },
      {
        action: action(() =>
          fillDraft(
            alice[UI],
            "fabrichat-thread-message",
            "newer reply",
            "next",
          )
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("  reply  ", "thread"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-thread-message") === "newer reply" &&
          draftText(alice[UI], "fabrichat-message") === "submitted text"
        ),
      },
      {
        action: action(() => {
          const key = propValue(
            findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
            "data-thread-key",
          );
          capturedThreadKey.set(typeof key === "string" ? key : "");
          clickInRow(
            findNodeById(alice[UI], "fabrichat-messages"),
            "Plain",
            "Thread",
          );
        }),
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-thread-message") === ""
        ),
      },
      {
        action: action(() =>
          fillDraft(
            alice[UI],
            "fabrichat-thread-message",
            "B draft",
            "thread-b",
          )
        ),
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-messages"),
            "Hello",
            "Thread",
          )
        ),
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-thread-message") === "newer reply"
        ),
      },
      {
        action: action(() =>
          clickButton(findNodeById(alice[UI], "fabrichat-thread"), "Close")
        ),
      },
      { action: staleThreadSend, trustedUi: sendGesture },
      { assertion: assert(() => messages.get().length === 9) },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-messages"),
            "Hello",
            "Thread",
          )
        ),
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-thread-message") === "newer reply"
        ),
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-messages"),
            "Plain",
            "Thread",
          )
        ),
      },
      { action: staleThreadSend, trustedUi: sendGesture },
      {
        assertion: assert(() =>
          messages.get().length === 9 &&
          draftText(alice[UI], "fabrichat-thread-message") === "B draft"
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("B draft", "thread-b"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-thread-message") === "" &&
          (messages.get() as MessageRecord[])[9]?.body === "B draft" &&
          equals(
            (messages.get() as MessageRecord[])[9]?.replyTo?.thread,
            messages.key(3),
          )
        ),
      },
      {
        action: action(() =>
          clickInRow(
            findNodeById(alice[UI], "fabrichat-messages"),
            "Hello",
            "Thread",
          )
        ),
      },
      {
        assertion: assert(() =>
          draftText(alice[UI], "fabrichat-thread-message") === "newer reply" &&
          draftText(alice[UI], "fabrichat-message") === "submitted text"
        ),
      },
    ],
    expectRuntimeErrors: [
      "Your profile hasn't loaded yet.",
      "The open thread changed. Reopen the thread before sending this draft.",
      "The open thread changed. Reopen the thread before sending this draft.",
    ],
  };
});
