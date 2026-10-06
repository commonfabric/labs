import {
  action,
  computed,
  Default,
  equals,
  handler,
  NAME,
  navigateTo,
  pattern,
  resultOf,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import Note from "./note.tsx";
import {
  getPieceName,
  type MentionablePiece,
  type MinimalPiece,
  type NotebookInput,
  type NotebookPiece,
  type NotePiece,
} from "./schemas.tsx";

// ===== Shared Utility Functions =====

/**
 * Remove items from all notebooks' notes arrays using equals() for identity comparison.
 * Optionally skip a target notebook index (for move operations).
 */
const removeFromAllNotebooks = (
  notebooks: Writable<NotebookPiece[]>,
  itemsToRemove: (
    | NotePiece
    | NotebookPiece
    | Writable<NotePiece>
    | Writable<NotebookPiece>
  )[],
  skipIndex?: number,
): void => {
  const notebooksList = notebooks.get();
  for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
    if (skipIndex !== undefined && nbIdx === skipIndex) continue;

    const nbNotesCell = notebooks.key(nbIdx).key("notes");
    const nbNotes = nbNotesCell.get() ?? [];

    const filtered = nbNotes.filter(
      (n) => !itemsToRemove.some((item) => equals(n, item)),
    );
    if (filtered.length !== nbNotes.length) {
      nbNotesCell.set(filtered);
    }
  }
};

// ===== Output Type =====

/** A #notebook that organizes notes into collections. */
export interface NotebookOutput extends NotebookPiece {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  notes: NotePiece[];
  noteCount: number;
  summary: string;
  isNotebook: boolean;
  isHidden: boolean;
  backlinks: MentionablePiece[];
  // LLM-callable streams for omnibot integration
  createNote: Stream<{ title: string; content: string }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<string>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
  // Test-accessible action streams
  selectAllNotes: Stream<void>;
  deselectAllNotes: Stream<void>;
  deleteSelected: Stream<void>;
  duplicateSelected: Stream<void>;
  showNewNoteModal: Stream<void>;
  cancelNewNote: Stream<void>;
  showNewNotebookModal: Stream<void>;
  cancelNewNotebook: Stream<void>;
  cancelNewNestedNotebook: Stream<void>;
  startEditTitle: Stream<void>;
  stopEditTitle: Stream<void>;
  goToAllNotes: Stream<void>;
  createNoteFromPrompt: Stream<void>;
  createAnotherNoteFromPrompt: Stream<void>;
  createNestedNotebookFromPrompt: Stream<void>;
  createAnotherNestedNotebookFromPrompt: Stream<void>;
  createNotebookFromSelectionPrompt: Stream<void>;
  // Test-accessible state
  selectedNoteIndices: number[];
  selectedCount: number;
  hasSelection: boolean;
  showNewNotePrompt: boolean;
  showNewNotebookPrompt: boolean;
  showNewNestedNotebookPrompt: boolean;
  isEditingTitle: boolean;
}

// Handler to remove a note from this notebook (but keep it in the space)
const removeFromNotebook = handler<
  void,
  { note: Writable<NotePiece>; notes: Writable<NotePiece[]> }
>((_, { note, notes }) => {
  const notebookNotes = notes.get();
  const index = notebookNotes.findIndex((n) => equals(n, note));
  if (index !== -1) {
    const copy = [...notebookNotes];
    copy.splice(index, 1);
    notes.set(copy);
  }
  // Make it visible in the space again
  note.key("isHidden").set(false);
});

// Handler for dropping items onto the current notebook's card
// This MOVES the dropped notebook - removes from all other notebooks, adds here
// Supports multi-item drag: if dragged item is in selection, moves ALL selected items
const handleDropOntoCurrentNotebook = handler<
  { detail: { sourceCell: Writable<NotePiece | NotebookPiece> } },
  {
    notes: Writable<NotePiece[]>;
    notebooks: Writable<NotebookPiece[]>;
    selectedNoteIndices: Writable<number[]>;
  }
>((event, { notes, notebooks, selectedNoteIndices }) => {
  const sourceCell = event.detail.sourceCell;
  const notesList = notes.get();
  const selected = selectedNoteIndices.get();

  // Check if dragged item is in the selection
  const draggedIndex = notesList.findIndex((n) => equals(sourceCell, n));
  const isDraggedInSelection = draggedIndex >= 0 &&
    selected.includes(draggedIndex);

  if (isDraggedInSelection && selected.length > 1) {
    // Multi-item move
    const itemsToMove = selected.map((idx) => notes.key(idx));

    // Remove from all notebooks
    removeFromAllNotebooks(notebooks, itemsToMove);

    // Add all to this notebook, deduplicated by link identity on the server.
    // The whole-list read above genuinely has to stay (it resolves the dragged
    // index against the selection), so this write still contends on concurrent
    // notes changes; addUnique keeps a re-add a no-op instead of a duplicate.
    for (const item of itemsToMove) {
      notes.addUnique(item);
      item.key("isHidden").set(true);
    }
    selectedNoteIndices.set([]);
  } else {
    // Single-item move
    if (notesList.some((n) => equals(sourceCell, n))) return;

    removeFromAllNotebooks(notebooks, [sourceCell]);
    sourceCell.key("isHidden").set(true);
    // Deduplicated by link identity; the early return above already covers the
    // common already-present case, and the retained read keeps this contended.
    notes.addUnique(sourceCell);
  }
});

// Handler for dropping any item onto a notebook - moves from current notebook to target
// Supports multi-item drag: if dragged item is in selection, moves ALL selected items
const handleDropOntoNotebook = handler<
  { detail: { sourceCell: Writable<NotePiece> } },
  {
    targetNotebook: Writable<{
      title?: string;
      notes?: NotePiece[];
      isNotebook?: boolean;
    }>;
    currentNotes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((event, { targetNotebook, currentNotes, selectedNoteIndices, notebooks }) => {
  const sourceCell = event.detail.sourceCell;

  // Check if target is actually a notebook
  if (!targetNotebook.key("isNotebook").get()) return;

  const targetNotesCell = targetNotebook.key("notes");
  const currentList = currentNotes.get();
  const selected = selectedNoteIndices.get();

  // The only binding today passes the notebook's own SELF as the target, so
  // target and current usually alias the same notes collection. In that case
  // there is nothing to remove from "current": removing would strip or
  // reorder the very memberships addUnique confirms below.
  const targetIsCurrent = equals(targetNotesCell, currentNotes);

  // Check if dragged item is in the selection
  const draggedIndex = currentList.findIndex((n) => equals(sourceCell, n));
  const isDraggedInSelection = draggedIndex >= 0 &&
    selected.includes(draggedIndex);

  if (isDraggedInSelection && selected.length > 1) {
    // Multi-item move
    const itemsToMove = selected.map((idx) => currentNotes.key(idx)).filter(
      Boolean,
    );

    // Add all to target, deduplicated by link identity on the server —
    // addUnique needs no read of the target list, so concurrent drops onto the
    // same notebook merge instead of conflicting.
    for (const item of itemsToMove) {
      targetNotesCell.addUnique(item);
      item.key("isHidden").set(true);
    }

    // Find target notebook index to skip it during removal
    const notebooksList = notebooks.get();
    const targetIndex = notebooksList.findIndex(
      (nb) => equals(nb, targetNotebook),
    );

    // Remove from all notebooks except target
    removeFromAllNotebooks(notebooks, itemsToMove, targetIndex);

    // Remove from current notebook — unless current IS the target, where
    // "removing" would strip the memberships this drop just confirmed. (The
    // pre-addUnique code ran this unconditionally, so a same-notebook
    // multi-drop silently dropped the selected notes from the notebook.)
    if (!targetIsCurrent) {
      currentNotes.set(
        currentList.filter(
          (n) => !itemsToMove.some((item) => equals(n, item)),
        ),
      );
    }
    selectedNoteIndices.set([]);
  } else {
    // Single-item move
    // Remove from current notebook if present — unless current IS the
    // target, where the removal would turn addUnique's no-op below into a
    // move-to-tail reorder of an already-present note.
    if (!targetIsCurrent) {
      const indexInCurrent = currentList.findIndex((n) =>
        equals(sourceCell, n)
      );
      if (indexInCurrent !== -1) {
        const copy = [...currentList];
        copy.splice(indexInCurrent, 1);
        currentNotes.set(copy);
      }
    }

    sourceCell.key("isHidden").set(true);
    // Deduplicated by link identity on the server, so a note the target
    // already holds keeps a single membership with no whole-list read. For a
    // genuinely distinct target this completes the move (the old guard
    // skipped it entirely, leaving the note in both notebooks).
    targetNotesCell.addUnique(sourceCell);
  }
});

// Handler for clicking on a backlink
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>(
  (_, { piece }) => navigateTo(piece),
);

// Handler to navigate to a child (note or notebook) - sets parent for back navigation
// Must be module-scope handler because it's used in .map() with per-iteration child bindings
const navigateToChild = handler<
  void,
  { child: Writable<NotePiece | NotebookPiece>; self: NotebookPiece }
>(
  (_, { child, self }) => {
    child.key("parentNotebook").set(self);
    navigateTo(child);
  },
);

// Handler to permanently delete selected notes from the space
const deleteSelectedNotes = handler<
  void,
  {
    notes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    pieceRegistry: Writable<MinimalPiece[] | Default<[]>>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((_, { notes, selectedNoteIndices, pieceRegistry, notebooks }) => {
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const itemsToDelete = selected.map((idx) => notesList[idx]).filter(Boolean);

  // Remove from all notebooks
  removeFromAllNotebooks(notebooks, itemsToDelete);

  // Remove from this notebook's notes array
  notes.set(
    notesList.filter(
      (n) => !itemsToDelete.some((item) => equals(n, item)),
    ),
  );

  // Remove from the registry (permanent delete)
  pieceRegistry.set(
    (pieceRegistry.get() ?? []).filter(
      (piece) => !itemsToDelete.some((item) => equals(piece, item)),
    ),
  );

  selectedNoteIndices.set([]);
});

// Handler to add selected notes to another notebook
const addSelectedToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    notebooks: Writable<NotebookPiece[]>;
    selectedAddNotebook: Writable<string>;
    showNewNotebookPrompt: Writable<boolean>;
    pendingNotebookAction: Writable<"add" | "move" | "">;
  }
>((
  event,
  {
    notes,
    selectedNoteIndices,
    notebooks,
    selectedAddNotebook,
    showNewNotebookPrompt,
    pendingNotebookAction,
  },
) => {
  // Handle both native select (target.value) and cf-select (detail.value)
  const value = event.target?.value ?? event.detail?.value ?? "";
  if (!value) return;

  // Handle "new-*" - show prompt to get name from user
  if (value === "new") {
    pendingNotebookAction.set("add");
    showNewNotebookPrompt.set(true);
    selectedAddNotebook.set("");
    return;
  }

  // Add to existing notebook
  const nbIndex = parseInt(value, 10);
  if (nbIndex < 0) return;

  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const targetNotebookCell = notebooks.key(nbIndex);
  const targetNotebookNotes: Writable<NotePiece[] | undefined> =
    targetNotebookCell.key("notes");

  // Collect notes first, then batch push (reduces N reactive cycles to 1)
  const notesToAdd: NotePiece[] = [];
  for (const idx of selected) {
    const note = notesList[idx];
    if (note) notesToAdd.push(note);
  }
  targetNotebookNotes.pushAll(notesToAdd);

  selectedNoteIndices.set([]);
  selectedAddNotebook.set("");
});

// Handler to move selected notes to another notebook (remove from current)
const moveSelectedToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    notebooks: Writable<NotebookPiece[]>;
    selectedMoveNotebook: Writable<string>;
    showNewNotebookPrompt: Writable<boolean>;
    pendingNotebookAction: Writable<"add" | "move" | "">;
  }
>((
  event,
  {
    notes,
    selectedNoteIndices,
    notebooks,
    selectedMoveNotebook,
    showNewNotebookPrompt,
    pendingNotebookAction,
  },
) => {
  const value = event.target?.value ?? event.detail?.value ?? "";
  if (!value) return;

  if (value === "new") {
    pendingNotebookAction.set("move");
    showNewNotebookPrompt.set(true);
    selectedMoveNotebook.set("");
    return;
  }

  const nbIndex = parseInt(value, 10);
  if (nbIndex < 0) return;

  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const notesToMove = selected.map((idx) => notesList[idx]).filter(Boolean);

  // Add to target notebook
  const targetNotebookNotes = notebooks.key(nbIndex).key("notes");
  targetNotebookNotes.pushAll(notesToMove);

  // Remove from all notebooks except target
  removeFromAllNotebooks(notebooks, notesToMove, nbIndex);

  // Remove from this notebook
  notes.set(
    notesList.filter(
      (n) => !notesToMove.some((item) => equals(n, item)),
    ),
  );

  selectedNoteIndices.set([]);
  selectedMoveNotebook.set("");
});

// Handler to create notebook from prompt and add/move selected notes
const createNotebookFromPrompt = handler<
  void,
  {
    newNotebookName: Writable<string>;
    showNewNotebookPrompt: Writable<boolean>;
    pendingNotebookAction: Writable<"add" | "move" | "">;
    selectedNoteIndices: Writable<number[]>;
    notes: Writable<NotePiece[]>;
    pieceRegistry: Writable<MinimalPiece[]>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((_, state) => {
  const {
    newNotebookName,
    showNewNotebookPrompt,
    pendingNotebookAction,
    selectedNoteIndices,
    notes,
    pieceRegistry,
    notebooks,
  } = state;

  const name = newNotebookName.get().trim() || "New Notebook";
  const actionType = pendingNotebookAction.get();

  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const selectedItems = selected.map((idx) => notesList[idx]).filter(Boolean);

  // Create the notebook with items included
  const newNotebook = Notebook({
    title: name,
    notes: selectedItems,
    isHidden: true,
  });
  pieceRegistry.push(newNotebook);

  if (actionType === "move") {
    // Remove from all existing notebooks
    removeFromAllNotebooks(notebooks, selectedItems);

    // Remove from this notebook, then add new notebook
    notes.set([
      ...notesList.filter(
        (n) => !selectedItems.some((item) => equals(n, item)),
      ),
      newNotebook,
    ]);
  } else {
    // For add: append the new notebook as sibling. Its contents derive from
    // the notes snapshot read above, so write the whole list from that same
    // snapshot; the read stays in the conflict set and a concurrent change
    // rejects this commit and retries against fresh state.
    notes.set([...notesList, newNotebook]);
  }

  // Clean up state
  selectedNoteIndices.set([]);
  newNotebookName.set("");
  pendingNotebookAction.set("");
  showNewNotebookPrompt.set(false);
});

// Handler to toggle checkbox selection with shift-click support
const toggleNoteCheckbox = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedNoteIndices: Writable<number[]>;
    lastSelectedNoteIndex: Writable<number>;
  }
>((event, { index, selectedNoteIndices, lastSelectedNoteIndex }) => {
  const current = selectedNoteIndices.get();
  const lastIdx = lastSelectedNoteIndex.get();

  if (event?.shiftKey && lastIdx >= 0 && lastIdx !== index) {
    const start = Math.min(lastIdx, index);
    const end = Math.max(lastIdx, index);
    const range: number[] = [];
    for (let i = start; i <= end; i++) {
      range.push(i);
    }
    selectedNoteIndices.set([...new Set([...current, ...range])]);
  } else {
    const idx = current.indexOf(index);
    if (idx >= 0) {
      selectedNoteIndices.set(current.filter((i: number) => i !== index));
    } else {
      selectedNoteIndices.set([...current, index]);
    }
  }
  lastSelectedNoteIndex.set(index);
});

const Notebook = pattern<NotebookInput, NotebookOutput>(
  (
    {
      title,
      notes,
      isNotebook,
      isHidden,
      parentNotebook: _parentNotebook,
      [SELF]: self,
    },
  ) => {
    // Ensure parentNotebook is always a Writable (input is optional)
    const parentNotebook = _parentNotebook ??
      new Writable(null as NotebookPiece | null);
    // Type-based discovery for notebooks and "All Notes" piece
    const notebookWish = wish<NotebookPiece>({
      query: "#notebook",
      scope: ["."],
      headless: true,
    });
    // Notebooks discovered through wish scope.
    const notebooks = notebookWish.candidates;

    // The registry is writable for creating notes and notebooks.
    const pieceRegistryWish = wish<Writable<MinimalPiece[]>>({
      query: "#pieceRegistry",
      headless: true,
    });
    const pieceRegistry: Writable<MinimalPiece[]> = resultOf(
      pieceRegistryWish.result,
    );

    // Use computed() for proper reactive tracking of notes.length
    const noteCount = computed(() => notes.get().length);
    const hasNotes = computed(() => notes.get().length > 0);

    const summary = computed(() => {
      const notesList = notes.get() ?? [];
      return notesList
        .map((note) => note?.summary ?? note?.[NAME] ?? "")
        .filter((s: string) => s.length > 0)
        .join(" | ");
    });

    // Selection state for multi-select
    const selectedNoteIndices = new Writable<number[]>([]);
    const lastSelectedNoteIndex = new Writable<number>(-1);
    const selectedAddNotebook = new Writable<string>("");
    const selectedMoveNotebook = new Writable<string>("");

    // Computed helpers for selection
    const selectedCount = computed(() => selectedNoteIndices.get().length);
    const hasSelection = computed(() => selectedNoteIndices.get().length > 0);

    // State for "New Notebook" prompt modal
    const showNewNotebookPrompt = new Writable<boolean>(false);
    const newNotebookName = new Writable<string>("");
    const pendingNotebookAction = new Writable<"add" | "move" | "">(""); // Track which action triggered the modal

    // State for "New Note" prompt modal
    const showNewNotePrompt = new Writable<boolean>(false);
    const newNoteTitle = new Writable<string>("");
    const usedCreateAnotherNote = new Writable<boolean>(false); // Track if "Create Another" was used

    // State for "New Nested Notebook" prompt modal (from dropdown menu)
    const showNewNestedNotebookPrompt = new Writable<boolean>(false);
    const newNestedNotebookTitle = new Writable<string>("");

    const usedCreateAnotherNotebook = new Writable<boolean>(false); // Track if "Create Another" was used

    // Backlinks - populated by backlinks-index.tsx
    const backlinks = new Writable<MentionablePiece[]>([]);

    // State for inline title editing
    const isEditingTitle = new Writable<boolean>(false);

    // ===== Actions (converted from module-scope handlers) =====

    const showNewNoteModalAction = action(() => showNewNotePrompt.set(true));
    const showNewNotebookModalAction = action(() =>
      showNewNestedNotebookPrompt.set(true)
    );

    const cancelNewNotePromptAction = action(() => {
      showNewNotePrompt.set(false);
      newNoteTitle.set("");
      usedCreateAnotherNote.set(false);
    });

    const cancelNewNestedNotebookPromptAction = action(() => {
      showNewNestedNotebookPrompt.set(false);
      newNestedNotebookTitle.set("");
      usedCreateAnotherNotebook.set(false);
    });

    const cancelNewNotebookPromptAction = action(() => {
      showNewNotebookPrompt.set(false);
      newNotebookName.set("");
      pendingNotebookAction.set("");
      selectedAddNotebook.set("");
      selectedMoveNotebook.set("");
    });

    // TODO(seefeld,mathpirate): We need some better way to find the "All Notes" notebook.
    const goToAllNotesAction = action(() => {
      const pieces = pieceRegistry.get() ?? [];
      const existing = pieces.find((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("All Notes");
      });
      if (existing) {
        return navigateTo(existing);
      }
    });

    const goToParentAction = action(() => {
      const p = parentNotebook.get();
      if (p) navigateTo(p);
    });

    const selectAllNotesAction = action(() => {
      const notesList = notes.get();
      selectedNoteIndices.set(notesList.map((_, i) => i));
    });

    const deselectAllNotesAction = action(() => {
      selectedNoteIndices.set([]);
    });

    const startEditingTitleAction = action(() => isEditingTitle.set(true));
    const stopEditingTitleAction = action(() => isEditingTitle.set(false));

    const handleTitleKeydownAction = action((event: { key?: string }) => {
      if (event?.key === "Enter") {
        isEditingTitle.set(false);
      }
    });

    // ===== Actions (close over notes, pieceRegistry, self) =====
    // These work because all inputs use Default<> (not optional ?), so self
    // always satisfies the output schema's required properties at runtime.

    // LLM-callable: Create a single note in this notebook
    const createNoteStreamAction = action(
      (
        { title: noteTitle, content, navigate }: {
          title: string;
          content: string;
          navigate?: boolean;
        },
      ) => {
        const newNote = Note({
          title: noteTitle,
          content,
          isHidden: true,
          parentNotebook: self,
        });
        pieceRegistry.push(newNote);
        notes.push(newNote);
        if (navigate) {
          navigateTo(newNote);
        }
        return newNote;
      },
    );

    // LLM-callable: Create multiple notes in bulk
    const createNotesStreamAction = action(
      (
        { notesData }: {
          notesData: Array<{ title: string; content: string }>;
        },
      ) => {
        const created: NotePiece[] = [];
        for (const data of notesData) {
          created.push(Note({
            title: data.title,
            content: data.content,
            isHidden: true,
            parentNotebook: self,
          }));
        }
        pieceRegistry.pushAll(created);
        notes.pushAll(created);
        return created;
      },
    );

    // LLM-callable: Rename the notebook
    const setTitleAction = action((newTitle: string) => {
      title.set(newTitle);
      return newTitle;
    });

    // LLM-callable: Create a new notebook (optionally with notes)
    const createNotebookStreamAction = action(
      (
        { title: nbTitle, notesData }: {
          title: string;
          notesData?: Array<{ title: string; content: string }>;
        },
      ) => {
        const notesToAdd: NotePiece[] = [];
        if (notesData && notesData.length > 0) {
          for (const data of notesData) {
            notesToAdd.push(Note({
              title: data.title,
              content: data.content,
              isHidden: true,
            }));
          }
        }

        const newNotebook = Notebook({
          title: nbTitle,
          notes: notesToAdd,
        });

        pieceRegistry.push(newNotebook);
        return newNotebook;
      },
    );

    // Create note - shared logic for "Create" and "Create Another" buttons
    const createNoteAction = action(() => {
      const noteTitle = newNoteTitle.get() || "New Note";
      const newNote = Note({
        title: noteTitle,
        content: "",
        isHidden: true,
        parentNotebook: self,
      });
      pieceRegistry.push(newNote);
      notes.push(newNote);

      // Close modal and navigate (unless "Create Another" was previously used)
      const shouldNavigate = !usedCreateAnotherNote.get();
      showNewNotePrompt.set(false);
      newNoteTitle.set("");
      usedCreateAnotherNote.set(false);
      if (shouldNavigate) {
        return navigateTo(newNote);
      }
    });

    const createAnotherNoteAction = action(() => {
      const noteTitle = newNoteTitle.get() || "New Note";
      const newNote = Note({
        title: noteTitle,
        content: "",
        isHidden: true,
        parentNotebook: self,
      });
      pieceRegistry.push(newNote);
      notes.push(newNote);

      // Keep modal open for "Create Another"
      usedCreateAnotherNote.set(true);
      newNoteTitle.set("");
    });

    // Create nested notebook - shared logic for "Create" and "Create Another" buttons
    const createNestedNotebookAction = action(() => {
      const nbTitle = newNestedNotebookTitle.get() || "New Notebook";
      const nb = Notebook({
        title: nbTitle,
        notes: [],
        isHidden: true,
        parentNotebook: self,
      });
      pieceRegistry.push(nb);
      notes.push(nb);

      const shouldNavigate = !usedCreateAnotherNotebook.get();
      showNewNestedNotebookPrompt.set(false);
      newNestedNotebookTitle.set("");
      usedCreateAnotherNotebook.set(false);
      if (shouldNavigate) {
        return navigateTo(nb);
      }
    });

    const createAnotherNestedNotebookAction = action(() => {
      const nbTitle = newNestedNotebookTitle.get() || "New Notebook";
      const nb = Notebook({
        title: nbTitle,
        notes: [],
        isHidden: true,
        parentNotebook: undefined,
      });
      pieceRegistry.push(nb);
      notes.push(nb);

      usedCreateAnotherNotebook.set(true);
      newNestedNotebookTitle.set("");
    });

    // Action to duplicate selected notes
    const doDuplicateSelectedNotes = action(() => {
      const selected = selectedNoteIndices.get();

      for (const idx of selected) {
        const original = notes.key(idx);
        if (original) {
          const newNote = Note({
            title: (original.get().title ?? "Note") + " (Copy)",
            content: original.get().content ?? "",
            isHidden: true,
            parentNotebook: self, // Set parent for back navigation
          });
          pieceRegistry.push(newNote);
          notes.push(newNote);
        }
      }
      selectedNoteIndices.set([]);
    });

    // COMBINED computed for ALL notebook relationships to avoid nested computed access issues
    // Returns parents, children, siblings, and their boolean flags all in one place
    // NOTE: Prefixed with _ because siblings feature is disabled; kept for re-enabling
    const _notebookRelationships = computed(() => {
      // Current notebook's name for comparison - use title since it's our local prop
      const currentTitle = title;
      // Build a pattern to match our NAME format: "📓 {title} ({count})"
      const _currentNamePattern = `📓 ${currentTitle}`;
      const nbCount = notebooks.length;

      // Find parent notebooks (notebooks that contain this notebook in their notes)
      // For now, skip parent detection as it requires accessing notes arrays of other pieces
      const parents: NotebookPiece[] = [];
      // Note: Parent detection requires deeper integration with piece introspection

      // Find child notebooks (notebooks in our notes list)
      const notesList = notes.get() ?? [];
      const childNames = (Array.isArray(notesList) ? notesList : [])
        .filter((n) => n?.isNotebook === true)
        .map((n) => getPieceName(n))
        .filter((t) => t.length > 0);

      const children: (NotePiece | NotebookPiece)[] = [];
      for (let i = 0; i < nbCount; i++) {
        const nb = notebooks[i];
        const nbName = getPieceName(nb);
        if (
          childNames.some((cn) => nbName.includes(cn) || cn.includes(nbName))
        ) {
          children.push(nb);
        }
      }

      // ========================================================================
      // SIBLINGS FEATURE DISABLED FOR PERFORMANCE
      // ========================================================================
      // The "Other notebooks" sibling feature was causing significant performance
      // issues with 50+ notebooks due to O(n*m) complexity in the computation.
      //
      // To re-enable:
      // 1. Uncomment the siblings computation below
      // 2. Uncomment the UI section in JSX (search for "DISABLED FOR PERFORMANCE")
      // 3. Set hasSiblings to: siblings.length > 0
      //
      // Performance consideration: Consider implementing lazy evaluation or
      // a collapsible UI that only computes siblings when expanded.
      // ========================================================================

      // const notesListNames = (Array.isArray(notesList) ? notesList : [])
      //   .map((n: any) => getPieceName(n))
      //   .filter((t: any) => t.length > 0);
      //
      // const siblings: any[] = [];
      // for (let i = 0; i < nbCount; i++) {
      //   const nb = notebooks[i];
      //   const nbName = getPieceName(nb);
      //   if (nbName.length === 0) continue;
      //   if (nbName.startsWith(currentNamePattern)) continue;
      //   if (notesListNames.some((n) => nbName.includes(n) || n.includes(nbName))) continue;
      //   siblings.push(nb);
      // }

      const siblings: any[] = []; // Empty - siblings feature disabled

      return {
        parents,
        hasParents: parents.length > 0,
        children,
        hasChildren: children.length > 0,
        siblings,
        hasSiblings: false, // Set to: siblings.length > 0 when re-enabling
      };
    });

    // Computed items for cf-select dropdowns (notebooks + "New Notebook...")
    // cf-select has proper bidirectional DOM sync, unlike native <select>
    const notebookSelectItems = computed(() => [
      ...notebooks.map((nb, idx: number) => ({
        label: nb?.[NAME] ?? "Untitled",
        value: String(idx),
      })),
      { label: "────────────", value: "_divider", disabled: true },
      { label: "New Notebook...", value: "new" },
    ]);

    // ===== Pre-computed UI values =====

    // Parent notebook display state - read from input prop
    const hasParentNotebook = computed(() => !!parentNotebook.get());
    const parentNotebookLabel = computed(() => {
      const p = parentNotebook.get();
      return p?.[NAME] ?? p?.title ?? "Parent";
    });

    // Title editing display states
    const titleDisplayStyle = computed(() =>
      isEditingTitle.get() ? "none" : "flex"
    );
    const titleInputDisplayStyle = computed(() =>
      isEditingTitle.get() ? "flex" : "none"
    );

    // Notes list display
    const notesListDisplay = computed(() => hasNotes ? "flex" : "none");
    const emptyStateDisplay = computed(() => hasNotes ? "none" : "flex");
    const selectAllDisplay = computed(() =>
      notes.get().length > 1 ? "flex" : "none"
    );

    // Selection state display
    const actionBarDisplay = computed(() => hasSelection ? "flex" : "none");

    // Backlinks display
    const backlinksDisplay = computed(() =>
      backlinks.get().length > 0 ? "flex" : "none"
    );

    // All Notes button display - search the registry by name.
    const allNotesButtonDisplay = computed(() => {
      const pieces = pieceRegistry.get() ?? [];
      const exists = pieces.some((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("All Notes");
      });
      return exists ? "flex" : "none";
    });

    // ===== Shared UI Styles =====

    const newButtonStyle = {
      padding: "6px 12px",
      display: "flex",
      alignItems: "center",
      gap: "4px",
    };

    return {
      // Include 📓 marker in NAME for reliable identification through proxy
      [NAME]: computed(() => `📓 ${title.get()} (${noteCount})`),
      isNotebook,
      isHidden,
      [UI]: (
        <cf-screen>
          <cf-vstack gap="4" padding="6">
            {/* Header row - parent link on left, Notebooks dropdown on right */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              {/* Parent link - shows parent notebook chip if parentNotebook is set */}
              <cf-hstack
                gap="2"
                align="center"
                style={{
                  display: computed(() => hasParentNotebook ? "flex" : "none"),
                }}
              >
                <span
                  style={{
                    fontSize: "13px",
                    color: "var(--cf-theme-color-text-secondary)",
                  }}
                >
                  In:
                </span>
                <cf-chip
                  label={parentNotebookLabel}
                  interactive
                  oncf-click={goToParentAction}
                />
              </cf-hstack>
              {/* Spacer when no parent */}
              <div
                style={{
                  display: computed(() => hasParentNotebook ? "none" : "block"),
                }}
              />

              <cf-button
                variant="ghost"
                onClick={goToAllNotesAction}
                style={{
                  padding: "8px 16px",
                  fontSize: "16px",
                  borderRadius: "8px",
                  display: allNotesButtonDisplay,
                }}
              >
                📁 All Notes
              </cf-button>
            </div>

            <cf-card>
              <cf-vstack gap="4">
                {/* Header - also a drop zone for receiving items from "Other notebooks" */}
                <cf-drop-zone
                  accept="sibling"
                  oncf-drop={handleDropOntoCurrentNotebook({
                    notes,
                    notebooks,
                    selectedNoteIndices,
                  })}
                  style={{ width: "100%" }}
                >
                  <div
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px",
                      borderRadius: "8px",
                      background: "var(--cf-theme-color-background, #fff)",
                    }}
                  >
                    {/* Editable Title */}
                    <div
                      style={{
                        display: titleDisplayStyle,
                        alignItems: "center",
                        gap: "8px",
                        cursor: "pointer",
                      }}
                      onClick={startEditingTitleAction}
                    >
                      <span
                        style={{
                          margin: 0,
                          fontSize: "15px",
                          fontWeight: "600",
                        }}
                      >
                        📓 {title} ({noteCount})
                      </span>
                    </div>
                    <div
                      style={{
                        display: titleInputDisplayStyle,
                        flex: 1,
                        marginRight: "12px",
                      }}
                    >
                      <cf-input
                        $value={title}
                        placeholder="Notebook name..."
                        style={{ flex: 1 }}
                        oncf-blur={stopEditingTitleAction}
                        oncf-keydown={handleTitleKeydownAction}
                      />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <cf-button
                        size="sm"
                        variant="ghost"
                        title="New Note"
                        onClick={showNewNoteModalAction}
                        style={newButtonStyle}
                      >
                        <span style={{ fontSize: "14px" }}>📝</span>
                        <span style={{ fontSize: "13px", fontWeight: "500" }}>
                          New
                        </span>
                      </cf-button>
                      <cf-button
                        size="sm"
                        variant="ghost"
                        title="New Notebook"
                        onClick={showNewNotebookModalAction}
                        style={newButtonStyle}
                      >
                        <span style={{ fontSize: "14px" }}>📓</span>
                        <span style={{ fontSize: "13px", fontWeight: "500" }}>
                          New
                        </span>
                      </cf-button>
                    </div>
                  </div>
                </cf-drop-zone>

                {/* Empty state - shown when notebook has no notes, opens new note modal */}
                <div
                  style={{
                    display: emptyStateDisplay,
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "48px 24px",
                    cursor: "pointer",
                    borderRadius: "8px",
                    border: "2px dashed var(--cf-theme-color-border, #e5e5e7)",
                    background: "var(--cf-theme-color-surface, #f9f9f9)",
                  }}
                  onClick={showNewNoteModalAction}
                >
                  <span style={{ fontSize: "32px", marginBottom: "12px" }}>
                    📝
                  </span>
                  <span
                    style={{
                      fontSize: "15px",
                      fontWeight: "500",
                      color: "var(--cf-theme-color-text)",
                    }}
                  >
                    Click to create your first note
                  </span>
                </div>

                <cf-vstack
                  gap="0"
                  style={{
                    display: notesListDisplay,
                  }}
                >
                  {/* Notes List - using cf-table like default-app for consistent spacing */}
                  <cf-table full-width hover>
                    <tbody>
                      {notes.map((note, index) => (
                        <tr
                          style={{
                            background: computed(() =>
                              selectedNoteIndices.get().includes(index)
                                ? "var(--cf-theme-color-surface, #f5f5f7)"
                                : "transparent"
                            ),
                          }}
                        >
                          <td
                            style={{
                              width: "32px",
                              padding: "0 4px",
                              verticalAlign: "middle",
                            }}
                          >
                            <div
                              style={{
                                cursor: "pointer",
                                userSelect: "none",
                              }}
                              onClick={toggleNoteCheckbox({
                                index,
                                selectedNoteIndices,
                                lastSelectedNoteIndex,
                              })}
                            >
                              <cf-checkbox
                                checked={computed(() =>
                                  selectedNoteIndices.get().includes(index)
                                )}
                              />
                            </div>
                          </td>
                          <td style={{ verticalAlign: "middle" }}>
                            {/* Drop zone + drag source on the item itself */}
                            <cf-drop-zone
                              accept="note,notebook"
                              oncf-drop={handleDropOntoNotebook({
                                targetNotebook: self,
                                currentNotes: notes,
                                selectedNoteIndices,
                                notebooks,
                              })}
                            >
                              <cf-drag-source $cell={note} type="note">
                                <div
                                  style={{ cursor: "pointer" }}
                                  onClick={navigateToChild({
                                    child: note,
                                    self,
                                  })}
                                >
                                  <cf-chip
                                    label={note?.[NAME] ??
                                      note?.title ??
                                      "Untitled"}
                                    interactive
                                  />
                                </div>
                              </cf-drag-source>
                            </cf-drop-zone>
                          </td>
                          <td
                            style={{
                              width: "40px",
                              verticalAlign: "middle",
                            }}
                          >
                            <cf-button
                              size="sm"
                              variant="ghost"
                              onClick={removeFromNotebook({ note, notes })}
                            >
                              ✕
                            </cf-button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </cf-table>

                  {/* Select All footer - only show when more than 1 item */}
                  <div
                    style={{
                      display: selectAllDisplay,
                      alignItems: "center",
                      padding: "4px 0",
                      fontSize: "13px",
                      color: "var(--cf-theme-color-text-secondary, #6e6e73)",
                    }}
                  >
                    {/* Checkbox column (32px + 4px padding) */}
                    <div style={{ width: "32px", padding: "0 4px" }}>
                      <cf-checkbox
                        checked={computed(() =>
                          notes.get().length > 0 &&
                          selectedNoteIndices.get().length ===
                            notes.get().length
                        )}
                        oncf-change={computed(() =>
                          selectedNoteIndices.get().length ===
                              notes.get().length
                            ? deselectAllNotesAction
                            : selectAllNotesAction
                        )}
                      />
                    </div>
                    {/* Text aligned with piece pills */}
                    <span style={{ paddingLeft: "4px" }}>Select All</span>
                  </div>
                </cf-vstack>

                {/* Action Bar - Use CSS display to keep DOM alive (preserves handler streams) */}
                <cf-hstack
                  padding="3"
                  gap="3"
                  style={{
                    display: actionBarDisplay,
                    background: "var(--cf-theme-color-surface, #f5f5f7)",
                    borderRadius: "8px",
                    alignItems: "center",
                    marginTop: "8px",
                  }}
                >
                  <span style={{ fontSize: "13px", fontWeight: "500" }}>
                    {selectedCount} selected
                  </span>
                  <span style={{ flex: 1 }} />
                  <cf-select
                    $value={selectedAddNotebook}
                    items={notebookSelectItems}
                    placeholder="Add to notebook..."
                    style={{ width: "160px" }}
                    onChange={addSelectedToNotebook({
                      notes,
                      selectedNoteIndices,
                      notebooks,
                      selectedAddNotebook,
                      showNewNotebookPrompt,
                      pendingNotebookAction,
                    })}
                  />
                  <cf-select
                    $value={selectedMoveNotebook}
                    items={notebookSelectItems}
                    placeholder="Move to..."
                    style={{ width: "140px" }}
                    onChange={moveSelectedToNotebook({
                      notes,
                      selectedNoteIndices,
                      notebooks,
                      selectedMoveNotebook,
                      showNewNotebookPrompt,
                      pendingNotebookAction,
                    })}
                  />
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={doDuplicateSelectedNotes}
                  >
                    Duplicate
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={deleteSelectedNotes({
                      notes,
                      selectedNoteIndices,
                      pieceRegistry,
                      notebooks,
                    })}
                    style={{ color: "var(--cf-theme-color-error, #dc3545)" }}
                  >
                    Delete
                  </cf-button>
                </cf-hstack>
              </cf-vstack>
            </cf-card>

            {/* Siblings feature disabled for performance - see _notebookRelationships for re-enabling */}
          </cf-vstack>

          {/* New Notebook Prompt Modal */}
          <cf-modal
            $open={showNewNotebookPrompt}
            dismissable
            size="sm"
            label="New Notebook"
          >
            <span slot="header">New Notebook</span>
            <cf-input
              $value={newNotebookName}
              placeholder="Enter notebook name..."
            />
            <cf-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <cf-button
                variant="ghost"
                onClick={cancelNewNotebookPromptAction}
              >
                Cancel
              </cf-button>
              <cf-button
                variant="primary"
                onClick={createNotebookFromPrompt({
                  newNotebookName,
                  showNewNotebookPrompt,
                  pendingNotebookAction,
                  selectedNoteIndices,
                  notes,
                  pieceRegistry,
                  notebooks,
                })}
              >
                Create
              </cf-button>
            </cf-hstack>
          </cf-modal>

          {/* New Note Prompt Modal */}
          <cf-modal
            $open={showNewNotePrompt}
            dismissable
            size="sm"
            label="New Note"
          >
            <span slot="header">New Note</span>
            <cf-input
              $value={newNoteTitle}
              placeholder="Enter note title..."
            />
            <cf-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <cf-button
                variant="ghost"
                onClick={cancelNewNotePromptAction}
              >
                Cancel
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={createAnotherNoteAction}
              >
                Create Another
              </cf-button>
              <cf-button
                variant="primary"
                onClick={createNoteAction}
              >
                Create
              </cf-button>
            </cf-hstack>
          </cf-modal>

          {/* New Nested Notebook Prompt Modal */}
          <cf-modal
            $open={showNewNestedNotebookPrompt}
            dismissable
            size="sm"
            label="New Notebook"
          >
            <span slot="header">New Notebook</span>
            <cf-input
              $value={newNestedNotebookTitle}
              placeholder="Enter notebook title..."
            />
            <cf-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <cf-button
                variant="ghost"
                onClick={cancelNewNestedNotebookPromptAction}
              >
                Cancel
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={createAnotherNestedNotebookAction}
              >
                Create Another
              </cf-button>
              <cf-button
                variant="primary"
                onClick={createNestedNotebookAction}
              >
                Create
              </cf-button>
            </cf-hstack>
          </cf-modal>

          {/* Backlinks footer - show pieces that link to this notebook */}
          <cf-hstack
            slot="footer"
            gap="2"
            padding="3"
            style={{
              display: backlinksDisplay,
              alignItems: "center",
              borderTop: "1px solid var(--cf-theme-color-border, #e5e5e7)",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                lineHeight: "28px",
                color: "var(--cf-theme-color-text-secondary, #666)",
              }}
            >
              Linked from:
            </span>
            {backlinks.map((piece) => (
              <cf-button
                variant="ghost"
                size="sm"
                onClick={handleBacklinkClick({ piece })}
                style={{ fontSize: "12px" }}
              >
                {piece?.[NAME]}
              </cf-button>
            ))}
          </cf-hstack>
        </cf-screen>
      ),
      title,
      notes,
      noteCount,
      summary,
      backlinks,
      // Make notes discoverable via [[ autocomplete system-wide
      mentionable: notes,
      // LLM-callable streams for omnibot integration
      createNote: createNoteStreamAction,
      createNotes: createNotesStreamAction,
      setTitle: setTitleAction,
      createNotebook: createNotebookStreamAction,
      // Test-accessible action streams
      selectAllNotes: selectAllNotesAction,
      deselectAllNotes: deselectAllNotesAction,
      deleteSelected: deleteSelectedNotes({
        notes,
        selectedNoteIndices,
        pieceRegistry,
        notebooks,
      }),
      duplicateSelected: doDuplicateSelectedNotes,
      showNewNoteModal: showNewNoteModalAction,
      cancelNewNote: cancelNewNotePromptAction,
      showNewNotebookModal: showNewNotebookModalAction,
      cancelNewNotebook: cancelNewNotebookPromptAction,
      cancelNewNestedNotebook: cancelNewNestedNotebookPromptAction,
      startEditTitle: startEditingTitleAction,
      stopEditTitle: stopEditingTitleAction,
      goToAllNotes: goToAllNotesAction,
      createNoteFromPrompt: createNoteAction,
      createAnotherNoteFromPrompt: createAnotherNoteAction,
      createNestedNotebookFromPrompt: createNestedNotebookAction,
      createAnotherNestedNotebookFromPrompt: createAnotherNestedNotebookAction,
      createNotebookFromSelectionPrompt: createNotebookFromPrompt({
        newNotebookName,
        showNewNotebookPrompt,
        pendingNotebookAction,
        selectedNoteIndices,
        notes,
        pieceRegistry,
        notebooks,
      }),
      // Test-accessible state
      selectedNoteIndices,
      selectedCount,
      hasSelection,
      showNewNotePrompt,
      showNewNotebookPrompt,
      showNewNestedNotebookPrompt,
      isEditingTitle,
    };
  },
);

export default Notebook;
