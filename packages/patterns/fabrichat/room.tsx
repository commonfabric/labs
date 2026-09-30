/**
 * Stores an attested conversation with exact times, request deduplication,
 * editable history, reactions, and session-owned message windows.
 */

import {
  action,
  type AuthenticatedActionWrite,
  type AuthoredByCurrentUser,
  type Cell,
  computed,
  currentPrincipal,
  type Default,
  entityRefToString,
  equals,
  eventKey,
  FabricEpochNsec,
  getEntityId,
  handler,
  isWellFormedDID,
  lift,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  setSpaceMembers,
  spaceAccess,
  spaceMembers,
  type Stream,
  type TrustedActionWrite,
  UI,
  viewerPrincipal,
  VIEWS,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import {
  CHAT_POLICY,
  conversationView,
  handlerTime,
  isMainMessage,
  isSingleEmoji,
  proposedTime,
  reserveTime,
  threadRoot,
} from "./records.ts";
import type {
  ChatIndexEntry,
  ChatManagerOutput,
  ChatMessage,
  ChatMessageWindow,
  ChatProfile,
  ChatReaction,
  ChatReactionTallies,
  ChatReply,
  ChatRoomAbout,
  ChatRoomActivity,
  ChatRoomOutput,
  ChatWindowAnchor,
  MessageRequest,
  OpenWindowRequest,
  SendMessageRequest,
} from "./schemas.ts";
import { selectWindow } from "./window.ts";

/** A message version admitted by one of the room's reviewed writers. */
export type StoredMessage = AuthoredByCurrentUser<
  WritePolicyAnyOf<ChatMessage, [
    TrustedActionWrite<
      unknown,
      typeof commitSend,
      "ChatSend",
      "ChatSendSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof sendMessageFromUi,
      "ChatSend",
      "ChatSendSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitEdit,
      "ChatEdit",
      "ChatEditSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof editMessageFromUi,
      "ChatEdit",
      "ChatEditSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDelete,
      "ChatDelete",
      "ChatDeleteSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof deleteMessageFromUi,
      "ChatDelete",
      "ChatDeleteSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitObliterate,
      "ChatObliterate",
      "ChatObliterateSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof obliterateMessageFromUi,
      "ChatObliterate",
      "ChatObliterateSurface"
    >,
  ]>
>;

/** A reaction's own label and reviewed writers, independent of its message. */
export type StoredReaction = AuthoredByCurrentUser<
  WritePolicyAnyOf<ChatReaction, [
    TrustedActionWrite<
      unknown,
      typeof commitSendReaction,
      "ChatReact",
      "ChatReactSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof sendReactionFromUi,
      "ChatReact",
      "ChatReactSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDeleteReaction,
      "ChatReact",
      "ChatReactSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof deleteReactionFromUi,
      "ChatReact",
      "ChatReactSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDelete,
      "ChatDelete",
      "ChatDeleteSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof deleteMessageFromUi,
      "ChatDelete",
      "ChatDeleteSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitObliterate,
      "ChatObliterate",
      "ChatObliterateSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof obliterateMessageFromUi,
      "ChatObliterate",
      "ChatObliterateSurface"
    >,
  ]>
>;

/** Bookkeeping kept across message obliteration and event redelivery. */
interface RoomMemory {
  requests: Record<string, boolean>;
  authors: Record<string, string>;
  usedTimes: Record<string, boolean>;
  nextSeq: number;
  expiredThrough: number;
  left: Record<string, boolean>;
  admissions: Record<string, number>;
  profiles: Record<string, Cell<ChatProfile>[]>;
  abandoned: boolean;
  notices: { id: string; recipient: string }[];
}

/** Bookkeeping writable only by the room's record writers. */
export type StoredMemory = WritePolicyAnyOf<RoomMemory, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof sendMessageFromUi>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof editMessageFromUi>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof deleteMessageFromUi>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof obliterateMessageFromUi>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof sendReactionFromUi>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
  WriteAuthorizedBy<unknown, typeof deleteReactionFromUi>,
  WriteAuthorizedBy<unknown, typeof commitShowProfile>,
  WriteAuthorizedBy<unknown, typeof commitLeave>,
  WriteAuthorizedBy<unknown, typeof commitAdd>,
  WriteAuthorizedBy<unknown, typeof addMemberFromUi>,
  WriteAuthorizedBy<unknown, typeof commitRemove>,
  WriteAuthorizedBy<unknown, typeof removeMemberFromUi>,
  WriteAuthorizedBy<unknown, typeof commitDelivered>,
]>;

/** Activity records retain the authenticated actor of their own event. */
export type StoredActivity = AuthoredByCurrentUser<
  WritePolicyAnyOf<ChatRoomActivity, [
    TrustedActionWrite<
      unknown,
      typeof commitSend,
      "ChatSend",
      "ChatSendSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof sendMessageFromUi,
      "ChatSend",
      "ChatSendSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitEdit,
      "ChatEdit",
      "ChatEditSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof editMessageFromUi,
      "ChatEdit",
      "ChatEditSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDelete,
      "ChatDelete",
      "ChatDeleteSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof deleteMessageFromUi,
      "ChatDelete",
      "ChatDeleteSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitObliterate,
      "ChatObliterate",
      "ChatObliterateSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof obliterateMessageFromUi,
      "ChatObliterate",
      "ChatObliterateSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitSendReaction,
      "ChatReact",
      "ChatReactSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof sendReactionFromUi,
      "ChatReact",
      "ChatReactSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDeleteReaction,
      "ChatReact",
      "ChatReactSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof deleteReactionFromUi,
      "ChatReact",
      "ChatReactSurface"
    >,
    AuthenticatedActionWrite<unknown, typeof commitShowProfile>,
    AuthenticatedActionWrite<unknown, typeof commitLeave>,
    TrustedActionWrite<
      unknown,
      typeof commitAdd,
      "ChatMembers",
      "ChatMembersSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof addMemberFromUi,
      "ChatMembers",
      "ChatMembersSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof commitRemove,
      "ChatMembers",
      "ChatMembersSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof removeMemberFromUi,
      "ChatMembers",
      "ChatMembersSurface"
    >,
  ]>
>;

/** Roster contributions may be added by their actor and removed on departure. */
type StoredRoster = WritePolicyAnyOf<Cell<ChatProfile>[], [
  WriteAuthorizedBy<unknown, typeof commitAdd>,
  WriteAuthorizedBy<unknown, typeof addMemberFromUi>,
  WriteAuthorizedBy<unknown, typeof commitShowProfile>,
  WriteAuthorizedBy<unknown, typeof commitLeave>,
  WriteAuthorizedBy<unknown, typeof commitRemove>,
  WriteAuthorizedBy<unknown, typeof removeMemberFromUi>,
]>;

/** The internal writer bindings; identity is read at execution time. */
interface RoomWriterState {
  dedicated: boolean;
  initialMembers: readonly string[];
  myProfile?: Cell<ChatProfile>;
  records: Writable<ChatMessage[]>;
  memory: Writable<RoomMemory>;
  activity: Writable<ChatRoomActivity[]>;
  roster: Writable<Cell<ChatProfile>[]>;
  about: Cell<ChatRoomAbout>;
  uiMessage?: Cell<ChatMessage>;
  uiEmoji?: string;
  uiPrincipal?: string;
  uiAccess?: Writable<"WRITE" | "OWNER">;
  uiReply?: Writable<ChatReply | null>;
  uiDraft?: Writable<string>;
  uiThread?: Writable<{ root?: Cell<ChatMessage>; before?: FabricEpochNsec }>;
}

/** The text captured by a reviewed submit control at the gesture. */
interface TextGesture {
  target?: { value?: string };
}

/** Captures the text and time of a reviewed submit gesture. */
function uiVersion(
  event: TextGesture,
): SendMessageRequest["version"] | undefined {
  return typeof event.target?.value === "string"
    ? { body: event.target.value, sentAt: new FabricEpochNsec(handlerTime()) }
    : undefined;
}

/** Resolves the message visibly bound to a reviewed control. */
function messageRequest(
  input: MessageRequest | TextGesture,
  state: RoomWriterState,
): MessageRequest | undefined {
  return "requestId" in input
    ? input
    : state.uiMessage
    ? { requestId: eventKey(), message: state.uiMessage }
    : undefined;
}

/** Returns a stable record key for a resolved entity. */
function entityKey(cell: Cell<unknown>): string | undefined {
  const ref = getEntityId(cell.resolveAsCell());
  return ref === undefined ? undefined : entityRefToString(ref);
}

/** Returns the authenticated sender's unspent request key. */
function requestKey(
  requestId: string,
  state: RoomWriterState,
): string | undefined {
  const principal = currentPrincipal();
  if (
    !principal || !state.about.get() || state.memory.key("abandoned").get() ||
    typeof requestId !== "string" || !requestId.trim()
  ) {
    return undefined;
  }
  const key = JSON.stringify([principal, requestId]);
  return state.memory.key("requests").key(key).get() ? undefined : key;
}

/** Finds the room-owned handle to an event's message. */
function messageIndex(
  message: Cell<ChatMessage>,
  state: RoomWriterState,
): number {
  return message
    ? state.records.get().findIndex((entry) => equals(entry, message))
    : -1;
}

/** Returns whether the actor sent the message, independently of profile selection. */
function isSender(message: Cell<ChatMessage>, state: RoomWriterState): boolean {
  const key = entityKey(message);
  return key !== undefined &&
    state.memory.key("authors").key(key).get() === currentPrincipal();
}

/** Appends activity and advances the expiration watermark in the writer's transaction. */
function recordActivity(
  state: RoomWriterState,
  requestId: string,
  what: Cell<ChatMessage> | Cell<Cell<ChatProfile>[]>,
  at: ChatRoomActivity["at"],
  now: bigint,
  obliterated?: Cell<ChatMessage>,
): void {
  const expired = state.activity.get().filter((entry) =>
    entry.at.value < now - CHAT_POLICY.recentActivityWindowNsec.value
  );
  const watermark = expired.reduce(
    (highest, entry) => Math.max(highest, entry.seq),
    state.memory.key("expiredThrough").get() ?? 0,
  );
  state.memory.key("expiredThrough").set(watermark);
  const seq = state.memory.key("nextSeq").get() ?? 1;
  state.memory.key("nextSeq").set(seq + 1);
  state.activity.set(
    state.activity.get().filter((entry) =>
      entry.at.value >= now - CHAT_POLICY.recentActivityWindowNsec.value &&
      (!obliterated || !equals(entry.what, obliterated))
    ),
  );
  const activity = new Writable<StoredActivity>();
  activity.set({ seq, at, requestId, what });
  state.activity.push(activity);
}

/** Records a new message from the authenticated sender, preserving its exact text. */
function writeSend(
  input: (SendMessageRequest) | TextGesture,
  state: RoomWriterState,
): void {
  const version = "requestId" in input ? input.version : uiVersion(input);
  if (!version) return;
  const event: SendMessageRequest = "requestId" in input ? input : {
    requestId: eventKey(),
    version,
    replyTo: state.uiReply?.get() ??
      (state.uiThread?.get().root?.get() !== undefined
        ? { message: state.uiThread.get().root!, shownIn: "thread" }
        : undefined),
  };
  const key = requestKey(event.requestId, state);
  const profile = state.myProfile?.resolveAsCell();
  if (
    !key || profile?.get() === undefined ||
    typeof event.version?.body !== "string" || !event.version.body.trim()
  ) return;
  const now = handlerTime();
  const proposed = proposedTime(event.version.sentAt, now);
  if (proposed === undefined) return;
  const targetIndex = event.replyTo
    ? messageIndex(event.replyTo.message, state)
    : -1;
  if (event.replyTo && targetIndex < 0) return;
  const target = targetIndex < 0
    ? undefined
    : state.records.key(targetIndex).resolveAsCell();
  if (
    event.replyTo && (!target || typeof target.get().body !== "string" ||
      !["main", "thread", "both"].includes(event.replyTo.shownIn) ||
      (event.replyTo.shownIn === "main" && !isMainMessage(target.get())))
  ) return;
  const floor = target && proposed <= target.get().sentAt.value
    ? target.get().sentAt.value + 1n
    : proposed;
  const used = state.memory.key("usedTimes");
  const sentAt = reserveTime(used, floor, now);
  const at = reserveTime(used, now, now);
  if (!sentAt || !at) return;
  const reactions = new Writable<StoredReaction[]>([]);
  const message = new Writable<StoredMessage>();
  message.set({
    authorProfile: profile,
    body: event.version.body,
    sentAt,
    earlierVersions: [],
    ...(event.replyTo
      ? { replyTo: { message: target!, shownIn: event.replyTo.shownIn } }
      : {}),
    reactions: [],
  });
  message.key("reactions").set(reactions);
  state.records.addUnique(message);
  const id = entityKey(message);
  if (id === undefined) {
    throw new Error("A stored chat message must have an entity.");
  }
  state.memory.key("authors").key(id).set(currentPrincipal()!);
  state.memory.key("requests").key(key).set(true);
  recordActivity(state, event.requestId, message, at, now);
  if (state.uiDraft?.get() === event.version.body) state.uiDraft.set("");
  state.uiReply?.set(null);
}

/** Binds the protocol event directly to its verified writer. */
export const commitSend = handler<SendMessageRequest, RoomWriterState>((
  event,
  state,
) => writeSend(event, state));

/** Binds the reviewed DOM event to the same room operation. */
const sendMessageFromUi = handler<TextGesture, RoomWriterState>((
  event,
  state,
) => writeSend(event, state));

/** Records a new version while retaining the sender's profile and original position. */
function writeEdit(
  input:
    | (MessageRequest & { version: SendMessageRequest["version"] })
    | TextGesture,
  state: RoomWriterState,
): void {
  const request = messageRequest(input, state);
  const version = "requestId" in input ? input.version : uiVersion(input);
  if (!request || !version) return;
  const event = { ...request, version };
  const key = requestKey(event.requestId, state);
  const index = messageIndex(event.message, state);
  if (index < 0) return;
  const message = state.records.key(index).resolveAsCell();
  if (
    !key || !message || !isSender(message, state) ||
    state.myProfile?.get() === undefined ||
    typeof message.get().body !== "string" ||
    typeof event.version?.body !== "string" || !event.version.body.trim()
  ) return;
  const now = handlerTime();
  const proposed = proposedTime(event.version.sentAt, now);
  if (proposed === undefined) return;
  const editedAt = reserveTime(state.memory.key("usedTimes"), proposed, now);
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!editedAt || !at) return;
  const previous = message.get();
  message.key("earlierVersions").push({
    body: previous.body as string,
    sentAt: previous.editedAt ?? previous.sentAt,
  });
  message.key("body").set(event.version.body);
  message.key("editedAt").set(editedAt);
  state.memory.key("requests").key(key).set(true);
  recordActivity(state, event.requestId, message, at, now);
}

/** Binds the protocol event directly to its verified writer. */
export const commitEdit = handler<
  MessageRequest & { version: SendMessageRequest["version"] },
  RoomWriterState
>((event, state) => writeEdit(event, state));

/** Binds the reviewed DOM event to the same room operation. */
const editMessageFromUi = handler<TextGesture, RoomWriterState>((
  event,
  state,
) => writeEdit(event, state));

/** Records the sender's deletion, keeping the version it replaced. */
function writeDelete(
  input: (MessageRequest) | TextGesture,
  state: RoomWriterState,
): void {
  const event = messageRequest(input, state);
  if (!event) return;
  const key = requestKey(event.requestId, state);
  const index = messageIndex(event.message, state);
  if (index < 0) return;
  const message = state.records.key(index).resolveAsCell();
  if (
    !key || !message || !isSender(message, state) ||
    typeof message.get().body !== "string"
  ) return;
  removeMessage(event, state, key, message, false);
}

/** Binds the protocol event directly to its verified writer. */
export const commitDelete = handler<MessageRequest, RoomWriterState>((
  event,
  state,
) => writeDelete(event, state));

/** Binds the reviewed DOM event to the same room operation. */
const deleteMessageFromUi = handler<TextGesture, RoomWriterState>((
  event,
  state,
) => writeDelete(event, state));

/** Obliterates an owned direct message or a group message curated by an owner. */
function writeObliterate(
  input: (MessageRequest) | TextGesture,
  state: RoomWriterState,
): void {
  const event = messageRequest(input, state);
  if (!event) return;
  const key = requestKey(event.requestId, state);
  const index = messageIndex(event.message, state);
  if (index < 0) return;
  const message = state.records.key(index).resolveAsCell();
  if (
    !key || !message || message.key("authorProfile").get() === undefined ||
    (state.about.get().kind === "direct"
      ? !isSender(message, state)
      : spaceMembers()?.[currentPrincipal() ?? ""] !== "OWNER")
  ) return;
  removeMessage(event, state, key, message, true);
}

/** Binds the protocol event directly to its verified writer. */
export const commitObliterate = handler<MessageRequest, RoomWriterState>((
  event,
  state,
) => writeObliterate(event, state));

/** Binds the reviewed DOM event to the same room operation. */
const obliterateMessageFromUi = handler<TextGesture, RoomWriterState>((
  event,
  state,
) => writeObliterate(event, state));

/** Applies a deletion or obliteration under the caller's reviewed writer identity. */
function removeMessage(
  event: MessageRequest,
  state: RoomWriterState,
  key: string,
  message: Writable<ChatMessage>,
  obliterate: boolean,
): void {
  const now = handlerTime();
  const editedAt = reserveTime(state.memory.key("usedTimes"), now, now);
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!editedAt || !at) return;
  const previous = message.get();
  if (obliterate) {
    message.key("authorProfile").set(undefined);
    message.key("earlierVersions").set([]);
  } else {
    message.key("earlierVersions").push({
      body: previous.body as string,
      sentAt: previous.editedAt ?? previous.sentAt,
    });
  }
  message.key("reactions").set([]);
  message.key("body").set({ deleted: true });
  message.key("editedAt").set(editedAt);
  state.memory.key("requests").key(key).set(true);
  recordActivity(
    state,
    event.requestId,
    message,
    at,
    now,
    obliterate ? message : undefined,
  );
}

/** Adds an emoji once at its reactor's stable address. */
function writeSendReaction(
  input: (MessageRequest & { emoji: string }) | TextGesture,
  state: RoomWriterState,
): void {
  const request = messageRequest(input, state);
  const emoji = "requestId" in input
    ? input.emoji
    : state.uiEmoji ?? input.target?.value;
  if (!request || typeof emoji !== "string") return;
  const event = { ...request, emoji };
  const key = requestKey(event.requestId, state);
  const index = messageIndex(event.message, state);
  if (index < 0) return;
  const message = state.records.key(index).resolveAsCell();
  const profile = state.myProfile?.resolveAsCell();
  if (
    !key || !message || typeof message.get().body !== "string" ||
    profile?.get() === undefined || !isSingleEmoji(event.emoji)
  ) return;
  const profileId = entityKey(profile);
  if (!profileId) return;
  const reactions = message.key("reactions");
  if (
    reactions.get().some((reaction) =>
      equals(reaction.reactorProfile, profile) && reaction.emoji === event.emoji
    )
  ) {
    state.memory.key("requests").key(key).set(true);
    return;
  }
  const now = handlerTime();
  const sentAt = reserveTime(state.memory.key("usedTimes"), now, now);
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!sentAt || !at) return;
  const reaction = new Writable<StoredReaction>();
  reaction.set({ reactorProfile: profile, emoji: event.emoji, sentAt });
  reactions.addUnique(reaction);
  state.memory.key("requests").key(key).set(true);
  recordActivity(state, event.requestId, message, at, now);
}

/** Binds the protocol event directly to its verified writer. */
export const commitSendReaction = handler<
  MessageRequest & { emoji: string },
  RoomWriterState
>((event, state) => writeSendReaction(event, state));

/** Binds the reviewed DOM event to the same room operation. */
const sendReactionFromUi = handler<TextGesture, RoomWriterState>((
  event,
  state,
) => writeSendReaction(event, state));

/** Removes only the sender's reaction, without toggling an absent one back on. */
function writeDeleteReaction(
  input: (MessageRequest & { emoji: string }) | TextGesture,
  state: RoomWriterState,
): void {
  const request = messageRequest(input, state);
  const emoji = "requestId" in input
    ? input.emoji
    : state.uiEmoji ?? input.target?.value;
  if (!request || typeof emoji !== "string") return;
  const event = { ...request, emoji };
  const key = requestKey(event.requestId, state);
  const index = messageIndex(event.message, state);
  if (index < 0) return;
  const message = state.records.key(index).resolveAsCell();
  const profile = state.myProfile?.resolveAsCell();
  if (
    !key || !message || typeof message.get().body !== "string" || !profile ||
    !isSingleEmoji(event.emoji)
  ) return;
  const profileId = entityKey(profile);
  if (!profileId) return;
  const reactions = message.key("reactions");
  const reactionIndex = reactions.get().findIndex((reaction) =>
    equals(reaction.reactorProfile, profile) && reaction.emoji === event.emoji
  );
  if (reactionIndex < 0) {
    state.memory.key("requests").key(key).set(true);
    return;
  }
  const now = handlerTime();
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!at) return;
  const reaction = reactions.key(reactionIndex).resolveAsCell();
  reactions.removeByValue(reaction);
  const removed: Writable<ChatReaction | undefined> = reaction;
  removed.set(undefined);
  state.memory.key("requests").key(key).set(true);
  recordActivity(state, event.requestId, message, at, now);
}

/** Binds the protocol event directly to its verified writer. */
export const commitDeleteReaction = handler<
  MessageRequest & { emoji: string },
  RoomWriterState
>((event, state) => writeDeleteReaction(event, state));

/** Binds the reviewed DOM event to the same room operation. */
const deleteReactionFromUi = handler<TextGesture, RoomWriterState>((
  event,
  state,
) => writeDeleteReaction(event, state));

/** Adds the sender's resolved profile as a roster claim. */
export const commitShowProfile = handler<
  { requestId: string },
  RoomWriterState
>((event, state) => {
  const key = requestKey(event.requestId, state);
  const profile = state.myProfile?.resolveAsCell();
  if (!key || profile?.get() === undefined) return;
  state.memory.key("requests").key(key).set(true);
  if (state.roster.get().some((entry) => equals(entry, profile))) return;
  const now = handlerTime();
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!at) return;
  state.roster.addUnique(profile);
  const contributions = state.memory.key("profiles").key(currentPrincipal()!);
  contributions.set([...(contributions.get() ?? []), profile]);
  recordActivity(state, event.requestId, state.roster.resolveAsCell(), at, now);
});

/** Whether this room offers independent group membership controls. */
function hasMembership(state: RoomWriterState): boolean {
  return state.dedicated && state.about.get().kind === "group";
}

/** Removes a departed actor's roster contribution while retaining message history. */
function removeProfile(principal: string, state: RoomWriterState): void {
  const profiles = state.memory.key("profiles").key(principal).get() ?? [];
  for (const profile of profiles) state.roster.removeByValue(profile);
  const removed: Writable<Cell<ChatProfile>[] | undefined> = state.memory.key(
    "profiles",
  ).key(principal);
  removed.set(undefined);
}

/** Records a membership result in the same transaction as its ACL transition. */
function membershipActivity(
  requestId: string,
  key: string,
  state: RoomWriterState,
): void {
  const now = handlerTime();
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!at) throw new Error("No timestamp remains in this clock tick.");
  state.memory.key("requests").key(key).set(true);
  recordActivity(state, requestId, state.roster.resolveAsCell(), at, now);
}

/** Leaves membership and records the departure in one transaction. */
function writeLeave(
  event: { requestId: string },
  state: RoomWriterState,
): boolean {
  const key = requestKey(event.requestId, state);
  const actor = currentPrincipal();
  const acl = spaceMembers();
  if (!key || !actor || !hasMembership(state) || !acl?.[actor] || acl["*"]) {
    return false;
  }
  const remaining = Object.keys(acl).filter((principal) =>
    principal !== actor && principal !== "*"
  );
  const after = { ...acl };
  if (remaining.length === 0) {
    state.memory.key("abandoned").set(true);
  } else {
    delete after[actor];
    if (!remaining.some((principal) => after[principal] === "OWNER")) {
      const order = (principal: string) =>
        state.memory.key("admissions").key(principal).get() ??
          (state.initialMembers.includes(principal)
            ? 0
            : Number.MAX_SAFE_INTEGER);
      remaining.sort((a, b) =>
        order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0)
      );
      after[remaining[0]] = "OWNER";
    }
    setSpaceMembers(after);
  }
  state.memory.key("left").key(actor).set(true);
  removeProfile(actor, state);
  membershipActivity(event.requestId, key, state);
  return true;
}

/** Lets a member leave and optionally cleans up their client's private index. */
export const commitLeave = handler<
  { requestId: string },
  RoomWriterState & {
    uiForget?: Stream<{ requestId: string; room: Cell<ChatRoomOutput> }>;
    uiRooms?: Cell<ChatIndexEntry[]>;
    uiLeave?: Stream<{ requestId: string }>;
  }
>((event, state) => {
  // Find the indexed reference while membership permits reading stream aliases.
  const room = state.uiRooms?.get()?.find((entry) =>
    equals(entry.room.key("leave"), state.uiLeave)
  )?.room;
  if (writeLeave(event, state) && room) {
    // Cross-space event lineage holds this send until the departure commits.
    state.uiForget?.send({ requestId: event.requestId, room });
  }
});

/** Admits one member without downgrading an existing owner's grant. */
function writeAdd(
  event: { requestId: string; principal: string; access: "WRITE" | "OWNER" },
  state: RoomWriterState,
): void {
  const key = requestKey(event.requestId, state);
  const acl = spaceMembers();
  if (
    !key || !hasMembership(state) ||
    acl?.[currentPrincipal() ?? ""] !== "OWNER" ||
    !isWellFormedDID(event.principal) ||
    !["WRITE", "OWNER"].includes(event.access) ||
    state.memory.key("left").key(event.principal).get()
  ) return;
  const current = acl[event.principal];
  if (current === "OWNER" || current === event.access) {
    state.memory.key("requests").key(key).set(true);
    return;
  }
  setSpaceMembers({ ...acl, [event.principal]: event.access });
  if (!current) {
    const prior = Object.values(state.memory.key("admissions").get() ?? {});
    state.memory.key("admissions").key(event.principal).set(
      Math.max(0, ...prior) + 1,
    );
  }
  const notices = state.memory.key("notices");
  notices.set([...(notices.get() ?? []), {
    id: key,
    recipient: event.principal,
  }]);
  membershipActivity(event.requestId, key, state);
}

/** Binds the membership protocol request to its reviewed writer. */
export const commitAdd = handler<
  { requestId: string; principal: string; access: "WRITE" | "OWNER" },
  RoomWriterState
>((event, state) => writeAdd(event, state));

/** Applies the member choice shown by the reviewed control. */
const addMemberFromUi = handler<TextGesture, RoomWriterState>((event, state) =>
  writeAdd({
    requestId: eventKey(),
    principal: event.target?.value ?? "",
    access: state.uiAccess?.get() ?? "WRITE",
  }, state)
);

/** Revokes access while preserving the room's final owner. */
function writeRemove(
  event: { requestId: string; principal: string },
  state: RoomWriterState,
): void {
  const key = requestKey(event.requestId, state);
  const acl = spaceMembers();
  if (
    !key || !hasMembership(state) || acl?.[currentPrincipal() ?? ""] !== "OWNER"
  ) return;
  if (!acl[event.principal]) {
    state.memory.key("requests").key(key).set(true);
    return;
  }
  if (
    acl[event.principal] === "OWNER" &&
    Object.values(acl).filter((access) => access === "OWNER").length === 1
  ) return;
  const after = { ...acl };
  delete after[event.principal];
  setSpaceMembers(after);
  removeProfile(event.principal, state);
  membershipActivity(event.requestId, key, state);
}

/** Binds the membership protocol request to its reviewed writer. */
export const commitRemove = handler<
  { requestId: string; principal: string },
  RoomWriterState
>((event, state) => writeRemove(event, state));

/** Applies the member choice shown by the reviewed control. */
const removeMemberFromUi = handler<TextGesture, RoomWriterState>((
  _event,
  state,
) =>
  writeRemove(
    { requestId: eventKey(), principal: state.uiPrincipal ?? "" },
    state,
  )
);

/** Removes a delivered membership notice without emitting room activity. */
export const commitDelivered = handler<
  { requestId: string; id: string },
  RoomWriterState
>((event, state) => {
  const key = requestKey(event.requestId, state);
  if (
    !key || !hasMembership(state) ||
    spaceMembers()?.[currentPrincipal() ?? ""] !== "OWNER"
  ) return;
  state.memory.key("notices").set(
    (state.memory.key("notices").get() ?? []).filter((notice) =>
      notice.id !== event.id
    ),
  );
  state.memory.key("requests").key(key).set(true);
});

/** A session's fixed selection, retaining entities rather than message snapshots. */
interface WindowSelection {
  requestId: string;
  root?: Cell<ChatMessage>;
  from: ChatWindowAnchor;
  messages: Cell<ChatMessage>[];
}

/** Selects live message references for the sending session. */
const openWindow = handler<OpenWindowRequest, {
  records: Cell<ChatMessage[]>;
  windows: Writable<Record<string, WindowSelection>>;
}>((event, { records, windows }) => {
  if (!event.requestId || !event.windowId) return;
  const known = windows.key(event.windowId).get();
  if (known?.requestId === event.requestId) return;
  if (
    !known && Object.keys(windows.get()).length >= CHAT_POLICY.maxOpenWindows
  ) return;
  const all = records.get();
  if (
    event.root &&
    (!all.some((entry) => equals(entry, event.root)) ||
      threadRoot(event.root.get()))
  ) return;
  const view = conversationView(all, event.root);
  const selection = selectWindow(
    view,
    event.from,
    event.count,
    CHAT_POLICY.maxWindowCount,
  );
  if (!selection) return;
  windows.key(event.windowId).set({
    requestId: event.requestId,
    ...(event.root ? { root: event.root } : {}),
    from: event.from,
    messages: selection.messages.map((message) =>
      records.key(
        all.findIndex((entry) => entry.sentAt.value === message.sentAt.value),
      )
        .resolveAsCell()
    ),
  });
});

/** Removes one session window. */
const closeWindow = handler<{ requestId: string; windowId: string }, {
  windows: Writable<Record<string, WindowSelection>>;
}>((event, { windows }) => {
  if (!event.requestId || !event.windowId) return;
  const { [event.windowId]: _removed, ...remaining } = windows.get();
  windows.set(remaining);
});

/** Room storage and the profile supplied by its production wish boundary. */
export interface RoomInput {
  dedicated?: Default<boolean, false>;
  initialMembers?: Default<string[], []>;
  myProfile?: Cell<ChatProfile>;
  about: Cell<ChatRoomAbout>;
  records?: PerSpace<Writable<StoredMessage[] | Default<[]>>>;
  memory?: PerSpace<Writable<StoredMemory>>;
  activity?: PerSpace<
    Writable<StoredActivity[] | Default<[]>>
  >;
  roster?: PerSpace<Writable<StoredRoster | Default<[]>>>;
}

/** A window keeps original documents while its reader sees message values. */
type ReferenceWindow = Omit<ChatMessageWindow, "messages"> & {
  messages: Cell<ChatMessage>[];
};

/** Re-exports windows by alias with the protocol's ordinary data reader schema. */
const WindowViews = pattern<
  { value: Record<string, ReferenceWindow> },
  Record<string, ChatMessageWindow>
>(({ value }) => value);

/** Exposes activity values through aliases to their original authored documents. */
const ActivityView = pattern<
  { value: Cell<ChatRoomActivity>[] },
  ChatRoomActivity[]
>(({ value }) => value);

/** Retains the scoped boundary around a derived session window map. */
const windowCell = lift(
  (value: Cell<PerSession<Record<string, ChatMessageWindow>>>) => {
    value.get();
    return value;
  },
);

/** The people contributing one emoji, read live from the message's reaction cells. */
interface ReactionTally {
  emoji: string;
  profiles: Cell<ChatProfile>[];
  mine: boolean;
}

/** Renders one message with direct, separately reviewed writer controls. */
const MessageCard = pattern<{
  message: Cell<ChatMessage>;
  state: RoomWriterState;
  reply: Writable<ChatReply | null>;
  thread: Writable<{ root?: Cell<ChatMessage>; before?: FabricEpochNsec }>;
}, { [UI]: VNode }>(({ message, state, reply, thread }) => {
  const editing = new Writable.perSession(false);
  const history = new Writable.perSession(false);
  const bound = {
    dedicated: state.dedicated,
    initialMembers: state.initialMembers,
    myProfile: state.myProfile,
    records: state.records,
    memory: state.memory,
    activity: state.activity,
    roster: state.roster,
    about: state.about,
    uiMessage: message,
  };
  const live = computed(() => typeof message.key("body").get() === "string");
  const removed = computed(() =>
    message.key("authorProfile").get() === undefined
  );
  const mine = computed(() => {
    const viewer = viewerPrincipal();
    const key = entityKey(message);
    return viewer !== undefined && key !== undefined &&
      state.memory.key("authors").key(key).get() === viewer;
  });
  const replyCount = computed(() =>
    (state.records.get() ?? []).filter((entry) =>
      equals(threadRoot(entry), message)
    )
      .length
  );
  const canObliterate = computed(() =>
    state.about.get()?.kind === "direct"
      ? mine
      : spaceAccess(state.about) === "OWNER"
  );
  const quotedBody = computed(() => {
    const body = message.get()?.replyTo?.message.get()?.body;
    return typeof body === "string" ? body : "Deleted message";
  });
  const tallies = computed(() =>
    (message.key("reactions").get() ?? []).reduce<ReactionTally[]>(
      (groups, reaction) => {
        const existing = groups.find((group) => group.emoji === reaction.emoji);
        const own = equals(reaction.reactorProfile, state.myProfile);
        if (existing) {
          existing.profiles.push(reaction.reactorProfile);
          existing.mine ||= own;
        } else {
          groups.push({
            emoji: reaction.emoji,
            profiles: [reaction.reactorProfile],
            mine: own,
          });
        }
        return groups;
      },
      [],
    )
  );
  return {
    [UI]: (
      <cf-vstack
        gap="2"
        style={{
          padding: "0.75rem 0",
          borderBottom: "1px solid var(--cf-color-border)",
        }}
      >
        {removed
          ? <cf-text variant="caption">Removed message</cf-text>
          : (
            <cf-profile-badge
              $profile={message.get()?.authorProfile}
              size="sm"
            />
          )}
        {message.get()?.replyTo
          ? (
            <blockquote
              style={{
                margin: "0",
                padding: "0.5rem",
                borderLeft: "2px solid var(--cf-color-border)",
              }}
            >
              <cf-text variant="caption">Replying to</cf-text>
              <cf-text>
                {quotedBody}
              </cf-text>
            </blockquote>
          )
          : null}
        <cf-cfc-authorship
          $value={message}
          $author={message.get()?.authorProfile}
        >
          <cf-text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {live
              ? String(message.get()?.body)
              : removed
              ? "Message removed"
              : "Deleted message"}
          </cf-text>
        </cf-cfc-authorship>
        {message.get()?.editedAt
          ? <cf-text variant="caption">Edited</cf-text>
          : null}
        <cf-hstack gap="2" wrap>
          {live
            ? (
              <cf-button
                size="sm"
                variant="ghost"
                onClick={action(() => {
                  thread.set({ root: threadRoot(message.get()) ?? message });
                  reply.set({ message, shownIn: "thread" });
                })}
              >
                Reply
              </cf-button>
            )
            : null}
          {replyCount > 0
            ? (
              <cf-button
                size="sm"
                variant="ghost"
                onClick={action(() => thread.set({ root: message }))}
              >
                View thread ({replyCount})
              </cf-button>
            )
            : null}
          {live && mine
            ? (
              <cf-button
                size="sm"
                variant="ghost"
                onClick={action(() => editing.set(!editing.get()))}
              >
                Edit
              </cf-button>
            )
            : null}
          {live && mine
            ? (
              <div
                data-ui-pattern="ChatDeleteSurface"
                data-ui-event-integrity="ChatDeleteSurface"
              >
                <cf-button
                  size="sm"
                  variant="ghost"
                  data-ui-action="ChatDelete"
                  onClick={deleteMessageFromUi(bound)}
                >
                  Delete
                </cf-button>
              </div>
            )
            : null}
          {!removed && canObliterate
            ? (
              <div
                data-ui-pattern="ChatObliterateSurface"
                data-ui-event-integrity="ChatObliterateSurface"
              >
                <cf-button
                  size="sm"
                  variant="ghost"
                  data-ui-action="ChatObliterate"
                  onClick={obliterateMessageFromUi(bound)}
                >
                  Remove permanently
                </cf-button>
              </div>
            )
            : null}
          {live && (message.get()?.earlierVersions.length ?? 0) > 0
            ? (
              <cf-button
                size="sm"
                variant="ghost"
                onClick={action(() => history.set(!history.get()))}
              >
                Version history
              </cf-button>
            )
            : null}
        </cf-hstack>
        {history.get() && live
          ? (
            <cf-vstack gap="2">
              {(message.get()?.earlierVersions ?? []).map((version) => (
                <cf-text style={{ whiteSpace: "pre-wrap" }}>
                  {version.body}
                </cf-text>
              ))}
            </cf-vstack>
          )
          : null}
        {editing.get() && live && mine
          ? (
            <div
              data-ui-pattern="ChatEditSurface"
              data-ui-event-integrity="ChatEditSurface"
            >
              <cf-submit-input
                placeholder="Replacement text"
                buttonText="Save edit"
                data-ui-action="ChatEdit"
                onClick={editMessageFromUi(bound)}
              />
            </div>
          )
          : null}
        {live
          ? (
            <div
              data-ui-pattern="ChatReactSurface"
              data-ui-event-integrity="ChatReactSurface"
            >
              <cf-hstack gap="2" wrap>
                {tallies.map((tally) => (
                  <cf-hover-card>
                    {tally.mine
                      ? (
                        <cf-button
                          size="sm"
                          variant="outline"
                          data-ui-action="ChatReact"
                          onClick={deleteReactionFromUi({
                            dedicated: state.dedicated,
                            initialMembers: state.initialMembers,
                            myProfile: state.myProfile,
                            records: state.records,
                            memory: state.memory,
                            activity: state.activity,
                            roster: state.roster,
                            about: state.about,
                            uiMessage: message,
                            uiEmoji: tally.emoji,
                          })}
                        >
                          {tally.emoji} {tally.profiles.length}
                        </cf-button>
                      )
                      : (
                        <cf-button
                          size="sm"
                          variant="ghost"
                          data-ui-action="ChatReact"
                          onClick={sendReactionFromUi({
                            dedicated: state.dedicated,
                            initialMembers: state.initialMembers,
                            myProfile: state.myProfile,
                            records: state.records,
                            memory: state.memory,
                            activity: state.activity,
                            roster: state.roster,
                            about: state.about,
                            uiMessage: message,
                            uiEmoji: tally.emoji,
                          })}
                        >
                          {tally.emoji} {tally.profiles.length}
                        </cf-button>
                      )}
                    <cf-vstack slot="card">
                      {tally.profiles.map((profile) => (
                        <cf-profile-badge $profile={profile} size="sm" />
                      ))}
                    </cf-vstack>
                  </cf-hover-card>
                ))}
              </cf-hstack>
              <cf-button
                size="sm"
                variant="ghost"
                data-ui-action="ChatReact"
                onClick={sendReactionFromUi({
                  dedicated: state.dedicated,
                  initialMembers: state.initialMembers,
                  myProfile: state.myProfile,
                  records: state.records,
                  memory: state.memory,
                  activity: state.activity,
                  roster: state.roster,
                  about: state.about,
                  uiMessage: message,
                  uiEmoji: "😺",
                })}
              >
                😺
              </cf-button>
              <cf-submit-input
                placeholder="One emoji"
                buttonText="React"
                data-ui-action="ChatReact"
                onClick={sendReactionFromUi(bound)}
              />
            </div>
          )
          : null}
      </cf-vstack>
    ),
  };
});

/** A room's record and its direct protocol surface. */
export const FabriChatRoom = pattern<RoomInput, ChatRoomOutput>(
  (
    {
      myProfile,
      about,
      records,
      memory,
      activity,
      roster,
      dedicated,
      initialMembers,
    },
  ) => {
    const state = {
      dedicated,
      initialMembers,
      myProfile,
      about,
      records,
      memory,
      activity,
      roster,
    } as RoomWriterState;
    const reply = new Writable.perSession<ChatReply | null>(null);
    const draft = new Writable.perSession("");
    const thread = new Writable.perSession<
      { root?: Cell<ChatMessage>; before?: FabricEpochNsec }
    >({});
    const visibleConversation = computed(() =>
      conversationView(records!.get(), thread.get().root)
    );
    const visibleMessages = computed(() => {
      const end = thread.get().before;
      return visibleConversation.filter((message) =>
        end === undefined || message.sentAt.value < end.value
      )
        .slice(-CHAT_POLICY.maxWindowCount);
    });
    const visibleMessageRefs = computed((): Cell<ChatMessage>[] => {
      const stored = records!.get();
      const end = thread.get().before;
      const visible = conversationView(stored, thread.get().root).filter((
        message,
      ) => end === undefined || message.sentAt.value < end.value).slice(
        -CHAT_POLICY.maxWindowCount,
      );
      return visible.map((message) =>
        records!.key(
          stored.findIndex((entry) =>
            entry.sentAt.value === message.sentAt.value
          ),
        )
          .resolveAsCell()
      );
    });
    const olderAvailable = computed(() => {
      const first = visibleMessages[0]?.sentAt.value;
      return first !== undefined &&
        visibleConversation.some((message) => message.sentAt.value < first);
    });
    const clock = wish<number>({ query: "#now/1" });
    const activityRefs = computed((): Cell<ChatRoomActivity>[] =>
      activity!.get().flatMap((entry, index) =>
        entry.at.value >= (BigInt(Math.floor(clock.result ?? 0)) * 1_000_000n -
            CHAT_POLICY.recentActivityWindowNsec.value)
          ? [activity!.key(index).resolveAsCell()]
          : []
      )
    );
    const recentActivity = ActivityView({ value: activityRefs });
    const memberAccess = new Writable.perSession<"WRITE" | "OWNER">("WRITE");
    const members = computed(() =>
      Object.entries(spaceMembers() ?? {}).filter(([principal]) =>
        principal !== "*"
      ).map(([principal, access]) => ({ principal, access }))
    );
    const managesMembers = computed(() =>
      dedicated && about.get()?.kind === "group" &&
      spaceAccess(about) === "OWNER"
    );
    const selections = new Writable.perSession<Record<string, WindowSelection>>(
      {},
    );
    const windowValues = computed(() =>
      Object.fromEntries(
        Object.entries(selections.get()).map(([id, selection]) => {
          const selected = selection.messages.map((message) => message.get());
          const view = conversationView(records!.get(), selection.root);
          const first = selected[0]?.sentAt.value;
          const last = selected[selected.length - 1]?.sentAt.value;
          const empty = selectWindow(view, selection.from, 1, 1);
          return [
            id,
            {
              requestId: selection.requestId,
              ...(selection.root ? { root: selection.root } : {}),
              messages: selection.messages,
              hasOlder: first === undefined
                ? empty?.hasOlder ?? false
                : view.some((message) => message.sentAt.value < first),
              hasNewer: last === undefined
                ? empty?.hasNewer ?? false
                : view.some((message) => message.sentAt.value > last),
            } satisfies ReferenceWindow,
          ];
        }),
      )
    );
    const windows = windowCell(WindowViews({ value: windowValues }));
    const all = computed(() => conversationView(records!.get()));
    const latestMessages = computed((): Cell<ChatMessage>[] => {
      const stored = records!.get();
      return conversationView(stored).slice(-CHAT_POLICY.maxWindowCount).map((
        message,
      ) =>
        records!.key(
          stored.findIndex((entry) =>
            entry.sentAt.value === message.sentAt.value
          ),
        ).resolveAsCell()
      );
    });
    const hasOlder = computed(() => all.length > CHAT_POLICY.maxWindowCount);
    const messages = {
      count: computed(() => records!.get().length),
      oldestAt: computed(() =>
        [...records!.get()].sort((a, b) =>
          a.sentAt.value < b.sentAt.value ? -1 : 1
        )[0]?.sentAt
      ),
      newestAt: computed(() =>
        [...records!.get()].sort((a, b) =>
          a.sentAt.value < b.sentAt.value ? 1 : -1
        )[0]?.sentAt
      ),
      latest: { messages: latestMessages, hasOlder },
      windows,
      openWindow: openWindow({ records: records!, windows: selections }),
      closeWindow: closeWindow({ windows: selections }),
    };
    const participants = computed(() =>
      records!.get().reduce<Cell<ChatProfile>[]>(
        (profiles, message) =>
          message.authorProfile?.get() !== undefined &&
            !profiles.some((entry) => equals(entry, message.authorProfile))
            ? [...profiles, message.authorProfile]
            : profiles,
        [...roster!.get()],
      )
    );
    const canSend = computed(() => {
      const access = spaceAccess(about);
      return !memory!.key("abandoned").get() &&
        myProfile?.get() !== undefined &&
        (access === "WRITE" || access === "OWNER");
    });
    const reactionTallies = computed((): ChatReactionTallies[] => {
      const visible = latestMessages.map((message) => message.get());
      for (const window of Object.values(windowValues)) {
        for (const messageRef of window.messages) {
          const message = messageRef.get();
          if (
            !visible.some((entry) =>
              entry.sentAt.value === message.sentAt.value
            )
          ) visible.push(message);
        }
      }
      const stored = records!.get();
      return visible.map((message) => {
        const index = stored.findIndex((entry) =>
          entry.sentAt.value === message.sentAt.value
        );
        const reactions: ChatReactionTallies["reactions"] = [];
        for (const reaction of message.reactions) {
          let group = reactions.find((entry) => entry.emoji === reaction.emoji);
          if (!group) {
            group = {
              emoji: reaction.emoji,
              count: 0,
              mine: false,
              profiles: [],
            };
            reactions.push(group);
          }
          group.count++;
          group.mine ||= equals(reaction.reactorProfile, myProfile);
          group.profiles.push(reaction.reactorProfile);
        }
        return { message: records!.key(index).resolveAsCell(), reactions };
      });
    });
    const manager = wish<Pick<ChatManagerOutput, "rooms" | "forget">>({
      query: "#chatManager",
    });
    const facts = {
      about,
      recentActivity,
      recentActivityExpiredThrough: computed(() =>
        activity!.get().filter((entry) =>
          entry.at.value < (BigInt(Math.floor(clock.result ?? 0)) * 1_000_000n -
            CHAT_POLICY.recentActivityWindowNsec.value)
        )
          .reduce(
            (through, entry) => Math.max(through, entry.seq),
            memory!.key("expiredThrough").get() ?? 0,
          )
      ),
      roster: roster!,
      participants,
      messages,
      canSend,
      reactionTallies,
      sendMessage: commitSend(state),
      editMessage: commitEdit(state),
      deleteMessage: commitDelete(state),
      obliterateMessage: commitObliterate(state),
      sendReaction: commitSendReaction(state),
      deleteReaction: commitDeleteReaction(state),
      showProfile: commitShowProfile(state),
      leave: computed(() =>
        dedicated && about.get().kind === "group"
          ? commitLeave(state)
          : undefined
      ),
      add: computed(() =>
        dedicated && about.get().kind === "group" ? commitAdd(state) : undefined
      ),
      remove: computed(() =>
        dedicated && about.get().kind === "group"
          ? commitRemove(state)
          : undefined
      ),
      delivered: computed(() =>
        dedicated && about.get().kind === "group"
          ? commitDelivered(state)
          : undefined
      ),
      outgoingNotices: computed(() =>
        dedicated && about.get().kind === "group"
          ? [...(memory!.key("notices").get() ?? [])]
          : undefined
      ),
    };
    const leaveAndForget = commitLeave({
      ...state,
      uiForget: manager.result?.forget,
      uiRooms: manager.result?.rooms,
      uiLeave: facts.leave,
    });
    return {
      [NAME]: "FabriChat",
      [UI]: (
        <cf-theme
          theme={{
            density: "comfortable",
            colors: { primary: "#126b63", primaryForeground: "#ffffff" },
          }}
        >
          <cf-screen>
            <cf-hstack slot="header" justify="between" align="center">
              <cf-heading level={2}>
                {about.get()?.title || "Conversation"}
              </cf-heading>
              <cf-profile-badge $profile={myProfile} size="sm" />
              <cf-button
                variant="ghost"
                disabled={!canSend}
                onClick={action(() =>
                  facts.showProfile.send({ requestId: eventKey() })
                )}
              >
                Show my profile
              </cf-button>
              {dedicated && about.get()?.kind === "group"
                ? (
                  <cf-button
                    variant="ghost"
                    disabled={manager.result === undefined}
                    onClick={action(() =>
                      leaveAndForget.send({ requestId: eventKey() })
                    )}
                  >
                    Leave conversation
                  </cf-button>
                )
                : null}
            </cf-hstack>
            <cf-vstack id="fabrichat-messages" gap="3" padding="4">
              <cf-hstack gap="2" wrap>
                {participants.map((profile) => (
                  <cf-profile-badge $profile={profile} variant="chip" />
                ))}
              </cf-hstack>
              {managesMembers
                ? (
                  <details>
                    <summary>Conversation members</summary>
                    <div
                      data-ui-pattern="ChatMembersSurface"
                      data-ui-event-integrity="ChatMembersSurface"
                    >
                      <cf-vstack gap="2">
                        {members.map((member) => (
                          <cf-hstack gap="2">
                            <cf-text>
                              {member.principal} ({member.access})
                            </cf-text>
                            <cf-button
                              size="sm"
                              data-ui-action="ChatMembers"
                              onClick={removeMemberFromUi({
                                ...state,
                                uiPrincipal: member.principal,
                              })}
                            >
                              Remove member
                            </cf-button>
                          </cf-hstack>
                        ))}
                        <cf-select
                          $value={memberAccess}
                          items={[{ label: "Writer", value: "WRITE" }, {
                            label: "Owner",
                            value: "OWNER",
                          }]}
                        />
                        <cf-submit-input
                          placeholder="Member principal"
                          buttonText="Add member"
                          data-ui-action="ChatMembers"
                          onClick={addMemberFromUi({
                            ...state,
                            uiAccess: memberAccess,
                          })}
                        />
                      </cf-vstack>
                    </div>
                  </details>
                )
                : null}
              {thread.get().root?.get() !== undefined
                ? (
                  <cf-hstack gap="2">
                    <cf-heading level={3}>Thread</cf-heading>
                    <cf-button
                      variant="ghost"
                      onClick={action(() => {
                        thread.set({});
                        reply.set(null);
                        thread.key("before").set(undefined);
                      })}
                    >
                      Back to conversation
                    </cf-button>
                  </cf-hstack>
                )
                : null}
              <cf-hstack gap="2">
                {olderAvailable
                  ? (
                    <cf-button
                      variant="outline"
                      onClick={action(() =>
                        thread.key("before").set(
                          visibleMessages[0]?.sentAt,
                        )
                      )}
                    >
                      Older messages
                    </cf-button>
                  )
                  : null}
                {thread.get().before !== undefined
                  ? (
                    <cf-button
                      variant="outline"
                      onClick={action(() =>
                        thread.key("before").set(undefined)
                      )}
                    >
                      Latest messages
                    </cf-button>
                  )
                  : null}
              </cf-hstack>
              {visibleMessages.length === 0
                ? <cf-text>Start the conversation.</cf-text>
                : null}
              {visibleMessageRefs.map((message) => {
                const card: PerSession<{ [UI]: VNode }> = MessageCard({
                  message,
                  state,
                  reply,
                  thread,
                });
                return card[UI];
              })}
            </cf-vstack>
            <cf-vstack slot="footer" gap="2" padding="4">
              {reply.get()
                ? (
                  <cf-hstack gap="2">
                    <cf-text>Replying to a message</cf-text>
                    <cf-text variant="caption">
                      Placement: {reply.get()?.shownIn}
                    </cf-text>
                    {reply.get()?.message.get()?.replyTo?.shownIn !== "thread"
                      ? (
                        <cf-button
                          variant="ghost"
                          onClick={action(() => {
                            const selected = reply.get();
                            if (selected) {
                              reply.set({ ...selected, shownIn: "main" });
                              thread.set({});
                            }
                          })}
                        >
                          Conversation only
                        </cf-button>
                      )
                      : null}
                    <cf-button
                      variant="ghost"
                      onClick={action(() => {
                        const selected = reply.get();
                        if (selected) {
                          reply.set({ ...selected, shownIn: "thread" });
                        }
                      })}
                    >
                      Thread only
                    </cf-button>
                    <cf-button
                      variant="ghost"
                      onClick={action(() => {
                        const selected = reply.get();
                        if (selected) {
                          reply.set({ ...selected, shownIn: "both" });
                        }
                      })}
                    >
                      Conversation and thread
                    </cf-button>
                    <cf-button
                      variant="ghost"
                      onClick={action(() => reply.set(null))}
                    >
                      Cancel reply
                    </cf-button>
                  </cf-hstack>
                )
                : null}
              <div
                data-ui-pattern="ChatSendSurface"
                data-ui-event-integrity="ChatSendSurface"
              >
                <cf-submit-input
                  inputId="fabrichat-message"
                  value={draft}
                  clearOnSubmit={false}
                  onInput={action((event: TextGesture) =>
                    draft.set(event.target?.value ?? "")
                  )}
                  placeholder="Write a message"
                  buttonText="Send"
                  disabled={!canSend}
                  data-ui-action="ChatSend"
                  onClick={sendMessageFromUi({
                    ...state,
                    uiReply: reply,
                    uiDraft: draft,
                    uiThread: thread,
                  })}
                />
              </div>
              {!canSend
                ? (
                  <cf-text variant="caption">
                    A profile and write access are required to send.
                  </cf-text>
                )
                : null}
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
      ...facts,
      [VIEWS]: { room: facts },
    };
  },
);

export default FabriChatRoom;
