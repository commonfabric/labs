/**
 * Test Pattern: Note
 *
 * Tests for the note pattern:
 * - Initial state with provided values
 * - Edit content via editContent stream
 * - NAME computed from title
 * - Menu toggle behavior
 * - Title editing behavior
 *
 * Run: deno task cf test packages/patterns/notes/note.test.tsx --verbose
 */
import {
  action,
  assert,
  FS,
  handler,
  NAME,
  pattern,
  resultOf,
  type Stream,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { findNode, propsOf } from "../test/vnode-helpers.ts";
import Note, {
  backlinkCreateProps,
  bareMentionId,
  handleNewBacklink,
} from "./note.tsx";
import Notebook from "./notebook.tsx";
import {
  type MentionablePiece,
  type MentionRefMap,
  type MinimalPiece,
} from "./schemas.tsx";

const appendLink = handler<void, {
  stream: Stream<{ piece: Writable<MentionablePiece> }>;
  piece: Writable<MentionablePiece>;
}>((_, { stream, piece }) => {
  stream.send({ piece });
});

const createBacklink = handler<void, {
  stream: Stream<{
    detail: { piece: Writable<MentionablePiece>; navigate: boolean };
  }>;
  piece: Writable<MentionablePiece>;
}>((_, { stream, piece }) => {
  stream.send({ detail: { piece, navigate: false } });
});

/**
 * Whether the note's editor was given a reference map. Its presence is the
 * whole switch: with it the editor mints `[Label][key]` and puts the
 * destination in that cell, without it a `[[Name (id)]]` wiki-link.
 */
const editorHasReferences = (subject: { [UI]: unknown }): boolean => {
  const editor = findNode(
    subject[UI],
    (node) => propsOf(node)?.["onbacklink-create"] !== undefined,
  );
  return propsOf(editor)?.["$references"] !== undefined;
};

export default pattern(() => {
  const pieceRegistryRequest = wish<Writable<MinimalPiece[]>>({
    query: "#pieceRegistry",
  });
  const pieceRegistry = resultOf(pieceRegistryRequest.result);
  const note = Note({
    title: "Test Note",
    content: "Line one\nLine two\nLine three",

    isHidden: false,
  });
  const backlinkCreate = handleNewBacklink({
    mentionable: new Writable<MentionablePiece[]>([]),
    pieceRegistry,
  });
  const editorProps = backlinkCreateProps(backlinkCreate);

  // Create notebooks for parentNotebook testing
  const notebookA = Notebook({
    title: "Notebook A",
    notes: [],
  });

  const notebookB = Notebook({
    title: "Notebook B",
    notes: [],
  });

  // Note created with a parent notebook
  const noteWithParent = Note({
    title: "Child Note",
    content: "I belong to a notebook",

    isHidden: true,
    parentNotebook: notebookA,
  });

  // Note created with a different parent notebook
  const noteInNotebookB = Note({
    title: "Note in B",
    content: "I belong to notebook B",

    isHidden: true,
    parentNotebook: notebookB,
  });

  // Note explicitly created with no parent (same as `note` above but explicit)
  const noteNoParent = Note({
    title: "Orphan Note",
    content: "I have no notebook",

    isHidden: false,
  });

  // A piece to link to via appendLink.
  const linkTarget = Note({
    title: "Link Target",
    content: "I am linkable",

    isHidden: false,
  });

  const backlinkTarget = Note({
    title: "Backlink Target",
    content: "",
  });
  // ==========================================================================
  // Actions - Content Editing
  // ==========================================================================

  const action_edit_content = action(() => {
    note.editContent.send({ detail: { value: "Updated content here" } });
  });

  const action_edit_content_multiline = action(() => {
    note.editContent.send({
      detail: { value: "First line\nSecond line\nThird line" },
    });
  });

  const action_clear_content = action(() => {
    note.editContent.send({ detail: { value: "" } });
  });

  // ==========================================================================
  // Actions - Menu Toggle
  // ==========================================================================

  const action_toggle_menu = action(() => {
    note.toggleMenu.send();
  });

  const action_toggle_menu_again = action(() => {
    note.toggleMenu.send();
  });

  const action_toggle_menu_for_close = action(() => {
    note.toggleMenu.send();
  });

  const action_close_menu = action(() => {
    note.closeMenu.send();
  });

  // ==========================================================================
  // Actions - Title Editing
  // ==========================================================================

  const action_start_editing = action(() => {
    note.startEditingTitle.send();
  });

  const action_stop_editing = action(() => {
    note.stopEditingTitle.send();
  });

  // ==========================================================================
  // Actions - Create New Note (wish + SELF machinery)
  // ==========================================================================

  const action_create_new_note = action(() => {
    note.createNewNote.send();
  });

  const action_create_from_parented = action(() => {
    noteWithParent.createNewNote.send();
  });

  // ==========================================================================
  // Actions - Append wiki-link
  // ==========================================================================

  const action_append_link = appendLink({
    stream: note.appendLink,
    piece: linkTarget,
  });

  const action_create_backlink = createBacklink({
    stream: editorProps["onbacklink-create"],
    piece: backlinkTarget,
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_name = assert(
    () => note[NAME] === "📝 Test Note",
  );
  const assert_editor_has_references = assert(
    () => editorHasReferences(note),
  );
  const assert_initial_title = assert(() => note.title === "Test Note");
  const assert_initial_content = assert(
    () => note.content === "Line one\nLine two\nLine three",
  );
  const assert_initial_not_hidden = assert(() => note.isHidden === false);
  const assert_initial_no_parent = assert(
    () => !note.parentNotebook,
  );
  const assert_initial_empty_backlinks = assert(
    () => note.backlinks.length === 0,
  );
  const assert_initial_empty_mentioned = assert(
    () => note.mentioned.length === 0,
  );

  // ==========================================================================
  // Assertions - Parent Notebook
  // ==========================================================================

  // Note created with parent A should have it set
  const assert_has_parent = assert(
    () => !!noteWithParent.parentNotebook,
  );

  const assert_parent_is_notebook_a = assert(
    () => noteWithParent.parentNotebook?.title === "Notebook A",
  );

  // Note created with parent B should point to B
  const assert_note_b_has_parent = assert(
    () => !!noteInNotebookB.parentNotebook,
  );

  const assert_parent_is_notebook_b = assert(
    () => noteInNotebookB.parentNotebook?.title === "Notebook B",
  );

  // Different notes have different parents
  const assert_different_parents = assert(
    () =>
      noteWithParent.parentNotebook?.title !== noteInNotebookB.parentNotebook
        ?.title,
  );

  // Note created without parent should have no parent
  const assert_orphan_no_parent = assert(
    () => !noteNoParent.parentNotebook,
  );

  // Child notes should be hidden (set at creation)
  const assert_child_a_hidden = assert(
    () => noteWithParent.isHidden === true,
  );

  const assert_child_b_hidden = assert(
    () => noteInNotebookB.isHidden === true,
  );

  // Orphan note should not be hidden
  const assert_orphan_not_hidden = assert(
    () => noteNoParent.isHidden === false,
  );

  // ==========================================================================
  // Assertions - After Content Edit
  // ==========================================================================

  const assert_content_updated = assert(
    () => note.content === "Updated content here",
  );
  const assert_content_multiline = assert(
    () => note.content === "First line\nSecond line\nThird line",
  );
  const assert_content_cleared = assert(() => note.content === "");

  // ==========================================================================
  // Assertions - Menu Toggle
  // ==========================================================================

  const assert_initial_menu_closed = assert(
    () => note.menuOpen === false,
  );

  const assert_menu_open = assert(
    () => note.menuOpen === true,
  );

  const assert_menu_closed_after_toggle = assert(
    () => note.menuOpen === false,
  );

  const assert_menu_open_before_close = assert(
    () => note.menuOpen === true,
  );

  const assert_menu_closed_via_close = assert(
    () => note.menuOpen === false,
  );

  // ==========================================================================
  // Assertions - Title Editing
  // ==========================================================================

  const assert_initial_not_editing = assert(
    () => note.isEditingTitle === false,
  );

  const assert_editing_title = assert(
    () => note.isEditingTitle === true,
  );

  const assert_stopped_editing = assert(
    () => note.isEditingTitle === false,
  );

  // ==========================================================================
  // Assertions - Create New Note (wish + SELF machinery)
  // ==========================================================================

  // After creating new note, original note should be unchanged
  const assert_note_unchanged_after_create = assert(
    () => note.title === "Test Note",
  );

  // After creating new note from parented note, original should be unchanged
  const assert_parented_note_unchanged = assert(
    () => noteWithParent.title === "Child Note",
  );

  // ==========================================================================
  // Assertions - Append wiki-link
  // ==========================================================================

  // appendLink appends `[[<NAME> (<entityId>)]]` to the content, with the
  // target's entityId stringified via the cell-rep chokepoint, and pushes the
  // target onto `mentioned`.
  const assert_link_appended = assert(() =>
    /\[\[📝 Link Target \([^)]+\)\]\]/.test(note.content)
  );
  const assert_mentioned_after_link = assert(
    () => note.mentioned.length === 1,
  );
  const assert_backlink_registers_piece = assert(() =>
    pieceRegistry.get().some((piece) => piece[NAME] === "📝 Backlink Target")
  );

  // The wiki-link embed contract: `of:` strips (the renderer re-adds it),
  // bare ids pass through, and `computed:` is REJECTED — the bare embed
  // format cannot carry the scheme, and the scheme is part of the identity.
  const assert_mention_id_strips_of = assert(
    () => bareMentionId("of:fid1:abc") === "fid1:abc",
  );
  const assert_mention_id_passes_bare = assert(
    () => bareMentionId("fid1:abc") === "fid1:abc",
  );
  const assert_computed_mention_rejected = assert(() => {
    try {
      bareMentionId("computed:fid1:tripwire");
      return false;
    } catch {
      return true;
    }
  });

  // ===== The filesystem projection, and editing through it =====

  const projectionTarget = Note({
    title: "Target",
    content: "",
    isHidden: false,
  });

  // The test owns the map so it can seed a mention; the note's own result is
  // a materialized view and holds no writer.
  const projectedRefs = new Writable<MentionRefMap>({});

  const projected = Note({
    title: "Projected",
    content: "See the target.",
    isHidden: false,
    references: projectedRefs,
  });

  // Staged so the assertions can hand the projection back verbatim.
  const projectedBody = new Writable("");

  const action_mention_in_projection = action(() => {
    projectedRefs.key("a3f9zz").set({
      destination: projectionTarget,
      modifiedTitle: false,
    });
  });

  const action_capture_projection = action(() => {
    projectedBody.set(projected[FS].content ?? "");
  });

  // The property every `touch` depends on: handing back exactly what was
  // projected changes neither the note's text nor its mentions.
  const action_write_projection_back = action(() => {
    projected.editProjection.send({ body: projectedBody.get() });
  });

  const action_drop_definition = action(() => {
    projected.editProjection.send({ body: "See the target." });
  });

  // Clearing the file is an edit, not an absent one.
  const action_clear_through_projection = action(() => {
    projected.editProjection.send({ body: "" });
  });

  const assert_projection_carries_definition = assert(
    () =>
      String(projected[FS].content ?? "").startsWith(
        "See the target.\n\n[a3f9zz]: /",
      ),
  );

  const assert_round_trip_keeps_content = assert(
    () => projected.content === "See the target.",
  );

  const assert_round_trip_keeps_reference = assert(
    () => Object.keys(projectedRefs.get() ?? {}).length === 1,
  );

  const assert_dropped_definition_drops_reference = assert(
    () => Object.keys(projectedRefs.get() ?? {}).length === 0,
  );

  const assert_cleared_projection_clears_content = assert(
    () => projected.content === "",
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // The editor is given the note's reference map, which is what selects
      // the reference form for mentions made from here.
      { assertion: assert_editor_has_references },

      // === The filesystem projection ===
      { action: action_mention_in_projection },
      { assertion: assert_projection_carries_definition },
      { action: action_capture_projection },
      { action: action_write_projection_back },
      { assertion: assert_round_trip_keeps_content },
      { assertion: assert_round_trip_keeps_reference },
      { action: action_drop_definition },
      { assertion: assert_dropped_definition_drops_reference },
      { action: action_clear_through_projection },
      { assertion: assert_cleared_projection_clears_content },
      // === Initial state ===
      { assertion: assert_name },
      { assertion: assert_initial_title },
      { assertion: assert_initial_content },
      { assertion: assert_initial_not_hidden },
      { assertion: assert_initial_no_parent },
      { assertion: assert_initial_empty_backlinks },
      { assertion: assert_initial_empty_mentioned },

      // === Parent notebook - note in notebook A ===
      { assertion: assert_has_parent },
      { assertion: assert_parent_is_notebook_a },
      { assertion: assert_child_a_hidden },

      // === Parent notebook - note in notebook B ===
      { assertion: assert_note_b_has_parent },
      { assertion: assert_parent_is_notebook_b },
      { assertion: assert_child_b_hidden },

      // === Different parents are distinct ===
      { assertion: assert_different_parents },

      // === Orphan note has no parent ===
      { assertion: assert_orphan_no_parent },
      { assertion: assert_orphan_not_hidden },

      // === Edit content ===
      { action: action_edit_content },
      { assertion: assert_content_updated },

      { action: action_edit_content_multiline },
      { assertion: assert_content_multiline },

      { action: action_clear_content },
      { assertion: assert_content_cleared },

      // === Menu toggle behavior ===
      { assertion: assert_initial_menu_closed },
      { action: action_toggle_menu },
      { assertion: assert_menu_open },
      { action: action_toggle_menu_again },
      { assertion: assert_menu_closed_after_toggle },
      { action: action_toggle_menu_for_close },
      { assertion: assert_menu_open_before_close },
      { action: action_close_menu },
      { assertion: assert_menu_closed_via_close },

      // === Title editing behavior ===
      { assertion: assert_initial_not_editing },
      { action: action_start_editing },
      { assertion: assert_editing_title },
      { action: action_stop_editing },
      { assertion: assert_stopped_editing },

      // === Create new note (wish + SELF machinery) ===
      { action: action_create_new_note },
      { assertion: assert_note_unchanged_after_create },
      { action: action_create_from_parented },
      { assertion: assert_parented_note_unchanged },

      // === Append wiki-link ===
      { action: action_create_backlink },
      { assertion: assert_backlink_registers_piece },
      { action: action_append_link },
      { assertion: assert_link_appended },
      { assertion: assert_mentioned_after_link },
      { assertion: assert_mention_id_strips_of },
      { assertion: assert_mention_id_passes_bare },
      { assertion: assert_computed_mention_rejected },
    ],
    note,
    noteWithParent,
    noteInNotebookB,
    noteNoParent,
    linkTarget,
    backlinkTarget,
  };
});
