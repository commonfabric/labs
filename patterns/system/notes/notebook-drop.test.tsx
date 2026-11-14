/**
 * Test: dropping onto a note row keeps memberships stable.
 *
 * Every row's drop zone binds handleDropOntoNotebook, which files a dropped
 * note in this notebook with addUnique (dedup by link identity, no
 * whole-list read), and for a note in a multi-selection takes the selection
 * out of every other notebook. Neither may remove anything from this
 * notebook: an in-notebook drop of an existing note would turn into a
 * move-to-tail reorder, and a multi-select drop would strip the selected
 * notes from the notebook entirely. These tests drive the drop stream bound
 * to a row and pin: order stability for an in-notebook re-drop, membership
 * survival for a multi-select re-drop, and a plain add for a note from
 * outside.
 *
 * Run: deno task cf test patterns/system/notes/notebook-drop.test.tsx --root patterns --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findNode,
  fireEvent,
  isElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Notebook from "./notebook.tsx";
import Note from "./note.tsx";

// A row's title lives in its cf-chip's `label` prop, which textContent
// (a children walk) never sees — so locate the row zone as the
// note,notebook-accepting cf-drop-zone whose subtree holds the chip with
// that label. Module scope: SES callbacks may not capture callables from
// enclosing function scopes.
const sendDropOntoRow = (
  subject: { [UI]: unknown },
  rowText: string,
  sourceCell: unknown,
) => {
  const zone = findNode(subject[UI], (node) => {
    if (!isElement(node, "cf-drop-zone")) return false;
    // Prop values arrive as link proxies, so resolve before comparing.
    if (
      String(propValue(node, "accept") ?? "") !== "note,notebook"
    ) return false;
    // Labels carry the note NAME ("📝 <title>"), so match by inclusion.
    const chip = findNode(
      node,
      (inner) =>
        isElement(inner, "cf-chip") &&
        String(propValue(inner, "label") ?? "").includes(rowText),
    );
    return chip !== undefined;
  });
  fireEvent(
    zone,
    "oncf-drop",
    { detail: { sourceCell } },
    `the ${rowText} row`,
  );
};

const noteTitlesOf = (subject: { notes?: unknown }): string[] =>
  [...((subject.notes as { title?: string }[] | undefined) ?? [])]
    .map((n) => n?.title ?? "");

export default pattern(() => {
  const firstNote = Note({
    title: "First Note",
    content: "",
    isHidden: true,
  });
  const secondNote = Note({
    title: "Second Note",
    content: "",
    isHidden: true,
  });
  // Lives outside the notebook until a drop pulls it in.
  const looseNote = Note({
    title: "Loose Note",
    content: "",
    isHidden: false,
  });

  const subject = Notebook({
    title: "Drop Test Notebook",
    notes: [firstNote, secondNote],
    isHidden: false,
  });

  const action_drop_existing_note_onto_row = action(() =>
    sendDropOntoRow(subject, "Second Note", firstNote)
  );
  const action_select_all = action(() => {
    subject.selectAllNotes.send();
  });
  const action_drop_selected_onto_row = action(() =>
    sendDropOntoRow(subject, "Second Note", firstNote)
  );
  const action_drop_loose_note_onto_row = action(() =>
    sendDropOntoRow(subject, "Second Note", looseNote)
  );

  const assert_initial_order = assert(() => {
    const titles = noteTitlesOf(subject);
    return titles.length === 2 && titles[0] === "First Note" &&
      titles[1] === "Second Note";
  });

  // An in-notebook drop of an already-present note is a no-op: same
  // memberships, same order. (Removing then re-adding would file the note
  // back at the tail.)
  const assert_re_drop_keeps_order = assert(() => {
    const titles = noteTitlesOf(subject);
    return titles.length === 2 && titles[0] === "First Note" &&
      titles[1] === "Second Note";
  });

  // A multi-select drop within the notebook must not remove the selection
  // from the notebook it is already in.
  const assert_multi_drop_keeps_notes = assert(() => {
    const titles = noteTitlesOf(subject);
    return titles.length === 2 && titles[0] === "First Note" &&
      titles[1] === "Second Note";
  });

  // The selection is consumed by the drop either way.
  const assert_multi_drop_clears_selection = assert(() =>
    [...(subject.selectedNoteIndices ?? [])].length === 0
  );

  // A note from outside the notebook is added once and hidden from the
  // space-wide list.
  const assert_loose_note_added = assert(() => {
    const titles = noteTitlesOf(subject);
    return titles.length === 3 && titles[2] === "Loose Note";
  });
  const assert_loose_note_hidden = assert(() => looseNote.isHidden === true);

  return {
    [TESTS]: [
      { assertion: assert_initial_order },

      { action: action_drop_existing_note_onto_row },
      { assertion: assert_re_drop_keeps_order },

      { action: action_select_all },
      { action: action_drop_selected_onto_row },
      { assertion: assert_multi_drop_keeps_notes },
      { assertion: assert_multi_drop_clears_selection },

      { action: action_drop_loose_note_onto_row },
      { assertion: assert_loose_note_added },
      { assertion: assert_loose_note_hidden },
    ],
    subject,
  };
});
