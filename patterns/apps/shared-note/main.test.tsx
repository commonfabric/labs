/**
 * Tests imported text, editor bindings, recovery, the live-cursor notice, the
 * profile-name sanitizer's co-presence bounds, the verbs that edit the body
 * and map the comments' anchors through their edits, and the comments
 * anchored to it, without a notebook.
 */

import {
  action,
  type AddIntegrity,
  assert,
  equals,
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
  type NoteComment,
  type NoteProfile,
  SharedNoteCore,
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

/** The range `quote` occupies in `MARKDOWN`, as a selection event carries it. */
const selectionOf = (quote: string) => ({
  type: "cf-selection-change",
  detail: {
    from: MARKDOWN.indexOf(quote),
    to: MARKDOWN.indexOf(quote) + quote.length,
    text: quote,
  },
});

/** The `display` a row shown or hidden through its style takes. */
const displayOf = (node: unknown): unknown =>
  readValue((propValue(node, "style") as { display?: unknown })?.display);

/** The row holding `text`: the innermost node holding it and a Resolve or Reopen button. */
const rowOf = (root: unknown, text: string): unknown =>
  innermostNode(
    root,
    (node) =>
      hasText(node, text) &&
      (findElementByText(node, "cf-button", "Resolve") !== undefined ||
        findElementByText(node, "cf-button", "Reopen") !== undefined),
  );

/** The ranges the editor under `root` is asked to mark. */
const highlightsOf = (
  root: unknown,
): { id: string; from: number; to: number; kind?: string }[] | undefined =>
  propValue(findElement(root, "cf-code-editor"), "highlights") as
    | { id: string; from: number; to: number; kind?: string }[]
    | undefined;

/** Whether the Comment button under `root` is disabled. */
const commentDisabled = (root: unknown): unknown =>
  propValue(findElementByText(root, "cf-button", "Comment"), "disabled");

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
    subject[NAME] === "Team notes" && blank.content === "" &&
    subject.comments.length === 0
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
      MARKDOWN &&
    findNodeById(subject[TILE_UI], "shared-note-comments") !== undefined
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
  const comments = Writable.of<NoteComment[]>([]);
  const note = SharedNoteCore({
    content,
    comments,
    myProfile: adaProfile,
    participantName: "Ada",
  });
  // The same note as a viewer with no profile sees it.
  const guest = SharedNoteCore({ content, comments, participantName: "" });
  const QUOTE = "- [ ] task";
  const quoteFrom = MARKDOWN.indexOf(QUOTE);
  const quoteTo = quoteFrom + QUOTE.length;
  // What the body verbs do to the body before the anchor is read against
  // it: a line before everything, and a longer word before the quote.
  const INTRO = "# Intro\n";
  const GROWTH = "Everyone".length - "Team".length;
  const movedFrom = quoteFrom + INTRO.length + GROWTH;
  const movedTo = quoteTo + INTRO.length + GROWTH;

  const assert_comment_needs_a_selection = assert(() =>
    commentDisabled(note[UI]) === true &&
    highlightsOf(note[UI])?.length === 0
  );
  const action_select_quote = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-selection-change",
      selectionOf(QUOTE),
    )
  );
  const assert_selection_enables_comment = assert(() =>
    commentDisabled(note[UI]) === false &&
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none"
  );
  // Each write lands in its own step: a click in the same step as the write
  // of the draft it reads would read the draft as it was.
  const action_open_composer = action(() => clickButton(note[UI], "Comment"));
  const assert_composer_open = assert(() =>
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "block" &&
    hasText(findNodeById(note[UI], "shared-note-composer"), QUOTE)
  );
  const action_type_comment = action(() =>
    typeInto(
      findNodeById(note[UI], "shared-note-comment-draft"),
      "Needs a date",
    )
  );
  const action_post_comment = action(() => clickButton(note[UI], "Post"));
  const assert_comment_posted = assert(() =>
    note.comments.length === 1 &&
    note.comments[0].body === "Needs a date" &&
    note.comments[0].anchor.from === quoteFrom &&
    note.comments[0].anchor.to === quoteTo &&
    note.comments[0].anchor.version === undefined &&
    note.comments[0].resolved === false &&
    equals(note.comments[0].authorProfile, adaProfile) &&
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none"
  );
  const assert_reply_needs_a_profile = assert(() =>
    propValue(
        findNodeByProp(rowOf(note[UI], "Needs a date"), "aria-label", "Reply"),
        "disabled",
      ) === false &&
    propValue(
        findNodeByProp(rowOf(guest[UI], "Needs a date"), "aria-label", "Reply"),
        "disabled",
      ) === true &&
    commentDisabled(guest[UI]) === true
  );
  const assert_editor_marks_the_comment = assert(() => {
    const highlights = highlightsOf(note[UI]);
    return highlights?.length === 1 &&
      highlights[0].id === note.comments[0].id &&
      highlights[0].from === quoteFrom &&
      highlights[0].to === quoteTo &&
      highlights[0].kind === "selected" &&
      hasText(rowOf(note[UI], "Needs a date"), QUOTE);
  });
  // The body verbs map the anchor through their own edit, so the comment
  // stays on its text with no editor open to report.
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
    const highlights = highlightsOf(note[UI]);
    return content.get().slice(movedFrom, movedTo) === QUOTE &&
      note.comments[0].anchor.from === movedFrom &&
      note.comments[0].anchor.to === movedTo &&
      highlights?.length === 1 &&
      highlights[0].from === movedFrom &&
      highlights[0].to === movedTo &&
      hasText(rowOf(note[UI], "Needs a date"), QUOTE);
  });
  const action_editor_reports_mapped_range = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-highlights-mapped",
      {
        type: "cf-highlights-mapped",
        detail: {
          highlights: [{
            id: note.comments[0].id,
            from: movedFrom + 8,
            to: movedTo + 8,
          }],
        },
      },
    )
  );
  const assert_anchor_follows_the_editor = assert(() =>
    note.comments[0].anchor.from === movedFrom + 8 &&
    note.comments[0].anchor.to === movedTo + 8
  );
  // A report that reached the pattern late, from before the one it holds,
  // leaves the anchor where the later report put it.
  const action_editor_reports_with_a_version = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-highlights-mapped",
      {
        type: "cf-highlights-mapped",
        detail: {
          highlights: [{
            id: note.comments[0].id,
            from: movedFrom + 8,
            to: movedTo + 8,
          }],
          version: { epoch: 1, version: 5 },
        },
      },
    )
  );
  // A report with the anchor's own stamp comes from a document with a
  // different unconfirmed edit; the one that arrived first stands.
  const action_other_editor_reports_the_same_version = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-highlights-mapped",
      {
        type: "cf-highlights-mapped",
        detail: {
          highlights: [{
            id: note.comments[0].id,
            from: movedFrom + 6,
            to: movedTo + 6,
          }],
          version: { epoch: 1, version: 5 },
        },
      },
    )
  );
  const action_editor_replays_an_older_report = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-highlights-mapped",
      {
        type: "cf-highlights-mapped",
        detail: {
          highlights: [{
            id: note.comments[0].id,
            from: movedFrom + 4,
            to: movedTo + 4,
          }],
          version: { epoch: 1, version: 4 },
        },
      },
    )
  );
  const assert_older_report_leaves_the_anchor = assert(() =>
    note.comments[0].anchor.from === movedFrom + 8 &&
    note.comments[0].anchor.to === movedTo + 8 &&
    note.comments[0].anchor.version?.epoch === 1 &&
    note.comments[0].anchor.version?.version === 5
  );
  // An editor reports the range emptied: someone deleted the text. The
  // comment stays in the panel, marks nothing, and says so.
  const action_editor_reports_the_range_emptied = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-highlights-mapped",
      {
        type: "cf-highlights-mapped",
        detail: {
          highlights: [{
            id: note.comments[0].id,
            from: movedFrom + 8,
            to: movedFrom + 8,
          }],
          version: { epoch: 1, version: 6 },
        },
      },
    )
  );
  const assert_comment_orphaned = assert(() =>
    note.comments[0].anchor.from === movedFrom + 8 &&
    note.comments[0].anchor.to === movedFrom + 8 &&
    highlightsOf(note[UI])?.length === 0 &&
    hasText(rowOf(note[UI], "Needs a date"), "text no longer in note")
  );
  const action_resolve_comment = action(() =>
    clickInRow(note[UI], "Needs a date", "Resolve")
  );
  const assert_resolved_comment_hidden = assert(() =>
    note.comments[0].resolved === true &&
    displayOf(rowOf(note[UI], "Needs a date")) === "none" &&
    findElementByText(
        rowOf(note[UI], "Needs a date"),
        "cf-button",
        "Reopen",
      ) !==
      undefined
  );
  const action_show_resolved = action(() =>
    check(findElement(note[UI], "cf-checkbox"))
  );
  const assert_resolved_comment_shown = assert(() =>
    displayOf(rowOf(note[UI], "Needs a date")) === "flex"
  );
  const assert_absent_quote_refused = assert(() => note.comments.length === 1);
  const AGENT_QUOTE = "Preserve this";
  const agentQuoteFrom = INTRO.length + MARKDOWN.indexOf(AGENT_QUOTE);
  const assert_agent_comment_lands = assert(() =>
    note.comments.length === 2 &&
    note.comments[1].body === "Agent note" &&
    note.comments[1].anchor.from === agentQuoteFrom &&
    note.comments[1].anchor.to === agentQuoteFrom + AGENT_QUOTE.length &&
    equals(note.comments[1].authorProfile, adaProfile) &&
    hasText(rowOf(note[UI], "Agent note"), AGENT_QUOTE) &&
    highlightsOf(note[UI])?.length === 1 &&
    highlightsOf(note[UI])?.[0].id === note.comments[1].id
  );
  const action_select_row = action(() =>
    fireClick(rowOf(note[UI], "Agent note"))
  );
  const assert_row_selected = assert(() =>
    highlightsOf(note[UI])?.[0].kind === "selected"
  );
  const action_type_reply = action(() =>
    typeInto(
      findNodeByProp(rowOf(note[UI], "Agent note"), "aria-label", "Reply"),
      "Dated it",
    )
  );
  const action_post_reply = action(() =>
    clickInRow(note[UI], "Agent note", "Reply")
  );
  const assert_reply_carries_author = assert(() =>
    note.comments[1].replies.length === 1 &&
    note.comments[1].replies[0].body === "Dated it" &&
    equals(note.comments[1].replies[0].authorProfile, adaProfile) &&
    hasText(rowOf(note[UI], "Agent note"), "Dated it")
  );
  // A verb deletes the commented text: the anchor it maps is empty, and
  // the comment is orphaned the way an editor's report orphans one.
  const action_verb_deletes_the_commented_text = action(() =>
    note.replaceText.send({ old: "title: Preserve this\n", new: "" })
  );
  const assert_verb_orphaned_the_comment = assert(() =>
    note.comments[1].anchor.from === INTRO.length + "---\n".length &&
    note.comments[1].anchor.to === note.comments[1].anchor.from &&
    highlightsOf(note[UI])?.length === 0 &&
    hasText(rowOf(note[UI], "Agent note"), "text no longer in note")
  );
  const action_resolve_by_verb = action(() =>
    note.resolveComment.send({ id: note.comments[1].id })
  );
  const assert_resolved_by_verb = assert(() =>
    note.comments[1].resolved === true && highlightsOf(note[UI])?.length === 0
  );
  // A selection made before others typed: the editor reports where their
  // edit moved it, and the post lands there, stamped with the version the
  // editor read it at.
  const HEADING = "# Everyone";
  const headingFrom = INTRO.length + MARKDOWN.indexOf("# Team");
  const action_select_heading = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-selection-change",
      {
        type: "cf-selection-change",
        detail: {
          from: headingFrom,
          to: headingFrom + HEADING.length,
          text: HEADING,
          version: { epoch: 1, version: 7 },
        },
      },
    )
  );
  const action_open_composer_on_heading = action(() =>
    clickButton(note[UI], "Comment")
  );
  const action_type_heading_comment = action(() =>
    typeInto(findNodeById(note[UI], "shared-note-comment-draft"), "Title?")
  );
  const action_editor_reports_the_selection_moved = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-selection-change",
      {
        type: "cf-selection-change",
        detail: {
          from: headingFrom + 3,
          to: headingFrom + 3 + HEADING.length,
          text: HEADING,
          version: { epoch: 1, version: 8 },
        },
      },
    )
  );
  const action_post_heading_comment = action(() =>
    clickButton(note[UI], "Post")
  );
  const assert_post_lands_where_the_selection_moved = assert(() =>
    note.comments.length === 3 &&
    note.comments[2].body === "Title?" &&
    note.comments[2].anchor.from === headingFrom + 3 &&
    note.comments[2].anchor.to === headingFrom + 3 + HEADING.length &&
    note.comments[2].anchor.version?.epoch === 1 &&
    note.comments[2].anchor.version?.version === 8
  );
  // The same, with the selected text deleted before the post: the editor
  // reports the selection collapsed, and the post is refused with the
  // composer left open.
  const action_select_task = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-selection-change",
      {
        type: "cf-selection-change",
        detail: { from: movedFrom, to: movedTo, text: QUOTE },
      },
    )
  );
  const action_open_composer_on_task = action(() =>
    clickButton(note[UI], "Comment")
  );
  const action_type_task_comment = action(() =>
    typeInto(findNodeById(note[UI], "shared-note-comment-draft"), "Gone")
  );
  const action_editor_reports_the_selection_collapsed = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-selection-change",
      {
        type: "cf-selection-change",
        detail: { from: movedFrom, to: movedFrom, text: "" },
      },
    )
  );
  const action_post_task_comment = action(() => clickButton(note[UI], "Post"));
  const assert_post_without_a_selection_refused = assert(() =>
    note.comments.length === 3 &&
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "block"
  );

  return {
    // The one refused `addComment` below throws inside the verb, which the
    // runner reports as a runtime error; it is expected.
    // The one refused post throws inside its handler the same way.
    expectRuntimeErrors: [
      "addComment found no occurrence of `quote`",
      "Select the text to comment on first.",
    ],
    [TESTS]: [
      { assertion: assert_imported_content },
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
      { action: action_replace_text },
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
      { assertion: assert_reply_needs_a_profile },
      { assertion: assert_editor_marks_the_comment },
      { action: action_verb_prepends_a_line },
      { action: action_verb_replaces_text_before_the_quote },
      { action: action_verb_appends_a_line },
      { assertion: assert_verbs_moved_the_anchor_with_the_text },
      { action: action_editor_reports_mapped_range },
      { assertion: assert_anchor_follows_the_editor },
      { action: action_editor_reports_with_a_version },
      { action: action_other_editor_reports_the_same_version },
      { action: action_editor_replays_an_older_report },
      { assertion: assert_older_report_leaves_the_anchor },
      { action: action_editor_reports_the_range_emptied },
      { assertion: assert_comment_orphaned },
      { action: action_resolve_comment },
      { assertion: assert_resolved_comment_hidden },
      { action: action_show_resolved },
      { assertion: assert_resolved_comment_shown },
      // A quote the body holds nowhere is refused, and a unique one lands.
      {
        action: note.addComment,
        event: { quote: "nowhere in the note", body: "Lost" },
      },
      { assertion: assert_absent_quote_refused },
      {
        action: note.addComment,
        event: { quote: AGENT_QUOTE, body: "Agent note" },
      },
      { assertion: assert_agent_comment_lands },
      { action: action_select_row },
      { assertion: assert_row_selected },
      { action: action_type_reply },
      { action: action_post_reply },
      { assertion: assert_reply_carries_author },
      { action: action_verb_deletes_the_commented_text },
      { assertion: assert_verb_orphaned_the_comment },
      { action: action_resolve_by_verb },
      { assertion: assert_resolved_by_verb },
      { action: action_select_heading },
      { action: action_open_composer_on_heading },
      { action: action_type_heading_comment },
      { action: action_editor_reports_the_selection_moved },
      { action: action_post_heading_comment },
      { assertion: assert_post_lands_where_the_selection_moved },
      { action: action_select_task },
      { action: action_open_composer_on_task },
      { action: action_type_task_comment },
      { action: action_editor_reports_the_selection_collapsed },
      { action: action_post_task_comment },
      { assertion: assert_post_without_a_selection_refused },
    ],
    subject,
    note,
  };
});
