import {
  action,
  cellFromUrl,
  computed,
  debugStr,
  type Default,
  equals,
  FS,
  generateText,
  handler,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  type PatternToolResult,
  SELF,
  type Stream,
  TILE_UI,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import NoteMd from "./note-md.tsx";
import { referenceAddresses } from "./reference-address.ts";
import { attachDefinitions, splitDefinitions } from "./reference-block.ts";
import {
  type MentionablePiece,
  type MentionRefMap,
  type MinimalPiece,
  type NotebookPiece,
  type NoteInput,
  type NotePiece,
} from "./schemas.tsx";

export { NotePiece };

/**
 * The bare id embedded in wiki-link text (`[[Name (<id>)]]`). Mirrors
 * mentionIdFromCellId in packages/ui (not importable from a pattern): `of:`
 * strips — the renderer (note-md) re-adds it — and `computed:` is REJECTED,
 * because the bare embed format cannot carry the scheme and the scheme is
 * part of the identity (a computed cell's bare hash names its of: sibling).
 * Mentionables are pieces (always of:) today, so the throw is a tripwire —
 * if it ever fires, the embed format must learn to carry the scheme.
 * Exported so the pattern test can pin the tripwire.
 */
export const bareMentionId = (uri: string): string => {
  if (uri.startsWith("computed:")) {
    throw new Error(`cannot embed a computed: cell in a wiki-link: ${uri}`);
  }
  return uri.replace(/^of:/, "");
};

// ===== Output Type =====

/** Represents a small #note a user took to remember some text. */
export interface NoteOutput extends NotePiece {
  [NAME]: string;
  [UI]: VNode;

  /** A note is always markdown, so it declares that arm rather than the whole
   * `FsProjection` union: the open arm types every field loosely, and a reader
   * of this projection wants `content` as the string it is. */
  [FS]: {
    type: "text/markdown";
    frontmatter?: Record<string, unknown>;
    content: string;
  };
  title: string;
  content: string;
  summary: string;
  mentioned: MentionablePiece[] | Default<[]>;
  backlinks: MentionablePiece[];

  /**
   * Where this note's `[Label][key]` mentions point. The default matches the
   * input's; see `NoteInput.references` for why they have to.
   */
  // deno-lint-ignore ban-types
  references: MentionRefMap | Default<{}>;
  isHidden: boolean;
  grep: PatternToolResult<{ content: string }>;
  translate: PatternToolResult<{ content: string }>;
  editContent: Stream<{ detail: { value: string } }>;

  /** Take an edited filesystem projection, definitions and all. */
  editProjection: Stream<{ body: string }>;
  setTitle: Stream<string>;
  appendLink: Stream<{ piece: Writable<MentionablePiece> }>;
  createNewNote: Stream<void>;

  /** Parent notebook reference, null if not in a notebook */
  parentNotebook: NotebookPiece | null;

  /** Tile variant (CT-1764): the minimal embedded UI used when a container
   * (e.g. Record) renders this note via `<cf-render variant="tile">`. */
  [TILE_UI]: VNode;
  // Test-accessible state
  menuOpen: boolean;
  isEditingTitle: boolean;
  // Test-accessible action streams
  toggleMenu: Stream<void>;
  closeMenu: Stream<void>;
  startEditingTitle: Stream<void>;
  stopEditingTitle: Stream<void>;
}

// ===== Module-scope handlers (reused with different bindings) =====

// Used in cf-code-editor - binds mentionable and pieceRegistry
const handleNewBacklink = handler<
  {
    detail: {
      piece: Writable<MentionablePiece>;
      navigate: boolean;
    };
  },
  {
    mentionable: Writable<MentionablePiece[]>;
    pieceRegistry: Writable<MinimalPiece[]>;
  }
>(({ detail }, { mentionable, pieceRegistry }) => {
  // Register the piece so it appears in default-app.
  pieceRegistry.push(detail.piece);

  if (detail.navigate) {
    return navigateTo(detail.piece);
  } else {
    mentionable.push(detail.piece);
  }
});

// Used in .map() over notebooks - binds different notebook each time
const menuGoToNotebook = handler<
  void,
  { menuOpen: Writable<boolean>; notebook: Writable<MinimalPiece> }
>((_, { menuOpen, notebook }) => {
  menuOpen.set(false);
  return navigateTo(notebook);
});

// Used in .map() over backlinks - binds different piece each time
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>(
  (_, { piece }) => navigateTo(piece),
);

// ===== Utility functions =====

// Grep sub-pattern for patternTool - filters content lines by query
const grepPattern = pattern<
  { query: string; content: string },
  string[]
>(({ query, content }) => {
  return computed(() => {
    return content.split("\n").filter((c: string) => c.includes(query));
  });
});

// Translate sub-pattern for patternTool - translates content to specified language
const translatePattern = pattern<
  { language: string; content: string },
  string | undefined
>(({ language, content }) => {
  const genResult = generateText({
    system: computed(() => `Translate the content to ${language}.`),
    prompt: computed(() => `<to_translate>${content}</to_translate>`),
  });

  return computed(() => {
    if (genResult.pending !== false) return undefined;
    if (genResult.result == null) return "Error occurred";
    return genResult.result;
  });
});

// ===== Pattern =====

const Note = pattern<NoteInput, NoteOutput>(
  ({
    title,
    content,
    isHidden,
    linkPattern,
    parentNotebook: _parentNotebook,
    references,
    [SELF]: self,
  }) => {
    // Ensure parentNotebook is always a Writable (input is optional)
    const parentNotebook = _parentNotebook ??
      new Writable(null as NotebookPiece | null);

    // Type-based discovery for notebooks and "All Notes" piece
    const notebookWish = wish<NotebookPiece>({
      query: "#notebook",
      scope: ["."],
      headless: true,
    });
    const allNotesWish = wish<MinimalPiece>({
      query: "#allNotes",
      scope: ["."],
      headless: true,
    });

    // Notebooks and "All Notes" from wish scope (must be before actions that reference them)
    const notebooks = notebookWish.candidates;
    const allNotesPiece = allNotesWish.result;

    // The registry is writable for creating notes and backlinks.
    const pieceRegistry = wish<Writable<MinimalPiece[]>>({
      query: "#pieceRegistry",
      headless: true,
    }).result!;
    const mentionable = wish<MentionablePiece[] | Default<[]>>(
      { query: "#mentionable", headless: true },
    ).result;
    const mentioned = new Writable<MentionablePiece[]>([]);

    // UI state
    const menuOpen = new Writable(false);
    const isEditingTitle = new Writable(false);

    // Backlinks - populated by backlinks-index.tsx
    const backlinks = new Writable<MentionablePiece[]>([]);

    // Summary - truncated content for search indexing
    const summary = computed(() => {
      const text = content.get();
      if (!text || text.trim() === "") return "";
      const cleaned = text.trim();
      if (cleaned.length <= 200) return cleaned;
      const truncated = cleaned.slice(0, 200);
      const lastSpace = truncated.lastIndexOf(" ");
      return lastSpace > 150
        ? truncated.slice(0, lastSpace) + "..."
        : truncated + "...";
    });

    // ===== Actions =====

    const handlePieceLinkClick = action(
      ({ detail }: { detail: { piece: Writable<MentionablePiece> } }) =>
        navigateTo(detail.piece),
    );

    const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));
    const closeMenu = action(() => menuOpen.set(false));

    const startEditingTitle = action(() => isEditingTitle.set(true));
    const stopEditingTitle = action(() => isEditingTitle.set(false));

    const handleTitleKeydown = action((event: { key?: string }) => {
      if (event?.key === "Enter") {
        isEditingTitle.set(false);
      }
    });

    const goToParent = action(() => {
      const p = parentNotebook.get();
      if (p) navigateTo(p);
    });

    const goToViewer = action(() => {
      return navigateTo(
        NoteMd({
          note: {
            title,
            content,
            backlinks,
          },
          sourceNoteRef: self as NotePiece,
          content,
          references: references!,
        }),
      );
    });

    // Create new note action - closes over the registry and parentNotebook
    const createNewNote = action(() => {
      const notebook = parentNotebook.get();

      if (notebook) {
        notebook.createNote.send({
          title: "New Note",
          content: "",
          navigate: true,
        });
      } else {
        const note = Note({
          title: "New Note",
          content: "",
          isHidden: !!notebook,
          parentNotebook: notebook,
        });
        pieceRegistry.push(note as any);
        return navigateTo(note);
      }
    });

    const menuAllNotebooks = action(() => {
      menuOpen.set(false);
      if (allNotesPiece) {
        return navigateTo(allNotesPiece);
      }
    });

    // Exported stream for external content editing
    const editContent = action(
      (rawInput: { detail: { value: string } }) => {
        // Single widening cast to allow runtime validation of unexpected shapes
        const loose = rawInput as { detail?: { value?: unknown } };
        const value = loose?.detail?.value;
        if (typeof value !== "string") {
          console.error(
            `editContent: invalid input shape. ` +
              `Expected { detail: { value: string } }, ` +
              debugStr`got: $quote,long${rawInput}`,
          );
          return;
        }
        content.set(value);
      },
    );

    // Exported stream for external title editing
    const setTitle = action((newTitle: string) => {
      title.set(newTitle);
    });

    // Append a wiki-link to another piece at the end of the note content
    const appendLink = action(
      ({ piece }: { piece: Writable<MentionablePiece> }) => {
        const name = piece.get()[NAME] ?? "";
        const resolved = (piece as any).resolveAsCell();
        // Derive the embed id from the scheme-PRESERVING sourceURI (the bare
        // entityId would silently alias a computed: cell to its of: sibling)
        // and let bareMentionId enforce the embed contract.
        const uri: string | undefined = resolved?.sourceURI;
        const entityId = uri ? bareMentionId(uri) : undefined;
        if (!name || !entityId) return;

        const link = `[[${name} (${entityId})]]`;
        const current = content.get();
        content.set(current ? `${current}\n${link}` : link);

        mentioned.push(piece);
      },
    );

    // LAZY: Only compute which notebooks contain this note when menu is open
    const containingNotebooks = computed(() => {
      if (!menuOpen.get()) return [];

      const result: NotebookPiece[] = [];
      for (const nb of notebooks) {
        for (const n of nb?.notes ?? []) {
          if (equals(n, self)) {
            result.push(nb);
            break;
          }
        }
      }
      return result;
    });

    // Link pattern for wiki-links
    const patternJson = computed(() => {
      const lpValue = (linkPattern as any)?.get?.() ?? linkPattern;
      const custom = typeof lpValue === "string" ? lpValue.trim() : "";
      return custom || JSON.stringify(Note);
    });

    // ===== Pre-computed UI values =====

    // Parent notebook display state - read from input prop
    const hasParentNotebook = computed(() => !!parentNotebook.get());
    const parentNotebookLabel = computed(() => {
      const p = parentNotebook.get();
      return p?.[NAME] ?? p?.title ?? "Notebook";
    });

    // Menu display states
    const menuDisplayStyle = computed(() => menuOpen.get() ? "flex" : "none");
    const allNotesDividerDisplay = computed(() =>
      allNotesPiece ? "block" : "none"
    );
    const allNotesButtonDisplay = computed(() =>
      allNotesPiece ? "flex" : "none"
    );

    // Title editing display states
    const titleDisplayStyle = computed(() =>
      isEditingTitle.get() ? "none" : "flex"
    );
    const titleInputDisplayStyle = computed(() =>
      isEditingTitle.get() ? "flex" : "none"
    );

    // ===== Filesystem projection =====

    // The definitions a projected file carries, in key order so the block is
    // stable across projections rather than reordering under the reader.
    const projectedDefinitions = computed(() => {
      const addresses = referenceAddresses(references);
      return Object.keys(addresses).sort().map((key) => ({
        key,
        address: addresses[key],
      }));
    });

    // The projection is a computed, which is what makes it read-only: the
    // filesystem bridge writes a whole edited body back to `$FS.content`, and
    // a note that accepted that would take its own generated definitions in
    // as note text. An edit arrives through `editProjection` instead.
    const projectedContent = computed(() =>
      attachDefinitions(content.get() ?? "", projectedDefinitions)
    );

    // A body handed to `editProjection` waits here while its definitions
    // resolve. `null` is what "nothing staged" means — an empty string is a
    // note someone cleared through the filesystem, which is an edit like any
    // other and has to be applied rather than read as an absent one.
    const pendingEdit = new Writable<string | null>(null);

    // Every address the staged body defines, in the order it defines them, so
    // the resolutions below line up with it.
    const pendingAddresses = computed(() => {
      const body = pendingEdit.get();
      if (body === null) return [] as string[];
      return splitDefinitions(body).definitions.map((d) => d.address);
    });

    // One resolution per address. `cellFromUrl` returns no cell for an
    // address that names no piece, which is how an ordinary reference link
    // stays an ordinary reference link.
    const pendingResolutions = pendingAddresses.map((address) =>
      cellFromUrl({ url: address })
    );

    // Apply the staged edit once every address has an answer. Writing from a
    // computed is what lets the result of a resolution land in the cells that
    // hold it; the guard on `pendingEdit` is what stops it running again.
    computed(() => {
      const body = pendingEdit.get();
      if (body === null) return;

      const split = splitDefinitions(body);
      const resolutions = pendingResolutions;
      // Read once, before anything is written: these are the addresses the
      // map held when the edit arrived, and what a definition is compared
      // against to decide whether it has been repointed.
      const before = referenceAddresses(references);
      // An empty array passes `some`, and "not resolved yet" looks exactly
      // like "nothing to resolve" through it. The count is what tells them
      // apart, and applying the edit early would drop every mention in it.
      if (resolutions.length !== split.definitions.length) return;
      if (resolutions.some((r) => r?.pending !== false)) return;
      const previous = references?.get() ?? {};
      const kept: { key: string; address: string }[] = [];
      const next: Record<string, unknown> = {};

      split.definitions.forEach((definition, index) => {
        const destination = resolutions[index]?.cell;
        if (!destination) {
          // Not a piece, so not a mention: the definition stays in the text.
          kept.push(definition);
          return;
        }
        // A key whose destination is unchanged keeps whatever the user
        // decided about its label; one that has been repointed starts over,
        // so the label follows the piece it now names.
        const entry = (previous as MentionRefMap)[definition.key];
        const unchanged = entry !== undefined &&
          before[definition.key] === definition.address;
        next[definition.key] = {
          destination,
          modifiedTitle: unchanged ? entry.modifiedTitle : false,
        };
      });

      content.set(attachDefinitions(split.content, kept));
      references?.set(next as MentionRefMap);
      pendingEdit.set(null);
    });

    /**
     * Take an edited projection. The body arrives whole, as the filesystem
     * hands it over; what it defines is read back as this note's mentions.
     */
    const editProjection = action((event: { body: string }) => {
      pendingEdit.set(event.body ?? "");
    });

    // ===== Shared UI Styles =====

    const headerButtonStyle = {
      alignItems: "center",
      padding: "6px 12px",
      fontSize: "14px",
      borderRadius: "8px",
    };

    // ===== UI =====

    const editorUI = (
      <cf-code-editor
        $value={content}
        $mentionable={mentionable!}
        $mentioned={mentioned}
        $references={references!}
        $pattern={patternJson}
        onbacklink-click={handlePieceLinkClick}
        onbacklink-create={handleNewBacklink({
          mentionable: mentionable!,
          pieceRegistry,
        })}
        language="text/markdown"
        mode="prose"
        wordWrap
        tabIndent
        placeholder="Start writing..."
      />
    );

    return {
      [NAME]: computed(() => `📝 ${title.get()}`),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content: projectedContent,
      },
      [UI]: (
        <cf-screen>
          <cf-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            {/* Parent notebook chip */}
            <cf-hstack
              gap="2"
              align="center"
              style={{
                display: computed(() => hasParentNotebook ? "flex" : "none"),
                marginBottom: "4px",
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
                oncf-click={goToParent}
              />
            </cf-hstack>

            <cf-hstack gap="3" style={{ alignItems: "center" }}>
              {/* Editable Title - click to edit */}
              <div
                style={{
                  display: titleDisplayStyle,
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  flex: 1,
                }}
                onClick={startEditingTitle}
              >
                <span
                  style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                >
                  {title}
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
                  placeholder="Note title..."
                  style={{ flex: 1 }}
                  oncf-blur={stopEditingTitle}
                  oncf-keydown={handleTitleKeydown}
                />
              </div>

              {/* View Mode button */}
              <cf-button
                variant="ghost"
                onClick={goToViewer}
                style={headerButtonStyle}
                title="View as markdown"
              >
                View
              </cf-button>

              {/* New Note button */}
              <cf-button
                variant="ghost"
                onClick={createNewNote}
                style={{ ...headerButtonStyle, gap: "4px" }}
                title="Create new note"
              >
                📝 New
              </cf-button>

              <cf-button
                variant="ghost"
                onClick={toggleMenu}
                style={{ ...headerButtonStyle, padding: "8px 16px" }}
              >
                Notebooks ▾
              </cf-button>

              {/* Backdrop to close menu */}
              <div
                onClick={closeMenu}
                style={{
                  display: computed(() => menuOpen.get() ? "block" : "none"),
                  position: "fixed",
                  inset: "0",
                  zIndex: "999",
                }}
              />

              {/* Dropdown Menu */}
              <cf-vstack
                gap="0"
                style={{
                  display: menuDisplayStyle,
                  position: "fixed",
                  top: "112px",
                  right: "16px",
                  background: "var(--cf-theme-color-background, white)",
                  border: "1px solid var(--cf-theme-color-border, #e5e5e7)",
                  borderRadius: "12px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  minWidth: "180px",
                  zIndex: "1000",
                  padding: "4px",
                }}
              >
                {notebooks.map((notebook) => (
                  <cf-button
                    variant="ghost"
                    onClick={menuGoToNotebook({ menuOpen, notebook })}
                    style={{ justifyContent: "flex-start" }}
                  >
                    {"  "}
                    {notebook?.[NAME] ?? "Untitled"}
                    {computed(() => {
                      return containingNotebooks
                          .find((nb) => equals(nb, notebook))
                        ? " ✓"
                        : "";
                    })}
                  </cf-button>
                ))}

                {/* Divider + All Notes - only show if All Notes piece exists */}
                <div
                  style={{
                    display: allNotesDividerDisplay,
                    height: "1px",
                    background: "var(--cf-theme-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />

                <cf-button
                  variant="ghost"
                  onClick={menuAllNotebooks}
                  style={{
                    display: allNotesButtonDisplay,
                    justifyContent: "flex-start",
                  }}
                >
                  {"  "}📁 All Notes
                </cf-button>
              </cf-vstack>
            </cf-hstack>
          </cf-vstack>

          {editorUI}

          <cf-hstack slot="footer">
            {backlinks?.map((piece) => (
              <cf-button onClick={handleBacklinkClick({ piece })}>
                {piece?.[NAME]}
              </cf-button>
            ))}
          </cf-hstack>
        </cf-screen>
      ),
      title,
      content,
      summary,
      mentioned,
      backlinks,
      references: references!,
      isHidden,
      parentNotebook,
      grep: patternTool(grepPattern, { content }),
      translate: patternTool(translatePattern, { content }),
      editContent,
      editProjection,
      setTitle,
      appendLink,
      createNewNote,
      [TILE_UI]: editorUI,
      // Test-accessible state
      menuOpen,
      isEditingTitle,
      // Test-accessible action streams
      toggleMenu,
      closeMenu,
      startEditingTitle,
      stopEditingTitle,
    };
  },
);

export default Note;
