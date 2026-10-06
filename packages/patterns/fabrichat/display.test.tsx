/**
 * A room's elements shown or hidden by a prop start out hidden: each carries
 * a static `hidden`, so it stays out of view while its display computed has
 * no value, and that computed shows it once it has one, with a concrete
 * display.
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
  findNode,
  findNodeByProp,
  hasText,
  isButton,
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
import {
  CHAT_EDIT_SURFACE,
  CHAT_REACT_SURFACE,
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

/** What `node` has as its display, as its `style` names it. */
const displayOf = (node: unknown) =>
  readValue(
    (propValue(node, "style") as { display?: unknown } | undefined)?.display,
  );

/**
 * The display of the first node under `root` that `accept` admits and that
 * carries `hidden`; `missing` when there is none.
 */
const hiddenNodeDisplay = (
  root: unknown,
  accept: (node: unknown) => boolean,
) => {
  const node = findNode(
    root,
    (each) => propValue(each, "hidden") === true && accept(each),
  );
  return node === undefined ? "missing" : displayOf(node);
};

/** The first message's edit form under `root`, the main conversation's. */
const editForm = (root: unknown) =>
  findNodeByProp(root, "data-ui-pattern", CHAT_EDIT_SURFACE);

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const },
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          propValue(editForm(alice[UI]), "hidden") === true
        ),
      },
      { assertion: assert(() => displayOf(editForm(alice[UI])) === "none") },
      // The message's row, in the main conversation.
      {
        assertion: assert(() =>
          hiddenNodeDisplay(alice[UI], (node) => hasText(node, "Hello")) ===
            "block"
        ),
      },
      // The viewer's own message offers its edit control.
      {
        assertion: assert(() =>
          hiddenNodeDisplay(alice[UI], isButton("Edit")) === "inline-flex"
        ),
      },
      { action: action(() => clickButton(alice[UI], "Reply")) },
      {
        assertion: assert(() =>
          hiddenNodeDisplay(
            alice[UI],
            (node) => hasText(node, "Replying to:"),
          ) === "flex"
        ),
      },
      { action: action(() => clickButton(alice[UI], "☺+")) },
      {
        assertion: assert(() =>
          hiddenNodeDisplay(
            alice[UI],
            (node) => propValue(node, "data-ui-pattern") === CHAT_REACT_SURFACE,
          ) === "flex"
        ),
      },
      { action: action(() => clickButton(alice[UI], "Thread")) },
      {
        assertion: assert(() =>
          hiddenNodeDisplay(
            alice[UI],
            (node) => propValue(node, "id") === "fabrichat-thread",
          ) === "flex"
        ),
      },
      { action: action(() => clickButton(alice[UI], "Edit")) },
      { assertion: assert(() => displayOf(editForm(alice[UI])) === "block") },
    ],
  };
});
