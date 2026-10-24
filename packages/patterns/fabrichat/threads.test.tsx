/**
 * Where a room's rendering shows each message: which rows the main
 * conversation and the open thread show, the reply count a thread's root
 * carries, and which of a row's controls its sender and the room's OWNER are
 * offered.
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
  findNode,
  findNodeById,
  hasText,
  isButton,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { type MessagesValue } from "./room-records.tsx";
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

const typed = (text: string) => ({ type: "click", target: { value: text } });

const MAIN = "fabrichat-messages";
const THREAD = "fabrichat-thread";

/** What `node` has as its display, as its `style` names it. */
const displayOf = (node: unknown) =>
  readValue(
    (propValue(node, "style") as { display?: unknown } | undefined)?.display,
  );

/** Whether `node` is a message row, a `cf-hover-reveal`, showing `text`. */
const isRowShowing = (text: string) => (node: unknown): boolean => {
  const value = readValue(node) as { name?: unknown } | undefined;
  return readValue(value?.name) === "cf-hover-reveal" && hasText(node, text);
};

/** The row showing `text` in the list `id` under `root`. */
const rowIn = (root: unknown, id: string, text: string): unknown =>
  findNode(findNodeById(root, id), isRowShowing(text));

/**
 * Which of `texts` have a row in the list `id`, in their order: `row` for a
 * text the list holds a row for, `missing` for one it doesn't.
 */
const rowsIn = (
  root: unknown,
  id: string,
  texts: readonly string[],
): string =>
  texts.map((text) => rowIn(root, id, text) === undefined ? "missing" : "row")
    .join(" ");

/** The link to its thread that the main row showing `text` carries. */
const threadLink = (root: unknown, text: string): unknown =>
  findNode(
    rowIn(root, MAIN, text),
    (node) => propValue(node, "variant") === "link",
  );

/** A thread link's display, and its label where it is shown. */
const threadLinkText = (root: unknown, text: string): string => {
  const link = threadLink(root, text);
  const display = String(displayOf(link));
  return display === "none" ? display : `${display} ${textContent(link)}`;
};

/** The display of the control labelled `label` in the main row `text`. */
const controlDisplay = (root: unknown, text: string, label: string) =>
  displayOf(findNode(rowIn(root, MAIN, text), isButton(label)));

const ALL = ["Root", "Other", "First reply", "Second reply"];

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    about: { kind: "group" as const },
    messages,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Root"),
        trustedUi: sendGesture,
      },
      {
        action: bob.composerSend,
        event: typed("Other"),
        trustedUi: sendGesture,
      },
      // Both are in the main conversation, no thread is open, so the thread's
      // list holds no row, and neither roots one.
      {
        assertion: assert(() =>
          rowsIn(alice[UI], MAIN, ["Root", "Other"]) === "row row" &&
          rowsIn(alice[UI], THREAD, ["Root", "Other"]) ===
            "missing missing" &&
          threadLinkText(alice[UI], "Root") === "none" &&
          threadLinkText(alice[UI], "Other") === "none"
        ),
      },

      // A reply in the open thread has no row in the main conversation, and
      // its root counts it. The thread's list holds the thread's rows alone.
      { action: action(() => clickInRow(alice[UI], "Root", "Thread")) },
      {
        action: alice.threadComposerSend,
        event: typed("First reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          rowsIn(alice[UI], MAIN, ALL.slice(0, 3)) ===
            "row row missing" &&
          rowsIn(alice[UI], THREAD, ALL.slice(0, 3)) ===
            "row missing row" &&
          threadLinkText(alice[UI], "Root") === "inline-flex 1 reply" &&
          threadLinkText(alice[UI], "Other") === "none"
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("Second reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          rowsIn(alice[UI], THREAD, ALL) === "row missing row row" &&
          threadLinkText(alice[UI], "Root") === "inline-flex 2 replies"
        ),
      },
      // The room renders with the thread open, its rows among the rest.
      { render: alice[UI] },

      // The open thread is the session's: another viewer's stays closed, and
      // their main conversation shows the same rows and the same count.
      {
        assertion: assert(() =>
          rowsIn(bob[UI], THREAD, ALL) === "missing missing missing missing" &&
          rowsIn(bob[UI], MAIN, ALL) === "row row missing missing" &&
          threadLinkText(bob[UI], "Root") === "inline-flex 2 replies"
        ),
      },

      // Opening another message's thread shows that message alone, and
      // closing it shows none.
      { action: action(() => clickInRow(alice[UI], "Other", "Thread")) },
      {
        assertion: assert(() =>
          rowsIn(alice[UI], THREAD, ALL) === "missing row missing missing"
        ),
      },
      { action: action(() => clickButton(alice[UI], "Close")) },
      // A row offers its edit control to its sender alone, and its removal to
      // the room's OWNER, which this lane's user is.
      {
        assertion: assert(() =>
          rowsIn(alice[UI], THREAD, ALL) ===
            "missing missing missing missing" &&
          controlDisplay(alice[UI], "Root", "Edit") === "inline-flex" &&
          controlDisplay(alice[UI], "Other", "Edit") === "none" &&
          controlDisplay(alice[UI], "Other", "Remove entirely") ===
            "inline-flex"
        ),
      },
    ],
  };
});
