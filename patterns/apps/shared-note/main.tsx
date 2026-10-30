/**
 * A shared Markdown document with Fabric profile names on live cursors and
 * comments anchored to ranges of its text.
 */

import {
  type Cell,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  type Stream,
  type TextChange,
  TILE_UI,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  type AnchorVersion,
  excerptOf,
  locateQuote,
  mapAnchor,
  precedes,
} from "./anchors.ts";
import { normalizePresenceParticipantName } from "./participant-name.ts";

/** What a viewer's Fabric profile shows: a name and an avatar, where set. */
export interface NoteProfile {
  name?: string;
  avatar?: string;
}

/** A live link to a person's profile. */
export type ProfileCell = Cell<NoteProfile>;

/**
 * Where a comment sits in the body: a range of the text, which every edit of
 * the body maps along with the text.
 */
export interface CommentAnchor {
  /** Start of the range, as the last edit mapped it. */
  from: number;

  /**
   * End of the range, exclusive. Equal to `from` once an edit has deleted
   * the text the range covered: the comment then marks nothing.
   */
  to: number;

  /**
   * The body version the range was last read at, as the editor that
   * reported it numbers the collaborative field. Absent until an editor has
   * reported. A report of an earlier version is one that reached the
   * pattern late, and leaves the anchor where a later one put it.
   */
  version?: AnchorVersion;
}

/** A reply under a comment, which shares the comment's anchor. */
export interface CommentReply {
  /** The profile the reply was made under. */
  authorProfile: ProfileCell;

  /** The reply's text. */
  body: string;

  /** The handler clock when the reply was made, in milliseconds. */
  createdAt: number;
}

/** A comment on a range of the body. */
export interface NoteComment {
  /** Names the comment to the editor and the verbs; minted when it is made. */
  id: string;

  /** Where the comment sits. */
  anchor: CommentAnchor;

  /** The profile the comment was made under. */
  authorProfile: ProfileCell;

  /** The comment's text. */
  body: string;

  /** The handler clock when the comment was made, in milliseconds. */
  createdAt: number;

  /** Whether the comment is settled. A resolved comment marks no text. */
  resolved: boolean;

  /** Replies in the order made. A reply is not anchored, so this does not recurse. */
  replies: CommentReply[];
}

/** A comment anchored on text the body holds once. */
export interface AddCommentEvent {
  /** Text the body holds exactly once, compared code unit for code unit. */
  quote: string;

  /** The comment's text. */
  body: string;
}

/** Names a comment by its id. */
export interface CommentIdEvent {
  /** The comment's `id`. */
  id: string;
}

/** Initial document values, shared by every viewer of this piece. */
export interface SharedNoteInput {
  /** Editable document title, independent of Markdown frontmatter. */
  title?: PerSpace<string | Default<"Untitled note">>;

  /** LF-normalized Markdown; live editing uses CodeMirror operations. */
  content?: PerSpace<string | Default<"">>;

  /** Comments on the body, shared by every viewer. */
  comments?: PerSpace<NoteComment[] | Default<[]>>;
}

/** Readable Markdown and the same compact view for standalone and embedded use. */
export interface SharedNoteOutput {
  [NAME]: string;
  [UI]: VNode;
  [TILE_UI]: VNode;
  title: PerSpace<string>;
  content: PerSpace<string>;
  comments: PerSpace<NoteComment[]>;
  participantName: PerUser<string>;

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
   * Adds a comment under the caller's profile, anchored on the one occurrence
   * of `quote`, and refuses when `quote` is empty, occurs nowhere, or occurs
   * more than once, when `body` is blank, or when the caller has no profile.
   */
  addComment: Stream<AddCommentEvent>;

  /** Marks the comment named by `id` resolved, and refuses an unknown `id`. */
  resolveComment: Stream<CommentIdEvent>;
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

type CommentsCell = Writable<NoteComment[]>;

/**
 * Edits the body through `applyChanges()` and maps every comment's anchor
 * through the same change, in one commit. Once an editor has opened the body
 * it accepts only edits, which the open editors merge with their own typing.
 * The change's positions refer to the text the verb read, and land only
 * while the body still holds it; a body that moved on refuses the commit,
 * and the verb runs again against the new text, mapping again. An open
 * editor maps the same edit to the same positions, so what it holds and what
 * is stored agree without a report; with no editor open, this is what keeps
 * the anchors on their text.
 */
const editBody = (
  content: Writable<string>,
  comments: CommentsCell,
  change: TextChange,
): void => {
  content.applyChanges(change);
  comments.get().forEach((comment, index) => {
    const mapped = mapAnchor(comment.anchor, [change]);
    if (
      mapped.from === comment.anchor.from && mapped.to === comment.anchor.to
    ) {
      return;
    }
    comments.key(index).key("anchor").set({
      ...comment.anchor,
      from: mapped.from,
      to: mapped.to,
    });
  });
};

/** What the verbs that edit the body work on. */
interface BodyVerbState {
  content: Writable<string>;
  comments: CommentsCell;
}

const appendLine = handler<LineEvent, BodyVerbState>(
  ({ text }, { content, comments }) => {
    const current = content.get();
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    editBody(content, comments, {
      from: current.length,
      insert: separator + text,
    });
  },
);

const prependLine = handler<LineEvent, BodyVerbState>(
  ({ text }, { content, comments }) => {
    const current = content.get();
    const separator = current === "" || text.endsWith("\n") ? "" : "\n";
    editBody(content, comments, { from: 0, insert: text + separator });
  },
);

const replaceText = handler<ReplaceTextEvent, BodyVerbState>(
  (event, { content, comments }) => {
    const current = content.get();
    const from = locateQuote(current, event.old);
    if (from === "empty") {
      throw new Error(
        "replaceText needs a non-empty `old` to anchor on; to add text, use " +
          "`appendLine` or `prependLine`",
      );
    }
    if (from === "absent") {
      throw new Error(
        "replaceText found no occurrence of `old`; read the note again and " +
          "anchor on text it holds",
      );
    }
    if (from === "repeated") {
      throw new Error(
        "replaceText found `old` more than once; anchor on a longer passage " +
          "that occurs once",
      );
    }
    editBody(content, comments, {
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

/**
 * The selected text of the viewer's editor, empty with `from === to` when
 * nothing is selected, with the body version the editor read it at where it
 * has one.
 */
interface Selection {
  from: number;
  to: number;
  text: string;
  version?: AnchorVersion;
}

/** A range the editor marks, as `cf-code-editor` takes and reports it. */
interface HighlightRange {
  id: string;
  from: number;
  to: number;
  kind?: string;
}

/** The `display` an element shown or hidden through a prop takes. */
type NoteDisplay = "block" | "flex" | "none";

/** Why an act from a viewer whose profile hasn't resolved is refused. */
const NO_PROFILE = "Choose a Fabric profile to comment.";

/**
 * The profile `myProfile` resolves to, once it holds a value; `undefined`
 * until it does.
 */
const resolvedProfile = (
  myProfile: ProfileCell | undefined,
): ProfileCell | undefined => {
  const profile = myProfile?.resolveAsCell();
  return profile?.get() === undefined ? undefined : profile;
};

/**
 * A name for a new comment. Minted in a handler, where the clock and entropy
 * are allowed; the clock alone would name two comments made in one second
 * alike.
 */
const mintCommentId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * The index of `comment` in `comments`, or a refusal for one no longer there.
 * `comment` is whatever a row was built from, compared by identity.
 */
const indexOfComment = (
  comments: CommentsCell,
  comment: object,
): number => {
  const index = comments.get().findIndex((each) => equals(comment, each));
  if (index === -1) throw new Error("This comment is no longer on the note.");
  return index;
};

const trackSelection = handler<
  {
    detail: { from: number; to: number; text: string; version?: AnchorVersion };
  },
  { selection: Writable<Selection> }
>((event, { selection }) => {
  const { from, to, text, version } = event.detail;
  selection.set({
    from,
    to,
    text,
    ...(version === undefined ? {} : { version }),
  });
});

const openComposer = handler<
  unknown,
  { composerOpen: Writable<boolean>; draft: Writable<string> }
>((_, { composerOpen, draft }) => {
  draft.set("");
  composerOpen.set(true);
});

const closeComposer = handler<
  unknown,
  { composerOpen: Writable<boolean>; draft: Writable<string> }
>((_, { composerOpen, draft }) => {
  composerOpen.set(false);
  draft.set("");
});

const submitComment = handler<unknown, {
  comments: CommentsCell;
  myProfile: ProfileCell | undefined;
  selection: Writable<Selection>;
  draft: Writable<string>;
  composerOpen: Writable<boolean>;
  selectedCommentId: Writable<string>;
}>((_, state) => {
  const profile = resolvedProfile(state.myProfile);
  if (profile === undefined) throw new Error(NO_PROFILE);
  const selection = state.selection.get();
  if (selection.from === selection.to) {
    throw new Error("Select the text to comment on first.");
  }
  const body = state.draft.get().trim();
  if (body === "") throw new Error("This comment has no text.");
  // The editor reports where every edit moves the selection, so the range
  // is read against the body as the editor last showed it, and the anchor
  // carries that version where the editor named one.
  const id = mintCommentId();
  const { version } = selection;
  state.comments.push({
    id,
    anchor: {
      from: selection.from,
      to: selection.to,
      ...(version === undefined ? {} : { version }),
    },
    authorProfile: profile,
    body,
    createdAt: Date.now(),
    resolved: false,
    replies: [],
  });
  state.draft.set("");
  state.composerOpen.set(false);
  state.selectedCommentId.set(id);
});

const addComment = handler<AddCommentEvent, {
  comments: CommentsCell;
  content: Writable<string>;
  myProfile: ProfileCell | undefined;
}>((event, { comments, content, myProfile }) => {
  const profile = resolvedProfile(myProfile);
  if (profile === undefined) throw new Error(NO_PROFILE);
  const body = event.body.trim();
  if (body === "") throw new Error("addComment needs a `body` with text");
  const from = locateQuote(content.get(), event.quote);
  if (from === "empty") {
    throw new Error("addComment needs a non-empty `quote` to anchor on");
  }
  if (from === "absent") {
    throw new Error(
      "addComment found no occurrence of `quote`; read the note again and " +
        "anchor on text it holds",
    );
  }
  if (from === "repeated") {
    throw new Error(
      "addComment found `quote` more than once; anchor on a longer passage " +
        "that occurs once",
    );
  }
  comments.push({
    id: mintCommentId(),
    anchor: { from, to: from + event.quote.length },
    authorProfile: profile,
    body,
    createdAt: Date.now(),
    resolved: false,
    replies: [],
  });
});

const addReply = handler<unknown, {
  comments: CommentsCell;
  comment: NoteComment;
  myProfile: ProfileCell | undefined;
  replyDraft: Writable<string>;
}>((_, { comments, comment, myProfile, replyDraft }) => {
  const profile = resolvedProfile(myProfile);
  if (profile === undefined) throw new Error(NO_PROFILE);
  const body = replyDraft.get().trim();
  if (body === "") throw new Error("This reply has no text.");
  const index = indexOfComment(comments, comment);
  comments.key(index).key("replies").push({
    authorProfile: profile,
    body,
    createdAt: Date.now(),
  });
  replyDraft.set("");
});

const toggleResolved = handler<
  unknown,
  { comments: CommentsCell; comment: NoteComment }
>((_, { comments, comment }) => {
  const resolved = comments.key(indexOfComment(comments, comment)).key(
    "resolved",
  );
  resolved.set(!resolved.get());
});

const resolveComment = handler<CommentIdEvent, { comments: CommentsCell }>(
  (event, { comments }) => {
    const index = comments.get().findIndex((each) => each.id === event.id);
    if (index === -1) {
      throw new Error(`resolveComment found no comment named \`${event.id}\``);
    }
    comments.key(index).key("resolved").set(true);
  },
);

const selectComment = handler<unknown, {
  comments: CommentsCell;
  comment: NoteComment;
  selectedCommentId: Writable<string>;
}>((_, { comments, comment, selectedCommentId }) => {
  selectedCommentId.set(comments.get()[indexOfComment(comments, comment)].id);
});

const selectHighlight = handler<
  { detail: { id: string } },
  { selectedCommentId: Writable<string> }
>((event, { selectedCommentId }) => {
  selectedCommentId.set(event.detail.id);
});

// Every editor reports every edit that moves a range, its own or a
// collaborator's; every editor maps the same edits, so concurrent edits end
// with each reporting the same merged positions, and the version sets the
// duplicates aside. Reports can still reach this handler out of order: two sessions
// writing one comment at once have the loser run again against the winner's
// write, replaying a report the winner has moved past. The version each
// report carries is what tells such a replay from news, and a report has to
// be later than the version the anchor holds: two editors with different
// unconfirmed edits name one version for different text, and the first of
// their reports to arrive stands until the next report from either. A range
// the edit emptied is reported empty and stored so: its text is gone, and the
// comment marks nothing from then on.
const rebaseHighlights = handler<
  { detail: { highlights: HighlightRange[]; version?: AnchorVersion } },
  { comments: CommentsCell }
>((event, { comments }) => {
  const list = comments.get();
  const version = event.detail.version;
  for (const range of event.detail.highlights) {
    const index = list.findIndex((each) => each.id === range.id);
    if (index === -1) continue;
    const anchor = comments.key(index).key("anchor");
    const current = anchor.get();
    if (
      version !== undefined && current.version !== undefined &&
      !precedes(current.version, version)
    ) continue;
    const moved = current.from !== range.from || current.to !== range.to;
    if (!moved && version === undefined) continue;
    const stamped = version ?? current.version;
    anchor.set({
      from: range.from,
      to: range.to,
      ...(stamped === undefined ? {} : { version: stamped }),
    });
  }
});

/** What the note's body and comments are built from, with the viewer given. */
export interface SharedNoteCoreInput {
  /** The body, which the editor and the verbs edit. */
  content: Writable<string>;

  /** Comments on the body. */
  comments: Writable<NoteComment[]>;

  /** The viewer's profile, which holds no value until it resolves. */
  myProfile?: ProfileCell;

  /** The viewer's name on live cursors, or empty for none. */
  participantName: string;
}

/** The body's editor with its comments panel, and the verbs. */
export interface SharedNoteCoreOutput {
  [UI]: VNode;
  comments: NoteComment[];
  appendLine: Stream<LineEvent>;
  prependLine: Stream<LineEvent>;
  replaceText: Stream<ReplaceTextEvent>;
  addComment: Stream<AddCommentEvent>;
  resolveComment: Stream<CommentIdEvent>;
}

/**
 * The editor and the comments beside it, for a viewer whose profile is given
 * rather than resolved. `SharedNote` resolves the viewer and wraps this; a
 * test hands it a profile of its own.
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

  const selection = new Writable.perSession<Selection>({
    from: 0,
    to: 0,
    text: "",
  });
  const composerOpen = new Writable.perSession(false);
  const draft = new Writable.perSession("");
  const replyDraft = new Writable.perSession("");
  const selectedCommentId = new Writable.perSession("");
  const showResolved = new Writable.perSession(false);

  // What the editor marks: every open comment whose text the body still
  // holds, with the selected one told apart.
  const highlights = computed((): PerSession<HighlightRange[]> => {
    const selected = selectedCommentId.get();
    const ranges: HighlightRange[] = [];
    for (const comment of comments.get()) {
      const { from, to } = comment.anchor;
      if (comment.resolved || from === to) continue;
      ranges.push(
        comment.id === selected
          ? { id: comment.id, from, to, kind: "selected" }
          : { id: comment.id, from, to },
      );
    }
    return ranges;
  });
  const openCount = computed(() =>
    comments.get().filter((comment) => !comment.resolved).length
  );
  const commentDisabled = computed((): PerSession<boolean> => {
    const selected = selection.get();
    return selected.from === selected.to || myProfile?.get() === undefined;
  });
  const replyDisabled = computed((): PerSession<boolean> =>
    myProfile?.get() === undefined
  );
  const selectionExcerpt = computed((): PerSession<string> => {
    const selected = selection.get();
    return selected.from === selected.to ? "" : excerptOf(selected.text);
  });
  // What differs by session is shown or hidden through a prop, never by
  // building a different tree: a branch chosen per session is stored once for
  // everyone, and runtimes that chose differently overwrite each other
  // without end. Each element shown this way also carries a static `hidden`,
  // which keeps it out of view until its display computed has a value.
  const composerDisplay = computed((): PerSession<NoteDisplay> =>
    composerOpen.get() ? "block" : "none"
  );

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
        oncf-selection-change={trackSelection({ selection })}
        oncf-highlight-click={selectHighlight({ selectedCommentId })}
        oncf-highlights-mapped={rebaseHighlights({ comments })}
        style={{ minHeight: "20rem" }}
      />
      <cf-vstack gap="2" id="shared-note-comments">
        <cf-hstack gap="2" align="center" justify="between" wrap>
          <cf-text variant="heading-sm">Comments ({openCount})</cf-text>
          <cf-hstack gap="2" align="center" wrap>
            <cf-checkbox $checked={showResolved}>Show resolved</cf-checkbox>
            <cf-button
              id="shared-note-comment-button"
              size="sm"
              disabled={commentDisabled}
              onClick={openComposer({ composerOpen, draft })}
            >
              Comment
            </cf-button>
          </cf-hstack>
        </cf-hstack>
        <cf-vstack
          gap="2"
          id="shared-note-composer"
          hidden
          style={{ display: composerDisplay }}
        >
          <cf-text variant="caption" tone="muted">
            On “{selectionExcerpt}”
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
              onClick={submitComment({
                comments,
                myProfile,
                selection,
                draft,
                composerOpen,
                selectedCommentId,
              })}
            >
              Post
            </cf-button>
            <cf-button
              size="sm"
              variant="ghost"
              onClick={closeComposer({ composerOpen, draft })}
            >
              Cancel
            </cf-button>
          </cf-hstack>
        </cf-vstack>
        {comments.map((comment) => {
          const rowDisplay = computed((): PerSession<NoteDisplay> =>
            !comment.resolved || showResolved.get() ? "flex" : "none"
          );
          const selected = computed((): PerSession<boolean> =>
            selectedCommentId.get() === comment.id
          );
          const replyDisplay = computed((): PerSession<NoteDisplay> =>
            selectedCommentId.get() === comment.id ? "flex" : "none"
          );
          // The row quotes what the range covers now, so it reads as the
          // highlight does.
          const orphaned = computed(() =>
            comment.anchor.from === comment.anchor.to
          );
          const excerpt = computed(() =>
            excerptOf(
              content.get().slice(comment.anchor.from, comment.anchor.to),
            )
          );
          return (
            <cf-vstack
              gap="1"
              hidden
              style={{
                display: rowDisplay,
                padding: "0.5rem",
                borderLeft: selected
                  ? "3px solid var(--cf-theme-color-primary)"
                  : "3px solid var(--cf-theme-color-border)",
              }}
              onClick={selectComment({ comments, comment, selectedCommentId })}
            >
              <cf-hstack gap="2" align="center" wrap>
                <cf-profile-badge
                  variant="chip"
                  size="sm"
                  $profile={comment.authorProfile}
                />
                <cf-text
                  variant="caption"
                  tone="muted"
                  style={{ fontStyle: "italic" }}
                >
                  {orphaned ? "text no longer in note" : excerpt}
                </cf-text>
              </cf-hstack>
              <cf-text style={{ whiteSpace: "pre-wrap" }}>
                {comment.body}
              </cf-text>
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
                  <cf-text style={{ whiteSpace: "pre-wrap" }}>
                    {reply.body}
                  </cf-text>
                </cf-hstack>
              ))}
              <cf-hstack
                gap="2"
                align="center"
                wrap
                hidden
                style={{ display: replyDisplay }}
              >
                <cf-input
                  aria-label="Reply"
                  placeholder="Reply…"
                  $value={replyDraft}
                  disabled={replyDisabled}
                  timingStrategy="immediate"
                  oncf-submit={addReply({
                    comments,
                    comment,
                    myProfile,
                    replyDraft,
                  })}
                  style={{ flex: "1 1 8rem", minWidth: "0" }}
                />
                <cf-button
                  size="sm"
                  disabled={replyDisabled}
                  onClick={addReply({
                    comments,
                    comment,
                    myProfile,
                    replyDraft,
                  })}
                >
                  Reply
                </cf-button>
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={toggleResolved({ comments, comment })}
                >
                  {comment.resolved ? "Reopen" : "Resolve"}
                </cf-button>
              </cf-hstack>
            </cf-vstack>
          );
        })}
      </cf-vstack>
    </cf-vstack>
  );

  return {
    [UI]: view,
    comments,
    appendLine: appendLine({ content, comments }),
    prependLine: prependLine({ content, comments }),
    replaceText: replaceText({ content, comments }),
    addComment: addComment({ comments, content, myProfile }),
    resolveComment: resolveComment({ comments }),
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
      title,
      content,
      comments,
      participantName,
      appendLine: note.appendLine,
      prependLine: note.prependLine,
      replaceText: note.replaceText,
      addComment: note.addComment,
      resolveComment: note.resolveComment,
    };
  },
);
