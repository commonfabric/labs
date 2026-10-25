/**
 * One message of a FabriChat room, rendered: `FabriChatMessageRow`, with its
 * reviewed surfaces for reacting, editing, deleting, and obliterating, and the
 * reaction tallies, body text and attachments it shows.
 */
import {
  action,
  type Cell,
  computed,
  equals,
  pattern,
  type PerSession,
  type ReadonlyCell,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { FileEntry } from "../fabrifile/schemas.tsx";
import type { ViewPlace } from "./logic.ts";
import {
  commitDelete,
  commitDeleteReaction,
  commitEdit,
  commitObliterate,
  commitReply,
  commitSendReaction,
  type ComposerCell,
  entityKeyOf,
  isDeleted,
  type JoiningManager,
  type MessageCell,
  messageRightsOf,
  type MessagesCell,
  NO_MESSAGE_RIGHTS,
  type ReactionsValue,
  type RepliedMessage,
  type RoomStreamEvent,
  tellManagerJoined,
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

  /**
   * The viewer's reaction with this emoji, the one `deleteReaction` removes;
   * absent where `mine` is false.
   */
  own?: Cell<ChatReaction>;
}

/**
 * The reactions `list` holds, tallied as `reactionTalliesOf()` does, each
 * tally with a card id made from `cardIdPrefix` and, where the viewer is
 * among its reactors, the viewer's reaction by its cell.
 */
export const reactionTallies = (
  list: Cell<ReactionsValue> | undefined,
  viewer: ProfileCell | undefined,
  cardIdPrefix: string,
): ReactionTally[] => {
  const reactions = (list?.get() ?? []) as ChatReaction[];
  return reactionTalliesOf(reactions, viewer).map((tally, index) => {
    const own = viewer === undefined
      ? -1
      : reactions.findIndex((reaction) =>
        reaction?.emoji === tally.emoji &&
        equals(reaction.reactorProfile, viewer)
      );
    return {
      ...tally,
      cardId: `${cardIdPrefix}-${index}`,
      ...(own < 0 || list === undefined ? {} : { own: list.key(own) }),
    };
  });
};

/** How a message's body reads, for a quote or a deleted message. */
export const bodyText = (record: RepliedMessage | undefined): string =>
  record === undefined
    ? ""
    : typeof record.body === "string"
    ? record.body
    : record.authorProfile === undefined
    ? "This message was removed."
    : "This message was deleted.";

/** How a reaction's emoji is drawn. */
const EMOJI_STYLE = { fontSize: "18px", lineHeight: "1" };

/** What one attachment of a message renders. */
interface AttachmentInput {
  /** The file, an entry of the message's space's store. */
  entry: Cell<FileEntry>;
}

/**
 * One file a message attaches: a preview where it is an image, and a link that
 * downloads it, each read through the entry under the viewer's own access; a
 * note that the entry was removed from its store, once it is; or a note that
 * the file can't be shown, to a viewer who can't read the entry. Which of
 * them shows differs by viewer, so each is in the tree and shown or hidden
 * through a prop, as the row's own controls are.
 */
const FabriChatAttachment = pattern<AttachmentInput, { [UI]: VNode }>(
  ({ entry }) => {
    const name = computed(() => entry.get()?.name ?? "");
    const mediaType = computed(() => entry.get()?.mediaType ?? "");
    const blob = computed(() => entry.get()?.blob);
    const shown = computed((): "file" | "removed" | "unreadable" => {
      const value = entry.get();
      return value === undefined
        ? "unreadable"
        : value.removedAt !== undefined
        ? "removed"
        : "file";
    });
    const fileDisplay = computed((): ChatDisplay =>
      shown === "file" ? "flex" : "none"
    );
    const imageDisplay = computed((): ChatDisplay =>
      shown === "file" && (entry.get()?.mediaType ?? "").startsWith("image/")
        ? "block"
        : "none"
    );
    const removedDisplay = computed((): ChatDisplay =>
      shown === "removed" ? "block" : "none"
    );
    const unreadableDisplay = computed((): ChatDisplay =>
      shown === "unreadable" ? "block" : "none"
    );
    return {
      [UI]: (
        <div>
          <div
            hidden
            style={{
              display: fileDisplay,
              flexDirection: "column",
              gap: "0.25rem",
            }}
          >
            <div hidden style={{ display: imageDisplay }}>
              <cf-image
                blob={blob}
                media-type={mediaType}
                alt={name}
                style="max-width: 16rem; max-height: 16rem;"
              />
            </div>
            <cf-blob-link blob={blob} name={name}>{name}</cf-blob-link>
          </div>
          <div hidden style={{ display: removedDisplay }}>
            <cf-text variant="caption" style={{ fontStyle: "italic" }}>
              This file was removed.
            </cf-text>
          </div>
          <div hidden style={{ display: unreadableDisplay }}>
            <cf-text variant="caption" style={{ fontStyle: "italic" }}>
              This file can't be shown.
            </cf-text>
          </div>
        </div>
      ),
    };
  },
);

/** What a message row needs. */
export interface FabriChatMessageRowInput {
  /** The message. */
  message: MessageCell;

  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /**
   * Whether the row belongs to the open thread's list rather than the main
   * conversation's. The main conversation's list holds a row for each message
   * shown there, and the thread's list for each message of the session's open
   * thread; a row's list decides which of the row's controls it offers.
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
   * Whether the room lets an OWNER of its space obliterate any message;
   * absent, it doesn't.
   */
  ownersMayObliterate?: boolean;

  /** The room's messages, which a reply is pushed onto. */
  messages: MessagesCell;

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
  /** The message's rendering. */
  [UI]: VNode;

  /** The message's reactions, tallied by emoji. */
  tallies: ReactionTally[];

  /** Adds the viewer's reaction: `emoji`, or the text typed in. */
  sendReaction: Stream<RoomStreamEvent>;

  /** Removes the viewer's reaction: the one `reaction` names. */
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
    ownersMayObliterate,
    messages,
    canJoin,
    container,
    manager,
    self,
  } = input;
  const joined = tellManagerJoined({ canJoin, container, manager, self });
  const pickerOpen = new Writable.perSession(false);
  const togglePicker = action(() => pickerOpen.set(!pickerOpen.get()));
  // How the message reads, the same for every viewer. A row costs a run of
  // each of its computeds for each message, so what reads the message alone
  // is one computed.
  const shown = computed(() => {
    const record = message.get();
    const reply = record?.replyTo;
    return {
      isDeleted: isDeleted(record),
      text: bodyText(record),
      attachments: record?.attachments ?? [],
      isEdited: record?.editedAt !== undefined &&
        typeof record.body === "string",
      quote: reply?.shownIn === "main" ? bodyText(reply.message.get()) : "",
    };
  });
  // How many replies the thread the message roots holds. The room derives
  // every message's place at once, from its messages alone, so whichever
  // runtime runs the room computes them for every viewer. The row reads its
  // own, and runs again only when that one changes.
  const thread = computed((): { label: string; display: ChatDisplay } => {
    const key = viewKeyOf(message);
    const replies =
      (key === undefined ? undefined : places.key(key).get())?.replies ?? 0;
    return {
      label: replies === 1 ? "1 reply" : `${replies} replies`,
      display: !inThread && replies > 0 ? "inline-flex" : "none",
    };
  });
  // What differs by viewer or by session is shown or hidden through a prop,
  // never by building a different tree: a branch chosen per viewer is stored
  // once for everyone, and runtimes that chose differently overwrite each
  // other without end. Each element shown or hidden this way also carries a
  // static `hidden`, which keeps it out of view until the computed holding its
  // display has a value and is outranked by that value once it has one, so an
  // element whose computed has yet to run stays hidden. A computed that reads
  // the viewer's or the session's state has a value only once a runtime acting
  // for that viewer runs the room, which one that only renders it does not,
  // so which rows the main conversation holds, which every viewer is shown,
  // is decided from the room's messages alone, by the room.
  //
  // A runtime serving the room runs a computed that reads the viewer once
  // for every viewer, and one that reads the session once for every session,
  // so what each one shows is one computed: the viewer's tallies and what
  // they may do to the message, and what the session has open on it.
  //
  // What the viewer may do follows the rule the room's handlers admit an act
  // by, and none of it while they can't write in the room. The rule reads the
  // message's author and body, and is handed those two alone.
  const viewer = computed((): {
    tallies: ReactionTally[];
    canEdit: boolean;
    editDisplay: ChatDisplay;
    deleteDisplay: ChatDisplay;
    obliterateDisplay: ChatDisplay;
  } => {
    const key = entityKeyOf(message.resolveAsCell()) ?? "unsaved";
    const record = message.get();
    const rights = cannotWrite || myProfile?.get() === undefined
      ? NO_MESSAGE_RIGHTS
      : messageRightsOf(
        record === undefined
          ? undefined
          : { authorProfile: record.authorProfile, body: record.body },
        myProfile.resolveAsCell(),
        kind,
        isOwner === true,
        ownersMayObliterate === true,
      );
    return {
      tallies: reactionTallies(
        record?.reactions,
        myProfile?.get() === undefined ? undefined : myProfile,
        `fabrichat-reactors-${key}`,
      ),
      canEdit: rights.canEdit,
      editDisplay: rights.canEdit ? "inline-flex" : "none",
      deleteDisplay: rights.canDelete ? "inline-flex" : "none",
      obliterateDisplay: rights.canObliterate ? "inline-flex" : "none",
    };
  });
  // What the session has open on the message: its editor, which closes once
  // the message no longer takes an edit from the viewer, as when an OWNER
  // deletes it, and its reaction picker.
  const session = computed((): {
    editorDisplay: ChatDisplay;
    pickerDisplay: ChatDisplay;
    pickerLabel: string;
  } => {
    const editing = composer.get()?.editing;
    const isEditing = editing !== undefined && equals(editing, message);
    const pickerShown = pickerOpen.get() === true;
    return {
      editorDisplay: isEditing && viewer.canEdit ? "block" : "none",
      pickerDisplay: pickerShown ? "flex" : "none",
      pickerLabel: pickerShown ? "✕" : "☺+",
    };
  });
  const startReply = action(() => composer.key("replyTo").set(message));
  const openThread = action(() => composer.key("thread").set(message));
  const startEdit = action(() => composer.key("editing").set(message));
  const stopEdit = action(() => composer.key("editing").set(undefined));

  // Each handler is bound to the cells it uses and no others; `messages`
  // takes the replies, and names the room's space to the acts on a message.
  const sendReaction = commitSendReaction({
    myProfile,
    room: messages,
    message,
    pickerOpen,
    closesPicker: true,
    joined,
  });
  const deleteReaction = commitDeleteReaction({
    myProfile,
    room: messages,
    message,
  });
  const editMessage = commitEdit({
    myProfile,
    room: messages,
    message,
    composer,
  });
  const deleteMessage = commitDelete({
    myProfile,
    room: messages,
    message,
  });
  const obliterateMessage = commitObliterate({
    myProfile,
    room: messages,
    message,
    kind,
    ownersMayObliterate,
  });
  const replyInThread = commitReply({
    myProfile,
    messages,
    message,
    shownIn: "thread",
    joined,
  });
  const replyInBoth = commitReply({
    myProfile,
    messages,
    message,
    shownIn: "both",
    joined,
  });
  const replyInMain = commitReply({
    myProfile,
    messages,
    message,
    shownIn: "main",
    joined,
  });

  return {
    [UI]: (
      // A row is built only for a message its list shows: the main
      // conversation's rows are the room's shared choice, and a thread row is
      // the session's, for a message of its open thread.
      <div>
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
              {shown.quote
                ? (
                  <cf-text
                    variant="caption"
                    style={{
                      borderLeft: "3px solid var(--cf-theme-color-border)",
                      paddingLeft: "0.5rem",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {shown.quote}
                  </cf-text>
                )
                : null}
              {shown.isDeleted
                ? (
                  <cf-text variant="body" style={{ fontStyle: "italic" }}>
                    {shown.text}
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
                      {shown.text}
                    </cf-text>
                  </cf-cfc-authorship>
                )}
              {shown.attachments.map((entry) => (
                <FabriChatAttachment entry={entry} />
              ))}
              {shown.isEdited
                ? <cf-text variant="caption">(edited)</cf-text>
                : null}
              <div
                data-ui-pattern={CHAT_EDIT_SURFACE}
                data-ui-event-integrity={CHAT_EDIT_SURFACE}
                hidden
                style={{ display: session.editorDisplay }}
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
                {viewer.tallies.map((tally) => (
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
                        room: messages,
                        message,
                        emoji: tally.emoji,
                        joined,
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
                        room: messages,
                        message,
                        reaction: tally.own,
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
                style={{ display: thread.display }}
                onClick={openThread}
              >
                {thread.label}
              </cf-button>
            </cf-vstack>
          </div>
          <cf-hstack slot="actions" gap="1" align="center">
            <div
              data-ui-pattern={CHAT_REACT_SURFACE}
              data-ui-event-integrity={CHAT_REACT_SURFACE}
              hidden
              style={{
                display: session.pickerDisplay,
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
                    room: messages,
                    message,
                    emoji,
                    pickerOpen,
                    closesPicker: true,
                    joined,
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
            {shown.isDeleted ? null : (
              <cf-button
                size="sm"
                variant="ghost"
                aria-label="Add reaction"
                title="Add reaction"
                disabled={cannotWrite}
                onClick={togglePicker}
              >
                <span style={EMOJI_STYLE}>{session.pickerLabel}</span>
              </cf-button>
            )}
            {shown.isDeleted || inThread
              ? null
              : (
                <cf-button size="sm" variant="ghost" onClick={startReply}>
                  Reply
                </cf-button>
              )}
            {shown.isDeleted || inThread
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
              style={{ display: viewer.editDisplay }}
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
                style={{ display: viewer.deleteDisplay }}
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
                style={{ display: viewer.obliterateDisplay }}
                onClick={obliterateMessage}
              >
                Remove entirely
              </cf-button>
            </div>
          </cf-hstack>
        </cf-hover-reveal>
      </div>
    ),
    tallies: viewer.tallies,
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
