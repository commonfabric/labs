/**
 * Tests the note's activity rows: one row per editing session of the body or
 * the title, however many changes it holds, and none for a session that
 * changed nothing; one row per edit verb call, comment and reply; and none for
 * a call that is refused.
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElement,
  findNodeByProp,
  fireEvent,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import SharedNote, {
  type ActivityRow,
  SharedNoteCore,
  type StoredComment,
} from "./main.tsx";
import {
  profileGesture,
  type TestProfile,
  writeOwnProfile,
} from "./test-profile.ts";

const BODY = "# Plan\n\nShip it\n";

/** 2020-09-13 in milliseconds: a row's time is well past it, in nanoseconds. */
const LONG_AGO_MS = 1_600_000_000_000n;

/** The words of each row in `rows`, oldest first. */
const bodies = (rows: readonly (ActivityRow | undefined)[]): string[] =>
  rows.map((row) => row?.body ?? "");

/** The body's editor under `root`. */
const editorOf = (root: unknown): unknown =>
  findElement(root, "cf-code-editor");

/** The title field under `root`. */
const titleFieldOf = (root: unknown): unknown =>
  findNodeByProp(root, "aria-label", "Note title");

/** The viewer's own edit, as `cf-code-editor` tells one. */
const change = (value: string) => ({
  type: "cf-edit",
  detail: { value },
});

export default pattern(() => {
  const adaProfile = Writable.of<TestProfile>();
  const content = Writable.of<string>(BODY);
  const comments = Writable.of<StoredComment[]>([]);
  const title = Writable.of<string>("Packing list");
  const activity = Writable.of<ActivityRow[]>([]);
  const note = SharedNoteCore({
    content,
    comments,
    myProfile: adaProfile,
    participantName: "Ada",
    title,
    activity,
  });

  // The whole note, whose title field is its own editing session.
  const whole = SharedNote({ title: "Groceries", content: BODY });

  const action_blur = action(() =>
    fireEvent(editorOf(note[UI]), "oncf-blur", {})
  );
  const action_type = action(() =>
    fireEvent(editorOf(note[UI]), "oncf-edit", change(BODY + "x"))
  );
  const action_type_more = action(() =>
    fireEvent(editorOf(note[UI]), "oncf-edit", change(BODY + "xy"))
  );

  const assert_no_rows = assert(() => activity.get().length === 0);
  const assert_one_edit = assert(() =>
    bodies(activity.get()).join("|") === 'edited "Packing list"'
  );
  const assert_still_one_edit = assert(() => activity.get().length === 1);
  const assert_two_edits = assert(() =>
    bodies(activity.get()).join("|") ===
      'edited "Packing list"|edited "Packing list"'
  );
  // The row's time is the handler's clock as it ran, in nanoseconds, not
  // milliseconds.
  const assert_row_has_time = assert(() => {
    const at = activity.get()[0]?.doneAt?.value;
    return at !== undefined && at > LONG_AGO_MS * 1_000_000n;
  });

  const action_retitle = action(() => title.set("  "));
  const assert_untitled = assert(() =>
    bodies(activity.get()).at(-1) === 'edited "Untitled note"'
  );
  const action_long_title = action(() => title.set("x".repeat(500)));
  const assert_title_cut_short = assert(() =>
    bodies(activity.get()).at(-1) === `edited "${"x".repeat(79)}…"`
  );
  const action_restore_title = action(() => title.set("Packing list"));

  const assert_verbs_reported = assert(() =>
    bodies(activity.get()).slice(-3).join("|") ===
      'edited "Packing list"|edited "Packing list"|edited "Packing list"'
  );
  const assert_verb_count = assert(() => activity.get().length === 7);

  const assert_commented = assert(() =>
    bodies(activity.get()).at(-1) === 'commented on "Packing list"' &&
    activity.get().length === 8
  );
  const action_reply = action(() =>
    note.replyToComment.send({
      id: comments.get().find((c) => c?.status === "posted")?.id ?? "",
      body: "Friday",
    })
  );
  const assert_replied = assert(() =>
    bodies(activity.get()).at(-1) ===
      'replied to a comment on "Packing list"' &&
    activity.get().length === 9
  );

  const assert_refusals_add_nothing = assert(() => activity.get().length === 9);

  const action_type_title = action(() => {
    setBound(titleFieldOf(whole[UI]), "$value", "Groceries!");
    fireEvent(titleFieldOf(whole[UI]), "oncf-input", {
      type: "cf-input",
      detail: { value: "Groceries!" },
    });
  });
  const action_blur_title = action(() =>
    fireEvent(titleFieldOf(whole[UI]), "oncf-blur", {})
  );
  const assert_title_quiet = assert(() =>
    (whole["[ACTIVITY]"] ?? []).length === 0
  );
  const assert_title_edit = assert(() =>
    bodies(whole["[ACTIVITY]"] ?? []).join("|") === 'edited "Groceries!"'
  );

  return {
    // The refused verbs throw inside their handlers, which the runner reports
    // as runtime errors; they are expected.
    expectRuntimeErrors: [
      "replaceText needs a non-empty `old`",
      "addComment needs a `body` with text",
    ],
    [TESTS]: [
      {
        action: writeOwnProfile({ profile: adaProfile, name: "Ada" }),
        event: {},
        trustedUi: profileGesture,
      },

      // Leaving the editor without changing it reports nothing.
      { action: action_blur },
      { assertion: assert_no_rows },

      // Many changes in one session are one row, told as the editor loses
      // focus; leaving again without a change adds none.
      { action: action_type },
      { action: action_type_more },
      { assertion: assert_no_rows },
      { action: action_blur },
      { assertion: assert_one_edit },
      { assertion: assert_row_has_time },
      { action: action_blur },
      { assertion: assert_still_one_edit },

      // The next session is a row of its own.
      { action: action_type },
      { action: action_blur },
      { assertion: assert_two_edits },

      // A note with no title is named as the editor shows it.
      { action: action_retitle },
      { action: action_type },
      { action: action_blur },
      { assertion: assert_untitled },
      // A long title is cut short in the row.
      { action: action_long_title },
      { action: action_type },
      { action: action_blur },
      { assertion: assert_title_cut_short },
      { action: action_restore_title },

      // Each verb call is a session of its own.
      { action: note.appendLine, event: { text: "- tent" } },
      { action: note.prependLine, event: { text: "# Trip" } },
      { action: note.replaceText, event: { old: "Ship it", new: "Pack it" } },
      { assertion: assert_verbs_reported },
      { assertion: assert_verb_count },

      // Comments and replies are reported; their words are not.
      { action: note.addComment, event: { quote: "Pack it", body: "When?" } },
      { assertion: assert_commented },
      { action: action_reply },
      { assertion: assert_replied },

      // A refused call writes nothing, its row included.
      { action: note.replaceText, event: { old: "", new: "x" } },
      { action: note.addComment, event: { quote: "Pack it", body: " " } },
      { assertion: assert_refusals_add_nothing },

      // The title field is an editing session of its own.
      { action: action_blur_title },
      { assertion: assert_title_quiet },
      { action: action_type_title },
      { action: action_blur_title },
      { assertion: assert_title_edit },
    ],
    note,
    whole,
  };
});
