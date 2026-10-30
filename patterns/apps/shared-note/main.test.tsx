/**
 * Tests imported text, editor bindings, recovery, the live-cursor notice, the
 * profile-name sanitizer's co-presence bounds, the verbs that edit the body,
 * and the comments anchored to it, without a notebook.
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
  const QUOTE = "- [ ] task";
  const quoteFrom = MARKDOWN.indexOf(QUOTE);
  const quoteTo = quoteFrom + QUOTE.length;

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
    note.comments[0].anchor.quote === QUOTE &&
    note.comments[0].anchor.from === quoteFrom &&
    note.comments[0].anchor.to === quoteTo &&
    note.comments[0].resolved === false &&
    equals(note.comments[0].authorProfile, adaProfile) &&
    displayOf(findNodeById(note[UI], "shared-note-composer")) === "none"
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
  const action_editor_reports_mapped_range = action(() =>
    fireEvent(
      findElement(note[UI], "cf-code-editor"),
      "oncf-highlights-mapped",
      {
        type: "cf-highlights-mapped",
        detail: {
          highlights: [{
            id: note.comments[0].id,
            from: quoteFrom + 8,
            to: quoteTo + 8,
          }],
        },
      },
    )
  );
  const assert_anchor_follows_the_editor = assert(() =>
    note.comments[0].anchor.from === quoteFrom + 8 &&
    note.comments[0].anchor.to === quoteTo + 8 &&
    note.comments[0].anchor.quote === QUOTE
  );
  // The body moves on with no editor open, so the stored range no longer
  // holds the quote; the quote re-finds the comment.
  const action_body_grows_before_the_quote = action(() =>
    content.set("# Intro\n\n" + MARKDOWN)
  );
  const assert_quote_refinds_the_comment = assert(() => {
    const highlights = highlightsOf(note[UI]);
    return highlights?.length === 1 &&
      highlights[0].from === quoteFrom + "# Intro\n\n".length &&
      highlights[0].to === quoteTo + "# Intro\n\n".length &&
      !hasText(rowOf(note[UI], "Needs a date"), "text no longer in note");
  });
  const action_body_loses_the_quote = action(() =>
    content.set(MARKDOWN.replace(QUOTE, "- [x] done"))
  );
  const assert_comment_orphaned = assert(() =>
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
  const assert_agent_comment_lands = assert(() =>
    note.comments.length === 2 &&
    note.comments[1].body === "Agent note" &&
    note.comments[1].anchor.quote === "Preserve this" &&
    note.comments[1].anchor.from === MARKDOWN.indexOf("Preserve this") &&
    equals(note.comments[1].authorProfile, adaProfile) &&
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
  const action_resolve_by_verb = action(() =>
    note.resolveComment.send({ id: note.comments[1].id })
  );
  const assert_resolved_by_verb = assert(() =>
    note.comments[1].resolved === true && highlightsOf(note[UI])?.length === 0
  );

  return {
    // The one refused `addComment` below throws inside the verb, which the
    // runner reports as a runtime error; exactly that one is expected.
    expectRuntimeErrors: ["addComment found no occurrence of `quote`"],
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
      { assertion: assert_editor_marks_the_comment },
      { action: action_editor_reports_mapped_range },
      { assertion: assert_anchor_follows_the_editor },
      { action: action_body_grows_before_the_quote },
      { assertion: assert_quote_refinds_the_comment },
      { action: action_body_loses_the_quote },
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
        event: { quote: "Preserve this", body: "Agent note" },
      },
      { assertion: assert_agent_comment_lands },
      { action: action_select_row },
      { assertion: assert_row_selected },
      { action: action_type_reply },
      { action: action_post_reply },
      { assertion: assert_reply_carries_author },
      { action: action_resolve_by_verb },
      { assertion: assert_resolved_by_verb },
    ],
    subject,
    note,
  };
});
