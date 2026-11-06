/**
 * A shared Markdown document with Fabric profile names on live cursors and
 * comments on ranges of its text.
 */

import {
  anchorsOf,
  type AuthoredByCurrentUser,
  type Cell,
  computed,
  currentPrincipal,
  Default,
  type FieldAnchors,
  FS,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  principalOf,
  profileOwnerOf,
  type Stream,
  TILE_UI,
  UI,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import { normalizePresenceParticipantName } from "./participant-name.ts";

/** What a viewer's Fabric profile shows: a name and an avatar, where set. */
export interface NoteProfile {
  name?: string;
  avatar?: string;
}

/** A live link to a person's profile. */
export type ProfileCell = Cell<NoteProfile>;

/** Initial document values, shared by every viewer of this piece. */
export interface SharedNoteInput {
  /** Editable document title, independent of Markdown frontmatter. */
  title?: PerSpace<string | Default<"Untitled note">>;

  /** LF-normalized Markdown; live editing uses CodeMirror operations. */
  content?: PerSpace<string | Default<"">>;

  /**
   * Comments on the body, one keyed record per comment. A record with
   * `draft` set is a comment its author is still writing.
   */
  comments?: PerSpace<StoredComment[] | Default<[]>>;
}

/** Readable Markdown and the same compact view for standalone and embedded use. */
export interface SharedNoteOutput {
  [NAME]: string;
  [UI]: VNode;
  [TILE_UI]: VNode;

  /**
   * The note as `index.md`: the title in the frontmatter, then the body, both
   * linked to the fields below. A filesystem save writes both back. Once an
   * editor has changed the body, a save that changes it too is refused, and
   * the body is edited through the verbs below instead.
   */
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };

  title: PerSpace<string>;
  content: PerSpace<string>;
  comments: PerSpace<StoredComment[]>;
  participantName: PerUser<string>;

  /**
   * Where each comment's text is now: the body's anchors, two per comment,
   * drafts included. The text of the comment `id` runs from the anchor
   * `<id>:from` to the anchor `<id>:to`. `undefined` until the body first
   * holds an anchor.
   */
  commentAnchors: FieldAnchors | undefined;

  /** Adds `text` to the end of the document, on a line of its own. */
  appendLine: Stream<LineEvent>;

  /** Adds `text` to the start of the document, on a line of its own. */
  prependLine: Stream<LineEvent>;

  /**
   * Replaces the one occurrence of `old` in the document with `new`, and
   * refuses when `old` is empty, occurs nowhere, or occurs more than once.
   */
  replaceText: Stream<ReplaceTextEvent>;

  /**
   * Comments under the caller's profile on the one occurrence of `quote` in
   * the body, and refuses when `quote` is empty, occurs nowhere, or occurs
   * more than once, when `body` has no text, or when the caller has no
   * profile.
   */
  addComment: Stream<AddCommentEvent>;

  /** Replies to the comment `id` under the caller's profile. */
  replyToComment: Stream<CommentReplyEvent>;

  /** Marks the comment `id` resolved: it stays listed and marks no text. */
  resolveComment: Stream<CommentIdEvent>;

  /** Marks the comment `id` open again. */
  reopenComment: Stream<CommentIdEvent>;

  /** Deletes the comment `id`, which only its author can do. */
  deleteComment: Stream<CommentIdEvent>;
}

/** Text to add as a line of its own. */
export interface LineEvent {
  /** The line, without a trailing newline. */
  text: string;
}

/** An exact replacement anchored on text the document holds once. */
export interface ReplaceTextEvent {
  /** Text the document holds exactly once, compared code unit for code unit. */
  old: string;

  /** Text that takes its place. */
  new: string;
}

/** A comment on text the body holds once. */
export interface AddCommentEvent {
  /** Text the body holds exactly once, compared code unit for code unit. */
  quote: string;

  /** The comment. */
  body: string;
}

/** Names a comment. */
export interface CommentIdEvent {
  /** The comment's `id`. */
  id: string;
}

/** A reply to a comment. */
export interface CommentReplyEvent extends CommentIdEvent {
  /** The reply. */
  body: string;
}

// The verbs edit the body through `applyChanges()` rather than `set()`: once an
// editor has opened the body it accepts only edits, which the open editors
// merge with their own typing. Each edit's positions refer to the text the verb
// read, and land only while the body still holds it; a body that moved on
// refuses the commit, and the verb runs again against the new text. Memory
// moves every comment's anchor through the edit as it stores it.

const appendLine = handler<LineEvent, { content: Writable<string> }>(
  ({ text }, { content }) => {
    const current = content.get();
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    content.applyChanges({ from: current.length, insert: separator + text });
  },
);

const prependLine = handler<LineEvent, { content: Writable<string> }>(
  ({ text }, { content }) => {
    const current = content.get();
    const separator = current === "" || text.endsWith("\n") ? "" : "\n";
    content.applyChanges({ from: 0, insert: text + separator });
  },
);

/**
 * Where `text` occurs in `body`, which must be exactly once.
 *
 * @throws If `text` is empty, occurs nowhere, or occurs more than once;
 *   `verb` and `field` name the call and its argument in the message.
 */
const onlyOccurrence = (
  body: string,
  text: string,
  verb: string,
  field: string,
): number => {
  if (text === "") {
    throw new Error(`${verb} needs a non-empty \`${field}\` to anchor on`);
  }
  const from = body.indexOf(text);
  if (from === -1) {
    throw new Error(
      `${verb} found no occurrence of \`${field}\`; read the note again and ` +
        "anchor on text it holds",
    );
  }
  if (body.indexOf(text, from + 1) !== -1) {
    throw new Error(
      `${verb} found \`${field}\` more than once; anchor on a longer ` +
        "passage that occurs once",
    );
  }
  return from;
};

const replaceText = handler<ReplaceTextEvent, { content: Writable<string> }>(
  (event, { content }) => {
    if (event.old === "") {
      throw new Error(
        "replaceText needs a non-empty `old` to anchor on; to add text, use " +
          "`appendLine` or `prependLine`",
      );
    }
    const from = onlyOccurrence(content.get(), event.old, "replaceText", "old");
    content.applyChanges({
      from,
      to: from + event.old.length,
      insert: event.new,
    });
  },
);

const reportError = handler<
  { detail: { message?: string } },
  { error: Writable<string> }
>((event, { error }) => {
  error.set(
    event.detail.message || "Editing paused. Reopen this note to reconnect.",
  );
});

const preserveUnsentText = handler<
  { detail: { localValue: string } },
  { recovery: Writable<string | null> }
>((event, { recovery }) => {
  recovery.set(event.detail.localValue);
});

// A presence failure removes live cursors and leaves editing alone. The editor
// tries a `configuration` failure again only when the room or name changes,
// and any other failure when it next gains focus. A failure while it has focus
// keeps focus, so the viewer has to leave the note and come back.
const reportPresenceError = handler<
  { detail: { category?: string } },
  { presenceNotice: Writable<string> }
>((event, { presenceNotice }) => {
  presenceNotice.set(
    event.detail.category === "configuration"
      ? "Live cursors are unavailable on this server. Editing still works."
      : "Live cursors are unavailable. Editing still works; click outside the note, then back into it to try again.",
  );
});

const clearPresenceNotice = handler<
  unknown,
  { presenceNotice: Writable<string> }
>((_, { presenceNotice }) => {
  presenceNotice.set("");
});

//
// Comments
//
// A comment says which text it is about through two anchors of the body,
// one where its text starts and one where it ends. Memory moves both through
// every edit, whoever makes it, so the comment stores no position. A handler
// changes the anchors as it changes any cell: it reads the body and the
// anchors and writes the anchors, and its commit lands only while both are
// still what it read. Comments and replies are labeled `authored-by` whoever
// wrote them, by the runtime, and only the handlers their policies name can
// write them.
//

/** A reply to a comment. */
export interface ReplyRecord {
  /** The profile the reply was written under. */
  authorProfile: ProfileCell;

  /** The reply. */
  body: string;

  /** The handler clock when the reply was written, in milliseconds. */
  postedAt: number;
}

/** A stored reply: written by `commitReply` alone, labeled with its author. */
export type StoredReply = AuthoredByCurrentUser<
  WriteAuthorizedBy<ReplyRecord, typeof commitReply>
>;

/** The replies to one comment, in the order they were written. */
export type RepliesValue = StoredReply[] | Default<[]>;

/** A comment on a range of the body. */
export interface CommentRecord {
  /** The comment's id, which its two anchors on the body are named for. */
  id: string;

  /** The profile the comment was written under. */
  authorProfile: ProfileCell;

  /** The comment; empty while it is a draft. */
  body: string;

  /**
   * Whether the comment is still being written. A draft holds its anchors
   * from the moment its author opens the composer; it is listed only to its
   * author, who can continue or discard it, and marks no text for anyone
   * else.
   */
  draft: boolean;

  /**
   * The text between the anchors when the comment was written, shown once
   * an edit has deleted that text from the body.
   */
  quote: string;

  /** The handler clock when the comment was written, in milliseconds. */
  postedAt: number;

  /**
   * The comment's replies, a list of its own that anyone may add to under
   * their own name.
   */
  replies: Writable<RepliesValue>;

  /**
   * Whether the comment is settled, a cell of its own that anyone may set. A
   * resolved comment marks no text.
   */
  resolved: Writable<boolean | Default<false>>;
}

/**
 * A stored comment, one keyed record under its id. Only the handlers that
 * start, post and delete a comment can write the record, and each labels it
 * `authored-by` the person it runs for. A later schema can neither add a
 * writer to the policy nor drop one.
 */
export type StoredComment = AuthoredByCurrentUser<
  WritePolicyAnyOf<CommentRecord, [
    WriteAuthorizedBy<unknown, typeof openComposer>,
    WriteAuthorizedBy<unknown, typeof postComment>,
    WriteAuthorizedBy<unknown, typeof addComment>,
    WriteAuthorizedBy<unknown, typeof deleteComment>,
    WriteAuthorizedBy<unknown, typeof discardDraft>,
  ]>
>;

type CommentsCell = Writable<StoredComment[] | Default<[]>>;

/** The body's anchors, as a handler reads and writes them. */
type AnchorsCell = Writable<FieldAnchors | undefined>;

/** The id of the anchor where the text of the comment `id` starts. */
const fromAnchorOf = (id: string): string => `${id}:from`;

/** The id of the anchor where the text of the comment `id` ends. */
const toAnchorOf = (id: string): string => `${id}:to`;

/**
 * Anchors the comment `id` on `from` up to `to` of the body, beside the
 * anchors the body already holds. The caller has read the body in the same
 * handler, so the offsets refer to the text the commit lands on.
 */
const anchorComment = (
  anchors: AnchorsCell,
  id: string,
  from: number,
  to: number,
): void => {
  // Memory bounds what a field's anchors document may hold, and refuses a
  // commit past its bounds with an error that says so; the note leaves those
  // bounds to Memory rather than restating them here.
  anchors.set({
    ...anchors.get(),
    [fromAnchorOf(id)]: from,
    [toAnchorOf(id)]: to,
  });
};

/** Removes the two anchors of the comment `id`, leaving the others. */
const unanchorComment = (anchors: AnchorsCell, id: string): void => {
  const {
    [fromAnchorOf(id)]: _from,
    [toAnchorOf(id)]: _to,
    ...others
  } = anchors.get() ?? {};
  anchors.set(others);
};

/**
 * The editor's main selection, as the note keeps it: a range of the body and
 * the text there. `from === to` is nothing selected.
 */
interface NoteSelection {
  from: number;
  to: number;
  text: string;
}

const NOTHING_SELECTED: NoteSelection = { from: 0, to: 0, text: "" };

/**
 * What `cf-selection-change` reports: the selection as a range of the
 * editor's text, and the whole of that text, `value`, which the range is
 * right for.
 */
interface SelectionReport extends NoteSelection {
  value: string;
}

/** A mark the editor draws: the text from one anchor of the body to another. */
interface NoteHighlight {
  id: string;
  fromAnchor: string;
  toAnchor: string;
  kind?: string;
}

/** The mark on the text of the comment `id`, of `kind` where one is given. */
const highlightOf = (id: string, kind?: string): NoteHighlight => ({
  id,
  fromAnchor: fromAnchorOf(id),
  toAnchor: toAnchorOf(id),
  ...(kind === undefined ? {} : { kind }),
});

/** The `display` of an element a session shows or hides. */
type NoteDisplay = "block" | "flex" | "none";

/** What one session sees of a comment's row. */
interface RowDisplay {
  row: NoteDisplay;
  border: string;
}

/**
 * What one session sees of the actions on its selected comment: whether
 * they are shown, where among the rows, and which of them.
 */
interface ActionsDisplay {
  bar: NoteDisplay;
  order: number;
  resolve: NoteDisplay;
  reopen: NoteDisplay;
  delete: NoteDisplay;
}

/**
 * How many places in the panel's order one comment takes: its row, then the
 * actions on it.
 */
const PLACES_PER_COMMENT = 2;

/**
 * Why an act from a viewer whose profile hasn't resolved, or isn't their own,
 * is refused.
 */
const NO_PROFILE = "Choose a Fabric profile of your own to comment.";

/** How long a quote shown beside a comment may run before it is cut. */
const EXCERPT_LENGTH = 80;

/** `text` on one line, cut to `EXCERPT_LENGTH` characters. */
const excerptOf = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  return characters.length <= EXCERPT_LENGTH
    ? line
    : `${characters.slice(0, EXCERPT_LENGTH - 1).join("")}…`;
};

/**
 * The profile `myProfile` resolves to, once it holds a value and is the
 * profile of the person the handler runs for; `undefined` otherwise. A
 * comment or reply is labeled as written by that person and shows the profile
 * it stores, so a profile of someone else's would show them as its author.
 */
const ownProfile = (
  myProfile: ProfileCell | undefined,
): ProfileCell | undefined => {
  const profile = myProfile?.resolveAsCell();
  if (profile?.get() === undefined) return undefined;
  const actor = currentPrincipal();
  return actor !== undefined && profileOwnerOf(profile) === actor
    ? profile
    : undefined;
};

/**
 * A new comment's id, minted in a handler, where the clock and entropy are
 * allowed; the clock alone would name two comments made in one millisecond
 * alike.
 */
const mintCommentId = (): string =>
  `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Stores a comment under `id`, which its anchors are named for. */
const storeComment = (
  comments: CommentsCell,
  id: string,
  profile: ProfileCell,
  body: string,
  quote: string,
  draft: boolean,
): void => {
  // A comment may link only lists and cells that exist, so they are made
  // before the comment links them.
  const replies = new Writable<RepliesValue>([]);
  const resolved = new Writable<boolean | Default<false>>(false);
  const record = comments.elementById(id);
  record.set({
    id,
    authorProfile: profile,
    body,
    draft,
    quote,
    postedAt: Date.now(),
    replies,
    resolved,
  });
  comments.addUnique(record);
};

/**
 * The cell of the keyed record of the posted comment `id` names. A draft is
 * its author's alone, to post or discard, so it names none.
 *
 * @throws If no posted comment has that id.
 */
const commentNamed = (
  comments: CommentsCell,
  id: string,
): Writable<StoredComment> => {
  const record = id === "" ? undefined : comments.elementById(id);
  const current: StoredComment | undefined = record?.get();
  if (record === undefined || current === undefined || current.draft) {
    throw new Error(`No comment has the id \`${id}\`.`);
  }
  return record;
};

/**
 * Keeps the editor's selection while the body is the text the editor
 * reported it against, since only then does its range name the selected text
 * in the body, and keeps nothing selected otherwise, until the editor reports
 * against the body as it is. The report reaches this handler from the editor
 * within the runtime, and the editor's text is compared here rather than
 * kept.
 */
const trackSelection = handler<
  { detail: SelectionReport },
  { content: Writable<string>; selection: Writable<NoteSelection> }
>((event, { content, selection }) => {
  const { from, to, text, value } = event.detail;
  selection.set(
    from === to || content.get() !== value
      ? NOTHING_SELECTED
      : { from, to, text },
  );
});

/**
 * The draft being written in this session, if any: its id, and the text
 * between its anchors when it was started. `id` is empty while the composer
 * is closed.
 */
interface Composing {
  id: string;
  text: string;
}

const NOT_COMPOSING: Composing = { id: "", text: "" };

/** What starting a comment works on. */
interface OpenComposerState {
  content: Writable<string>;
  anchors: AnchorsCell;
  comments: CommentsCell;
  myProfile: ProfileCell | undefined;
  selection: Writable<NoteSelection>;
  composing: Writable<Composing>;
  draft: Writable<string>;
  notice: Writable<string>;
}

/**
 * Starts a comment on the current selection: a draft record under a new id,
 * and the two anchors of the body named for it. The selection was kept
 * against the body as it was then, and is refused if the body no longer
 * holds its text at its range. From then on Memory keeps the anchors on that
 * text through every edit, however long the person writes and whatever they
 * select meanwhile, and the draft stays theirs to continue or discard if they
 * leave.
 */
const openComposer = handler<unknown, OpenComposerState>((_, state) => {
  const profile = ownProfile(state.myProfile);
  if (profile === undefined) {
    state.notice.set(NO_PROFILE);
    return;
  }
  if (state.composing.get().id !== "") {
    state.notice.set("Post or cancel the comment you are writing first.");
    return;
  }
  const { from, to, text } = state.selection.get();
  if (from === to) {
    state.notice.set("Select the text to comment on first.");
    return;
  }
  // The range was right for the body when it was kept. An edit since, which
  // the editor has not yet reported the selection against, can leave other
  // text there; one that leaves the same text at the range gets past this.
  if (state.content.get().slice(from, to) !== text) {
    state.notice.set("The note changed under your selection; try again.");
    return;
  }
  const id = mintCommentId();
  anchorComment(state.anchors, id, from, to);
  storeComment(state.comments, id, profile, "", text, true);
  state.composing.set({ id, text });
  state.draft.set("");
  state.notice.set("");
});

/** Whether the comment `record` is labeled as written by the caller. */
const writtenByCaller = (record: Writable<StoredComment>): boolean => {
  const actor = currentPrincipal();
  return actor !== undefined && principalOf(record, "authored-by") === actor;
};

/**
 * Removes the comment `record`, stored under `id`, with its anchors. The list
 * stops linking the record, and the record is left holding `undefined`, which
 * is how a deleted comment is represented: a pattern cannot delete the
 * document itself. The list therefore never holds a deleted comment, while a
 * read of a record by its id can find one, which is why such reads are typed
 * `StoredComment | undefined`.
 */
const removeComment = (
  anchors: AnchorsCell,
  comments: CommentsCell,
  record: Writable<StoredComment>,
  id: string,
): void => {
  comments.removeByValue(record);
  const cleared: Writable<StoredComment | undefined> = comments.elementById(id);
  cleared.set(undefined);
  unanchorComment(anchors, id);
};

/**
 * Deletes the draft `id` with its anchors, if it is still a draft and the
 * caller wrote it; a draft posted or discarded meanwhile, from another tab,
 * is left as it is.
 */
const discardDraftRecord = (
  anchors: AnchorsCell,
  comments: CommentsCell,
  id: string,
): void => {
  const record = comments.elementById(id);
  const current: StoredComment | undefined = record.get();
  if (current?.draft !== true || !writtenByCaller(record)) return;
  removeComment(anchors, comments, record, id);
};

/** What continuing a draft works on. */
interface ResumeState {
  comments: CommentsCell;
  id: string;
  text: string;
  composing: Writable<Composing>;
  draft: Writable<string>;
  notice: Writable<string>;
}

/**
 * Opens the composer on a draft this session is not writing, unless the
 * composer is already open on another or the draft is no longer one.
 */
const resumeDraft = handler<unknown, ResumeState>(
  (_, { comments, id, text, composing, draft, notice }) => {
    if (composing.get().id !== "") {
      notice.set("Post or cancel the comment you are writing first.");
      return;
    }
    const current: StoredComment | undefined = comments.elementById(id).get();
    if (current?.draft !== true) {
      notice.set("This draft was posted or discarded in another tab.");
      return;
    }
    composing.set({ id, text });
    draft.set("");
    notice.set("");
  },
);

/** What discarding a draft works on. */
interface DiscardState {
  anchors: AnchorsCell;
  comments: CommentsCell;
}

/** Discards the draft `id`, from its row or from the composer's Cancel. */
const discardDraft = handler<CommentIdEvent, DiscardState>(
  (event, { anchors, comments }) =>
    discardDraftRecord(anchors, comments, event.id),
);

/** What closing the composer works on. */
interface CloseComposerState {
  discardVerb: Stream<CommentIdEvent>;
  composing: Writable<Composing>;
  draft: Writable<string>;
  notice: Writable<string>;
}

/** Discards the draft being written, with its anchors, and closes the composer. */
const closeComposer = handler<unknown, CloseComposerState>(
  (_, { discardVerb, composing, draft, notice }) => {
    const { id } = composing.get();
    if (id !== "") discardVerb.send({ id });
    composing.set(NOT_COMPOSING);
    draft.set("");
    notice.set("");
  },
);

/** What posting from the composer works on. */
interface PostCommentState {
  comments: CommentsCell;
  myProfile: ProfileCell | undefined;
  composing: Writable<Composing>;
  draft: Writable<string>;
  selectedId: Writable<string>;
  replyDraft: Writable<string>;
  notice: Writable<string>;
}

/**
 * Posts the draft being written, with the composer's text as its body. A
 * draft discarded or posted elsewhere meanwhile, from another tab, is no
 * longer this composer's to post: the composer says so and stays open with
 * the text, which Cancel then closes.
 */
const postComment = handler<unknown, PostCommentState>((_, state) => {
  if (ownProfile(state.myProfile) === undefined) {
    state.notice.set(NO_PROFILE);
    return;
  }
  const { id } = state.composing.get();
  const body = state.draft.get().trim();
  if (id === "" || body === "") {
    state.notice.set("Write a comment to post it.");
    return;
  }
  const record = state.comments.elementById(id);
  if (record.get()?.draft !== true || !writtenByCaller(record)) {
    // The composer stays open, so the text can still be copied; Cancel
    // closes it.
    state.notice.set("This draft was posted or discarded in another tab.");
    return;
  }
  record.key("body").set(body);
  record.key("draft").set(false);
  record.key("postedAt").set(Date.now());
  state.composing.set(NOT_COMPOSING);
  state.draft.set("");
  state.notice.set("");
  selectId(id, state);
});

/** What the `addComment` verb works on. */
interface AddCommentState {
  content: Writable<string>;
  anchors: AnchorsCell;
  comments: CommentsCell;
  myProfile: ProfileCell | undefined;
}

const addComment = handler<AddCommentEvent, AddCommentState>(
  (event, { content, anchors, comments, myProfile }) => {
    const profile = ownProfile(myProfile);
    if (profile === undefined) throw new Error(NO_PROFILE);
    const body = event.body.trim();
    if (body === "") throw new Error("addComment needs a `body` with text");
    const from = onlyOccurrence(
      content.get(),
      event.quote,
      "addComment",
      "quote",
    );
    const id = mintCommentId();
    anchorComment(anchors, id, from, from + event.quote.length);
    storeComment(comments, id, profile, body, event.quote, false);
  },
);

/** What replying to a comment works on. */
interface ReplyState {
  comments: CommentsCell;
  myProfile: ProfileCell | undefined;
}

const commitReply = handler<CommentReplyEvent, ReplyState>(
  (event, { comments, myProfile }) => {
    const profile = ownProfile(myProfile);
    if (profile === undefined) throw new Error(NO_PROFILE);
    const record = commentNamed(comments, event.id);
    const body = event.body.trim();
    if (body === "") throw new Error("This reply has no text.");
    record.get().replies.push({
      authorProfile: profile,
      body,
      postedAt: Date.now(),
    });
  },
);

/** What resolving or reopening a comment works on. */
interface ResolveState {
  comments: CommentsCell;
}

const resolveComment = handler<CommentIdEvent, ResolveState>(
  (event, { comments }) => {
    commentNamed(comments, event.id).get().resolved.set(true);
  },
);

const reopenComment = handler<CommentIdEvent, ResolveState>(
  (event, { comments }) => {
    commentNamed(comments, event.id).get().resolved.set(false);
  },
);

/** What deleting a comment works on. */
interface DeleteCommentState {
  anchors: AnchorsCell;
  comments: CommentsCell;
}

/**
 * Deletes a comment and its anchors. Only the person the comment is labeled
 * as written by can delete it.
 */
const deleteComment = handler<CommentIdEvent, DeleteCommentState>(
  (event, { anchors, comments }) => {
    const record = commentNamed(comments, event.id);
    if (!writtenByCaller(record)) {
      throw new Error("Only its author can delete a comment.");
    }
    removeComment(anchors, comments, record, event.id);
  },
);

/** Sends the row's comment id to one of the comment verbs. */
const actOnComment = handler<
  unknown,
  { verb: Stream<CommentIdEvent>; id: string }
>((_, { verb, id }) => {
  verb.send({ id });
});

/** Sends the selected comment's id to one of the comment verbs. */
const actOnSelected = handler<
  unknown,
  { verb: Stream<CommentIdEvent>; selectedId: Writable<string> }
>((_, { verb, selectedId }) => {
  const id = selectedId.get();
  if (id === "") return;
  verb.send({ id });
});

/**
 * Sends the reply draft to `replyToComment` for the selected comment, and
 * clears the draft and the notice. A reply the verb would refuse, from a
 * viewer with no profile of their own or to a comment no longer posted, is
 * refused here first, in the notice, so the draft stays.
 */
const replyToSelected = handler<
  unknown,
  ReplyState & {
    verb: Stream<CommentReplyEvent>;
    selectedId: Writable<string>;
    replyDraft: Writable<string>;
    notice: Writable<string>;
  }
>((_, { comments, myProfile, verb, selectedId, replyDraft, notice }) => {
  const id = selectedId.get();
  const body = replyDraft.get().trim();
  if (id === "" || body === "") return;
  if (ownProfile(myProfile) === undefined) {
    notice.set(NO_PROFILE);
    return;
  }
  const current: StoredComment | undefined = comments.elementById(id).get();
  if (current === undefined || current.draft) {
    notice.set("This comment is no longer posted.");
    return;
  }
  verb.send({ id, body });
  replyDraft.set("");
  notice.set("");
});

/** What selecting a comment changes: the selection, and the reply draft. */
interface SelectState {
  selectedId: Writable<string>;
  replyDraft: Writable<string>;
}

/**
 * Selects the comment `id`. The reply field moves to that comment, so a
 * draft written for another comment is cleared rather than posted there.
 */
const selectId = (id: string, { selectedId, replyDraft }: SelectState) => {
  if (selectedId.get() === id) return;
  selectedId.set(id);
  replyDraft.set("");
};

const selectComment = handler<unknown, SelectState & { id: string }>(
  (_, state) => selectId(state.id, state),
);

const selectHighlight = handler<{ detail: { id: string } }, SelectState>(
  (event, state) => selectId(event.detail.id, state),
);

/** What the note's body and comments are built from, with the viewer given. */
export interface SharedNoteCoreInput {
  /** The body, which the editor and the verbs edit. */
  content: Writable<string>;

  /** Comments on the body. */
  comments: CommentsCell;

  /** The viewer's profile, which holds no value until it resolves. */
  myProfile?: ProfileCell;

  /** The viewer's name on live cursors, or empty for none. */
  participantName: string;
}

/** The body's editor with its comments panel, and the verbs. */
export interface SharedNoteCoreOutput {
  [UI]: VNode;
  commentAnchors: FieldAnchors | undefined;
  appendLine: Stream<LineEvent>;
  prependLine: Stream<LineEvent>;
  replaceText: Stream<ReplaceTextEvent>;
  addComment: Stream<AddCommentEvent>;
  replyToComment: Stream<CommentReplyEvent>;
  resolveComment: Stream<CommentIdEvent>;
  reopenComment: Stream<CommentIdEvent>;
  deleteComment: Stream<CommentIdEvent>;
}

/**
 * The editor and the comments beside it, for a viewer whose profile is given
 * rather than resolved. The default export resolves the viewer and wraps this;
 * a test hands it a profile of its own.
 */
export const SharedNoteCore = pattern<
  SharedNoteCoreInput,
  SharedNoteCoreOutput
>(({ content, comments, myProfile, participantName }) => {
  const error = new Writable.perSession("");
  const recovery = new Writable.perSession<string | null>(null);
  const hasError = computed(() => error.get() !== "");
  const presenceNotice = new Writable.perSession("");
  const hasPresenceNotice = computed(() => presenceNotice.get() !== "");
  const hasRecovery = computed(() => recovery.get() !== null);
  const recoveryText = computed(() => recovery.get() ?? "");

  const anchors = anchorsOf(content);
  const replyVerb = commitReply({ comments, myProfile });
  const resolveVerb = resolveComment({ comments });
  const reopenVerb = reopenComment({ comments });
  const deleteVerb = deleteComment({ anchors, comments });
  const discardVerb = discardDraft({ anchors, comments });
  const selection = new Writable.perSession<NoteSelection>(NOTHING_SELECTED);
  const composing = new Writable.perSession<Composing>(NOT_COMPOSING);
  const draft = new Writable.perSession("");
  const notice = new Writable.perSession("");
  const replyDraft = new Writable.perSession("");
  const selectedId = new Writable.perSession("");
  const showResolved = new Writable.perSession(false);
  const composer = {
    content,
    anchors,
    comments,
    myProfile,
    selection,
    composing,
    draft,
    notice,
  };

  // Each comment's range by id, as Memory holds its two anchors now.
  const rangeOf = computed(() => {
    const held: FieldAnchors = anchors ?? {};
    const ranges: Record<string, { from: number; to: number }> = {};
    for (const comment of comments.get()) {
      if (comment === undefined) continue;
      const from = held[fromAnchorOf(comment.id)];
      const to = held[toAnchorOf(comment.id)];
      if (from !== undefined && to !== undefined) {
        ranges[comment.id] = { from, to };
      }
    }
    return ranges;
  });

  // Where each comment's row sits in the panel: in the order the comments'
  // text appears in the body, those whose text is gone after the rest. A
  // row's place changes only when that order does, not with every edit
  // ahead of it.
  const placeOf = computed(() => {
    const starts: { id: string; from: number }[] = [];
    for (const comment of comments.get()) {
      if (comment === undefined) continue;
      const range = rangeOf[comment.id];
      starts.push({
        id: comment.id,
        from: range === undefined || range.to <= range.from
          ? Number.MAX_SAFE_INTEGER
          : range.from,
      });
    }
    starts.sort((a, b) => a.from - b.from);
    const places: Record<string, number> = {};
    starts.forEach(({ id }, rank) => {
      places[id] = rank * PLACES_PER_COMMENT;
    });
    return places;
  });

  // What the editor marks: the text between the two anchors of every open
  // comment, the selected one told apart. The editor knows where each anchor
  // is. The open comments are the same for every viewer, and only the last
  // step reads the viewer's selection.
  const openIds = computed(() =>
    comments.get()
      .filter((comment) =>
        comment !== undefined && !comment.draft && !comment.resolved.get()
      )
      .map((comment) => comment.id)
  );
  // The comment being written marks its text too, for the person writing it.
  const highlights = computed((): PerSession<NoteHighlight[]> => {
    const selected = selectedId.get();
    const marks = openIds.map((id) =>
      highlightOf(id, id === selected ? "active" : undefined)
    );
    const writing = composing.get().id;
    return writing === "" || openIds.includes(writing)
      ? marks
      : [...marks, highlightOf(writing, "active")];
  });
  const openCount = computed(() => openIds.length);
  const hasProfile = computed(() => myProfile?.get() !== undefined);
  const noProfile = computed(() => !hasProfile);
  const commentDisabled = computed((): PerSession<boolean> => {
    const selected = selection.get();
    return selected.from === selected.to || !hasProfile ||
      composing.get().id !== "";
  });
  // Per-session differences in the composer, the notice and the rows are
  // shown or hidden through a per-session `display` prop. Each element shown
  // this way also carries a static `hidden`, which keeps it out of view until
  // its display has a value.
  const composerDisplay = computed((): PerSession<NoteDisplay> =>
    composing.get().id === "" ? "none" : "flex"
  );
  const composerQuote = computed((): PerSession<string> =>
    excerptOf(composing.get().text)
  );
  const noticeDisplay = computed((): PerSession<NoteDisplay> =>
    notice.get() === "" ? "none" : "block"
  );
  // The viewer's principal, or empty for a viewer whose profile names none.
  const viewer = computed((): string =>
    myProfile === undefined ? "" : profileOwnerOf(myProfile) ?? ""
  );

  // The actions on the selected comment are one set of controls for the
  // panel, placed under that comment's row, rather than a hidden set in
  // every row: a row's controls are built again for every comment on every
  // load. They are shown while the selected comment's row is.
  const actions = computed((): PerSession<ActionsDisplay> => {
    const id = selectedId.get();
    const record = comments.get().find((comment) => comment?.id === id);
    const resolved = record?.resolved.get() ?? false;
    const listed = record !== undefined && !record.draft &&
      (!resolved || showResolved.get());
    const mine = record !== undefined && viewer !== "" &&
      principalOf(comments.elementById(id), "authored-by") === viewer;
    return {
      bar: listed ? "flex" : "none",
      order: (placeOf[id] ?? 0) + 1,
      resolve: resolved ? "none" : "flex",
      reopen: resolved ? "flex" : "none",
      delete: mine ? "flex" : "none",
    };
  });

  const view = (
    <cf-vstack gap="3">
      {hasError ? <cf-text role="alert">{error}</cf-text> : null}
      {hasPresenceNotice
        ? <cf-text role="status">{presenceNotice}</cf-text>
        : null}
      {hasRecovery
        ? (
          <cf-vstack gap="2">
            <cf-text role="alert">
              Editing paused. Copy your unsent text below before reopening this
              note.
            </cf-text>
            <cf-textarea
              id="shared-note-recovery"
              aria-label="Unsent text to recover"
              value={recoveryText}
              readonly
              rows={8}
            />
          </cf-vstack>
        )
        : null}
      <cf-hstack gap="4" align="start" wrap>
        <cf-code-editor
          $value={content}
          collaborative
          participantName={participantName}
          language="text/markdown"
          mode="prose"
          wordWrap
          tabIndent
          placeholder="Start writing…"
          highlights={highlights}
          oncf-error={reportError({ error })}
          oncf-collaboration-reconcile={preserveUnsentText({ recovery })}
          oncf-presence-error={reportPresenceError({ presenceNotice })}
          oncf-presence-join={clearPresenceNotice({ presenceNotice })}
          oncf-selection-change={trackSelection({ content, selection })}
          oncf-highlight-click={selectHighlight({ selectedId, replyDraft })}
          style={{ flex: "3 1 24rem", minWidth: "0", minHeight: "20rem" }}
        />
        <cf-vstack
          gap="2"
          id="shared-note-comments"
          style={{ flex: "1 1 16rem", minWidth: "0" }}
        >
          <cf-hstack gap="2" align="center" justify="between" wrap>
            <cf-text variant="heading-sm">Comments ({openCount})</cf-text>
            <cf-button
              id="shared-note-comment-button"
              size="sm"
              disabled={commentDisabled}
              onClick={openComposer(composer)}
            >
              Comment
            </cf-button>
          </cf-hstack>
          <cf-checkbox $checked={showResolved}>Show resolved</cf-checkbox>
          <cf-text
            id="shared-note-comment-notice"
            role="status"
            hidden
            style={{ display: noticeDisplay }}
          >
            {notice}
          </cf-text>
          <cf-vstack
            gap="2"
            id="shared-note-composer"
            hidden
            style={{ display: composerDisplay }}
          >
            <cf-text variant="caption" tone="muted">
              On “{composerQuote}”
            </cf-text>
            <cf-textarea
              id="shared-note-comment-draft"
              aria-label="Comment"
              placeholder="Write a comment…"
              $value={draft}
              rows={3}
            />
            <cf-hstack gap="2">
              <cf-button
                id="shared-note-post-button"
                size="sm"
                onClick={postComment({
                  comments,
                  myProfile,
                  composing,
                  draft,
                  selectedId,
                  replyDraft,
                  notice,
                })}
              >
                Post
              </cf-button>
              <cf-button
                size="sm"
                variant="ghost"
                onClick={closeComposer({
                  discardVerb,
                  composing,
                  draft,
                  notice,
                })}
              >
                Cancel
              </cf-button>
            </cf-hstack>
          </cf-vstack>
          <cf-vstack gap="2" style={{ display: "flex" }}>
            {comments.map((comment) => {
              const id = comment.id;
              // A row's derived values are two reactive nodes, one for what
              // every viewer sees and one for what this session sees. Each
              // node a row holds is started again for every comment on every
              // load, so a value of its own is a cost paid per comment.
              const placed = computed(() => {
                const range = rangeOf[comment.id];
                const gone = range !== undefined && range.to <= range.from;
                const draftDisplay: NoteDisplay = comment.draft
                  ? "flex"
                  : "none";
                // The quote is the author's; the text between the anchors
                // is the note's now, which anyone who can write the note can
                // change. It is shown apart from the quote whenever the two
                // differ.
                const now = range === undefined || gone
                  ? ""
                  : content.get().slice(range.from, range.to);
                return {
                  order: placeOf[comment.id] ?? 0,
                  gone,
                  quoteDecoration: gone ? "line-through" : "none",
                  moved: now !== "" && now !== comment.quote,
                  nowExcerpt: excerptOf(now),
                  draftDisplay,
                };
              });
              const shown = computed((): PerSession<RowDisplay> => {
                const mine = viewer !== "" &&
                  principalOf(
                      comments.elementById(comment.id),
                      "authored-by",
                    ) === viewer;
                const selected = selectedId.get() === comment.id;
                const resolved = comment.resolved.get();
                return {
                  // A draft is listed only to its author, and not while the
                  // composer is writing it.
                  row: comment.draft
                    ? mine && composing.get().id !== comment.id
                      ? "flex"
                      : "none"
                    : !resolved || showResolved.get()
                    ? "flex"
                    : "none",
                  border: selected
                    ? "3px solid var(--cf-theme-color-primary)"
                    : "3px solid var(--cf-theme-color-border)",
                };
              });
              return (
                <cf-vstack
                  gap="1"
                  hidden
                  data-comment-id={id}
                  style={{
                    display: shown.row,
                    order: placed.order,
                    padding: "0.5rem",
                    borderLeft: shown.border,
                  }}
                  onClick={selectComment({ id, selectedId, replyDraft })}
                >
                  <cf-hstack gap="2" align="center" wrap>
                    <cf-profile-badge
                      variant="chip"
                      size="sm"
                      $profile={comment.authorProfile}
                    />
                    <cf-cfc-authorship
                      $value={comment.quote}
                      $author={comment.authorProfile}
                      verifyTextIntegrity
                      style={{ minWidth: "0", maxWidth: "100%" }}
                    >
                      <cf-text
                        variant="caption"
                        tone="muted"
                        style={{
                          display: "block",
                          fontStyle: "italic",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          textDecoration: placed.quoteDecoration,
                        }}
                      >
                        {comment.quote}
                      </cf-text>
                    </cf-cfc-authorship>
                    {placed.gone
                      ? (
                        <cf-text variant="caption" tone="muted">
                          text no longer in note
                        </cf-text>
                      )
                      : null}
                    {placed.moved
                      ? (
                        <cf-text variant="caption" tone="muted">
                          now “{placed.nowExcerpt}”
                        </cf-text>
                      )
                      : null}
                  </cf-hstack>
                  <cf-cfc-authorship
                    $value={comment.body}
                    $author={comment.authorProfile}
                    verifyTextIntegrity
                  >
                    <cf-text block style={{ whiteSpace: "pre-wrap" }}>
                      {comment.body}
                    </cf-text>
                  </cf-cfc-authorship>
                  {comment.replies.map((reply) => (
                    <cf-hstack
                      gap="2"
                      align="start"
                      style={{ paddingLeft: "1rem" }}
                    >
                      <cf-profile-badge
                        variant="chip"
                        size="xs"
                        $profile={reply.authorProfile}
                      />
                      <cf-cfc-authorship
                        $value={reply.body}
                        $author={reply.authorProfile}
                        verifyTextIntegrity
                      >
                        <cf-text block style={{ whiteSpace: "pre-wrap" }}>
                          {reply.body}
                        </cf-text>
                      </cf-cfc-authorship>
                    </cf-hstack>
                  ))}
                  <cf-hstack
                    gap="2"
                    align="center"
                    wrap
                    hidden
                    style={{ display: placed.draftDisplay }}
                  >
                    <cf-text variant="caption" tone="muted">
                      Draft
                    </cf-text>
                    <cf-button
                      size="sm"
                      onClick={resumeDraft({
                        comments,
                        id,
                        text: comment.quote,
                        composing,
                        draft,
                        notice,
                      })}
                    >
                      Continue
                    </cf-button>
                    <cf-button
                      size="sm"
                      variant="ghost"
                      onClick={actOnComment({ verb: discardVerb, id })}
                    >
                      Discard
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              );
            })}
            <cf-hstack
              gap="2"
              align="center"
              wrap
              hidden
              id="shared-note-comment-actions"
              style={{
                display: actions.bar,
                order: actions.order,
                // Drawn as the foot of the selected row: up against it,
                // across the gap between rows, under the same border.
                marginTop: "-0.5rem",
                padding: "0 0.5rem 0.5rem",
                borderLeft: "3px solid var(--cf-theme-color-primary)",
              }}
            >
              <cf-input
                aria-label="Reply"
                placeholder="Reply…"
                $value={replyDraft}
                disabled={noProfile}
                timingStrategy="immediate"
                oncf-submit={replyToSelected({
                  comments,
                  myProfile,
                  verb: replyVerb,
                  selectedId,
                  replyDraft,
                  notice,
                })}
                style={{ flex: "1 1 8rem", minWidth: "0" }}
              />
              <cf-button
                size="sm"
                disabled={noProfile}
                onClick={replyToSelected({
                  comments,
                  myProfile,
                  verb: replyVerb,
                  selectedId,
                  replyDraft,
                  notice,
                })}
              >
                Reply
              </cf-button>
              <cf-button
                size="sm"
                variant="ghost"
                hidden
                style={{ display: actions.resolve }}
                onClick={actOnSelected({ verb: resolveVerb, selectedId })}
              >
                Resolve
              </cf-button>
              <cf-button
                size="sm"
                variant="ghost"
                hidden
                style={{ display: actions.reopen }}
                onClick={actOnSelected({ verb: reopenVerb, selectedId })}
              >
                Reopen
              </cf-button>
              <cf-button
                size="sm"
                variant="ghost"
                hidden
                style={{ display: actions.delete }}
                onClick={actOnSelected({ verb: deleteVerb, selectedId })}
              >
                Delete
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-vstack>
      </cf-hstack>
    </cf-vstack>
  );

  return {
    [UI]: view,
    commentAnchors: anchors,
    appendLine: appendLine({ content }),
    prependLine: prependLine({ content }),
    replaceText: replaceText({ content }),
    addComment: addComment({ content, anchors, comments, myProfile }),
    replyToComment: replyVerb,
    resolveComment: resolveVerb,
    reopenComment: reopenVerb,
    deleteComment: deleteVerb,
  };
});

export default pattern<SharedNoteInput, SharedNoteOutput>(
  ({ title, content, comments }) => {
    const profile = wish<NoteProfile>({ query: "#profile" });
    const profileName = wish<string>({ query: "#profileName" });
    const participantName = computed(() =>
      normalizePresenceParticipantName(profileName.result ?? "")
    );
    const hasProfile = computed(() =>
      participantName !== "" &&
      profile.result !== undefined
    );
    const note = SharedNoteCore({
      content,
      comments,
      myProfile: profile.result,
      participantName,
    });

    const view = (
      <cf-vstack
        gap="3"
        style={{ padding: "1rem", width: "100%", boxSizing: "border-box" }}
      >
        <cf-hstack
          gap="3"
          align="center"
          justify="between"
          wrap
        >
          <cf-input
            $value={title}
            aria-label="Note title"
            placeholder="Untitled note"
            style={{ flex: "1 1 16rem", minWidth: "0" }}
          />
          {hasProfile
            ? <cf-profile-badge variant="chip" $profile={profile.result} />
            : (
              <div
                id="shared-note-profile-setup"
                style={{ minWidth: "0", maxWidth: "100%" }}
              >
                <cf-text>Choose a Fabric profile to label your cursor.</cf-text>
                {profile[UI]}
              </div>
            )}
        </cf-hstack>
        {note[UI]}
      </cf-vstack>
    );

    return {
      [NAME]: title,
      [UI]: view,
      [TILE_UI]: view,
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content,
      },
      title,
      content,
      comments,
      participantName,
      commentAnchors: note.commentAnchors,
      appendLine: note.appendLine,
      prependLine: note.prependLine,
      replaceText: note.replaceText,
      addComment: note.addComment,
      replyToComment: note.replyToComment,
      resolveComment: note.resolveComment,
      reopenComment: note.reopenComment,
      deleteComment: note.deleteComment,
    };
  },
);
