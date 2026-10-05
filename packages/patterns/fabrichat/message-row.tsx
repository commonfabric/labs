/**
 * One message of a FabriChat room, rendered: `FabriChatMessageRow`, with its
 * reviewed surfaces for reacting, editing, deleting, and obliterating, and the
 * reaction tallies and body text it shows.
 */
import {
  action,
  computed,
  equals,
  pattern,
  type PerSession,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  isInMain,
  threadReplyCounts,
  threadRootOf,
  type ViewItem,
} from "./logic.ts";
import {
  type ActivityCell,
  type ActivityCountersCell,
  canActIn,
  commitDelete,
  commitDeleteReaction,
  commitEdit,
  commitObliterate,
  commitSend,
  commitSendReaction,
  type ComposerCell,
  entityKeyOf,
  entryFor,
  FABRICHAT_POLICY,
  isDeleted,
  isOwnerOf,
  type MessageCell,
  messageEntries,
  type MessageRecord,
  type MessagesCell,
  type ReactionListsCell,
  type RequestsCell,
  type RoomStreamEvent,
  type UsedTimesCell,
} from "./room-records.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_UNREACT_ACTION,
  type ChatDisplay,
  type ChatReaction,
  type ChatReactionTally,
  type ChatRoomKind,
  type ProfileCell,
  reactionTalliesOf,
} from "./schemas.tsx";

/** The emoji a message's reaction picker puts within easy reach. */
export const FABRICHAT_QUICK_REACTIONS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🎉",
] as const;

/** How one emoji stands on one message, and the card listing its reactors. */
export interface ReactionTally extends ChatReactionTally {
  /**
   * An id for the card that lists them, unique on the page, so the count can
   * name the card as its description.
   */
  cardId: string;
}

/**
 * `reactions` tallied as `reactionTalliesOf()` does, each tally with a card id
 * made from `cardIdPrefix`.
 */
export const reactionTallies = (
  reactions: readonly ChatReaction[],
  viewer: ProfileCell | undefined,
  cardIdPrefix: string,
): ReactionTally[] =>
  reactionTalliesOf(reactions, viewer).map((tally, index) => ({
    ...tally,
    cardId: `${cardIdPrefix}-${index}`,
  }));

/** How a message's body reads, for a quote or a deleted message. */
export const bodyText = (record: MessageRecord | undefined): string =>
  record === undefined
    ? ""
    : typeof record.body === "string"
    ? record.body
    : record.authorProfile === undefined
    ? "This message was removed."
    : "This message was deleted.";

/** How a reaction's emoji is drawn. */
const EMOJI_STYLE = { fontSize: "18px", lineHeight: "1" };

/** What a message row needs. */
export interface FabriChatMessageRowInput {
  /** The message. */
  message: MessageCell;

  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /**
   * Whether the row belongs to the open thread's list rather than the main
   * conversation's. Every message has a row in each list, shown only where
   * the message belongs.
   */
  inThread: boolean;

  /** The room's kind. */
  kind: ChatRoomKind;

  /** The session's composer state. */
  composer: PerSession<ComposerCell>;

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

/** What a message row provides: its rendering, and its controls' streams. */
export interface FabriChatMessageRowOutput {
  /** The message's rendering, hidden where the message doesn't belong. */
  [UI]: VNode;

  /** The message's reactions, tallied by emoji. */
  tallies: ReactionTally[];

  /** Adds the viewer's reaction: `emoji`, or the text typed in. */
  sendReaction: Stream<RoomStreamEvent>;

  /** Removes the viewer's reaction: `emoji`. */
  deleteReaction: Stream<RoomStreamEvent>;

  /** Records a new version of the message, from the text typed in. */
  editMessage: Stream<RoomStreamEvent>;

  /** Deletes the message. */
  deleteMessage: Stream<RoomStreamEvent>;

  /** Obliterates the message. */
  obliterateMessage: Stream<RoomStreamEvent>;

  /** Sends a reply to the message, shown only in its thread. */
  replyInThread: Stream<RoomStreamEvent>;

  /** Sends a reply to the message, shown in its thread and the conversation. */
  replyInBoth: Stream<RoomStreamEvent>;

  /** Sends a reply to the message, shown in the conversation, quoting it. */
  replyInMain: Stream<RoomStreamEvent>;
}

/**
 * One message: its sender, its body, what it replies to, and its reactions,
 * with controls that appear on hover to react, reply, edit, and delete.
 */
export const FabriChatMessageRow = pattern<
  FabriChatMessageRowInput,
  FabriChatMessageRowOutput
>((input) => {
  const {
    message,
    myProfile,
    inThread,
    kind,
    composer,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
  } = input;
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
  const pickerOpen = new Writable.perSession(false);
  const togglePicker = action(() => pickerOpen.set(!pickerOpen.get()));
  const tallies = computed(() => {
    const record = message.get();
    const reactions = (record?.reactions?.get() ?? []) as ChatReaction[];
    const key = entityKeyOf(message.resolveAsCell()) ?? "unsaved";
    return reactionTallies(
      reactions,
      myProfile?.get() === undefined ? undefined : myProfile,
      `fabrichat-reactors-${key}`,
    );
  });
  const cannotWrite = computed(() => !canActIn(messages, myProfile));
  const isDeletedNow = computed(() => isDeleted(message.get()));
  const isMine = computed(() => {
    const author = message.get()?.authorProfile;
    return myProfile?.get() !== undefined && author !== undefined &&
      equals(author, myProfile.resolveAsCell());
  });
  const canObliterate = computed(() => {
    const record = message.get();
    if (record?.authorProfile === undefined || myProfile?.get() === undefined) {
      return false;
    }
    const viewer = myProfile.resolveAsCell();
    return kind === "direct"
      ? equals(record.authorProfile, viewer)
      : FABRICHAT_POLICY.ownersMayObliterate && isOwnerOf(messages);
  });
  const isEditing = computed(() => {
    const editing = composer.get()?.editing;
    return editing !== undefined && equals(editing, message);
  });
  const text = computed(() => bodyText(message.get()));
  const isEdited = computed(() => {
    const record = message.get();
    return record?.editedAt !== undefined && typeof record.body === "string";
  });
  const quote = computed(() => {
    const reply = message.get()?.replyTo;
    return reply?.shownIn === "main" ? bodyText(reply.message.get()) : "";
  });
  // Where the message belongs: the main conversation, the open thread, or
  // both, and how many replies the thread it roots holds.
  const placement = computed(() => {
    const entries = messageEntries(messages);
    const own = entryFor(entries, message);
    if (own === undefined) {
      return { inMain: false, inOpenThread: false, replies: 0 };
    }
    const openRoot = composer.get()?.thread;
    const root = openRoot?.get() === undefined
      ? undefined
      : entryFor(entries, openRoot);
    const byKey = new Map<string, ViewItem>(
      entries.map((entry) => [entry.key, entry]),
    );
    return {
      inMain: isInMain(own),
      inOpenThread: root !== undefined &&
        (own.key === root.key || threadRootOf(own, byKey) === root.key),
      replies: threadReplyCounts(entries).get(own.key) ?? 0,
    };
  });
  const rowDisplay = computed((): ChatDisplay =>
    (inThread ? placement.inOpenThread : placement.inMain) ? "block" : "none"
  );
  const threadLabel = computed(() =>
    placement.replies === 1 ? "1 reply" : `${placement.replies} replies`
  );
  const threadLinkDisplay = computed((): ChatDisplay =>
    !inThread && placement.replies > 0 ? "inline-flex" : "none"
  );
  // What differs by viewer or by session is shown or hidden through a prop,
  // never by building a different tree: a branch chosen per viewer is stored
  // once for everyone, and runtimes that chose differently overwrite each
  // other without end. Each element shown or hidden this way also carries a
  // static `hidden`, which keeps it out of view until its display computed has
  // a value and is outranked by that value once it has one, so an element
  // whose computed has yet to run stays hidden.
  const ownDisplay = computed((): ChatDisplay =>
    isMine && !isDeletedNow ? "inline-flex" : "none"
  );
  const obliterateDisplay = computed((): ChatDisplay =>
    canObliterate ? "inline-flex" : "none"
  );
  const editorDisplay = computed(
    (): ChatDisplay => (isEditing ? "block" : "none"),
  );
  const pickerDisplay = computed((): ChatDisplay =>
    pickerOpen.get() === true ? "flex" : "none"
  );
  const pickerLabel = computed(() => (pickerOpen.get() === true ? "✕" : "☺+"));
  const startReply = action(() => composer.key("replyTo").set(message));
  const openThread = action(() => composer.key("thread").set(message));
  const startEdit = action(() => composer.key("editing").set(message));
  const stopEdit = action(() => composer.key("editing").set(undefined));

  const sendReaction = commitSendReaction({
    myProfile,
    ...records,
    message,
    pickerOpen,
    closesPicker: true,
  });
  const deleteReaction = commitDeleteReaction({
    myProfile,
    ...records,
    message,
  });
  const editMessage = commitEdit({
    myProfile,
    ...records,
    message,
  });
  const deleteMessage = commitDelete({
    myProfile,
    ...records,
    message,
  });
  const obliterateMessage = commitObliterate({
    myProfile,
    ...records,
    message,
  });
  const replyInThread = commitSend({
    myProfile,
    ...records,
    message,
    shownIn: "thread",
  });
  const replyInBoth = commitSend({
    myProfile,
    ...records,
    message,
    shownIn: "both",
  });
  const replyInMain = commitSend({
    myProfile,
    ...records,
    message,
    shownIn: "main",
  });

  return {
    [UI]: (
      <div hidden style={{ display: rowDisplay }}>
        <cf-hover-reveal revealed={pickerOpen}>
          <div
            style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}
          >
            <cf-profile-badge
              variant="circle"
              size="sm"
              $profile={message.key("authorProfile")}
            />
            <cf-vstack gap="1" style={{ flex: "1", minWidth: "0" }}>
              {quote
                ? (
                  <cf-text
                    variant="caption"
                    style={{
                      borderLeft: "3px solid var(--cf-theme-color-border)",
                      paddingLeft: "0.5rem",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {quote}
                  </cf-text>
                )
                : null}
              {isDeletedNow
                ? (
                  <cf-text variant="body" style={{ fontStyle: "italic" }}>
                    {text}
                  </cf-text>
                )
                : (
                  <cf-cfc-authorship
                    $value={message.key("body")}
                    $author={message.key("authorProfile")}
                  >
                    <cf-text
                      variant="body"
                      block
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {text}
                    </cf-text>
                  </cf-cfc-authorship>
                )}
              {isEdited ? <cf-text variant="caption">(edited)</cf-text> : null}
              <div
                data-ui-pattern={CHAT_EDIT_SURFACE}
                data-ui-event-integrity={CHAT_EDIT_SURFACE}
                hidden
                style={{ display: editorDisplay }}
              >
                <cf-hstack gap="1" align="center">
                  <cf-submit-input
                    data-ui-action={CHAT_EDIT_ACTION}
                    placeholder="Edit message"
                    buttonText="Save"
                    disabled={cannotWrite}
                    onClick={editMessage}
                  />
                  <cf-button size="sm" variant="ghost" onClick={stopEdit}>
                    Cancel
                  </cf-button>
                </cf-hstack>
              </div>
              <div
                data-ui-pattern={CHAT_REACT_SURFACE}
                data-ui-event-integrity={CHAT_REACT_SURFACE}
                style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}
              >
                {tallies.map((tally) => (
                  <cf-hover-card>
                    <cf-button
                      data-ui-action={CHAT_REACT_ACTION}
                      aria-describedby={tally.cardId}
                      size="sm"
                      color="primary"
                      variant={tally.mine ? "outline" : "ghost"}
                      disabled={cannotWrite}
                      onClick={commitSendReaction({
                        myProfile,
                        kind,
                        composer,
                        messages,
                        reactionLists,
                        requests,
                        usedTimes,
                        activity,
                        counters,
                        message,
                        emoji: tally.emoji,
                      })}
                    >
                      <span>
                        <span style={EMOJI_STYLE}>{tally.emoji}</span>{" "}
                        {tally.count}
                      </span>
                    </cf-button>
                    <cf-button
                      data-ui-action={CHAT_UNREACT_ACTION}
                      size="sm"
                      variant="ghost"
                      aria-label="Remove my reaction"
                      title="Remove my reaction"
                      disabled={cannotWrite}
                      hidden
                      style={{ display: tally.mine ? "inline-flex" : "none" }}
                      onClick={commitDeleteReaction({
                        myProfile,
                        kind,
                        composer,
                        messages,
                        reactionLists,
                        requests,
                        usedTimes,
                        activity,
                        counters,
                        message,
                        emoji: tally.emoji,
                      })}
                    >
                      ✕
                    </cf-button>
                    <cf-vstack id={tally.cardId} slot="card" gap="1">
                      {tally.reactors.map((reactor) => (
                        <cf-profile-badge
                          size="sm"
                          noNavigate
                          $profile={reactor}
                        />
                      ))}
                    </cf-vstack>
                  </cf-hover-card>
                ))}
              </div>
              <cf-button
                size="sm"
                variant="link"
                hidden
                style={{ display: threadLinkDisplay }}
                onClick={openThread}
              >
                {threadLabel}
              </cf-button>
            </cf-vstack>
          </div>
          <cf-hstack slot="actions" gap="1" align="center">
            <div
              data-ui-pattern={CHAT_REACT_SURFACE}
              data-ui-event-integrity={CHAT_REACT_SURFACE}
              hidden
              style={{
                display: pickerDisplay,
                gap: "0.25rem",
                alignItems: "center",
              }}
            >
              {FABRICHAT_QUICK_REACTIONS.map((emoji) => (
                <cf-button
                  data-ui-action={CHAT_REACT_ACTION}
                  size="sm"
                  variant="ghost"
                  disabled={cannotWrite}
                  onClick={commitSendReaction({
                    myProfile,
                    kind,
                    composer,
                    messages,
                    reactionLists,
                    requests,
                    usedTimes,
                    activity,
                    counters,
                    message,
                    emoji,
                    pickerOpen,
                    closesPicker: true,
                  })}
                >
                  <span style={EMOJI_STYLE}>{emoji}</span>
                </cf-button>
              ))}
              <cf-submit-input
                data-ui-action={CHAT_REACT_ACTION}
                placeholder="Any emoji"
                buttonText="React"
                disabled={cannotWrite}
                onClick={sendReaction}
              />
            </div>
            {isDeletedNow ? null : (
              <cf-button
                size="sm"
                variant="ghost"
                aria-label="Add reaction"
                title="Add reaction"
                disabled={cannotWrite}
                onClick={togglePicker}
              >
                <span style={EMOJI_STYLE}>{pickerLabel}</span>
              </cf-button>
            )}
            {isDeletedNow || inThread
              ? null
              : (
                <cf-button size="sm" variant="ghost" onClick={startReply}>
                  Reply
                </cf-button>
              )}
            {isDeletedNow || inThread
              ? null
              : (
                <cf-button size="sm" variant="ghost" onClick={openThread}>
                  Thread
                </cf-button>
              )}
            <cf-button
              size="sm"
              variant="ghost"
              hidden
              style={{ display: ownDisplay }}
              onClick={startEdit}
            >
              Edit
            </cf-button>
            <div
              data-ui-pattern={CHAT_DELETE_SURFACE}
              data-ui-event-integrity={CHAT_DELETE_SURFACE}
              style={{ display: "flex" }}
            >
              <cf-button
                data-ui-action={CHAT_DELETE_ACTION}
                size="sm"
                variant="ghost"
                hidden
                style={{ display: ownDisplay }}
                onClick={deleteMessage}
              >
                Delete
              </cf-button>
            </div>
            <div
              data-ui-pattern={CHAT_OBLITERATE_SURFACE}
              data-ui-event-integrity={CHAT_OBLITERATE_SURFACE}
              style={{ display: "flex" }}
            >
              <cf-button
                data-ui-action={CHAT_OBLITERATE_ACTION}
                size="sm"
                variant="ghost"
                hidden
                style={{ display: obliterateDisplay }}
                onClick={obliterateMessage}
              >
                Remove entirely
              </cf-button>
            </div>
          </cf-hstack>
        </cf-hover-reveal>
      </div>
    ),
    tallies,
    sendReaction,
    deleteReaction,
    editMessage,
    deleteMessage,
    obliterateMessage,
    replyInThread,
    replyInBoth,
    replyInMain,
  };
});
