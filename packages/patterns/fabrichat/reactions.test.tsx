/**
 * Reactions in a FabriChat room: what a reaction stores, that adding or
 * removing one is idempotent rather than a toggle, which reactions are
 * refused, how a message tallies its own, and that deleting a message takes
 * its reactions with it. A refused reaction's run fails with its reason, and
 * the test requires exactly those, each by its reason.
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
import { FabriChatMessageRow, type ReactionTally } from "./message-row.tsx";
import {
  type ComposerState,
  type MessageRecord,
  type MessagesValue,
  type ReactionsValue,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_UNREACT_ACTION,
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
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
const unreactGesture = {
  surface: CHAT_REACT_SURFACE,
  action: CHAT_UNREACT_ACTION,
};
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

// A row's tallies, as `emoji count` with a `*` on the viewer's own, so that an
// assertion's failure shows the whole row.
const talliesText = (tallies: readonly ReactionTally[]): string =>
  tallies.map((tally) =>
    `${tally.emoji} ${tally.count}${tally.mine ? "*" : ""}`
  ).join(", ");

const reactionsOn = (
  messages: Cell<MessagesValue>,
  index: number,
): ChatReaction[] => {
  const message = (messages.get() as MessageRecord[])[index];
  return (message?.reactions?.get() ?? []) as ChatReaction[];
};

// How many reactions a held reaction list holds.
const heldCount = (
  holder: Cell<{ list?: Writable<ReactionsValue> }>,
): number => ((holder.get()?.list?.get() ?? []) as unknown[]).length;

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  // The first message's reaction list, held apart from the message, whose link
  // to it a deletion drops.
  const firstReactions = Writable.of<{ list?: Writable<ReactionsValue> }>({});
  const action_hold_first_reactions = action(() =>
    firstReactions.key("list").set(
      messages.key(0).key("reactions").resolveAsCell(),
    )
  );
  const records = {
    about: { kind: "group" as const },
    messages,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const rowRecords = {
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  };
  const aliceOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  const bobOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);
  const aliceOnSecond = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: typed("First"),
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: typed("Second"),
        trustedUi: sendGesture,
      },
      // Any single emoji is a reaction; text, and two emoji together, are not.
      {
        action: aliceOnFirst.sendReaction,
        event: { emoji: "👍🏽" },
        trustedUi: reactGesture,
      },
      {
        action: aliceOnFirst.sendReaction,
        event: { emoji: "cat" },
        trustedUi: reactGesture,
      },
      {
        action: aliceOnFirst.sendReaction,
        event: { emoji: "😺😺" },
        trustedUi: reactGesture,
      },
      {
        action: bobOnFirst.sendReaction,
        event: { emoji: "👍🏽" },
        trustedUi: reactGesture,
      },
      {
        action: bobOnFirst.sendReaction,
        event: { emoji: "🎉" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          talliesText(aliceOnFirst.tallies) === "👍🏽 2*, 🎉 1"
        ),
      },
      {
        assertion: assert(() =>
          talliesText(bobOnFirst.tallies) === "👍🏽 2*, 🎉 1*"
        ),
      },
      // Adding one already there changes nothing, even under a new request.
      {
        action: bobOnFirst.sendReaction,
        event: { emoji: "🎉" },
        trustedUi: reactGesture,
      },
      { assertion: assert(() => reactionsOn(messages, 0).length === 3) },
      // Removing is by the reaction's cell, and never a toggle: removing the
      // same cell twice leaves it removed, the second time removing nothing.
      {
        action: bobOnFirst.deleteReaction,
        event: { reaction: messages.key(0).key("reactions").key(2) },
        trustedUi: unreactGesture,
      },
      {
        action: bobOnFirst.deleteReaction,
        event: { reaction: messages.key(0).key("reactions").key(2) },
        trustedUi: unreactGesture,
      },
      {
        assertion: assert(() => talliesText(bobOnFirst.tallies) === "👍🏽 2*"),
      },
      // A reaction on one message leaves the other's alone.
      {
        action: aliceOnSecond.sendReaction,
        event: { emoji: "😂" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          reactionsOn(messages, 1).length === 1 &&
          reactionsOn(messages, 0).length === 2
        ),
      },
      // Deleting a message drops its link to its reactions, so the room
      // shows none and the deleted message takes no new ones; the list itself
      // outlives the link.
      { action: action_hold_first_reactions },
      {
        assertion: assert(() => heldCount(firstReactions) === 2),
      },
      {
        action: aliceOnFirst.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        action: bobOnFirst.sendReaction,
        event: { emoji: "😢" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          reactionsOn(messages, 0).length === 0 &&
          heldCount(firstReactions) === 2 &&
          aliceOnFirst.tallies.length === 0
        ),
      },
    ],
    expectRuntimeErrors: [
      // Text, and two emoji together.
      "A reaction is a single emoji.",
      "A reaction is a single emoji.",
      // A reaction on the deleted message.
      "That message was deleted.",
    ],
  };
});
