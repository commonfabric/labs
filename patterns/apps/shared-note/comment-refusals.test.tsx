/**
 * Tests what the comment controls refuse, and say they refuse, when what a
 * click acts on has changed since the view was drawn: a second click on
 * Comment before the button disables, a Post with nothing written or from a
 * viewer with no profile of their own, a Continue on a draft posted
 * meanwhile or while another comment is being written, and a reply to a
 * comment deleted in another tab. Each leaves the comments as they were and
 * keeps what was typed.
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  findElement,
  findElementByText,
  findNodeById,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  propValue,
  setBound,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import { SharedNoteCore, type StoredComment } from "./main.tsx";
import {
  profileGesture,
  type TestProfile,
  writeOwnProfile,
} from "./test-profile.ts";

const BODY = "# Plan\n\nShip it\n\nTest it\n";

/** A `cf-selection-change` event for the first `quote` in `body`. */
const selectionIn = (body: string, quote: string) => ({
  type: "cf-selection-change",
  detail: {
    from: body.indexOf(quote),
    to: body.indexOf(quote) + quote.length,
    text: quote,
    value: body,
  },
});

/** The comments a list holds, leaving out deleted records. */
const listed = (
  comments: readonly (StoredComment | undefined)[],
): StoredComment[] =>
  comments.filter((comment): comment is StoredComment => comment !== undefined);

/** The comment whose body or quote is `text`. */
const named = (
  comments: readonly (StoredComment | undefined)[],
  text: string,
): StoredComment | undefined =>
  listed(comments).find((c) => c.body === text || c.quote === text);

/** The editor under `root`. */
const editorOf = (root: unknown): unknown =>
  findElement(root, "cf-code-editor");

/** The button showing `label` in the row of the comment `id` under `root`. */
const rowButton = (root: unknown, id: string | undefined, label: string) =>
  findElementByText(
    findNodeByProp(root, "data-comment-id", id),
    "cf-button",
    label,
  );

export default pattern(() => {
  const adaProfile = Writable.of<TestProfile>();
  const action_write_adas_profile = writeOwnProfile({
    profile: adaProfile,
    name: "Ada",
  });
  const content = Writable.of<string>(BODY);
  const comments = Writable.of<StoredComment[]>([]);
  const note = SharedNoteCore({
    content,
    comments,
    myProfile: adaProfile,
    participantName: "Ada",
  });
  // The same note in another of Ada's tabs, in a third with nothing
  // selected, and as a viewer with no profile sees it.
  const otherTab = SharedNoteCore({
    content,
    comments,
    myProfile: adaProfile,
    participantName: "Ada",
  });
  const freshTab = SharedNoteCore({
    content,
    comments,
    myProfile: adaProfile,
    participantName: "Ada",
  });
  const guest = SharedNoteCore({ content, comments, participantName: "" });

  // === Actions ===

  const action_select_ship = action(() =>
    fireEvent(
      editorOf(note[UI]),
      "oncf-selection-change",
      selectionIn(content.get(), "Ship it"),
    )
  );
  const action_comment = action(() => clickButton(note[UI], "Comment"));
  const action_post = action(() => clickButton(note[UI], "Post"));
  const action_type_ship_friday = action(() =>
    setBound(
      findNodeById(note[UI], "shared-note-comment-draft"),
      "$value",
      "Friday",
    )
  );
  const action_select_row = action(() =>
    fireClick(findNodeByProp(
      note[UI],
      "data-comment-id",
      named(
        comments.get(),
        "Friday",
      )?.id,
    ))
  );
  const action_type_reply = action(() =>
    setBound(
      findNodeByProp(
        findNodeById(note[UI], "shared-note-comment-actions"),
        "aria-label",
        "Reply",
      ),
      "$value",
      "On it",
    )
  );
  const action_delete_in_other_tab = action(() =>
    otherTab.deleteComment.send({
      id: named(comments.get(), "Friday")?.id ?? "",
    })
  );
  const action_reply = action(() =>
    clickButton(findNodeById(note[UI], "shared-note-comment-actions"), "Reply")
  );
  const action_comment_on_test = action(() =>
    note.addComment.send({ quote: "Test it", body: "Coverage" })
  );
  const action_continue_posted = action(() =>
    fireClick(
      rowButton(note[UI], named(comments.get(), "Coverage")?.id, "Continue"),
    )
  );
  const action_other_tab_drafts_on_plan = action(() =>
    fireEvent(
      editorOf(otherTab[UI]),
      "oncf-selection-change",
      selectionIn(content.get(), "Plan"),
    )
  );
  const action_other_tab_comments = action(() =>
    clickButton(otherTab[UI], "Comment")
  );
  const action_continue_other_draft = action(() =>
    fireClick(
      rowButton(
        note[UI],
        listed(comments.get()).find((c) =>
          c.status === "draft" && c.quote === "Plan"
        )?.id,
        "Continue",
      ),
    )
  );
  const action_fresh_tab_comments = action(() =>
    clickButton(freshTab[UI], "Comment")
  );
  const action_guest_posts = action(() => clickButton(guest[UI], "Post"));

  // === Assertions ===

  const assert_composing = assert(() =>
    styleOf(findNodeById(note[UI], "shared-note-composer"), "display") ===
      "flex" &&
    listed(comments.get()).filter((c) => c.status === "draft").length === 1
  );
  const assert_second_comment_refused = assert(() =>
    hasText(
      findNodeById(note[UI], "shared-note-comment-notice"),
      "Post or cancel the comment you are writing first.",
    ) &&
    listed(comments.get()).filter((c) => c.status === "draft").length === 1
  );
  const assert_empty_post_refused = assert(() =>
    hasText(
      findNodeById(note[UI], "shared-note-comment-notice"),
      "Write a comment to post it.",
    ) &&
    listed(comments.get()).length === 1 &&
    listed(comments.get())[0]?.status === "draft" &&
    styleOf(findNodeById(note[UI], "shared-note-composer"), "display") ===
      "flex"
  );
  const assert_posted = assert(() =>
    named(comments.get(), "Friday")?.status === "posted" &&
    styleOf(findNodeById(note[UI], "shared-note-composer"), "display") ===
      "none"
  );
  const assert_reply_to_deleted_refused = assert(() =>
    named(comments.get(), "Friday") === undefined &&
    hasText(
      findNodeById(note[UI], "shared-note-comment-notice"),
      "This comment is no longer posted.",
    ) &&
    propValue(
        findNodeByProp(
          findNodeById(note[UI], "shared-note-comment-actions"),
          "aria-label",
          "Reply",
        ),
        "$value",
      ) === "On it"
  );
  const assert_continue_posted_refused = assert(() =>
    named(comments.get(), "Coverage")?.status === "posted" &&
    hasText(
      findNodeById(note[UI], "shared-note-comment-notice"),
      "This draft was posted or discarded in another tab.",
    ) &&
    styleOf(findNodeById(note[UI], "shared-note-composer"), "display") ===
      "none"
  );
  const assert_continue_while_composing_refused = assert(() =>
    listed(comments.get()).filter((c) => c.status === "draft").length === 2 &&
    hasText(
      findNodeById(note[UI], "shared-note-comment-notice"),
      "Post or cancel the comment you are writing first.",
    )
  );
  const assert_nothing_selected_refused = assert(() =>
    hasText(
      findNodeById(freshTab[UI], "shared-note-comment-notice"),
      "Select the text to comment on first.",
    ) &&
    styleOf(findNodeById(freshTab[UI], "shared-note-composer"), "display") ===
      "none"
  );
  const assert_guest_post_refused = assert(() =>
    hasText(
      findNodeById(guest[UI], "shared-note-comment-notice"),
      "Choose a Fabric profile of your own to comment.",
    )
  );
  const assert_empty_quote_refused = assert(() =>
    named(comments.get(), "Nowhere") === undefined
  );

  return {
    // The refused verb throws inside its handler, which the runner reports
    // as a runtime error; it is expected.
    expectRuntimeErrors: ["addComment needs a non-empty `quote`"],
    [TESTS]: [
      {
        action: action_write_adas_profile,
        event: {},
        trustedUi: profileGesture,
      },
      // A comment on nothing anchors nowhere.
      { action: note.addComment, event: { quote: "", body: "Nowhere" } },
      { assertion: assert_empty_quote_refused },

      { action: action_select_ship },
      { action: action_comment },
      { assertion: assert_composing },
      { action: action_comment },
      { assertion: assert_second_comment_refused },
      { action: action_post },
      { assertion: assert_empty_post_refused },
      { action: action_type_ship_friday },
      { action: action_post },
      { assertion: assert_posted },

      { action: action_select_row },
      { action: action_type_reply },
      { action: action_delete_in_other_tab },
      { action: action_reply },
      { assertion: assert_reply_to_deleted_refused },

      { action: action_comment_on_test },
      { action: action_continue_posted },
      { assertion: assert_continue_posted_refused },

      { action: action_other_tab_drafts_on_plan },
      { action: action_other_tab_comments },
      { action: action_select_ship },
      { action: action_comment },
      { action: action_continue_other_draft },
      { assertion: assert_continue_while_composing_refused },

      { action: action_fresh_tab_comments },
      { assertion: assert_nothing_selected_refused },
      { action: action_guest_posts },
      { assertion: assert_guest_post_refused },
    ],
    note,
  };
});
