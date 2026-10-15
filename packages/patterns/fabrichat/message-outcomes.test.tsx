/**
 * The outcome a FabriChat room records for each of its sender's message acts,
 * by `requestId`, in the sender's own `messageRequests`: `done` for an act that
 * took effect, and `refused` with a reason and a code for one that broke the
 * stream's rules, which writes nothing else. The composer shows the session's
 * latest refusal until an act takes effect. A viewer whose profile doesn't
 * resolve, as `#profile` resolves none where Home lists no profile, has each
 * send refused as `no-profile`.
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
  findNodeById,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import {
  type ActivityCounters,
  type MessageRecord,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
import FabriChatRoom, { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  epochNsec,
  type MessageActOutcome,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type FullRoomArg = Parameters<typeof FabriChatRoom>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};

const typed = (text: string, requestId: string) => ({
  type: "click",
  requestId,
  target: { value: text },
});

/** The outcome `outcomes` records under `id`, as `status/code`. */
const outcomeOf = (
  outcomes: Record<string, MessageActOutcome> | undefined,
  id: string,
): string => {
  const outcome = outcomes?.[id];
  return outcome === undefined
    ? "none"
    : outcome.status === "refused"
    ? `refused/${outcome.code}`
    : outcome.status;
};

/** What the room's composer shows of the session's latest refusal. */
const shownRefusal = (root: unknown): string => {
  const node = findNodeById(root, "fabrichat-act-refusal");
  const display = readValue(
    (propValue(node, "style") as { display?: unknown })?.display,
  );
  return display === "none" ? "" : textContent(node).trim();
};

/** A message of a room's records, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

/** A room's records, with none of them holding anything yet. */
const freshRecords = () => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
  requests: Writable.of<RequestMemo[]>([]),
  usedTimes: Writable.of<UsedTime[]>([]),
  activity: Writable.of<SentActivity[]>([]),
  counters: Writable.of<ActivityCounters[]>([]),
});

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile | undefined>({
    name: "Alice",
  });
  const records = freshRecords();
  const about = { kind: "group" as const, title: "Team" };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, about, ...records } as RoomArg,
  );
  // The same room, to a viewer whose profile hasn't resolved.
  const unresolved = FabriChatRoomCore({
    myProfile: Writable.of<TestProfile | undefined>(undefined),
    about,
    ...records,
  } as RoomArg);
  // A room whose viewer's `#profile` resolves none, as where Home's
  // `profiles` is empty: a space's own chat, which needs no `about`.
  const homeless = FabriChatRoom({ ...freshRecords() } as FullRoomArg);

  const action_send_too_old = action(() =>
    alice.sendMessage.send({
      requestId: "s-old",
      version: { body: "Late", sentAt: epochNsec(1n) },
    })
  );
  const action_edit_foreign = action(() =>
    alice.editMessage.send({
      requestId: "e-foreign",
      message: Writable.of<MessageRecord>(
        { body: "Not here", sentAt: epochNsec(0n), earlierVersions: [] },
      ),
      target: { value: "Changed" },
    })
  );
  const action_edit_deleted = action(() =>
    alice.editMessage.send({
      requestId: "e-deleted",
      message: messageOf(records.messages.key(0)),
      target: { value: "Never mind" },
    })
  );

  const action_lose_profile = action(() => aliceProfile.set(undefined));

  return {
    [TESTS]: [
      // A send that takes effect is done, and the composer shows nothing.
      {
        action: alice.sendMessage,
        event: typed("Hello", "s-1"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "s-1") === "done" &&
          records.messages.get().length === 1 &&
          shownRefusal(alice[UI]) === ""
        ),
      },
      // A message with no text is refused, writes nothing, and the composer
      // says why.
      {
        action: alice.sendMessage,
        event: typed("   ", "s-blank"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "s-blank") ===
            "refused/invalid-body" &&
          records.messages.get().length === 1 &&
          shownRefusal(alice[UI]) === "A message needs some text."
        ),
      },
      // A refused request remains terminal when redelivered with valid text.
      {
        action: alice.sendMessage,
        event: typed("A replacement payload", "s-blank"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "s-blank") ===
            "refused/invalid-body" &&
          records.messages.get().length === 1
        ),
      },
      // An act that takes effect clears what the composer shows.
      {
        action: alice.sendMessage,
        event: typed("Again", "s-2"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => shownRefusal(alice[UI]) === "") },
      // A time outside the room's window is refused.
      { action: action_send_too_old },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "s-old") === "refused/out-of-window"
        ),
      },
      // Editing a message outside the room names no target. Distinct-actor
      // refusals are exercised in `actor-ownership.test.tsx`.
      { action: action_edit_foreign },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "e-foreign") ===
            "refused/unknown-target" &&
          (records.messages.get() as MessageRecord[])[0]?.body === "Hello"
        ),
      },
      // A reaction that isn't a single emoji has no valid body.
      {
        action: alice.sendReaction,
        event: {
          requestId: "r-cat",
          emoji: "cat",
          message: messageOf(records.messages.key(0)),
        },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "r-cat") === "refused/invalid-body"
        ),
      },
      // Editing a deleted message targets a deleted message.
      {
        action: alice.deleteMessage,
        event: {
          requestId: "d-first",
          message: messageOf(records.messages.key(0)),
        },
        trustedUi: deleteGesture,
      },
      { action: action_edit_deleted },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "d-first") === "done" &&
          outcomeOf(alice.messageRequests, "e-deleted") ===
            "refused/deleted-target"
        ),
      },
      // A replay of a send that took effect keeps its outcome, even arriving
      // once the sender's profile no longer resolves, and leaves what the
      // composer shows as it was.
      { action: action_lose_profile },
      {
        action: alice.sendMessage,
        event: typed("Hello", "s-1"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(alice.messageRequests, "s-1") === "done" &&
          shownRefusal(alice[UI]) === "That message was deleted."
        ),
      },
      // A viewer whose profile hasn't resolved can't send.
      {
        action: unresolved.sendMessage,
        event: typed("Anyone?", "s-unresolved"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(unresolved.messageRequests, "s-unresolved") ===
            "refused/no-profile"
        ),
      },
      // Nor can a viewer whose `#profile` resolves none, as where Home lists
      // no profile: the send records why, rather than vanishing.
      {
        action: homeless.sendMessage,
        event: typed("Is this thing on?", "s-homeless"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(homeless.messageRequests, "s-homeless") ===
            "refused/no-profile" &&
          homeless.messages.count === 0
        ),
      },
    ],
  };
});
