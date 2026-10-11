import {
  computed,
  equals,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import {
  addParticipant,
  type ParticipantProfile,
  type ParticipantRoster,
  rosterProfiles,
} from "../loom/participants.tsx";
import { default as Note, type NotePiece } from "../notes/note.tsx";

import BacklinksIndex, { type MentionablePiece } from "./backlinks-index.tsx";
import SummaryIndex from "./summary-index.tsx";
import Notebook from "../notes/notebook.tsx";
import PieceGrid from "./piece-grid.tsx";

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
  // Declared (not just index-signature) so the schema surfaces them to
  // external callers and tests: the runtime reads outputs through the
  // declared type.
  pieceRegistry: MentionablePiece[];
  addPiece: Stream<{ piece: Writable<MentionablePiece> }>;

  /**
   * Fabric profiles of the space's participants, each the live profile cell
   * in its own space, in the order they were added. Any participant may add
   * any profile, so an entry is a claim: it does not say that the profile's
   * principal holds access to the space.
   */
  participants: ParticipantProfile[];

  /** Adds a labeled profile to `participants` once. */
  addParticipant: Stream<{ profile: ParticipantProfile }>;
}

const _visit = handler<
  Record<string, never>,
  { piece: Writable<MinimalPiece> }
>(
  (_, state) => {
    return navigateTo(state.piece);
  },
);

const removePiece = handler<
  Record<string, never>,
  {
    piece: Writable<MinimalPiece>;
    pieceRegistry: Writable<MinimalPiece[]>;
  }
>((_, state) => {
  const registeredPieces = state.pieceRegistry.get();
  const index = registeredPieces.findIndex(
    (c: any) => c && state.piece.equals(c),
  );

  if (index !== -1) {
    const pieceListCopy = [...registeredPieces];
    console.log("pieceListCopy before", pieceListCopy.length);
    pieceListCopy.splice(index, 1);
    console.log("pieceListCopy after", pieceListCopy.length);
    state.pieceRegistry.set(pieceListCopy);
  }
});

// Handler for dropping a note onto a notebook row
const dropOntoNotebook = handler<
  { detail: { sourceCell: Writable<NotePiece> } },
  { notebook: Writable<{ notes?: NotePiece[] }> }
>((event, { notebook }) => {
  const sourceCell = event.detail.sourceCell;

  // Hide from Patterns list. Idempotent on a re-drop: a note already in the
  // notebook is already hidden.
  sourceCell.key("isHidden").set(true);

  // Add to notebook by piece identity. addUnique compares a cell argument by
  // link, so re-dropping the same note resolves to one membership entry and
  // drops of distinct notes merge, without reading the whole list.
  notebook.key("notes").addUnique(sourceCell);
});

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

// Handler: Add a piece to the registry if not already present. The event field
// is declared as a cell so it arrives as one (the shell sends a piece cell);
// addUnique then dedups by link, so concurrent registrations of the same
// piece resolve to one entry and adds of distinct pieces merge, without
// reading the whole list.
const addPiece = handler<
  { piece: Writable<MentionablePiece> },
  { pieceRegistry: Writable<MentionablePiece[]> }
>((event, { pieceRegistry }) => {
  const piece = event?.piece;
  if (!piece) return;
  pieceRegistry.addUnique(piece);
});

/**
 * Adds the viewer's `#profile` to the roster, through `join` so that the
 * roster's one writer makes the write. Does nothing until the profile
 * document reads as present: an unresolved profile arrives as an empty cell,
 * and linking it would record no profile at all.
 */
const joinAsViewer = handler<
  void,
  {
    join: Stream<{ profile: ParticipantProfile }>;
    profile: ParticipantProfile | undefined;
  }
>((_, { join, profile }) => {
  const target = profile?.resolveAsCell();
  if (target === undefined || target.get() === undefined) return;
  join.send({ profile: target });
});

// Retained stream cell for existing default-app roots. Events have no effect.
const retiredAction = handler<unknown, Record<string, never>>(() => {});

export default pattern<PiecesListInput, PiecesListOutput>((_) => {
  // OWN the data cells (not from wish)
  const pieceRegistry = new Writable<MentionablePiece[]>([]);

  // Changes only through `addParticipant`, the one writer the roster's write
  // contract admits.
  const participants = new Writable<ParticipantRoster>({});
  const roster = computed(() => rosterProfiles(participants));
  const join = addParticipant({ roster: participants });
  const viewerProfile = wish<ParticipantProfile>({ query: "#profile" });
  const viewerName = wish<string>({ query: "#profileName" });
  // The name string is empty when no profile resolved, whereas a presence
  // test on the profile cell reads an absent profile as present.
  const hasProfile = computed(() => (viewerName.result ?? "").trim() !== "");
  const isParticipant = computed(() => {
    const mine = viewerProfile.result;
    if (!mine) return false;
    return roster.some((entry) => equals(entry, mine));
  });

  // Dropdown menu state
  const menuOpen = new Writable(false);

  // Filter out hidden pieces and pieces without resolved NAME
  // (prevents transient hash-only pills during reactive updates)
  // NOTE: Use truthy check, not === true, because piece.isHidden is a proxy object
  const visiblePieces = computed(() =>
    pieceRegistry.get().filter((piece) => {
      if (!piece) return false;
      if (piece.isHidden) return false;
      const name = piece?.[NAME];
      return typeof name === "string" && name.length > 0;
    })
  );

  const index = BacklinksIndex({ pieceRegistry });
  const summaryIdx = SummaryIndex({});

  const gridView = PieceGrid({ pieces: visiblePieces });

  return {
    backlinksIndex: index,
    summaryIndex: summaryIdx,

    [NAME]: computed(() => `Space Home (${visiblePieces.length})`),
    [UI]: (
      <cf-screen>
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
          <cf-vstack gap="6" padding="6">
            <cf-vstack gap="2">
              <h3 style={{ margin: "0", fontSize: "16px" }}>Participants</h3>
              <cf-hstack gap="2" wrap>
                {roster.map((profile) => (
                  <cf-profile-badge
                    $profile={profile}
                    variant="chip"
                    size="sm"
                  />
                ))}
              </cf-hstack>
              {
                /* The `#profile` wish's own surface: it creates a profile
                  when the viewer has none, and picks among several when no
                  default is set, where `.result` already names the most
                  recently used one. A JSX ternary lowers to a static-branch
                  `ifElse`. */
              }
              {isParticipant ? null : (
                <cf-vstack gap="2">
                  {viewerProfile[UI]}
                  <cf-hstack>
                    <cf-button
                      size="sm"
                      disabled={!hasProfile}
                      onClick={joinAsViewer({
                        join,
                        profile: viewerProfile.result,
                      })}
                    >
                      Join this space
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              )}
            </cf-vstack>

            <cf-vstack gap="4">
              <cf-hstack gap="2" align="center">
                <h3 style={{ margin: "0", fontSize: "16px" }}>Pieces</h3>
                <cf-cell-link $cell={gridView} />
              </cf-hstack>

              <cf-table full-width hover>
                <tbody>
                  {visiblePieces.map((piece) => {
                    const isNotebook = computed(() => {
                      const name = piece?.[NAME];
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
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
    ),
    // Exported data
    pieceRegistry,
    // Exported handlers (bound to state cells for external callers)
    addPiece: addPiece({ pieceRegistry }),
    trackRecent: retiredAction({}),
    participants: roster,
    addParticipant: join,
  };
});
