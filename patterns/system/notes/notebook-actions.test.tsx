/**
 * Test: the notebook's controls, driven through its rendered view.
 *
 * A shelf is listed among the space's mentionables under the name
 * "Notebook", a name a notebook's `#notebook` wish matches, so it is the
 * notebook the add-to and move-to selects offer and the one a move takes
 * notes out of. (A notebook made in the test is not found that way: the wish
 * matches a piece by the tag its schema carries, and a link the test lists
 * carries none.) With it discoverable, this drives what the view binds and
 * the pattern does not export: the per-row checkbox with shift-click ranges,
 * the row's remove button, the add-to and move-to selects, the header drop
 * zone, the row drop zone's multi-select move, and the title input's keydown.
 *
 * A navigation is not observable from a pattern test: the runner records it
 * for its summary, and nothing the test can read changes. So each control
 * whose only effect is to navigate is pressed after an assertion that it shows
 * its target.
 *
 * A drop onto the header moves a note out of the notebook holding it, which
 * shifts the notes after it in that list; the note added here has to be the
 * one dropped, not the one that moved into its place.
 *
 * Run: deno task cf test patterns/system/notes/notebook-actions.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  findElement,
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  isButton,
  isElement,
  propsOf,
  propValue,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import Notebook from "./notebook.tsx";
import Note from "./note.tsx";
import { addBacklink, NamedPiece, Shelf } from "./note-test-fixtures.tsx";

// ===== View helpers (module scope: SES callbacks may not capture callables
// from enclosing function scopes) =====

/** The table row whose chip is labelled `label` (a note's NAME). */
const rowOf = (root: unknown, label: string): unknown =>
  findNode(
    root,
    (node) =>
      isElement(node, "tr") &&
      findNodeByProp(node, "label", label) !== undefined,
  );

/** A row's checkbox cell: the first node in the row that takes a click. */
const checkboxOf = (row: unknown): unknown =>
  findNode(row, (node) => propsOf(node)?.onClick !== undefined);

const selectOf = (root: unknown, placeholder: string): unknown =>
  findNodeByProp(root, "placeholder", placeholder);

type SelectItem = { label?: string; value?: string };

/** The value the select offers for the notebook whose NAME starts `prefix`. */
const selectValueFor = (select: unknown, prefix: string): string => {
  const items = (propValue(select, "items") ?? []) as SelectItem[];
  const item = [...items].find((i) => (i?.label ?? "").startsWith(prefix));
  if (item?.value === undefined) {
    throw new Error(`no select item for "${prefix}"`);
  }
  return item.value;
};

const selectLabels = (select: unknown): string =>
  [...((propValue(select, "items") ?? []) as SelectItem[])]
    .map((i) => i?.label ?? "").join("|");

const titlesOf = (notebook: { notes?: unknown }): string =>
  [...((notebook.notes as { title?: string }[] | undefined) ?? [])]
    .map((n) => n?.title ?? "").join(",");

/** Whether the note titled `title` in the notebook is hidden from the space. */
const hiddenOf = (
  notebook: { notes?: unknown },
  title: string,
): boolean | undefined =>
  [...((notebook.notes as { title?: string; isHidden?: boolean }[]) ?? [])]
    .find((n) => n?.title === title)?.isHidden;

const sortedIndices = (indices: readonly number[] | undefined): string =>
  [...(indices ?? [])].sort((a, b) => a - b).join(",");

const dropOntoHeader = (root: unknown, sourceCell: unknown) =>
  fireEvent(
    findNodeByProp(root, "accept", "sibling"),
    "oncf-drop",
    { detail: { sourceCell } },
    "the header drop zone",
  );

export default pattern(() => {
  const mentionable = wish<Writable<object[]>>({ query: "#mentionable" })
    .result!;
  const pieceRegistry = wish<Writable<object[]>>({ query: "#pieceRegistry" })
    .result!;

  const alpha = Note({ title: "Alpha", content: "", isHidden: true });
  const beta = Note({ title: "Beta", content: "", isHidden: true });
  const gamma = Note({ title: "Gamma", content: "", isHidden: true });
  // Listed in the space until a drop files it into a notebook.
  const delta = Note({ title: "Delta", content: "", isHidden: false });

  const home = Notebook({
    title: "Home",
    notes: [alpha, beta, gamma],
    isHidden: false,
  });
  const other = Shelf({ notes: [delta] });
  const child = Notebook({
    title: "Child",
    notes: [],
    isHidden: true,
    parentNotebook: home,
  });
  const fresh = Notebook({ title: "Fresh", notes: [], isHidden: false });
  // Named the way the notebook finds its "All Notes" view.
  const allNotes = NamedPiece({ name: "All Notes (2)" });
  // Links to the notebook from outside it, so nothing else moves it.
  const linker = Note({ title: "Linker", content: "", isHidden: false });
  const backlinkToHome = addBacklink({ target: home, source: linker });

  // ===== Discovery =====

  const action_list_notebooks = action(() => {
    mentionable.push(other);
  });

  const assert_selects_offer_notebooks = assert(() =>
    selectLabels(selectOf(home[UI], "Add to notebook...")) ===
      "Notebook|────────────|New Notebook..."
  );

  // ===== Checkbox selection =====

  const action_click_alpha = action(() =>
    fireClick(checkboxOf(rowOf(home[UI], "📝 Alpha")), "Alpha's checkbox")
  );
  const action_shift_click_gamma = action(() =>
    fireEvent(
      checkboxOf(rowOf(home[UI], "📝 Gamma")),
      "onClick",
      { shiftKey: true },
      "Gamma's checkbox",
    )
  );
  const action_click_beta = action(() =>
    fireClick(checkboxOf(rowOf(home[UI], "📝 Beta")), "Beta's checkbox")
  );
  const action_click_gamma = action(() =>
    fireClick(checkboxOf(rowOf(home[UI], "📝 Gamma")), "Gamma's checkbox")
  );
  const action_click_delta = action(() =>
    fireClick(checkboxOf(rowOf(home[UI], "📝 Delta")), "Delta's checkbox")
  );

  const assert_alpha_selected = assert(() =>
    sortedIndices(home.selectedNoteIndices) === "0"
  );
  const assert_range_selected = assert(() =>
    sortedIndices(home.selectedNoteIndices) === "0,1,2"
  );
  const assert_beta_deselected = assert(() =>
    sortedIndices(home.selectedNoteIndices) === "0,2"
  );

  // ===== Add to and move to another notebook =====

  const action_add_to_other = action(() => {
    const select = selectOf(home[UI], "Add to notebook...");
    fireEvent(select, "onChange", {
      detail: { value: selectValueFor(select, "Notebook") },
    }, "the add-to select");
  });
  const assert_added_to_other = assert(() =>
    titlesOf(other) === "Delta,Alpha,Gamma" &&
    titlesOf(home) === "Alpha,Beta,Gamma" &&
    sortedIndices(home.selectedNoteIndices) === ""
  );

  const action_add_to_new = action(() =>
    fireEvent(
      selectOf(home[UI], "Add to notebook..."),
      "onChange",
      { detail: { value: "new" } },
      "the add-to select",
    )
  );
  const assert_new_notebook_prompt_shown = assert(() =>
    home.showNewNotebookPrompt === true
  );
  const action_cancel_new_notebook = action(() => {
    home.cancelNewNotebook.send();
  });
  const assert_new_notebook_prompt_hidden = assert(() =>
    home.showNewNotebookPrompt === false
  );

  const action_move_to_other = action(() => {
    const select = selectOf(home[UI], "Move to...");
    fireEvent(select, "onChange", {
      detail: { value: selectValueFor(select, "Notebook") },
    }, "the move-to select");
  });
  const assert_beta_moved = assert(() =>
    titlesOf(other) === "Delta,Alpha,Gamma,Beta" &&
    titlesOf(home) === "Alpha,Gamma" &&
    sortedIndices(home.selectedNoteIndices) === ""
  );

  // ===== Drops =====

  // Dropping a selected note onto a row moves the whole selection here, so
  // the selected notes leave every other notebook.
  const action_drop_alpha_onto_gamma_row = action(() => {
    const zone = findElement(rowOf(home[UI], "📝 Gamma"), "cf-drop-zone");
    fireEvent(zone, "oncf-drop", { detail: { sourceCell: alpha } }, "a row");
  });
  const assert_selection_left_other = assert(() =>
    titlesOf(other) === "Delta,Beta" && titlesOf(home) === "Alpha,Gamma" &&
    sortedIndices(home.selectedNoteIndices) === ""
  );

  const action_drop_delta_onto_header = action(() =>
    dropOntoHeader(home[UI], delta)
  );
  const assert_delta_moved_here = assert(() =>
    titlesOf(other) === "Beta" && titlesOf(home) === "Alpha,Gamma,Delta" &&
    hiddenOf(home, "Delta") === true
  );

  const action_drop_alpha_onto_header = action(() =>
    dropOntoHeader(home[UI], alpha)
  );
  const assert_present_note_drop_is_noop = assert(() =>
    titlesOf(home) === "Alpha,Gamma,Delta"
  );

  const assert_selection_kept_once = assert(() =>
    titlesOf(home).split(",").sort().join(",") === "Alpha,Delta,Gamma" &&
    sortedIndices(home.selectedNoteIndices) === ""
  );

  // ===== Row controls =====

  const action_remove_gamma = action(() => {
    const row = rowOf(home[UI], "📝 Gamma");
    fireClick(findNode(row, isButton("✕")), "Gamma's remove button");
  });
  const assert_gamma_removed_and_shown = assert(() =>
    titlesOf(home) === "Alpha,Delta" && gamma.title === "Gamma" &&
    gamma.isHidden === false
  );

  // ===== Move into a new notebook =====

  const action_move_to_new = action(() =>
    fireEvent(
      selectOf(home[UI], "Move to..."),
      "onChange",
      { detail: { value: "new" } },
      "the move-to select",
    )
  );
  const action_create_notebook_for_move = action(() => {
    home.createNotebookFromSelectionPrompt.send();
  });
  // The new notebook's row names it with its count of notes.
  const assert_alpha_moved_to_new_notebook = assert(() =>
    !titlesOf(home).includes("Alpha") &&
    findNodeByProp(home[UI], "label", "📓 New Notebook (1)") !== undefined &&
    home.showNewNotebookPrompt === false
  );

  // ===== Title keydown =====

  const action_start_editing = action(() => {
    home.startEditTitle.send();
  });
  const action_press_escape = action(() =>
    fireEvent(selectOf(home[UI], "Notebook name..."), "oncf-keydown", {
      key: "Escape",
    }, "title input")
  );
  const action_press_enter = action(() =>
    fireEvent(selectOf(home[UI], "Notebook name..."), "oncf-keydown", {
      key: "Enter",
    }, "title input")
  );
  const assert_editing = assert(() => home.isEditingTitle === true);
  const assert_not_editing = assert(() => home.isEditingTitle === false);

  // ===== Creating from the prompts, which opens what was created =====

  const action_show_note_prompt = action(() => {
    fresh.showNewNoteModal.send();
  });
  const assert_note_created_and_prompt_closed = assert(() =>
    titlesOf(fresh) === "New Note" && fresh.showNewNotePrompt === false
  );
  const action_show_notebook_prompt = action(() => {
    fresh.showNewNotebookModal.send();
  });
  const assert_notebook_created_and_prompt_closed = assert(() =>
    titlesOf(fresh) === "New Note,New Notebook" &&
    fresh.showNewNestedNotebookPrompt === false
  );

  // ===== Navigation controls =====

  const action_go_to_parent = action(() =>
    fireEvent(
      findNodeByProp(child[UI], "label", "📓 Home (2)"),
      "oncf-click",
      {},
      "the parent chip",
    )
  );
  const assert_parent_chip_shown = assert(() =>
    findNodeByProp(child[UI], "label", "📓 Home (2)") !== undefined
  );

  const action_register_all_notes = action(() => {
    pieceRegistry.push(allNotes);
  });
  const assert_all_notes_button_shown = assert(() =>
    styleOf(findNode(home[UI], isButton("📁 All Notes")), "display") === "flex"
  );

  const action_add_backlink = action(() => backlinkToHome.send());
  const assert_backlink_listed = assert(() =>
    findNode(home[UI], isButton("📝 Linker")) !== undefined
  );

  return {
    [TESTS]: [
      { action: action_list_notebooks },
      { assertion: assert_selects_offer_notebooks },

      { action: action_click_alpha },
      { assertion: assert_alpha_selected },
      { action: action_shift_click_gamma },
      { assertion: assert_range_selected },
      { action: action_click_beta },
      { assertion: assert_beta_deselected },

      { action: action_add_to_other },
      { assertion: assert_added_to_other },
      { action: action_add_to_new },
      { assertion: assert_new_notebook_prompt_shown },
      { action: action_cancel_new_notebook },
      { assertion: assert_new_notebook_prompt_hidden },
      { action: action_click_beta },
      { action: action_move_to_other },
      { assertion: assert_beta_moved },

      { action: action_click_alpha },
      { action: action_click_gamma },
      { action: action_drop_alpha_onto_gamma_row },
      { assertion: assert_selection_left_other },
      { action: action_drop_delta_onto_header },
      { assertion: assert_delta_moved_here },
      { action: action_drop_alpha_onto_header },
      { assertion: assert_present_note_drop_is_noop },
      { action: action_click_alpha },
      { action: action_click_delta },
      { action: action_drop_alpha_onto_header },
      { assertion: assert_selection_kept_once },

      { action: action_remove_gamma },
      { assertion: assert_gamma_removed_and_shown },

      { action: action_click_alpha },
      { action: action_move_to_new },
      { assertion: assert_new_notebook_prompt_shown },
      { action: action_create_notebook_for_move },
      { assertion: assert_alpha_moved_to_new_notebook },

      { action: action_start_editing },
      { action: action_press_escape },
      { assertion: assert_editing },
      { action: action_press_enter },
      { assertion: assert_not_editing },

      { action: action_show_note_prompt },
      // Direct steps: each opens what it created, and an event an action
      // sends would make that navigation a cascade hop (see the end).
      { action: fresh.createNoteFromPrompt },
      { assertion: assert_note_created_and_prompt_closed },
      { action: action_show_notebook_prompt },
      { action: fresh.createNestedNotebookFromPrompt },
      { assertion: assert_notebook_created_and_prompt_closed },

      { assertion: assert_parent_chip_shown },
      { action: action_go_to_parent },
      { action: action_register_all_notes },
      { assertion: assert_all_notes_button_shown },
      { press: home[UI], control: "📁 All Notes" },
      { action: action_add_backlink },
      { assertion: assert_backlink_listed },
      { press: home[UI], control: "📝 Linker" },
    ],
    home,
    other,
    child,
    fresh,
    // With server execution on, a navigation an action's event makes is a
    // cascade hop, which the client does not enact ahead of the server, and
    // the runtime warns `optimistic-navigate-skipped`. A press makes a root
    // event, but it sends only a click, and the parent chip binds
    // `oncf-click`. The flag is a boolean, so it cannot be pinned to that
    // warning.
    allowConsoleWarnings: true,
  };
});
