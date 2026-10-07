import {
  computed,
  equals,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { default as Note } from "../notes/note.tsx";

import BacklinksIndex, { type MentionablePiece } from "./backlinks-index.tsx";
import SummaryIndex from "./summary-index.tsx";
import KnowledgeGraph, {
  getNeighborsPattern,
  searchGraphPattern,
} from "./knowledge-graph.tsx";

import QuickCapture from "./quick-capture.tsx";
import OmniboxFAB from "./omnibox-fab.tsx";
import DoList from "../do-list/do-list.tsx";
import Notebook from "../notes/notebook.tsx";
import DailyJournal from "../notes/daily-journal.tsx";
import PieceGrid from "./piece-grid.tsx";
import SuggestionHistory, {
  type SuggestionHistoryEntry,
} from "./suggestion-history.tsx";

type MinimalPiece = {
  [NAME]?: string;
  isHidden?: boolean;
};

type PiecesListInput = void;

// Pattern returns only UI, no data outputs (only symbol properties)
export interface PiecesListOutput {
  [key: string]: unknown;
  [UI]: VNode;
  backlinksIndex: {
    mentionable: MentionablePiece[] | undefined;
  };
  sidebarUI?: unknown;
  fabUI: unknown;
  pieceRegistry: MentionablePiece[];
  addPiece: Stream<{ piece: Writable<MentionablePiece> }>;
}

const _visit = handler<
  Record<string, never>,
  { piece: Writable<MinimalPiece> }
>(
  (_, state) => {
    return navigateTo(state.piece);
  },
);

export const removePiece = handler<
  Record<string, never>,
  {
    piece: Writable<MinimalPiece>;
    pieceRegistry: Writable<MinimalPiece[]>;
  }
>((_, state) => {
  state.pieceRegistry.remove(state.piece);
});

// Handler for dropping a note onto a notebook row
const dropOntoNotebook = handler<
  { detail: { sourceCell: Writable<unknown> } },
  { notebook: Writable<{ notes?: unknown[] }> }
>((event, { notebook }) => {
  const sourceCell = event.detail.sourceCell;
  const notesCell = notebook.key("notes");
  const notesList = notesCell.get() ?? [];

  // Prevent duplicates using Writable.equals
  const alreadyExists = notesList.some((n) => equals(sourceCell, n as any));
  if (alreadyExists) return;

  // Hide from Patterns list
  sourceCell.key("isHidden").set(true);

  // Add to notebook - push cell reference, not value, to maintain piece identity
  notesCell.push(sourceCell);
});

const toggleFab = handler<any, { fabExpanded: Writable<boolean> }>(
  (_, { fabExpanded }) => {
    fabExpanded.set(!fabExpanded.get());
  },
);

// Toggle dropdown menu
const toggleMenu = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(!menuOpen.get()),
);

// Close dropdown menu (for backdrop click)
const closeMenu = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(false),
);

// Menu: New Note
const menuNewNote = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => {
    menuOpen.set(false);
    return navigateTo(
      Note({
        title: "New Note",
        content: "",
      }),
    );
  },
);

// Menu: New Notebook
const menuNewNotebook = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => {
    menuOpen.set(false);
    return navigateTo(Notebook({ title: "New Notebook" }));
  },
);

// Menu: Quick Capture
const menuQuickCapture = handler<
  void,
  { menuOpen: Writable<boolean>; quickCapture: any }
>((_, { menuOpen, quickCapture }) => {
  menuOpen.set(false);
  return navigateTo(quickCapture);
});

// Menu: Daily Journal (singleton)
export const menuDailyJournal = handler<
  void,
  { menuOpen: Writable<boolean>; pieceRegistry: Writable<MinimalPiece[]> }
>((_, { menuOpen, pieceRegistry }) => {
  menuOpen.set(false);
  const pieces = pieceRegistry.get();
  const existing = pieces.find((piece: any) => piece?.isJournal === true);
  if (existing) {
    return navigateTo(existing as any);
  }
  return navigateTo(DailyJournal({ title: "Daily Journal" }));
});

// Handler: Add a piece to the registry if not already present.
const addPiece = handler<
  { piece: Writable<MentionablePiece> },
  { pieceRegistry: Writable<MentionablePiece[]> }
>(({ piece }, { pieceRegistry }) => {
  pieceRegistry.addUnique(piece);
});

// Retained stream cell for existing default-app roots. Events have no effect.
const retiredAction = handler<unknown, Record<string, never>>(() => {});

const recordSuggestion = handler<
  SuggestionHistoryEntry,
  { suggestionHistory: Writable<SuggestionHistoryEntry[]> }
>(({ result, messages, timestamp }, { suggestionHistory }) => {
  const current = suggestionHistory.get() ?? [];
  suggestionHistory.set([...current, { result, messages, timestamp }]);
});

/** Read current do list items */
const readDoList = pattern<
  { items: Array<{ title: string; done: boolean; indent: number }> },
  { result: Array<{ title: string; done: boolean; indent: number }> }
>(({ items }) => {
  return { result: items };
});

const benExtraSystemPrompt = `
Do-list management:
- When users mention tasks, action items, or things to do, use addDoItem or addDoItems
- When users paste a block of text with multiple items, parse into items and use addDoItems to batch-add
- Use readDoList to check current items before making changes
- Use updateDoItem to mark done or rename; removeDoItem only for explicit deletion
- Use indent levels for sub-tasks (0=root, 1=sub-task, 2=sub-sub-task)

Knowledge graph:
- For finding relationships between pieces: use getNeighbors with an entity reference to get all incoming/outgoing links, or searchAnnotations to search agent-created annotations by text
`;

export default pattern<PiecesListInput, PiecesListOutput>((_) => {
  // OWN the data cells (not from wish)
  const pieceRegistry = new Writable<MentionablePiece[]>([]);
  const suggestionHistory = new Writable<SuggestionHistoryEntry[]>([]);
  const suggestionHistoryViewer = SuggestionHistory({});

  // Dropdown menu state
  const menuOpen = new Writable(false);

  // Keep registry entries as cells so inspecting one display field does not
  // materialize every field on every linked piece.
  const registeredPieceCells = computed(() => {
    const pieces: Writable<MentionablePiece>[] = [];
    const length = pieceRegistry.key("length").get();
    for (let index = 0; index < length; index++) {
      pieces.push(pieceRegistry.key(index));
    }
    return pieces;
  });

  // Filter out hidden pieces and pieces without resolved NAME
  // (prevents transient hash-only pills during reactive updates)
  const visiblePieces = computed(() => {
    const pieces: Writable<MentionablePiece>[] = [];
    const length = pieceRegistry.key("length").get();
    for (let index = 0; index < length; index++) {
      const piece = pieceRegistry.key(index);
      const isHidden = piece.key("isHidden").get();
      const name = piece.key(NAME).get();
      if (!isHidden && typeof name === "string" && name.length > 0) {
        pieces.push(piece);
      }
    }
    return pieces;
  });

  const doListItems = new Writable<any[]>([]);
  const doList = DoList({ items: doListItems });

  // Combine registered pieces with system pieces (like doList) so
  // BacklinksIndex picks up their mentionable items.
  const piecesWithSystem = computed(() => [
    ...registeredPieceCells,
    doList as any,
  ]);

  const index = BacklinksIndex({ pieceRegistry: piecesWithSystem });
  const summaryIdx = SummaryIndex({});
  const knowledgeGraph = KnowledgeGraph({});

  const quickCapture = QuickCapture({ pieceRegistry });

  const fab = OmniboxFAB({
    mentionable: index.mentionable,
    extraTools: {
      addDoItem: {
        handler: doList.addItem,
        description:
          "Add a task to the do list. Use indent for sub-tasks (0=root, 1=sub, 2=sub-sub). Pass attachments array to link pieces.",
      },
      addDoItems: {
        handler: doList.addItems,
        description:
          "Add multiple tasks at once. Each item can have attachments to link pieces.",
      },
      removeDoItem: {
        handler: doList.removeItemByTitle,
        description: "Remove a task and its subtasks by title.",
      },
      updateDoItem: {
        handler: doList.updateItemByTitle,
        description:
          "Update a task by title. Set done=true to complete, newTitle to rename, attachments to link pieces.",
      },
      readDoList: patternTool(readDoList, {
        items: doList.items,
      }),
      getNeighbors: patternTool(getNeighborsPattern, {
        edges: knowledgeGraph.edges,
      }),
      searchAnnotations: patternTool(searchGraphPattern, {
        edges: knowledgeGraph.edges,
        compoundNodes: knowledgeGraph.compoundNodes,
      }),
    },
    extraSystemPrompt: benExtraSystemPrompt,
  });

  const gridView = PieceGrid({ pieces: visiblePieces });

  return {
    backlinksIndex: index,
    summaryIndex: summaryIdx,
    knowledgeGraph,

    quickCapture,
    [NAME]: computed(() => `Ben's Space (${visiblePieces.length})`),
    [UI]: (
      <cf-screen>
        <cf-keybind
          code="KeyO"
          meta
          preventDefault
          oncf-keybind={toggleFab({ fabExpanded: fab.fabExpanded })}
        />
        <cf-keybind
          code="KeyO"
          ctrl
          preventDefault
          oncf-keybind={toggleFab({ fabExpanded: fab.fabExpanded })}
        />

        <cf-toolbar slot="header" sticky>
          <div slot="start">
            <h2 style={{ margin: 0, fontSize: "20px" }}>Patterns</h2>
          </div>
          <cf-cell-link
            $cell={index}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-theme-color-text-secondary)",
            }}
          >
            Mentions
          </cf-cell-link>
          <cf-cell-link
            $cell={summaryIdx}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-theme-color-text-secondary)",
            }}
          >
            Search
          </cf-cell-link>
          <cf-cell-link
            $cell={knowledgeGraph}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-theme-color-text-secondary)",
            }}
          >
            Graph
          </cf-cell-link>
          <cf-cell-link
            $cell={suggestionHistoryViewer}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-theme-color-text-secondary)",
            }}
          >
            History
          </cf-cell-link>

          <div slot="end">
            <cf-button
              variant="ghost"
              onClick={toggleMenu({ menuOpen })}
              style={{
                padding: "8px 16px",
                fontSize: "16px",
                borderRadius: "8px",
              }}
            >
              Notes ▾
            </cf-button>

            {
              /* Backdrop to close menu when clicking outside. It exists only
                while the menu is open: a full-screen layer whose visibility
                waits on a value still arriving would cover the page until
                then. */
            }
            {ifElse(
              menuOpen,
              <div
                onClick={closeMenu({ menuOpen })}
                style={{
                  position: "fixed",
                  inset: "0",
                  zIndex: "999",
                }}
              />,
              null,
            )}

            {/* Dropdown Menu */}
            <cf-vstack
              gap="0"
              style={{
                display: computed(() => (menuOpen.get() ? "flex" : "none")),
                position: "fixed",
                top: "112px",
                right: "16px",
                background: "var(--cf-theme-color-background, white)",
                border: "1px solid var(--cf-theme-color-border, #e5e5e7)",
                borderRadius: "12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                minWidth: "160px",
                zIndex: "1000",
                padding: "4px",
              }}
            >
              <cf-button
                variant="ghost"
                onClick={menuNewNote({ menuOpen })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📝 New Note
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={menuNewNotebook({ menuOpen })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📓 New Notebook
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={menuQuickCapture({ menuOpen, quickCapture })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}⚡ Quick Capture
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={menuDailyJournal({ menuOpen, pieceRegistry })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📅 Daily Journal
              </cf-button>
              <div
                style={{
                  height: "1px",
                  background: "var(--cf-theme-color-border, #e5e5e7)",
                  margin: "4px 8px",
                }}
              />
            </cf-vstack>
          </div>
        </cf-toolbar>

        <cf-vscroll flex showScrollbar>
          <cf-hstack gap="6" padding="6" align="start">
            <div style={{ flex: "1", minWidth: "0" }}>
              <cf-vstack gap="4">
                <h3 style={{ margin: "0", fontSize: "16px" }}>Do List</h3>
                <cf-cell-link $cell={doList} />
                {doList.compactUI}
              </cf-vstack>
            </div>

            <div style={{ flex: "1", minWidth: "0" }}>
              <cf-vstack gap="4">
                <cf-hstack gap="2" align="center">
                  <h3 style={{ margin: "0", fontSize: "16px" }}>Pieces</h3>
                  <cf-cell-link $cell={gridView} />
                </cf-hstack>

                <cf-table full-width hover>
                  <tbody>
                    {visiblePieces.map((piece) => {
                      const isNotebook = computed(() => {
                        const name = piece.key(NAME).get();
                        const result = typeof name === "string" &&
                          name.startsWith("📓");
                        return result;
                      });

                      const link = (
                        <cf-drag-source $cell={piece} type="note">
                          <cf-render variant="chip" $cell={piece} />
                        </cf-drag-source>
                      );

                      return (
                        <tr>
                          <td>
                            {isNotebook
                              ? (
                                <cf-drop-zone
                                  accept="note"
                                  oncf-drop={dropOntoNotebook({
                                    notebook: piece as any,
                                  })}
                                >
                                  {link}
                                </cf-drop-zone>
                              )
                              : link}
                          </td>
                          <td>
                            <cf-button
                              size="sm"
                              variant="ghost"
                              onClick={removePiece({ piece, pieceRegistry })}
                            >
                              🗑️
                            </cf-button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </cf-table>
              </cf-vstack>
            </div>
          </cf-hstack>
        </cf-vscroll>
      </cf-screen>
    ),
    fabUI: fab[UI],

    // Exported data
    pieceRegistry,
    suggestionHistory,

    // Exported handlers (bound to state cells for external callers)
    addPiece: addPiece({ pieceRegistry }),
    trackRecent: retiredAction({}),
    recordSuggestion: recordSuggestion({ suggestionHistory }),
    pinToChat: fab.pinToChat,
  };
});
