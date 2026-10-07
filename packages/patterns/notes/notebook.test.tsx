/**
 * Test Pattern: Notebook
 *
 * Comprehensive tests for the notebook pattern:
 * - Initial state with provided values
 * - noteCount computed from notes array
 * - setTitle stream for renaming
 * - createNote stream for adding notes
 * - createNotes stream for bulk adding
 * - Selection system (selectAll, deselectAll)
 * - Modal state management (showNewNoteModal, cancelNewNote, etc.)
 * - Title editing (startEditTitle, stopEditTitle)
 * - Delete selected notes
 * - Duplicate selected notes
 * - NAME computed format
 * - createNotebook stream for nested notebooks
 * - SELF-dependent functionality: parentNotebook set correctly on created notes
 *
 * The test harness sets up defaultPattern so wish("#default") resolves,
 * enabling tests for handlers that write to pieceRegistry.
 *
 * Run: deno task cf test packages/patterns/notes/notebook.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  NAME,
  pattern,
  resultOf,
  TESTS,
  wish,
  Writable,
} from "commonfabric";
import Notebook from "./notebook.tsx";
import Note from "./note.tsx";

export default pattern(() => {
  const pieceRegistryRequest = wish<Writable<object[]>>({
    query: "#pieceRegistry",
  });
  const pieceRegistry = resultOf(pieceRegistryRequest.result);

  // Create some initial notes for testing
  const note1 = Note({
    title: "First Note",
    content: "Content of first note",

    isHidden: true,
  });

  const note2 = Note({
    title: "Second Note",
    content: "Content of second note",

    isHidden: true,
  });

  const notebook = Notebook({
    title: "Test Notebook",
    notes: [note1, note2],
    isHidden: false,
  });

  // Create an empty notebook for empty state tests
  const emptyNotebook = Notebook({
    title: "Empty Notebook",
    notes: [],
    isHidden: false,
  });

  const selectionNoteA = Note({
    title: "Note A",
    content: "Content A",
    isHidden: true,
  });
  const selectionNoteB = Note({
    title: "Note B",
    content: "Content B",
    isHidden: true,
  });

  // Create a notebook for selection/deletion/duplication tests
  const selectionNotebook = Notebook({
    title: "Selection Test",
    notes: [selectionNoteA, selectionNoteB],
    isHidden: false,
  });

  const modalNotebook = Notebook({
    title: "Modal Actions",
    notes: [],
    isHidden: false,
  });

  const promptNotebook = Notebook({
    title: "Prompt Actions",
    notes: [
      Note({
        title: "Prompt Note",
        content: "Prompt content",
        isHidden: true,
      }),
    ],
    isHidden: false,
  });

  // ==========================================================================
  // Actions - Initial State
  // ==========================================================================

  const action_rename_notebook = action(() => {
    notebook.setTitle.send("Renamed Notebook");
  });

  const action_rename_again = action(() => {
    notebook.setTitle.send("Final Name");
  });

  const action_create_note_via_stream = action(() => {
    notebook.createNote.send({
      title: "Stream Created Note",
      content: "Created via createNote stream",
    });
  });

  const action_create_multiple_notes = action(() => {
    notebook.createNotes.send({
      notesData: [
        { title: "Bulk Note 1", content: "First bulk note" },
        { title: "Bulk Note 2", content: "Second bulk note" },
      ],
    });
  });

  // ==========================================================================
  // Actions - Selection System
  // ==========================================================================

  const action_select_all = action(() => {
    selectionNotebook.selectAllNotes.send();
  });

  const action_deselect_all = action(() => {
    selectionNotebook.deselectAllNotes.send();
  });

  // ==========================================================================
  // Actions - Modal State Management
  // ==========================================================================

  const action_show_new_note_modal = action(() => {
    notebook.showNewNoteModal.send();
  });

  const action_cancel_new_note = action(() => {
    notebook.cancelNewNote.send();
  });

  const action_show_new_notebook_modal = action(() => {
    notebook.showNewNotebookModal.send();
  });

  const action_cancel_new_notebook = action(() => {
    notebook.cancelNewNestedNotebook.send();
  });

  // ==========================================================================
  // Actions - Title Editing
  // ==========================================================================

  const action_start_editing = action(() => {
    notebook.startEditTitle.send();
  });

  const action_stop_editing = action(() => {
    notebook.stopEditTitle.send();
  });

  // ==========================================================================
  // Actions - Delete Selected
  // ==========================================================================

  const action_register_notes = action(() => {
    pieceRegistry.pushAll([note1, selectionNoteA, selectionNoteB]);
  });

  const action_delete_selected = action(() => {
    selectionNotebook.deleteSelected.send();
  });

  // ==========================================================================
  // Actions - Create Nested Notebook
  // ==========================================================================

  const action_create_notebook_via_stream = action(() => {
    notebook.createNotebook.send({
      title: "Nested Notebook",
      notesData: [
        { title: "Nested Note 1", content: "Content 1" },
      ],
    });
  });

  const action_go_to_all_notes = action(() => {
    modalNotebook.goToAllNotes.send();
  });

  const action_create_another_note = action(() => {
    modalNotebook.showNewNoteModal.send();
    modalNotebook.createAnotherNoteFromPrompt.send();
  });

  const action_create_note_from_modal = action(() => {
    modalNotebook.createNoteFromPrompt.send();
  });

  const action_create_another_nested_notebook = action(() => {
    modalNotebook.showNewNotebookModal.send();
    modalNotebook.createAnotherNestedNotebookFromPrompt.send();
  });

  const action_create_nested_notebook_from_modal = action(() => {
    modalNotebook.createNestedNotebookFromPrompt.send();
  });

  const action_create_notebook_from_prompt = action(() => {
    promptNotebook.createNotebookFromSelectionPrompt.send();
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_title = assert(() => notebook.title === "Test Notebook");
  const assert_initial_note_count = assert(() => notebook.noteCount === 2);
  const assert_is_notebook_flag = assert(() => notebook.isNotebook === true);
  const assert_initial_not_hidden = assert(() => notebook.isHidden === false);
  const assert_notes_array_length = assert(() => notebook.notes.length === 2);

  // Empty notebook assertions
  const assert_empty_notebook_count = assert(() =>
    emptyNotebook.noteCount === 0
  );
  const assert_empty_notebook_notes = assert(() =>
    emptyNotebook.notes.length === 0
  );

  // ==========================================================================
  // Assertions - After Rename
  // ==========================================================================

  const assert_title_renamed = assert(() =>
    notebook.title === "Renamed Notebook"
  );
  const assert_title_final = assert(() => notebook.title === "Final Name");

  // ==========================================================================
  // Assertions - After Creating Notes via Stream
  // ==========================================================================

  // After createNote, should have 3 notes
  const assert_note_count_after_create = assert(() => notebook.noteCount === 3);

  // The third note (index 2) was created via stream - verify it has parentNotebook
  const assert_created_note_has_parent = assert(() => {
    const notesList = notebook.notes;
    if (notesList.length < 3) return false;
    const createdNote = notesList[2] as any; // Cast to any to access parentNotebook
    return !!createdNote?.parentNotebook;
  });

  const assert_created_note_parent_title = assert(() => {
    const notesList = notebook.notes;
    if (notesList.length < 3) return false;
    const createdNote = notesList[2] as any; // Cast to any to access parentNotebook
    return createdNote?.parentNotebook?.title === notebook.title;
  });

  // After createNotes with 2 notes, should have 5 total
  const assert_note_count_after_bulk = assert(() => notebook.noteCount === 5);

  // ==========================================================================
  // Assertions - Selection System
  // ==========================================================================

  const assert_selection_initial = assert(() =>
    selectionNotebook.selectedNoteIndices.length === 0 &&
    selectionNotebook.hasSelection === false &&
    selectionNotebook.selectedCount === 0
  );

  const assert_all_selected = assert(() =>
    selectionNotebook.selectedNoteIndices.length === 2 &&
    selectionNotebook.hasSelection === true &&
    selectionNotebook.selectedCount === 2
  );

  const assert_none_selected = assert(() =>
    selectionNotebook.selectedNoteIndices.length === 0 &&
    selectionNotebook.hasSelection === false &&
    selectionNotebook.selectedCount === 0
  );

  // ==========================================================================
  // Assertions - Modal State Management
  // ==========================================================================

  const assert_initial_modal_state = assert(() =>
    notebook.showNewNotePrompt === false &&
    notebook.showNewNotebookPrompt === false &&
    notebook.showNewNestedNotebookPrompt === false
  );

  const assert_new_note_modal_shown = assert(() =>
    notebook.showNewNotePrompt === true
  );

  const assert_new_note_modal_hidden = assert(() =>
    notebook.showNewNotePrompt === false
  );

  const assert_new_notebook_modal_shown = assert(() =>
    notebook.showNewNestedNotebookPrompt === true
  );

  const assert_new_notebook_modal_hidden = assert(() =>
    notebook.showNewNestedNotebookPrompt === false
  );

  // ==========================================================================
  // Assertions - Title Editing
  // ==========================================================================

  const assert_not_editing_title = assert(() =>
    notebook.isEditingTitle === false
  );

  const assert_editing_title = assert(() => notebook.isEditingTitle === true);

  const assert_stopped_editing_title = assert(() =>
    notebook.isEditingTitle === false
  );

  // ==========================================================================
  // Assertions - Delete Selected
  // ==========================================================================

  const assert_notes_registered = assert(() =>
    pieceRegistry.get().some((piece) => equals(piece, selectionNoteA)) &&
    pieceRegistry.get().some((piece) => equals(piece, selectionNoteB)) &&
    pieceRegistry.get().some((piece) => equals(piece, note1))
  );

  const assert_notes_deleted = assert(() =>
    selectionNotebook.noteCount === 0 &&
    selectionNotebook.notes.length === 0 &&
    selectionNotebook.selectedNoteIndices.length === 0
  );

  const assert_selected_notes_removed_from_registry = assert(() =>
    !pieceRegistry.get().some((piece) => equals(piece, selectionNoteA)) &&
    !pieceRegistry.get().some((piece) => equals(piece, selectionNoteB))
  );

  const assert_unselected_note_kept = assert(() =>
    pieceRegistry.get().some((piece) => equals(piece, note1)) &&
    note1.title === "First Note" && note1.content === "Content of first note"
  );

  // ==========================================================================
  // Assertions - Duplicate Selected (run on fresh notebook)
  // ==========================================================================

  // Create a fresh notebook for duplication test
  const dupNotebook = Notebook({
    title: "Dup Test",
    notes: [
      Note({
        title: "Original 1",
        content: "Content 1",

        isHidden: true,
      }),
      Note({
        title: "Original 2",
        content: "Content 2",

        isHidden: true,
      }),
    ],
    isHidden: false,
  });

  const action_select_all_dup = action(() => {
    dupNotebook.selectAllNotes.send();
  });

  const action_duplicate_dup = action(() => {
    dupNotebook.duplicateSelected.send();
  });

  const assert_dup_initial_count = assert(() => dupNotebook.noteCount === 2);

  const assert_dup_all_selected = assert(() =>
    dupNotebook.selectedNoteIndices.length === 2
  );

  const assert_duplicated = assert(() =>
    dupNotebook.noteCount === 4 &&
    dupNotebook.selectedNoteIndices.length === 0
  );

  // Verify duplicated notes have parent set
  const assert_dup_notes_have_parent = assert(() => {
    const notesList = dupNotebook.notes;
    if (notesList.length < 4) return false;
    // Notes at index 2 and 3 are the duplicates
    const dup1 = notesList[2] as any;
    const dup2 = notesList[3] as any;
    return !!dup1?.parentNotebook && !!dup2?.parentNotebook;
  });

  // ==========================================================================
  // Assertions - NAME Computed Format
  // ==========================================================================

  const assert_name_format = assert(() => {
    const name = notebook[NAME];
    return typeof name === "string" &&
      name.includes("📓") &&
      name.includes(notebook.title) &&
      name.includes(String(notebook.noteCount));
  });

  // ==========================================================================
  // Assertions - Create Nested Notebook
  // ==========================================================================

  // createNotebook writes to pieceRegistry, not this notebook's notes array.
  // So the notebook's own noteCount should remain unchanged at 3.
  const assert_notebook_count_unchanged = assert(() =>
    notebook.noteCount === 3
  );

  const assert_go_to_all_notes_leaves_notebook_intact = assert(() =>
    modalNotebook.title === "Modal Actions"
  );
  const assert_create_another_note_keeps_modal_open = assert(() =>
    modalNotebook.noteCount === 1 && modalNotebook.showNewNotePrompt === true
  );
  const assert_create_note_closes_modal = assert(() =>
    modalNotebook.noteCount === 2 && modalNotebook.showNewNotePrompt === false
  );
  const assert_create_another_notebook_keeps_modal_open = assert(() =>
    modalNotebook.noteCount === 3 &&
    modalNotebook.showNewNestedNotebookPrompt === true
  );
  const assert_create_notebook_closes_modal = assert(() =>
    modalNotebook.noteCount === 4 &&
    modalNotebook.showNewNestedNotebookPrompt === false
  );
  const assert_prompt_creates_notebook = assert(() =>
    promptNotebook.noteCount === 2 &&
    promptNotebook.showNewNotebookPrompt === false &&
    promptNotebook.selectedCount === 0
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Initial state ===
      { assertion: assert_initial_title },
      { assertion: assert_initial_note_count },
      { assertion: assert_is_notebook_flag },
      { assertion: assert_initial_not_hidden },
      { assertion: assert_notes_array_length },

      // === Empty notebook ===
      { assertion: assert_empty_notebook_count },
      { assertion: assert_empty_notebook_notes },

      // === Rename via setTitle stream ===
      { action: action_rename_notebook },
      { assertion: assert_title_renamed },

      { action: action_rename_again },
      { assertion: assert_title_final },

      // === Create note via stream ===
      { action: action_create_note_via_stream },
      { assertion: assert_note_count_after_create },
      { assertion: assert_created_note_has_parent },
      { assertion: assert_created_note_parent_title },

      // === NAME computed format ===
      // KNOWN BUG: NAME not updating after note creation in test environment
      { assertion: assert_name_format },

      // === Selection system ===
      { assertion: assert_selection_initial },
      { action: action_select_all },
      { assertion: assert_all_selected },
      { action: action_deselect_all },
      { assertion: assert_none_selected },

      // === Modal state management ===
      { assertion: assert_initial_modal_state },
      { action: action_show_new_note_modal },
      { assertion: assert_new_note_modal_shown },
      { action: action_cancel_new_note },
      { assertion: assert_new_note_modal_hidden },
      { action: action_show_new_notebook_modal },
      { assertion: assert_new_notebook_modal_shown },
      { action: action_cancel_new_notebook },
      { assertion: assert_new_notebook_modal_hidden },

      // === Title editing ===
      { assertion: assert_not_editing_title },
      { action: action_start_editing },
      { assertion: assert_editing_title },
      { action: action_stop_editing },
      { assertion: assert_stopped_editing_title },

      // === Duplicate selected (on fresh notebook) ===
      { assertion: assert_dup_initial_count },
      { action: action_select_all_dup },
      { assertion: assert_dup_all_selected },
      { action: action_duplicate_dup },
      { assertion: assert_duplicated },
      { assertion: assert_dup_notes_have_parent },

      // === Delete selected (destructive, run last on selectionNotebook) ===
      { action: action_register_notes },
      { assertion: assert_notes_registered },
      { action: action_select_all },
      { action: action_delete_selected },
      { assertion: assert_notes_deleted },
      { assertion: assert_selected_notes_removed_from_registry },
      { assertion: assert_unselected_note_kept },

      // === Create nested notebook (writes to pieceRegistry, not notes) ===
      { action: action_create_notebook_via_stream },
      { assertion: assert_notebook_count_unchanged },
      // === Bulk create notes ===
      { action: action_create_multiple_notes },
      { assertion: assert_note_count_after_bulk },

      // === Registry-backed UI actions ===
      { action: action_go_to_all_notes },
      { assertion: assert_go_to_all_notes_leaves_notebook_intact },
      { action: action_create_another_note },
      { assertion: assert_create_another_note_keeps_modal_open },
      { action: action_create_note_from_modal },
      { assertion: assert_create_note_closes_modal },
      { action: action_create_another_nested_notebook },
      { assertion: assert_create_another_notebook_keeps_modal_open },
      { action: action_create_nested_notebook_from_modal },
      { assertion: assert_create_notebook_closes_modal },
      { action: action_create_notebook_from_prompt },
      { assertion: assert_prompt_creates_notebook },
    ],
    notebook,
    emptyNotebook,
    selectionNotebook,
    dupNotebook,
    modalNotebook,
    promptNotebook,
  };
});
