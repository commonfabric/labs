/**
 * Tests imported text, editor bindings, recovery, the live-cursor notice, the
 * profile-name sanitizer's co-presence bounds, the verbs that edit the body,
 * and comments on its text, which Memory's anchors keep on their text through
 * every edit, without a notebook.
 */

import {
  action,
  type AddIntegrity,
  assert,
  equals,
  type FieldAnchors,
  FS,
  NAME,
  pattern,
  TESTS,
  TILE_UI,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElement,
  findElementByText,
  findNodeById,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  propsOf,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import SharedNote, {
  type NoteProfile,
  SharedNoteCore,
  type StoredComment,
} from "./main.tsx";
import { normalizePresenceParticipantName } from "./participant-name.ts";

const MARKDOWN =
  "---\ntitle: Preserve this\n---\n# Team 😀\n\n- [ ] task\n\n```ts\nconst x = `${literal}`;\n```\n";

// A stand-in for a viewer's `#profile`, which a pattern test cannot resolve.
// It is labeled, as a Fabric profile is, because a comment may link only a
// document that carries a label.
type TestProfile = AddIntegrity<
  NoteProfile,
  readonly ["shared-note-test-profile"]
>;

/**
 * A `cf-selection-change` event for `quote` at `from`, stated against the
 * editor's own text, as an editor with no confirmed version reports it.
 */
const selectionAt = (from: number, quote: string) => ({
  type: "cf-selection-change",
  detail: {
    from,
    to: from + quote.length,
    text: quote,
    base: null,
  },
});

/**
 * A `cf-selection-change` event for the one occurrence of `quote` in `body`,
 * stated against `base`.
 */
const selectionIn = (
  body: string,
  quote: string,
  base: { epoch: number; version: number },
) => {
  const from = body.indexOf(quote);
  return {
    type: "cf-selection-change",
    detail: { from, to: from + quote.length, text: quote, base },
  };
};

/** The `display` an element shown or hidden through its style takes. */
const displayOf = (node: unknown): unknown =>
  readValue((propValue(node, "style") as { display?: unknown })?.display);

/** The row of the comment whose body is `text`. */
const rowOf = (root: unknown, text: string): unknown =>
  innermostNode(
    root,
    (node) =>
      hasText(node, text) &&
      findElementByText(node, "cf-button", "Delete") !== undefined,
  );

/** The anchors the editor under `root` is asked to mark. */
const highlightsOf = (
  root: unknown,
): { id: string; kind?: string }[] | undefined =>
  propValue(findElement(root, "cf-code-editor"), "highlights") as
    | { id: string; kind?: string }[]
    | undefined;

/** Whether the Comment button under `root` is disabled. */
const commentDisabled = (root: unknown): unknown =>
  propValue(findElementByText(root, "cf-button", "Comment"), "disabled");

/** The editor under `root`. */
const editorOf = (root: unknown): unknown =>
  findElement(root, "cf-code-editor");

/** The comments a list holds, leaving out deleted records. */
const listed = (
  comments: readonly (StoredComment | undefined)[],
): StoredComment[] =>
  comments.filter((comment): comment is StoredComment => comment !== undefined);

/** The id of the one draft among `comments`, or empty for none. */
const draftIdIn = (
  comments: readonly (StoredComment | undefined)[],
): string => listed(comments).find((comment) => comment.draft)?.id ?? "";

/** The range of the anchor `id` among `ranges`. */
const rangeIn = (
  ranges: FieldAnchors | undefined,
  id: string | undefined,
): { from: number; to: number } | undefined =>
  ranges?.anchors.find((anchor) => anchor.id === id);

/** The cell a control binds under `prop`, as a `$value` or `$checked`. */
function boundCell<T>(control: unknown, prop: string): Writable<T>;
function boundCell(control: unknown, prop: string): unknown {
  const cell = propsOf(control)?.[prop];
  if (cell === undefined) throw new Error(`the control binds no ${prop}`);
  return cell;
}

/** Writes `value` into the cell a field binds as its `$value`. */
const typeInto = (field: unknown, value: string): void => {
  boundCell<string>(field, "$value").set(value);
};

/** Checks the box a `cf-checkbox` binds as its `$checked`. */
const check = (box: unknown): void => {
  boundCell<boolean>(box, "$checked").set(true);
};

export default pattern(() => {
  const subject = SharedNote({ title: "Team notes", content: MARKDOWN });
  const blank = SharedNote({});
  const assert_imported_content = assert(() =>
    subject.content === MARKDOWN && subject.title === "Team notes" &&
    subject[NAME] === "Team notes" && blank.content === ""
  );
  const assert_filesystem_projection = assert(() =>
    subject[FS].type === "text/markdown" &&
    subject[FS].frontmatter.title === "Team notes" &&
    subject[FS].content === MARKDOWN
  );
  const assert_collaborative_editor = assert(() => {
    const props = propsOf(findElement(subject[UI], "cf-code-editor"));
    return readValue(props?.["$value"]) === MARKDOWN &&
      readValue(props?.collaborative) === true &&
      readValue(props?.mode) === "prose" &&
      readValue(props?.wordWrap) === true &&
      readValue(props?.tabIndent) === true &&
      props?.presenceRoom === undefined &&
      readValue(props?.participantName) === "";
  });
  const assert_profile_setup = assert(() =>
    findNodeById(subject[UI], "shared-note-profile-setup") !== undefined
  );
  const assert_profile_name_is_safe_for_presence = assert(() =>
    normalizePresenceParticipantName("  Ada\u0000\u0085 Lovelace  ") ===
      "Ada Lovelace" &&
    normalizePresenceParticipantName("a".repeat(81)) === "a".repeat(80) &&
    normalizePresenceParticipantName("😀".repeat(65)) === "😀".repeat(64) &&
    normalizePresenceParticipantName("\ud800") === ""
  );
  const assert_embeddable_view = assert(() =>
    readValue(
      propsOf(findElement(subject[TILE_UI], "cf-code-editor"))?.["$value"],
    ) ===
      MARKDOWN
  );
  const action_error = action(() =>
    fireEvent(findElement(subject[UI], "cf-code-editor"), "oncf-error", {
      detail: { message: "Connection refused" },
    })
  );
  const assert_error_visible = assert(() =>
    hasText(subject[UI], "Connection refused") && subject.content === MARKDOWN
  );
  const action_reconcile = action(() =>
    fireEvent(
      findElement(subject[UI], "cf-code-editor"),
      "oncf-collaboration-reconcile",
      {
        detail: { localValue: "My unsent text", canonicalValue: MARKDOWN },
      },
    )
  );
  const assert_recovery_visible = assert(() =>
    readValue(
        propsOf(findNodeById(subject[UI], "shared-note-recovery"))?.value,
      ) ===
      "My unsent text" && subject.content === MARKDOWN
  );
  const action_presence_error = action(() =>
    fireEvent(
      findElement(subject[UI], "cf-code-editor"),
      "oncf-presence-error",
      { detail: { category: "connection" } },
    )
  );
  const assert_presence_notice_visible = assert(() =>
    hasText(subject[UI], "Live cursors are unavailable") &&
    hasText(
      subject[UI],
      "click outside the note, then back into it to try again",
    ) &&
    subject.content === MARKDOWN
  );
  const action_presence_join = action(() =>
    fireEvent(
      findElement(subject[UI], "cf-code-editor"),
      "oncf-presence-join",
      {},
    )
  );
  const assert_presence_notice_cleared = assert(() =>
    !hasText(subject[UI], "Live cursors are unavailable")
  );
  const action_presence_unsupported = action(() =>
    fireEvent(
      findElement(subject[UI], "cf-code-editor"),
      "oncf-presence-error",
      { detail: { category: "configuration" } },
    )
  );
  const assert_presence_unsupported_notice = assert(() =>
    hasText(subject[UI], "Live cursors are unavailable on this server") &&
    !hasText(
      subject[UI],
      "click outside the note, then back into it to try again",
    )
  );
  const action_append_line = action(() =>
    subject.appendLine.send({ text: "- [ ] follow up" })
  );
  const assert_line_appended = assert(() =>
    subject.content === MARKDOWN + "- [ ] follow up"
  );
  const assert_projection_follows_body = assert(() =>
    subject[FS].content === MARKDOWN + "- [ ] follow up"
  );
  const action_replace_text = action(() =>
    subject.replaceText.send({ old: "- [ ] task", new: "- [x] task" })
  );
  const assert_text_replaced = assert(() =>
    subject.content ===
      MARKDOWN.replace("- [ ] task", "- [x] task") + "- [ ] follow up"
  );
  const action_prepend_line_to_blank = action(() =>
    blank.prependLine.send({ text: "# Agenda" })
  );
  const action_append_line_to_blank = action(() =>
    blank.appendLine.send({ text: "- one" })
  );
  const assert_blank_lines = assert(() => blank.content === "# Agenda\n- one");

  // Comments are driven on the core, whose viewer is a profile the test
  // holds. The default export resolves the viewer's `#profile`, which a
  // pattern test cannot.
  const adaProfile = Writable.of<TestProfile>({ name: "Ada" });
  const content = Writable.of<string>(MARKDOWN);
  const comments = Writable.of<StoredComment[]>([]);
  const note = SharedNoteCore({
    content,
    comments,
    myProfile: adaProfile,
    participantName: "Ada",
  });
  // The same note as a viewer with no profile sees it.
  const guest = SharedNoteCore({ content, comments, participantName: "" });
  // The same note in another of Ada's tabs.
  const otherTab = SharedNoteCore({
    content,
    comments,
    myProfile: adaProfile,
    participantName: "Ada",
  });
  const QUOTE = "- [ ] task";
  const quoteFrom = MARKDOWN.indexOf(QUOTE);
  // What the verbs do to the body: a line before everything, and a longer
  // word before the quote.
  const INTRO = "# Intro\n";
  const movedFrom = quoteFrom + INTRO.length + "Everyone".length -
    "Team".length;

  const assert_comment_needs_a_selection = assert(() =>
    commentDisabled(note[UI]) === true &&
    highlightsOf(note[UI])?.length === 0 &&
    note.commentRanges === undefined
  );
  const action_select_quote = action(() =>
    fireEvent(
      editorOf(note[UI]),
      "oncf-selection-change",
      selectionAt(quoteFrom, QUOTE),
    )
  );
  const assert_selection_enables_comment = assert(() =>
    commentDisabled(note[UI]) === false &&
    commentDisabled(guest[UI]) === true &&
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none"
  );
  // Each write lands in its own step: a click in the same step as the write
  // of the draft it reads would read the draft as it was.
  const action_open_composer = action(() => clickButton(note[UI], "Comment"));
  const assert_composer_open = assert(() =>
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "flex" &&
    hasText(findNodeById(note[UI], "shared-note-composer"), QUOTE)
  );
  const action_type_comment = action(() =>
    typeInto(
      findNodeById(note[UI], "shared-note-comment-draft"),
      "Needs a date",
    )
  );
  const action_post_comment = action(() => clickButton(note[UI], "Post"));
  const assert_comment_posted = assert(() => {
    const [comment] = listed(comments.get());
    const range = rangeIn(note.commentRanges, comment?.id);
    return listed(comments.get()).length === 1 &&
      comment.body === "Needs a date" &&
      comment.quote === QUOTE &&
      comment.resolved.get() === false &&
      comment.replies.get().length === 0 &&
      equals(comment.authorProfile, adaProfile) &&
      range?.from === quoteFrom && range?.to === quoteFrom + QUOTE.length &&
      displayOf(findNodeById(note[UI], "shared-note-composer")) === "none";
  });
  const assert_editor_marks_the_comment = assert(() => {
    const highlights = highlightsOf(note[UI]);
    return highlights?.length === 1 &&
      highlights[0].id === listed(comments.get())[0].id &&
      highlights[0].kind === "active" &&
      highlightsOf(guest[UI])?.[0]?.kind === undefined &&
      hasText(rowOf(note[UI], "Needs a date"), QUOTE);
  });
  const assert_reply_needs_a_profile = assert(() =>
    propValue(
        findNodeByProp(rowOf(note[UI], "Needs a date"), "aria-label", "Reply"),
        "disabled",
      ) === false &&
    propValue(
        findNodeByProp(rowOf(guest[UI], "Needs a date"), "aria-label", "Reply"),
        "disabled",
      ) === true
  );
  // Memory moves the anchor through each verb's edit as it stores it, so
  // the comment stays on its text with no editor open.
  const action_verb_prepends_a_line = action(() =>
    note.prependLine.send({ text: INTRO })
  );
  const action_verb_replaces_text_before_the_quote = action(() =>
    note.replaceText.send({ old: "Team", new: "Everyone" })
  );
  const action_verb_appends_a_line = action(() =>
    note.appendLine.send({ text: "- [ ] follow up" })
  );
  const assert_verbs_moved_the_anchor_with_the_text = assert(() => {
    const range = rangeIn(note.commentRanges, listed(comments.get())[0]?.id);
    return content.get().slice(movedFrom, movedFrom + QUOTE.length) ===
        QUOTE &&
      range?.from === movedFrom && range?.to === movedFrom + QUOTE.length &&
      hasText(rowOf(note[UI], "Needs a date"), QUOTE) &&
      !hasText(rowOf(note[UI], "Needs a date"), "text no longer in note") &&
      !hasText(rowOf(note[UI], "Needs a date"), "now “");
  });
  // A selection whose text the body no longer holds there is refused when
  // the composer opens, and the composer stays closed.
  const action_select_stale_text = action(() =>
    fireEvent(
      editorOf(note[UI]),
      "oncf-selection-change",
      selectionAt(0, "Not in the note"),
    )
  );
  const action_open_composer_on_stale_text = action(() =>
    clickButton(note[UI], "Comment")
  );
  const assert_stale_selection_refused = assert(() =>
    listed(comments.get()).length === 1 &&
    note.commentRanges?.anchors.length === 1 &&
    hasText(
      findNodeById(note[UI], "shared-note-comment-notice"),
      "The note changed under your selection",
    ) &&
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none"
  );
  // An agent comments on text it names, which the body holds once.
  const AGENT_QUOTE = "Preserve this";
  const assert_absent_quote_refused = assert(() =>
    listed(comments.get()).length === 1
  );
  const assert_agent_comment_lands = assert(() => {
    const agent = listed(comments.get()).find((c) => c.body === "Agent note");
    const range = rangeIn(note.commentRanges, agent?.id);
    return listed(comments.get()).length === 2 &&
      agent !== undefined &&
      equals(agent.authorProfile, adaProfile) &&
      range !== undefined &&
      content.get().slice(range.from, range.to) === AGENT_QUOTE &&
      hasText(rowOf(note[UI], "Agent note"), AGENT_QUOTE) &&
      highlightsOf(note[UI])?.length === 2;
  });
  const action_select_row = action(() =>
    fireClick(rowOf(note[UI], "Agent note"))
  );
  const assert_row_selected = assert(() =>
    highlightsOf(note[UI])?.find((h) => h.kind === "active")?.id ===
      listed(comments.get()).find((c) => c.body === "Agent note")?.id
  );
  const action_click_highlight = action(() =>
    fireEvent(editorOf(note[UI]), "oncf-highlight-click", {
      type: "cf-highlight-click",
      detail: { id: listed(comments.get())[0].id },
    })
  );
  const assert_highlight_selects_its_comment = assert(() =>
    highlightsOf(note[UI])?.find((h) => h.kind === "active")?.id ===
      listed(comments.get())[0].id
  );
  const action_type_reply = action(() =>
    typeInto(
      findNodeByProp(rowOf(note[UI], "Needs a date"), "aria-label", "Reply"),
      "Dated it",
    )
  );
  const action_post_reply = action(() =>
    clickInRow(note[UI], "Needs a date", "Reply")
  );
  const action_reply_by_verb = action(() =>
    note.replyToComment.send({
      id: listed(comments.get())[0].id,
      body: "Thanks",
    })
  );
  const assert_replies_carry_their_author = assert(() => {
    const replies = listed(comments.get())[0]?.replies.get() ?? [];
    return replies.length === 2 &&
      replies[0].body === "Dated it" && replies[1].body === "Thanks" &&
      equals(replies[0].authorProfile, adaProfile) &&
      hasText(rowOf(note[UI], "Needs a date"), "Dated it") &&
      hasText(rowOf(note[UI], "Needs a date"), "Thanks");
  });
  // A verb rewrites the commented text: the anchor covers the replacement,
  // and the row shows the author's quote and, apart from it, the text now.
  const EDITED = "- [x] task";
  const action_verb_rewrites_the_commented_text = action(() =>
    note.replaceText.send({ old: QUOTE, new: EDITED })
  );
  const assert_row_shows_the_quote_and_the_text_now = assert(() => {
    const range = rangeIn(note.commentRanges, listed(comments.get())[0]?.id);
    return range !== undefined &&
      content.get().slice(range.from, range.to) === EDITED &&
      hasText(rowOf(note[UI], "Needs a date"), QUOTE) &&
      hasText(rowOf(note[UI], "Needs a date"), `now “${EDITED}”`);
  });
  // A verb deletes the commented text: Memory empties the anchor, and the
  // comment stays listed, marks nothing, and quotes what it was about.
  const action_verb_deletes_the_commented_text = action(() =>
    note.replaceText.send({ old: `${EDITED}\n`, new: "" })
  );
  const assert_comment_text_gone = assert(() => {
    const range = rangeIn(note.commentRanges, listed(comments.get())[0]?.id);
    return range !== undefined && range.from === range.to &&
      hasText(rowOf(note[UI], "Needs a date"), "text no longer in note") &&
      hasText(rowOf(note[UI], "Needs a date"), QUOTE) &&
      !hasText(rowOf(note[UI], "Needs a date"), "now “");
  });
  const action_resolve_comment = action(() =>
    clickInRow(note[UI], "Needs a date", "Resolve")
  );
  const assert_resolved_comment_hidden = assert(() =>
    listed(comments.get())[0]?.resolved.get() === true &&
    displayOf(rowOf(note[UI], "Needs a date")) === "none" &&
    highlightsOf(note[UI])?.length === 1
  );
  const action_show_resolved = action(() =>
    check(findElement(note[UI], "cf-checkbox"))
  );
  const assert_resolved_comment_shown = assert(() =>
    displayOf(rowOf(note[UI], "Needs a date")) === "flex"
  );
  const action_reopen_by_verb = action(() =>
    note.reopenComment.send({ id: listed(comments.get())[0].id })
  );
  const assert_reopened = assert(() =>
    listed(comments.get())[0]?.resolved.get() === false &&
    highlightsOf(note[UI])?.length === 2
  );
  const action_delete_by_verb = action(() =>
    note.deleteComment.send({
      id: listed(comments.get()).find((c) => c.body === "Agent note")?.id ?? "",
    })
  );
  const assert_deleted_with_its_anchor = assert(() =>
    listed(comments.get()).length === 1 &&
    listed(comments.get())[0].body === "Needs a date" &&
    note.commentRanges?.anchors.length === 1 &&
    rowOf(note[UI], "Agent note") === undefined
  );
  // A selection an editor reports against a confirmed version: a verb edits
  // ahead of it while the composer is open, and Memory moves the range from
  // that version to the text the body holds when the comment is posted. The
  // anchors document was last restated by the deletion, which changed no
  // text, so its version is the body's.
  const HEADING = "Everyone";
  const action_select_heading_at_a_version = action(() => {
    const from = content.get().indexOf(HEADING);
    const ranges = note.commentRanges;
    fireEvent(editorOf(note[UI]), "oncf-selection-change", {
      type: "cf-selection-change",
      detail: {
        from,
        to: from + HEADING.length,
        text: HEADING,
        base: ranges === undefined
          ? null
          : { epoch: ranges.epoch, version: ranges.version },
      },
    });
  });
  const action_open_composer_on_heading = action(() =>
    clickButton(note[UI], "Comment")
  );
  const action_verb_edits_ahead_of_the_selection = action(() =>
    note.prependLine.send({ text: "> Pinned" })
  );
  const action_type_heading_comment = action(() =>
    typeInto(findNodeById(note[UI], "shared-note-comment-draft"), "Title?")
  );
  const action_post_heading_comment = action(() =>
    clickButton(note[UI], "Post")
  );
  const assert_comment_lands_where_the_text_moved = assert(() => {
    const titled = listed(comments.get()).find((c) => c.body === "Title?");
    const range = rangeIn(note.commentRanges, titled?.id);
    return note.commentRanges !== undefined &&
      content.get().startsWith("> Pinned\n") &&
      range !== undefined &&
      content.get().slice(range.from, range.to) === HEADING;
  });
  // A selection held until its version leaves the history Memory keeps: the
  // editor restates it against a version Memory holds before the composer
  // opens, and the comment lands. Here the first report names an epoch the
  // field never had.
  const PINNED = "Pinned";
  const action_select_pinned_at_an_ended_epoch = action(() =>
    fireEvent(
      editorOf(note[UI]),
      "oncf-selection-change",
      selectionIn(content.get(), PINNED, { epoch: 999, version: 0 }),
    )
  );
  const action_open_composer_on_pinned = action(() =>
    clickButton(note[UI], "Comment")
  );
  const action_open_composer_on_the_ended_epoch = action(() =>
    clickButton(note[UI], "Comment")
  );
  const assert_ended_epoch_refused = assert(() =>
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none" &&
    hasText(
      findNodeById(note[UI], "shared-note-comment-notice"),
      "The note changed under your selection",
    ) &&
    !listed(comments.get()).some((c) => c.draft)
  );
  const action_editor_restates_the_selection = action(() => {
    const ranges = note.commentRanges;
    fireEvent(
      editorOf(note[UI]),
      "oncf-selection-change",
      selectionIn(content.get(), PINNED, {
        epoch: ranges?.epoch ?? 0,
        version: ranges?.version ?? 0,
      }),
    );
  });
  const action_type_pinned_comment = action(() =>
    typeInto(findNodeById(note[UI], "shared-note-comment-draft"), "Why pin?")
  );
  const action_post_pinned_comment = action(() =>
    clickButton(note[UI], "Post")
  );
  const assert_restated_selection_posts = assert(() => {
    const pinned = listed(comments.get()).find((c) => c.body === "Why pin?");
    const range = rangeIn(note.commentRanges, pinned?.id);
    return range !== undefined &&
      content.get().slice(range.from, range.to) === PINNED &&
      displayOf(findNodeById(note[UI], "shared-note-composer")) === "none";
  });
  // The person selects other text while the composer is open: the composer
  // stays on the text it was opened on, which its anchor holds, and the post
  // lands there. Cancelling a composer removes its anchor.
  const action_select_everyone_again = action(() => {
    const ranges = note.commentRanges;
    fireEvent(
      editorOf(note[UI]),
      "oncf-selection-change",
      selectionIn(content.get(), HEADING, {
        epoch: ranges?.epoch ?? 0,
        version: ranges?.version ?? 0,
      }),
    );
  });
  const action_open_composer_on_everyone = action(() =>
    clickButton(note[UI], "Comment")
  );
  const action_select_pinned_while_composing = action(() => {
    const ranges = note.commentRanges;
    fireEvent(
      editorOf(note[UI]),
      "oncf-selection-change",
      selectionIn(content.get(), PINNED, {
        epoch: ranges?.epoch ?? 0,
        version: ranges?.version ?? 0,
      }),
    );
  });
  const assert_composer_keeps_its_selection = assert(() => {
    const composer = findNodeById(note[UI], "shared-note-composer");
    return displayOf(composer) === "flex" && hasText(composer, HEADING) &&
      !hasText(composer, PINNED) &&
      highlightsOf(note[UI])?.some((h) =>
          h.kind === "active" &&
          listed(comments.get()).some((c) => c.id === h.id && c.draft)
        ) === true;
  });
  // The draft is a record of its own, which nobody else sees, and the button
  // that would start another is disabled while it is open.
  const assert_draft_is_hidden_from_others = assert(() => {
    const drafted = listed(comments.get()).find((c) => c.draft);
    return drafted !== undefined && drafted.body === "" &&
      drafted.quote === HEADING &&
      displayOf(findNodeByProp(guest[UI], "data-comment-id", drafted.id)) ===
        "none" &&
      !highlightsOf(guest[UI])?.some((h) => h.id === drafted.id) &&
      commentDisabled(note[UI]) === true;
  });
  const action_type_second_look = action(() =>
    typeInto(findNodeById(note[UI], "shared-note-comment-draft"), "Again?")
  );
  const action_post_second_look = action(() => clickButton(note[UI], "Post"));
  const assert_post_lands_on_the_composer_text = assert(() => {
    const again = listed(comments.get()).find((c) => c.body === "Again?");
    const range = rangeIn(note.commentRanges, again?.id);
    return range !== undefined && again?.draft === false &&
      content.get().slice(range.from, range.to) === HEADING &&
      !listed(comments.get()).some((c) => c.draft);
  });
  const action_open_composer_on_pinned_again = action(() =>
    clickButton(note[UI], "Comment")
  );
  const action_cancel_composer = action(() => clickButton(note[UI], "Cancel"));
  const assert_cancel_removes_the_anchor = assert(() =>
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none" &&
    note.commentRanges?.anchors.length === listed(comments.get()).length &&
    !listed(comments.get()).some((c) => c.draft)
  );
  // A draft continued and posted in another tab: the first tab's Post is
  // refused, and the comment keeps the other tab's text.
  const action_open_composer_for_another_tab = action(() =>
    clickButton(note[UI], "Comment")
  );
  const action_continue_in_another_tab = action(() =>
    fireClick(
      findElementByText(
        findNodeByProp(
          otherTab[UI],
          "data-comment-id",
          draftIdIn(comments.get()),
        ),
        "cf-button",
        "Continue",
      ),
    )
  );
  const action_type_in_another_tab = action(() =>
    typeInto(
      findNodeById(otherTab[UI], "shared-note-comment-draft"),
      "From tab two",
    )
  );
  const action_post_in_another_tab = action(() =>
    clickButton(otherTab[UI], "Post")
  );
  const action_type_in_first_tab = action(() =>
    typeInto(findNodeById(note[UI], "shared-note-comment-draft"), "Tab one")
  );
  const action_post_in_first_tab = action(() => clickButton(note[UI], "Post"));
  const assert_first_tab_post_refused = assert(() => {
    const posted = listed(comments.get()).find((c) =>
      c.body === "From tab two"
    );
    return posted !== undefined && posted.draft === false &&
      !listed(comments.get()).some((c) => c.body === "Tab one") &&
      displayOf(findNodeById(note[UI], "shared-note-composer")) === "flex" &&
      hasText(
        findNodeById(note[UI], "shared-note-comment-notice"),
        "posted or discarded in another tab",
      );
  });
  // Cancelling the refused composer leaves the comment the other tab posted.
  const action_cancel_in_first_tab = action(() =>
    clickButton(note[UI], "Cancel")
  );
  const assert_cancel_leaves_the_posted_comment = assert(() =>
    listed(comments.get()).some((c) =>
      c.body === "From tab two" && c.draft === false
    ) &&
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none" &&
    note.commentRanges?.anchors.length === listed(comments.get()).length
  );
  // A draft discarded in another tab takes its anchor with it, and the first
  // tab's Cancel then has nothing left to discard.
  const action_open_composer_to_discard = action(() =>
    clickButton(note[UI], "Comment")
  );
  // A draft names no comment to the verbs, so nothing can reply to it.
  const action_reply_to_the_draft = action(() =>
    note.replyToComment.send({
      id: draftIdIn(comments.get()),
      body: "Too early",
    })
  );
  const assert_draft_takes_no_reply = assert(() =>
    listed(comments.get()).some((c) => c.draft && c.replies.get().length === 0)
  );
  const action_discard_in_another_tab = action(() =>
    fireClick(
      findElementByText(
        findNodeByProp(
          otherTab[UI],
          "data-comment-id",
          draftIdIn(comments.get()),
        ),
        "cf-button",
        "Discard",
      ),
    )
  );
  const assert_discarded_draft_is_gone = assert(() =>
    !listed(comments.get()).some((c) => c.draft) &&
    note.commentRanges?.anchors.length === listed(comments.get()).length
  );
  const action_cancel_after_discard = action(() =>
    clickButton(note[UI], "Cancel")
  );
  const assert_composer_closed_after_discard = assert(() =>
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none" &&
    listed(comments.get()).some((c) => c.body === "From tab two")
  );

  return {
    // The refused verbs throw inside their handlers, which the runner reports
    // as runtime errors; they are expected.
    expectRuntimeErrors: [
      "addComment found no occurrence of `quote`",
      "addComment found `quote` more than once",
      "replaceText needs a non-empty `old` to anchor on",
      "replaceText found no occurrence of `old`",
      "replaceText found `old` more than once",
      "No comment has the id",
    ],
    [TESTS]: [
      { assertion: assert_imported_content },
      { assertion: assert_filesystem_projection },
      { assertion: assert_collaborative_editor },
      { assertion: assert_profile_setup },
      { assertion: assert_profile_name_is_safe_for_presence },
      { assertion: assert_embeddable_view },
      { action: action_error },
      { assertion: assert_error_visible },
      { action: action_reconcile },
      { assertion: assert_recovery_visible },
      { action: action_presence_error },
      { assertion: assert_presence_notice_visible },
      { action: action_presence_join },
      { assertion: assert_presence_notice_cleared },
      { action: action_presence_unsupported },
      { assertion: assert_presence_unsupported_notice },
      { action: action_append_line },
      { assertion: assert_line_appended },
      { assertion: assert_projection_follows_body },
      { action: action_replace_text },
      { assertion: assert_text_replaced },
      // Each refusal leaves the body as it was.
      { action: subject.replaceText, event: { old: "", new: "x" } },
      { action: subject.replaceText, event: { old: "absent", new: "x" } },
      { action: subject.replaceText, event: { old: "- [", new: "x" } },
      { assertion: assert_text_replaced },
      { action: action_prepend_line_to_blank },
      { action: action_append_line_to_blank },
      { assertion: assert_blank_lines },
      { assertion: assert_comment_needs_a_selection },
      { action: action_select_quote },
      { assertion: assert_selection_enables_comment },
      { action: action_open_composer },
      { assertion: assert_composer_open },
      { action: action_type_comment },
      { action: action_post_comment },
      { assertion: assert_comment_posted },
      { assertion: assert_editor_marks_the_comment },
      { assertion: assert_reply_needs_a_profile },
      { action: action_verb_prepends_a_line },
      { action: action_verb_replaces_text_before_the_quote },
      { action: action_verb_appends_a_line },
      { assertion: assert_verbs_moved_the_anchor_with_the_text },
      { action: action_select_stale_text },
      { action: action_open_composer_on_stale_text },
      { assertion: assert_stale_selection_refused },
      {
        action: note.addComment,
        event: { quote: "Not in the note", body: "Lost" },
      },
      {
        action: note.addComment,
        event: { quote: "- [ ]", body: "Ambiguous" },
      },
      { assertion: assert_absent_quote_refused },
      {
        action: note.addComment,
        event: { quote: AGENT_QUOTE, body: "Agent note" },
      },
      { assertion: assert_agent_comment_lands },
      { action: action_select_row },
      { assertion: assert_row_selected },
      { action: action_click_highlight },
      { assertion: assert_highlight_selects_its_comment },
      { action: action_type_reply },
      { action: action_post_reply },
      { action: action_reply_by_verb },
      { assertion: assert_replies_carry_their_author },
      { action: action_verb_rewrites_the_commented_text },
      { assertion: assert_row_shows_the_quote_and_the_text_now },
      { action: action_verb_deletes_the_commented_text },
      { assertion: assert_comment_text_gone },
      { action: action_resolve_comment },
      { assertion: assert_resolved_comment_hidden },
      { action: action_show_resolved },
      { assertion: assert_resolved_comment_shown },
      { action: action_reopen_by_verb },
      { assertion: assert_reopened },
      { action: action_delete_by_verb },
      { assertion: assert_deleted_with_its_anchor },
      { action: action_select_heading_at_a_version },
      { action: action_open_composer_on_heading },
      { action: action_verb_edits_ahead_of_the_selection },
      { action: action_type_heading_comment },
      { action: action_post_heading_comment },
      { assertion: assert_comment_lands_where_the_text_moved },
      { action: action_select_pinned_at_an_ended_epoch },
      { action: action_open_composer_on_the_ended_epoch },
      { assertion: assert_ended_epoch_refused },
      { action: action_editor_restates_the_selection },
      { action: action_open_composer_on_pinned },
      { action: action_type_pinned_comment },
      { action: action_post_pinned_comment },
      { assertion: assert_restated_selection_posts },
      { action: action_select_everyone_again },
      { action: action_open_composer_on_everyone },
      { action: action_select_pinned_while_composing },
      { assertion: assert_composer_keeps_its_selection },
      { assertion: assert_draft_is_hidden_from_others },
      { action: action_type_second_look },
      { action: action_post_second_look },
      { assertion: assert_post_lands_on_the_composer_text },
      { action: action_open_composer_on_pinned_again },
      { action: action_cancel_composer },
      { assertion: assert_cancel_removes_the_anchor },
      { action: action_open_composer_for_another_tab },
      { action: action_continue_in_another_tab },
      { action: action_type_in_another_tab },
      { action: action_post_in_another_tab },
      { action: action_type_in_first_tab },
      { action: action_post_in_first_tab },
      { assertion: assert_first_tab_post_refused },
      { action: action_cancel_in_first_tab },
      { assertion: assert_cancel_leaves_the_posted_comment },
      { action: action_open_composer_to_discard },
      { action: action_reply_to_the_draft },
      { assertion: assert_draft_takes_no_reply },
      { action: action_discard_in_another_tab },
      { assertion: assert_discarded_draft_is_gone },
      { action: action_cancel_after_discard },
      { assertion: assert_composer_closed_after_discard },
    ],
    subject,
    note,
  };
});
