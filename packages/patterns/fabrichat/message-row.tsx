/**
 * One message of a FabriChat room, rendered: `FabriChatMessageRow`, with its
 * reviewed surfaces for reacting, editing, deleting, and obliterating, and the
 * reaction tallies and body text it shows.
 */
import {
  action,
  type Cell,
  computed,
  equals,
  pattern,
  type PerSession,
  principalOf,
  type ReadonlyCell,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { ViewPlace } from "./logic.ts";
import {
  type ActivityCell,
  type ActivityCountersCell,
  type ActRefusalCell,
  commitDelete,
  commitDeleteReaction,
  commitEdit,
  commitObliterate,
  commitSend,
  commitSendReaction,
  type ComposerCell,
  entityKeyOf,
  isDeleted,
  isObliterated,
  type JoiningManager,
  type MessageCell,
  type MessageRecord,
  type MessageRequestsCell,
  messageRightsOf,
  type MessagesCell,
  NO_MESSAGE_RIGHTS,
  ownersMayObliterateBy,
  type ReactionListsCell,
  type RequestsCell,
  type RoomStreamEvent,
  tellManagerJoined,
  type UsedTimesCell,
  viewKeyOf,
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
  type ChatContainer,
  type ChatDisplay,
  type ChatReaction,
  type ChatReactionTally,
  type ChatRoomKind,
  type ChatRoomLink,
  type ChatRoomPolicy,
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
    : isObliterated(record)
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
   * conversation's. Every message has a row in the main conversation's list,
   * shown only where the message belongs there. The thread's list holds a row
   * only for a message of the session's open thread, and shows each one.
   */
  inThread: boolean;

  /** The room's kind. */
  kind: ChatRoomKind;

  /** The session's composer state. */
  composer: PerSession<ComposerCell>;

  /**
   * Every message's place in the room's views, by the message's key, as the
   * room derives them from its messages. The row reads its own message's.
   */
  places: ReadonlyCell<Record<string, ViewPlace>>;

  /** Whether the viewer can't send, edit, delete, or react in the room. */
  cannotWrite: boolean;

  /** Whether the viewer holds OWNER in the room's space. */
  isOwner: boolean;

  /**
   * The room's policy, as `about.policy` links it, whose `ownersMayObliterate`
   * says whether an OWNER may obliterate; absent or unread, no OWNER may.
   */
  policy?: Cell<ChatRoomPolicy>;

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

  /** The sender's outcomes, by `requestId`; absent where none are kept. */
  outcomes?: MessageRequestsCell;

  /**
   * Why the session's latest act was refused, which the composer shows;
   * absent where nothing shows it.
   */
  refusal?: ActRefusalCell;

  /** Whether the room is one the viewer's manager can take them into. */
  canJoin?: boolean;

  /** The container's declaration for a room held inside another space. */
  container?: Cell<ChatContainer>;

  /**
   * The viewer's manager, which a write tells it joined the room; absent
   * while the viewer has none, or theirs hasn't resolved.
   */
  manager?: JoiningManager;

  /** The room itself, as the viewer's manager links it. */
  self?: Cell<ChatRoomLink>;
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
    places,
    cannotWrite,
    isOwner,
    policy,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    outcomes,
    refusal,
    canJoin,
    container,
    manager,
    self,
  } = input;
  const joined = tellManagerJoined({ canJoin, container, manager, self });
  const records = {
    kind,
    policy,
    composer,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    outcomes,
    refusal,
    joined,
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
  const isDeletedNow = computed(() => isDeleted(message.get()));
  // What the viewer may do to the message, by the rule the room's handlers
  // admit an act by, and none of it while they can't write in the room.
  const rights = computed(() =>
    cannotWrite || myProfile?.get() === undefined
      ? NO_MESSAGE_RIGHTS
      : messageRightsOf(
        message.get(),
        principalOf(myProfile, "represents-principal") !== undefined &&
          principalOf(message, "authored-by") ===
            principalOf(myProfile, "represents-principal"),
        kind,
        isOwner === true,
        ownersMayObliterateBy(policy),
      )
  );
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
  // Where the views show the message. The room derives every message's place
  // at once, from its messages alone, so whichever runtime runs the room
  // computes them for every viewer. The row reads its own, and runs again
  // only when that one changes.
  const place = computed(() => {
    const key = viewKeyOf(message);
    const own = key === undefined ? undefined : places.key(key).get();
    return { inMain: own?.inMain === true, replies: own?.replies ?? 0 };
  });
  const mainRowDisplay = computed((): ChatDisplay =>
    place.inMain ? "block" : "none"
  );
  const threadLabel = computed(() =>
    place.replies === 1 ? "1 reply" : `${place.replies} replies`
  );
  const threadLinkDisplay = computed((): ChatDisplay =>
    !inThread && place.replies > 0 ? "inline-flex" : "none"
  );
  // What differs by viewer or by session is shown or hidden through a prop,
  // never by building a different tree: a branch chosen per viewer is stored
  // once for everyone, and runtimes that chose differently overwrite each
  // other without end. Each element shown or hidden this way also carries a
  // static `hidden`, which keeps it out of view until its display computed has
  // a value and is outranked by that value once it has one, so an element
  // whose computed has yet to run stays hidden. A computed that reads the
  // viewer's or the session's state has a value only once a runtime acting
  // for that viewer runs the room, which one that only renders it does not,
  // so a row's place in the main conversation, which every viewer is shown,
  // is decided from the room's messages alone.
  const editDisplay = computed((): ChatDisplay =>
    rights.canEdit ? "inline-flex" : "none"
  );
  const deleteDisplay = computed((): ChatDisplay =>
    rights.canDelete ? "inline-flex" : "none"
  );
  const obliterateDisplay = computed((): ChatDisplay =>
    rights.canObliterate ? "inline-flex" : "none"
  );
  // An open editor closes once the message no longer takes an edit from the
  // viewer, as when an OWNER deletes it.
  const editorDisplay = computed((): ChatDisplay =>
    isEditing && rights.canEdit ? "block" : "none"
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
      // A row of the main conversation takes its display from shared state
      // alone, never the session's, or a viewer whose runtime only renders
      // the room would have the row hidden for good. A thread row is built
      // only for a message of the session's open thread, so it is shown
      // wherever it exists.
      <div
        hidden
        style={{ display: inThread ? "block" : mainRowDisplay }}
      >
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
                        outcomes,
                        refusal,
                        joined,
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
                        outcomes,
                        refusal,
                        joined,
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
                    outcomes,
                    refusal,
                    joined,
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
              style={{ display: editDisplay }}
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
                style={{ display: deleteDisplay }}
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
