/**
 * One FabriChat room instance viewed by two people, each in a runtime of
 * their own: the thread each session opens is its own, and so are the rows the
 * thread panel holds for it.
 */
import {
  action,
  type AddIntegrity,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickInRow,
  countElements,
  findNodeById,
  hasText,
} from "../test/vnode-helpers.ts";
import { type MessagesValue } from "./room-records.tsx";
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

// How many message rows the element `id` under `root` holds, shown or hidden:
// each row is one `cf-hover-reveal`.
const rowsIn = (root: unknown, id: string): number =>
  countElements(findNodeById(root, id), "cf-hover-reveal");

// Whether the thread panel under `root` holds `text`.
const threadHas = (root: unknown, text: string): boolean =>
  hasText(findNodeById(root, "fabrichat-thread"), text);

// One room instance over the records, which both sessions view. It has no
// viewer's profile, and opening a thread needs none; each person sends through
// a core of their own over the same records.
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
      {
        action: room.composerSend,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      {
        action: room.composerSend,
        event: typed("Other"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          rowsIn(setup.shared[UI], "fabrichat-messages") === 2
        ),
      },
      { action: action(() => clickInRow(setup.shared[UI], "Hello", "Thread")) },
      {
        assertion: assert(() =>
          rowsIn(setup.shared[UI], "fabrichat-thread") === 1
        ),
      },
      {
        assertion: assert(() => threadHas(setup.shared[UI], "Hello") === true),
      },
      { label: "alice-opened" },
      { await: "bob-opened" },
      // The thread Bob's session opened leaves Alice's panel as it was.
      {
        assertion: assert(() =>
          rowsIn(setup.shared[UI], "fabrichat-thread") === 1
        ),
      },
      {
        assertion: assert(() => threadHas(setup.shared[UI], "Hello") === true),
      },
      {
        assertion: assert(() => threadHas(setup.shared[UI], "Other") === false),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  return {
    [TESTS]: [
      { await: "alice-opened" },
      {
        assertion: assert(() =>
          rowsIn(setup.shared[UI], "fabrichat-messages") === 2
        ),
      },
      // The thread Alice's session opened holds no row in Bob's.
      {
        assertion: assert(() =>
          rowsIn(setup.shared[UI], "fabrichat-thread") === 0
        ),
      },
      { action: action(() => clickInRow(setup.shared[UI], "Other", "Thread")) },
      {
        assertion: assert(() =>
          rowsIn(setup.shared[UI], "fabrichat-thread") === 1
        ),
      },
      {
        assertion: assert(() => threadHas(setup.shared[UI], "Other") === true),
      },
      {
        assertion: assert(() => threadHas(setup.shared[UI], "Hello") === false),
      },
      { label: "bob-opened" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
