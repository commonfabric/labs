/**
 * A FabriChat group room, as its space's access list decides who may do what
 * in it: its OWNER obliterates anyone's messages, as a group room's policy
 * lets OWNERs, but deletes no one else's; a member with WRITE sends but can't
 * delete or obliterate someone else's; a reader with READ is offered no way to
 * write; and someone the list leaves out sees a placement of the room as not
 * theirs. Who is in the space is the space's business, not the room's. Each
 * act the room refuses fails its run with a reason, and each participant
 * requires exactly its own refusals, each by its reason.
 *
 * The test lane doesn't enforce the list, so what this checks is what the room
 * decides from the level `spaceAccess()` reports, not what the memory server
 * would refuse.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import { findNodeByProp, propValue, readValue } from "../test/vnode-helpers.ts";
import FabriChatPlacement from "./placement.tsx";
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
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];
type PlacementArg = Parameters<typeof FabriChatPlacement>[0];

// A labeled stand-in for a viewer's `#profile`.
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

/** The room's records, which every participant's room shares. */
interface Records {
  messages: Writable<MessagesValue>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;
}

// The messages' bodies, or how each was taken away, in the order they were
// recorded.
const bodies = (messages: Cell<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string"
      ? message.body
      : message?.authorProfile === undefined
      ? "<obliterated>"
      : "<deleted>"
  ).join(" | ");

// Whether the reaction field of a room's first message row, one of the row's
// write controls, is disabled.
const reactingDisabled = (room: unknown): unknown =>
  propValue(findNodeByProp(room, "placeholder", "Any emoji"), "disabled");

// The display of a message row's editor.
const editorDisplay = (row: unknown): unknown =>
  readValue(
    (propValue(
      findNodeByProp(row, "data-ui-pattern", CHAT_EDIT_SURFACE),
      "style",
    ) as { display?: unknown })?.display,
  );

// Whether a room's main composer is disabled.
const composerDisabled = (room: unknown): unknown =>
  propValue(findNodeByProp(room, "inputId", "fabrichat-message"), "disabled");

/** A message of the shared records, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

/** What makes the shared room a group room of its own. */
const groupRoom = {
  about: { kind: "group" as const, title: "Team" },
};

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
  },
}));

// The OWNER: the first participant.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const records = {
    messages: setup.records.messages,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );

  return {
    [TESTS]: [
      {
        action: room.composerSend,
        event: typed("From Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-sent" },
      { await: "bob-tried" },
      // Bob, with WRITE, couldn't delete or obliterate her message.
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "From Alice | From Bob | Bob again"
        ),
      },
      // An OWNER may not delete someone else's message.
      {
        action: room.deleteMessage,
        event: {
          message: messageOf(setup.records.messages.key(1)),
        },
        trustedUi: deleteGesture,
      },
      {
        assertion: assert(() => {
          return bodies(setup.records.messages) ===
            "From Alice | From Bob | Bob again";
        }),
      },
      // An OWNER may obliterate anyone's message in a group room, whose
      // policy lets its OWNERs obliterate.
      {
        assertion: assert(() =>
          room.about.policy.get()?.ownersMayObliterate === true
        ),
      },
      {
        action: room.obliterateMessage,
        event: {
          message: messageOf(setup.records.messages.key(1)),
        },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "From Alice | <obliterated> | Bob again"
        ),
      },
      { assertion: assert(() => room.canSend === true) },
      { label: "alice-done" },
    ],
    // Her refused deletion of someone else's message.
    expectRuntimeErrors: ["Only its author can delete a message."],
  };
});

// A member with WRITE, the default.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    messages: setup.records.messages,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const onAlices = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    // The group room's policy, as the room binds its rows to it, so that what
    // refuses his obliteration is his access rather than a missing policy.
    ownersMayObliterate: true,
    composer: Writable.of({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  } as RowArg);
  const composer = Writable.of<ComposerState>({});
  const onHis = FabriChatMessageRow({
    message: setup.records.messages.key(1),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    composer,
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  } as RowArg);
  const action_start_edit = action(() =>
    composer.key("editing").set(setup.records.messages.key(1))
  );

  return {
    [TESTS]: [
      { await: "alice-sent" },
      {
        assertion: assert(() =>
          room.canSend === true && composerDisabled(room[UI]) === false &&
          reactingDisabled(room[UI]) === false
        ),
      },
      {
        action: room.composerSend,
        event: typed("From Bob"),
        trustedUi: sendGesture,
      },
      {
        action: room.composerSend,
        event: typed("Bob again"),
        trustedUi: sendGesture,
      },
      {
        action: onAlices.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        action: onAlices.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        action: room.deleteMessage,
        event: {
          message: messageOf(setup.records.messages.key(0)),
        },
        trustedUi: deleteGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "From Alice | From Bob | Bob again"
        ),
      },
      // He opens the editor on his own message.
      { action: action_start_edit },
      { assertion: assert(() => editorDisplay(onHis[UI]) === "block") },
      { label: "bob-tried" },
      { await: "alice-done" },
      // Alice obliterated it, so the editor no longer offers him an edit.
      { assertion: assert(() => editorDisplay(onHis[UI]) === "none") },
    ],
    // His refused deletion and obliteration of Alice's message on its row,
    // and his refused deletion of it through the room.
    expectRuntimeErrors: [
      "Only its author can delete a message.",
      "Only an owner of this chat can remove a message.",
      "Only its author can delete a message.",
    ],
  };
});

// A reader with READ, who can't send.
export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Carol" });
  const records = {
    messages: setup.records.messages,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );

  return {
    [TESTS]: [
      { await: "alice-sent" },
      // Carol's profile resolves, but her access is READ, so the room offers
      // her no way to write.
      {
        assertion: assert(() =>
          room.canSend === false && composerDisabled(room[UI]) === true &&
          reactingDisabled(room[UI]) === true
        ),
      },
    ],
  };
});

// Someone the access list leaves out, looking at a placement of the room.
export const stranger = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Stranger" });
  const records = {
    messages: setup.records.messages,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const placement = FabriChatPlacement({ room } as PlacementArg);

  return {
    [TESTS]: [
      {
        assertion: assert(() => placement[VIEWS].chat.state === "not-member"),
      },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    carol: { pattern: carol, access: "READ" },
    stranger: { pattern: stranger, access: "none" },
  },
});
