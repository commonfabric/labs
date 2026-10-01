/**
 * `FabriChatRoom`: one conversation, an implementation of `ChatRoomOutput`
 * (`docs/specs/fabrichat/FabriChatRoom.md`). What the room stores, and the
 * handlers that write it, are in `room-records.tsx`; one message's rendering
 * is in `message-row.tsx`.
 *
 * The room keeps no membership of its own. Who takes part is its space's
 * business: the space's access list decides who may read and write, and its
 * default pattern lists the participants' profiles (`wish("#default")`), which
 * the room shows alongside every author.
 *
 * `FabriChatRoomCore` takes the viewer's profile as an input, so a test can
 * supply a stand-in. The default export, `FabriChatRoom`, resolves the real
 * one with `#profile`.
 */
import {
  action,
  computed,
  type Default,
  equals,
  type FabricEpochNsec,
  NAME,
  pattern,
  type PerSession,
  Stream,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { isInMain, type ShownIn } from "./logic.ts";
import {
  type AboutRecord,
  type ActivityCell,
  type ActivityCounters,
  type ActivityCountersCell,
  canActIn,
  commitDelete,
  commitDeleteReaction,
  commitEdit,
  commitObliterate,
  commitSend,
  commitSendReaction,
  commitWindow,
  compareEntries,
  type ComposerState,
  entryFor,
  FABRICHAT_POLICY,
  type MessageCell,
  messageEntries,
  type MessageEntry,
  type MessagesCell,
  NO_ACTIVITY,
  NUMBERING_KEY,
  type ReactionListsCell,
  type RequestsCell,
  type RoomStreamEvent,
  type RoomWindowEvent,
  SPACE_CHAT_ABOUT,
  type UsedTimesCell,
  type WindowsCell,
  type WindowsValue,
} from "./room-records.tsx";
import { bodyText, FabriChatMessageRow } from "./message-row.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type ChatRoomAbout,
  type ChatRoomActivity,
  type ChatRoomKind,
  type ChatRoomPolicy,
  type ProfileCell,
} from "./schemas.tsx";

/**
 * The room's participants: those its space lists, plus every author it
 * doesn't, in the order each first appears. Two are the same person when
 * their profiles are the same cell.
 */
export const participantsOf = (
  listed: readonly ProfileCell[],
  entries: readonly MessageEntry[],
): ProfileCell[] =>
  [...entries].sort(compareEntries).reduce<ProfileCell[]>(
    (found, entry) => {
      const author = entry.record.authorProfile;
      return author === undefined ||
          found.some((known) => equals(known, author))
        ? found
        : [...found, author];
    },
    [...listed],
  );

/** A room's messages: facts, the newest, and this session's windows. */
export interface ChatMessageList {
  /** How many messages the room holds, obliterated tombstones included. */
  count: number;

  /** The oldest message's `sentAt`; absent while there are none. */
  oldestAt?: FabricEpochNsec;

  /** The newest message's `sentAt`; absent while there are none. */
  newestAt?: FabricEpochNsec;

  /** The newest messages of the main conversation, kept current. */
  latest: {
    /** Up to `maxWindowCount` of them, oldest first. */
    messages: MessageCell[];

    /** Whether the main conversation has older messages than these. */
    hasOlder: boolean;
  };

  /** This session's open windows, by the `windowId` its client chose. */
  windows: PerSession<WindowsCell>;

  /** Opens a window, or moves one already open. */
  openWindow: Stream<RoomWindowEvent>;

  /** Closes a window. */
  closeWindow: Stream<RoomWindowEvent>;
}

/** A room's data face, for hosts that draw it natively. */
export interface ChatRoomView {
  /** What the room says about itself. */
  about: ChatRoomAbout;

  /** What the room recorded recently, in `seq` order. */
  recentActivity: ChatRoomActivity[];

  /** The highest `seq` dropped from `recentActivity` for age; 0 for none. */
  recentActivityExpiredThrough: number;

  /**
   * The participants of the room's space, as its default pattern lists them
   * (`wish("#default")`), plus any author it doesn't list.
   */
  participants: ProfileCell[];

  /** The room's messages. */
  messages: ChatMessageList;

  /** Whether this reader can send, edit, delete, and react. */
  canSend: boolean;

  /** Sends a message. */
  sendMessage: Stream<RoomStreamEvent>;

  /** Records a new version of one of the sender's messages. */
  editMessage: Stream<RoomStreamEvent>;

  /** Records one of the sender's messages as deleted. */
  deleteMessage: Stream<RoomStreamEvent>;

  /** Reduces a message to a tombstone. */
  obliterateMessage: Stream<RoomStreamEvent>;

  /** Adds the sender's reaction to a message. */
  sendReaction: Stream<RoomStreamEvent>;

  /** Removes the sender's reaction to a message. */
  deleteReaction: Stream<RoomStreamEvent>;
}

/** What a room offers everyone its space admits: `ChatRoomOutput`. */
export interface ChatRoomOutput extends ChatRoomView {
  /** The room's name, for lists of pieces. */
  [NAME]: string;

  /** The room's own rendering, with its reviewed surfaces. */
  [UI]: VNode;

  /** The room's data face, as one group. */
  [VIEWS]: { room: ChatRoomView };
}

/** What a room stores, and who is looking at it. */
export interface FabriChatRoomCoreInput {
  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /** What the room says about itself, as its creator wrote it. */
  about: AboutRecord;

  /** The room's messages. */
  messages: MessagesCell;

  /** Every message's reaction list. */
  reactionLists: ReactionListsCell;

  /** The requests the room has acted on. */
  requests: RequestsCell;

  /** The times the room has recorded something at. */
  usedTimes: UsedTimesCell;

  /** The room's recent activity. */
  activity: ActivityCell;

  /** Where the activity's numbering stands. */
  counters: ActivityCountersCell;
}

/**
 * What the room's core offers: `ChatRoomOutput`, and the streams its own
 * composers send to, which take the reply they compose from the session's
 * composer state.
 */
export interface FabriChatRoomCoreOutput extends ChatRoomOutput {
  /** The main composer's send, replying to the reply being composed. */
  composerSend: Stream<RoomStreamEvent>;

  /** The thread composer's send, replying in the open thread. */
  threadComposerSend: Stream<RoomStreamEvent>;
}

/**
 * A conversation with a composer that sends as the viewer: the whole of
 * `ChatRoomOutput`, given the viewer's profile.
 */
export const FabriChatRoomCore = pattern<
  FabriChatRoomCoreInput,
  FabriChatRoomCoreOutput
>((input) => {
  const {
    myProfile,
    about,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
  } = input;
  const composer = new Writable.perSession<ComposerState>({});
  const kind = computed((): ChatRoomKind => about?.kind ?? "group");
  const records = {
    kind,
    composer,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
  };
  const alsoToMain = new Writable.perSession(false);
  const windows = new Writable.perSession<WindowsValue>();

  const entries = computed(() => messageEntries(messages));
  const mainEntries = computed(() =>
    entries.filter(isInMain).sort(compareEntries)
  );
  const latest = computed(() => ({
    messages: mainEntries.slice(-FABRICHAT_POLICY.maxWindowCount).map((
      entry,
    ) => entry.cell),
    hasOlder: mainEntries.length > FABRICHAT_POLICY.maxWindowCount,
  }));
  const count = computed(() => entries.length);
  const sortedEntries = computed(() => [...entries].sort(compareEntries));
  const oldestAt = computed(() => sortedEntries[0]?.record.sentAt);
  const newestAt = computed(() =>
    sortedEntries[sortedEntries.length - 1]?.record.sentAt
  );
  // The space's participants, as its default pattern lists them; a space
  // whose default pattern isn't there yet lists none.
  const space = wish<{ participants?: ProfileCell[] }>({ query: "#default" });
  const spaceParticipants = computed(
    () => [...(space.result?.participants ?? [])],
  );
  const participants = computed(() =>
    participantsOf(spaceParticipants, entries)
  );
  const canSend = computed(() => canActIn(messages, myProfile));
  const cannotSend = computed(() => !canSend);
  // The policy is a document of its own, which `about` links.
  const policy = new Writable.perSpace<ChatRoomPolicy>(FABRICHAT_POLICY);
  const aboutView = {
    kind,
    title: computed(() => about?.title),
    createdAt: computed(() => about?.createdAt),
    policy,
  };
  const expiredThrough = computed(() =>
    ((counters.elementById(NUMBERING_KEY).get() ??
      NO_ACTIVITY) as ActivityCounters).expiredThrough
  );
  const title = computed(() =>
    about?.title ?? (kind === "direct" ? "Direct chat" : "Chat")
  );
  const hasThread = computed(() => {
    const root = composer.get()?.thread;
    return root?.get() !== undefined && entryFor(entries, root) !== undefined;
  });
  const replyingTo = computed(() => bodyText(composer.get()?.replyTo?.get()));
  // Per-session and per-viewer parts are hidden by a prop, never built as a
  // different tree (see `FabriChatMessageRow`).
  const replyDisplay = computed(() => (replyingTo ? "flex" : "none"));
  const threadDisplay = computed(() => (hasThread ? "flex" : "none"));
  const isEmpty = computed(() => mainEntries.length === 0);
  const threadShownIn = computed((): ShownIn =>
    alsoToMain.get() ? "both" : "thread"
  );

  const sendMessage = commitSend({ myProfile, ...records });
  const composeSend = commitSend({
    myProfile,
    ...records,
    replyFrom: "replyTo",
  });
  const sendThreadReply = commitSend({
    myProfile,
    ...records,
    replyFrom: "thread",
    shownIn: threadShownIn,
  });
  const streams = {
    sendMessage,
    editMessage: commitEdit({
      myProfile,
      ...records,
    }),
    deleteMessage: commitDelete({
      myProfile,
      ...records,
    }),
    obliterateMessage: commitObliterate({
      myProfile,
      ...records,
    }),
    sendReaction: commitSendReaction({
      myProfile,
      ...records,
    }),
    deleteReaction: commitDeleteReaction({
      myProfile,
      ...records,
    }),
  };
  const messageList = {
    count,
    oldestAt,
    newestAt,
    latest,
    windows,
    openWindow: commitWindow({ op: "open", messages, windows }),
    closeWindow: commitWindow({ op: "close", messages, windows }),
  };
  const view = {
    about: aboutView,
    recentActivity: activity,
    recentActivityExpiredThrough: expiredThrough,
    participants,
    messages: messageList,
    canSend,
    ...streams,
  };
  const closeThread = action(() => composer.key("thread").set(undefined));
  const cancelReply = action(() => composer.key("replyTo").set(undefined));

  return {
    [NAME]: title,
    [UI]: (
      <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "720px" }}>
        <cf-hstack justify="between" align="center" gap="4">
          <cf-heading level={3}>{title}</cf-heading>
          <cf-profile-badge $profile={myProfile} size="sm" />
        </cf-hstack>

        {
          /* A plain flex row, not `cf-hstack`, whose host clips overflow
            and would cut off the badges' verified glow. */
        }
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {participants.map((participant) => (
            <cf-profile-badge variant="chip" $profile={participant} />
          ))}
        </div>

        <cf-vstack
          id="fabrichat-messages"
          gap="3"
          style={{ minHeight: "160px" }}
        >
          {messages.map((message) => (
            <FabriChatMessageRow
              message={message}
              inThread={false}
              myProfile={myProfile}
              kind={kind}
              composer={composer}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
            />
          ))}
          {isEmpty
            ? <cf-empty-state message="No messages yet. Say hello!" />
            : null}
        </cf-vstack>

        <cf-hstack gap="2" align="center" style={{ display: replyDisplay }}>
          <cf-text variant="caption">Replying to: {replyingTo}</cf-text>
          <cf-button size="sm" variant="ghost" onClick={cancelReply}>
            Cancel
          </cf-button>
        </cf-hstack>
        <div
          data-ui-pattern={CHAT_SEND_SURFACE}
          data-ui-event-integrity={CHAT_SEND_SURFACE}
        >
          <cf-submit-input
            data-ui-action={CHAT_SEND_ACTION}
            inputId="fabrichat-message"
            placeholder="Message"
            buttonText="Send"
            disabled={cannotSend}
            onClick={composeSend}
          />
        </div>

        <cf-vstack
          id="fabrichat-thread"
          gap="2"
          style={{
            display: threadDisplay,
            borderTop: "1px solid var(--cf-theme-color-border)",
            paddingTop: "0.75rem",
          }}
        >
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Thread</cf-heading>
            <cf-button size="sm" variant="ghost" onClick={closeThread}>
              Close
            </cf-button>
          </cf-hstack>
          {messages.map((message) => (
            <FabriChatMessageRow
              message={message}
              inThread
              myProfile={myProfile}
              kind={kind}
              composer={composer}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
            />
          ))}
          <cf-checkbox $checked={alsoToMain}>
            Also send to the conversation
          </cf-checkbox>
          <div
            data-ui-pattern={CHAT_SEND_SURFACE}
            data-ui-event-integrity={CHAT_SEND_SURFACE}
          >
            <cf-submit-input
              data-ui-action={CHAT_SEND_ACTION}
              inputId="fabrichat-thread-message"
              placeholder="Reply in thread"
              buttonText="Reply"
              disabled={cannotSend}
              onClick={sendThreadReply}
            />
          </div>
        </cf-vstack>
      </cf-vstack>
    ),
    [VIEWS]: { room: view },
    ...view,
    composerSend: composeSend,
    threadComposerSend: sendThreadReply,
  };
});

/**
 * What a room stores. Each has a default, so a space's own chat starts with
 * none.
 */
export interface FabriChatRoomInput {
  /**
   * What the room says about itself, written once by whoever creates it. A
   * space's own chat is a group room with no title.
   */
  about?: AboutRecord | Default<typeof SPACE_CHAT_ABOUT>;

  /** The room's messages. */
  messages?: MessagesCell;

  /** Every message's reaction list. */
  reactionLists?: ReactionListsCell;

  /** The requests the room has acted on. */
  requests?: RequestsCell;

  /** The times the room has recorded something at. */
  usedTimes?: UsedTimesCell;

  /** The room's recent activity. */
  activity?: ActivityCell;

  /** Where the activity's numbering stands. */
  counters?: ActivityCountersCell;
}

/**
 * A FabriChat room whose viewer is the person looking at it: the
 * `ChatRoomOutput` its space's members share. A viewer with no profile can
 * read the conversation, and is offered the form that creates one.
 */
const FabriChatRoom = pattern<FabriChatRoomInput, ChatRoomOutput>(
  (input) => {
    const profileWish = wish<ChatProfile>({ query: "#profile" });
    // Hidden by a prop rather than a branch, as `FabriChatMessageRow` says.
    const setupDisplay = computed(() =>
      profileWish.result === undefined ? "block" : "none"
    );
    const room = FabriChatRoomCore(
      {
        myProfile: profileWish.result,
        about: input.about,
        messages: input.messages,
        reactionLists: input.reactionLists,
        requests: input.requests,
        usedTimes: input.usedTimes,
        activity: input.activity,
        counters: input.counters,
      },
    );

    return {
      [NAME]: room[NAME],
      [VIEWS]: room[VIEWS],
      about: room.about,
      recentActivity: room.recentActivity,
      recentActivityExpiredThrough: room.recentActivityExpiredThrough,
      participants: room.participants,
      messages: room.messages,
      canSend: room.canSend,
      sendMessage: room.sendMessage,
      editMessage: room.editMessage,
      deleteMessage: room.deleteMessage,
      obliterateMessage: room.obliterateMessage,
      sendReaction: room.sendReaction,
      deleteReaction: room.deleteReaction,
      [UI]: (
        <cf-screen>
          {room[UI]}
          <div
            id="fabrichat-profile-setup"
            style={{
              display: setupDisplay,
              padding: "0 1rem 1rem",
              maxWidth: "720px",
            }}
          >
            {profileWish[UI]}
          </div>
        </cf-screen>
      ),
    };
  },
);

export default FabriChatRoom;
