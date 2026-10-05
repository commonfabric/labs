/**
 * A message's edit form starts out hidden: it carries a static `hidden`, so
 * it stays out of view while its display computed has no value, and that
 * computed alone shows it once it has one.
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
  findNodeByProp,
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

/** The first message's edit form under `root`, the main conversation's. */
const editForm = (root: unknown) =>
  findNodeByProp(root, "data-ui-pattern", CHAT_EDIT_SURFACE);

/** What the first message's edit form under `root` has as its display. */
const editFormDisplay = (root: unknown) =>
  readValue(
    (propValue(editForm(root), "style") as { display?: unknown } | undefined)
      ?.display,
  );

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
      { assertion: assert(() => editFormDisplay(alice[UI]) === "none") },
      { action: action(() => clickButton(alice[UI], "Edit")) },
      { assertion: assert(() => editFormDisplay(alice[UI]) === "block") },
    ],
  };
});
