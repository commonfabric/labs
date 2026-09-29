/**
 * Stores an attested conversation with exact times, request deduplication,
 * editable history, reactions, and session-owned message windows.
 */

import {
  type AuthenticatedActionWrite,
  type AuthoredByCurrentUser,
  type Cell,
  computed,
  currentPrincipal,
  type Default,
  entityRefToString,
  equals,
  getEntityId,
  handler,
  lift,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  setSpaceMembers,
  spaceMembers,
  type TrustedActionWrite,
  UI,
  VIEWS,
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
  ChatMessage,
  ChatMessageWindow,
  ChatProfile,
  ChatReaction,
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
      typeof commitEdit,
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
      typeof commitObliterate,
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
      typeof commitDeleteReaction,
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
      typeof commitObliterate,
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
  profiles: Record<string, Cell<ChatProfile>>;
  abandoned: boolean;
  notices: { id: string; recipient: string }[];
}

/** Bookkeeping writable only by the room's record writers. */
export type StoredMemory = WritePolicyAnyOf<RoomMemory, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
  WriteAuthorizedBy<unknown, typeof commitShowProfile>,
  WriteAuthorizedBy<unknown, typeof commitLeave>,
  WriteAuthorizedBy<unknown, typeof commitAdd>,
  WriteAuthorizedBy<unknown, typeof commitRemove>,
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
      typeof commitEdit,
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
      typeof commitObliterate,
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
      typeof commitDeleteReaction,
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
      typeof commitRemove,
      "ChatMembers",
      "ChatMembersSurface"
    >,
  ]>
>;

/** Roster contributions may be added by their actor and removed on departure. */
type StoredRoster = WritePolicyAnyOf<Cell<ChatProfile>[], [
  WriteAuthorizedBy<unknown, typeof commitAdd>,
  WriteAuthorizedBy<unknown, typeof commitShowProfile>,
  WriteAuthorizedBy<unknown, typeof commitLeave>,
  WriteAuthorizedBy<unknown, typeof commitRemove>,
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
    !principal || state.memory.key("abandoned").get() ||
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
    entry.at.value < now - CHAT_POLICY.recentActivityWindowNsec
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
      entry.at.value >= now - CHAT_POLICY.recentActivityWindowNsec &&
      (!obliterated || !equals(entry.what, obliterated))
    ),
  );
  state.activity.push({ seq, at, requestId, what });
}

/** Records a new message from the authenticated sender, preserving its exact text. */
export const commitSend = handler<SendMessageRequest, RoomWriterState>(
  (event, state) => {
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
    const message = state.records.elementById(key);
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
  },
);

/** Records a new version while retaining the sender's profile and original position. */
export const commitEdit = handler<
  MessageRequest & { version: SendMessageRequest["version"] },
  RoomWriterState
>((event, state) => {
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
});

/** Records the sender's deletion, keeping the version it replaced. */
export const commitDelete = handler<MessageRequest, RoomWriterState>(
  (event, state) => {
    const key = requestKey(event.requestId, state);
    const index = messageIndex(event.message, state);
    if (index < 0) return;
    const message = state.records.key(index).resolveAsCell();
    if (
      !key || !message || !isSender(message, state) ||
      typeof message.get().body !== "string"
    ) return;
    removeMessage(event, state, key, message, false);
  },
);

/** Obliterates an owned direct message or a group message curated by an owner. */
export const commitObliterate = handler<MessageRequest, RoomWriterState>(
  (event, state) => {
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
  },
);

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
export const commitSendReaction = handler<
  MessageRequest & { emoji: string },
  RoomWriterState
>((event, state) => {
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
  const reaction = reactions.elementById(
    JSON.stringify([profileId, event.emoji]),
  );
  if (reaction.get()) {
    state.memory.key("requests").key(key).set(true);
    return;
  }
  const now = handlerTime();
  const sentAt = reserveTime(state.memory.key("usedTimes"), now, now);
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!sentAt || !at) return;
  reaction.set({ reactorProfile: profile, emoji: event.emoji, sentAt });
  reactions.addUnique(reaction);
  state.memory.key("requests").key(key).set(true);
  recordActivity(state, event.requestId, message, at, now);
});

/** Removes only the sender's reaction, without toggling an absent one back on. */
export const commitDeleteReaction = handler<
  MessageRequest & { emoji: string },
  RoomWriterState
>((event, state) => {
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
  const reaction = reactions.elementById(
    JSON.stringify([profileId, event.emoji]),
  );
  if (!reaction.get()) {
    state.memory.key("requests").key(key).set(true);
    return;
  }
  const now = handlerTime();
  const at = reserveTime(state.memory.key("usedTimes"), now, now);
  if (!at) return;
  reactions.removeByValue(reaction);
  const removed: Writable<ChatReaction | undefined> = reaction;
  removed.set(undefined);
  state.memory.key("requests").key(key).set(true);
  recordActivity(state, event.requestId, message, at, now);
});

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
  state.memory.key("profiles").key(currentPrincipal()!).set(profile);
  recordActivity(state, event.requestId, state.roster, at, now);
});

/** Whether this room offers independent group membership controls. */
function hasMembership(state: RoomWriterState): boolean {
  return state.dedicated && state.about.get().kind === "group";
}

/** Removes a departed actor's roster contribution while retaining message history. */
function removeProfile(principal: string, state: RoomWriterState): void {
  const profile = state.memory.key("profiles").key(principal).get();
  if (profile) state.roster.removeByValue(profile);
  const removed: Writable<Cell<ChatProfile> | undefined> = state.memory.key(
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
  recordActivity(state, requestId, state.roster, at, now);
}

/** Lets a member leave, promoting the longest-standing member when necessary. */
export const commitLeave = handler<{ requestId: string }, RoomWriterState>(
  (event, state) => {
    const key = requestKey(event.requestId, state);
    const actor = currentPrincipal();
    const acl = spaceMembers();
    if (!key || !actor || !hasMembership(state) || !acl?.[actor]) return;
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
  },
);

/** Admits one member without downgrading an existing owner's grant. */
export const commitAdd = handler<
  { requestId: string; principal: string; access: "WRITE" | "OWNER" },
  RoomWriterState
>((event, state) => {
  const key = requestKey(event.requestId, state);
  const acl = spaceMembers();
  if (
    !key || !hasMembership(state) ||
    acl?.[currentPrincipal() ?? ""] !== "OWNER" ||
    !event.principal.startsWith("did:") ||
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
});

/** Revokes access while preserving the room's final owner. */
export const commitRemove = handler<
  { requestId: string; principal: string },
  RoomWriterState
>((event, state) => {
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
});

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
      records.key(all.findIndex((entry) => equals(entry, message)))
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

/** Retains the scoped boundary around a derived session window map. */
const windowCell = lift(
  (value: Cell<PerSession<Record<string, ChatMessageWindow>>>) => {
    value.get();
    return value;
  },
);

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
              messages: selected,
              hasOlder: first === undefined
                ? empty?.hasOlder ?? false
                : view.some((message) => message.sentAt.value < first),
              hasNewer: last === undefined
                ? empty?.hasNewer ?? false
                : view.some((message) => message.sentAt.value > last),
            } satisfies ChatMessageWindow,
          ];
        }),
      )
    );
    const windows = windowCell(windowValues);
    const all = computed(() => conversationView(records!.get()));
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
      latest: computed(() => ({
        messages: all.slice(-CHAT_POLICY.maxWindowCount),
        hasOlder: all.length > CHAT_POLICY.maxWindowCount,
      })),
      windows,
      openWindow: openWindow({ records: records!, windows: selections }),
      closeWindow: closeWindow({ windows: selections }),
    };
    const facts = {
      about,
      recentActivity: activity!,
      recentActivityExpiredThrough: computed(() =>
        memory!.key("expiredThrough").get() ?? 0
      ),
      roster: roster!,
      participants: computed(() =>
        records!.get().reduce<Cell<ChatProfile>[]>(
          (profiles, message) =>
            message.authorProfile?.get() !== undefined &&
              !profiles.some((entry) => equals(entry, message.authorProfile))
              ? [...profiles, message.authorProfile]
              : profiles,
          [...roster!.get()],
        )
      ),
      messages,
      canSend: computed(() => {
        const acl = spaceMembers();
        const access = acl?.[currentPrincipal() ?? ""] ?? acl?.["*"];
        return !memory!.key("abandoned").get() &&
          myProfile?.get() !== undefined &&
          (access === "WRITE" || access === "OWNER");
      }),
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
    return {
      [NAME]: "FabriChat",
      [UI]: (
        <cf-vstack>
          {messages.latest.messages.map((message) => (
            <cf-text>
              {typeof message.body === "string"
                ? message.body
                : "Deleted message"}
            </cf-text>
          ))}
        </cf-vstack>
      ),
      ...facts,
      [VIEWS]: { room: facts },
    };
  },
);
