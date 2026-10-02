/**
 * Defines the UI-free chat protocol shared by rooms, managers, placements,
 * and clients. People and messages retain their identity through cell links.
 */

import type {
  Cell,
  FabricDurationNsec,
  FabricEpochNsec,
  NAME,
  PerSession,
  Stream,
  UI,
  VIEWS,
  VNode,
} from "commonfabric";

/** The profile fields used to present a person. */
export interface ChatProfile {
  name?: string;
  avatar?: string;
}

/** A version's text and the time the room recorded it. */
export interface ChatMessageVersion {
  body: string;
  sentAt: FabricEpochNsec;
}

/** The target and presentation of a reply. */
export interface ChatReply {
  message: Cell<ChatMessage>;
  shownIn: "main" | "thread" | "both";
}

/** One person's single-emoji reaction. */
export interface ChatReaction {
  reactorProfile: Cell<ChatProfile>;
  emoji: string;
  sentAt: FabricEpochNsec;
}

/** A message, its preceding versions, and separately authorized reactions. */
export interface ChatMessage {
  authorProfile?: Cell<ChatProfile>;
  body: string | { deleted: true };
  sentAt: FabricEpochNsec;
  editedAt?: FabricEpochNsec;
  earlierVersions: ChatMessageVersion[];
  replyTo?: ChatReply;
  reactions: ChatReaction[];
}

/** The room's declared behavior and resource limits. */
export interface ChatRoomPolicy {
  ownersMayObliterate: boolean;
  keepsHistory: boolean;
  deletionIsObliteration: boolean;
  proposedTimeMaxAgeNsec: FabricDurationNsec;
  proposedTimeMaxLeadNsec: FabricDurationNsec;
  recentActivityWindowNsec: FabricDurationNsec;
  maxWindowCount: number;
  maxOpenWindows: number;
}

/** The immutable facts attested by a manager-created room's creator. */
export interface ChatRoomRecord {
  kind: "direct" | "group";
  title?: string;
  createdAt: FabricEpochNsec;
}

/** Immutable room description, with independently labeled policy. */
export interface ChatRoomAbout {
  kind: "direct" | "group";
  title?: string;
  createdAt: FabricEpochNsec;
  policy: Cell<ChatRoomPolicy>;
  record?: Cell<ChatRoomRecord>;
}

/** An attested pointer to a change, numbered in commit order. */
export interface ChatRoomActivity {
  seq: number;
  at: FabricEpochNsec;
  requestId: string;
  what: Cell<ChatMessage>;
}

/** A position in a conversation or thread. */
export type ChatWindowAnchor =
  | { before: FabricEpochNsec | "end" }
  | { after: FabricEpochNsec | "start" }
  | { around: FabricEpochNsec };

/** A fixed selection of live messages from a conversation or thread. */
export interface ChatMessageWindow {
  requestId: string;
  root?: Cell<ChatMessage>;
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
}

/** A request to select messages for one session's panel. */
export interface OpenWindowRequest {
  requestId: string;
  windowId: string;
  root?: Cell<ChatMessage>;
  from: ChatWindowAnchor;
  count: number;
}

/** Shared message facts with a cell boundary for session-owned windows. */
export interface ChatMessageList {
  count: number;
  oldestAt?: FabricEpochNsec;
  newestAt?: FabricEpochNsec;
  latest: { messages: ChatMessage[]; hasOlder: boolean };
  windows: Cell<PerSession<Record<string, ChatMessageWindow>>>;
  openWindow: Stream<OpenWindowRequest>;
  closeWindow: Stream<{ requestId: string; windowId: string }>;
}

/** A send, with a client-proposed version time. */
export interface SendMessageRequest {
  requestId: string;
  version: ChatMessageVersion;
  replyTo?: ChatReply;
}

/** A request naming a message by entity. */
export interface MessageRequest {
  requestId: string;
  message: Cell<ChatMessage>;
}

/** Display counts retain their original message and reactor profile links. */
export interface ChatReactionTallies {
  message: Cell<ChatMessage>;
  reactions: {
    emoji: string;
    count: number;
    mine: boolean;
    profiles: Cell<ChatProfile>[];
  }[];
}

/** The public room facts and direct writer streams. */
export interface ChatRoomFacts {
  about: ChatRoomAbout;
  recentActivity: ChatRoomActivity[];
  recentActivityExpiredThrough: number;
  participants: Cell<ChatProfile>[];
  messages: ChatMessageList;
  canSend: boolean;
  reactionTallies: ChatReactionTallies[];
  sendMessage: Stream<SendMessageRequest>;
  editMessage: Stream<MessageRequest & { version: ChatMessageVersion }>;
  deleteMessage: Stream<MessageRequest>;
  obliterateMessage: Stream<MessageRequest>;
  sendReaction: Stream<MessageRequest & { emoji: string }>;
  deleteReaction: Stream<MessageRequest & { emoji: string }>;
}

/** A room's protocol and its own reviewed rendering. */
export interface ChatRoomOutput extends ChatRoomFacts {
  [NAME]?: string;
  [UI]: VNode;
  [VIEWS]: { room: ChatRoomFacts };
}

/**
 * The shared room metadata a manager reads through a room reference. Accepting
 * a reference does not subscribe to the room's viewer-specific UI or windows.
 * A linked space's own chat may omit its creation time and creation record.
 */
export interface ChatRoomLink {
  about?: Omit<ChatRoomAbout, "createdAt" | "record"> & {
    createdAt?: FabricEpochNsec;
    record?: Cell<
      Omit<ChatRoomRecord, "createdAt"> & { createdAt?: FabricEpochNsec }
    >;
  };
}

/** A user's link to a conversation. */
export interface ChatIndexEntry {
  room: Cell<ChatRoomOutput>;
  kind: "direct" | "group";
  counterpart?: string;
  since: FabricEpochNsec;
}

/** An observable outcome of a manager request. */
export type ChatRequestOutcome =
  | { status: "pending" }
  | { status: "done"; entry?: ChatIndexEntry }
  | { status: "refused"; reason: string };

/**
 * The manager's public event envelope. Each operation validates the fields it
 * uses; fields belonging to another operation are ignored. A caller may omit
 * requestId to use the identity of the dispatch as its deduplication key.
 */
export interface ManagerStreamEvent {
  requestId?: string;
  counterpart?: string;
  members?: string[];
  title?: string;
  joinableByLink?: boolean;
  room?: Cell<ChatRoomLink>;
  id?: string;
  readonly target?: {
    readonly value?: string;
    readonly dataset?: { readonly chatCounterpart?: string };
  };
}

/** The user's private room index and room-creation requests. */
export interface ChatManagerFacts {
  rooms: ChatIndexEntry[];
  direct: Record<string, ChatIndexEntry>;
  requests: Record<string, ChatRequestOutcome>;
  outgoingNotices: {
    id: string;
    room: Cell<ChatRoomOutput>;
    recipient: string;
  }[];
  openDirect: Stream<ManagerStreamEvent>;
  createGroup: Stream<ManagerStreamEvent>;
  accept: Stream<ManagerStreamEvent>;
  forget: Stream<ManagerStreamEvent>;
  delivered: Stream<ManagerStreamEvent>;
}

/** The home chat manager's public contract. */
export interface ChatManagerOutput extends ChatManagerFacts {
  [VIEWS]: { chats: ChatManagerFacts };
}
