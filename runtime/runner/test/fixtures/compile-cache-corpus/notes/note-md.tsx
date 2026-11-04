import {
  action,
  computed,
  equals,
  handler,
  NAME,
  navigateTo,
  pattern,
  type Stream,
  TILE_UI,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  type MentionablePiece,
  type NoteMdInput,
  type NotePiece,
} from "./schemas.tsx";
import { referenceAddresses } from "./reference-address.ts";

// Handler for clicking a backlink chip - module scope required for .map() binding
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>((_, { piece }) => navigateTo(piece));

// ===== Output Type =====

export interface NoteMdOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Passthrough note reference */
  note: NotePiece;

  /** Hidden from default-app piece list */
  isHidden: true;

  /** Excluded from mentions autocomplete (notes in notebooks may be hidden but still mentionable) */
  isMentionable: false;

  /** Tile variant (CT-1764): minimal embedded UI for `<cf-render variant="tile">`. */
  [TILE_UI]: VNode;

  /** Processed content with wiki-links converted to markdown links */
  processedContent: string;

  /** Stream to toggle checkboxes in content */
  checkboxToggle: Stream<{ detail: { index: number; checked: boolean } }>;

  /** Whether backlinks section should be visible */
  hasBacklinks: boolean;

  /** Stream to navigate back to source note for editing */
  goToEdit: Stream<void>;
}

export default pattern<NoteMdInput, NoteMdOutput>(
  ({ note, sourceNoteRef, content, references }) => {
    const displayName = computed(() => {
      const title = note?.title || "Untitled";
      return `📖 ${title}`;
    });

    const hasBacklinks = computed(() => (note?.backlinks?.length ?? 0) > 0);

    // Convert both mention forms to markdown links, which cf-markdown then
    // turns into clickable cf-cell-link components. Use the content prop if
    // provided, otherwise fall back to note.content.
    //
    // A wiki-link's embedded id is the BARE tagged hash by contract: the
    // editor strips `of:` at embed time (mentionIdFromCellId in packages/ui)
    // and REJECTS `computed:` ids, so prepending `/of:` is always correct for
    // that form. A reference's destination carries its own scheme, so that
    // form reads the address off the destination instead.
    const processedContent = computed(() => {
      const raw = content?.get?.() ?? note?.content ?? "";
      const withWikiLinks = raw.replace(
        /\[\[([^\]]*?)\s*\(([^)]+)\)\]\]/g,
        (_match, name, id) => `[${name.trim()}](/of:${id})`,
      );
      const addresses = referenceAddresses(references);

      // Match `[Label][key]`, the reference form. The key shape matches what
      // the editor mints (`mintRefKey`, `packages/ui/src/v2/core/mention-refs.ts`);
      // a pattern cannot import from the UI package, so the two are held in
      // step by hand. The literal is built here rather than at module scope,
      // where a stateful RegExp is not allowed.
      //
      // A key with no address is left exactly as written. It may be a
      // hand-written reference link, or a mention pasted out of a note whose
      // map is elsewhere; either way the label survives and the reader sees
      // what the author typed rather than a link to nothing.
      return withWikiLinks.replace(
        /\[([^\]\n]*)\]\[([0-9a-z]{6,10})\]/g,
        (match: string, label: string, key: string) =>
          addresses[key] ? `[${label}](${addresses[key]})` : match,
      );
    });

    // Type-based discovery for notes via mentionable list
    const noteWish = wish<NotePiece>({
      query: "#note",
      scope: ["."],
      headless: true,
    });

    // Use sourceNoteRef directly if provided, otherwise fall back to equality lookup
    const sourceNote = computed(() => {
      if (sourceNoteRef) {
        return sourceNoteRef;
      }
      if (!note) return null;
      return noteWish.candidates.find((piece) => equals(piece, note));
    });

    // Action: navigate back to source note for editing
    const goToEdit = action(() => {
      if (sourceNote) {
        return navigateTo(sourceNote);
      }
    });

    // Action: handle checkbox toggle in markdown content
    const handleCheckboxToggle = action(
      (event: { detail: { index: number; checked: boolean } }) => {
        if (!content) return;
        const currentContent = content.get();
        const { index, checked } = event.detail;

        // Find all checkbox patterns in the content
        const checkboxPattern = /- \[([ xX])\]/g;
        let match;
        let currentIndex = 0;
        let result = currentContent;

        checkboxPattern.lastIndex = 0;

        while ((match = checkboxPattern.exec(currentContent)) !== null) {
          if (currentIndex === index) {
            const newCheckbox = checked ? "- [x]" : "- [ ]";
            result = currentContent.slice(0, match.index) +
              newCheckbox +
              currentContent.slice(match.index + match[0].length);
            break;
          }
          currentIndex++;
        }

        if (result !== currentContent) {
          content.set(result);
        }
      },
    );

    // Scrollable content with markdown + backlinks (for print support)
    const markdownViewer = (
      <cf-vscroll flex showScrollbar fadeEdges>
        <div style={{ padding: "1rem", minHeight: "100%" }}>
          {/* Markdown content with wiki-links converted to clickable links */}
          <cf-markdown
            content={processedContent}
            oncf-checkbox-change={handleCheckboxToggle}
          />

          {/* Backlinks section - cf-chips at bottom */}
          <div
            style={{
              display: computed(() => (hasBacklinks ? "block" : "none")),
              marginTop: "2rem",
              paddingTop: "1rem",
              borderTop: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: "600",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--cf-colors-gray-500, #6b7280)",
                marginBottom: "0.5rem",
                display: "block",
              }}
            >
              Linked from:
            </span>
            <cf-hstack gap="2" wrap>
              {(note?.backlinks as MentionablePiece[] | undefined)?.map((
                piece,
              ) => (
                <cf-chip
                  label={piece?.[NAME] ?? "Untitled"}
                  interactive
                  oncf-click={handleBacklinkClick({ piece })}
                />
              ))}
            </cf-hstack>
          </div>
        </div>
      </cf-vscroll>
    );

    return {
      [NAME]: displayName,
      [UI]: (
        <cf-screen>
          <cf-hstack
            slot="header"
            padding="4"
            gap="3"
            align="center"
            style={{
              borderBottom: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            <cf-heading level={1} style={{ flex: "1" }}>
              {computed(() => note?.title || "Untitled Note")}
            </cf-heading>
            {/* Edit button - navigates back to source note for editing */}
            <cf-button
              color="neutral"
              variant="outline"
              size="sm"
              onClick={goToEdit}
            >
              Edit
            </cf-button>
          </cf-hstack>
          {markdownViewer}
        </cf-screen>
      ),
      note,
      isHidden: true,
      isMentionable: false,
      [TILE_UI]: markdownViewer,
      processedContent,
      checkboxToggle: handleCheckboxToggle,
      hasBacklinks,
      goToEdit,
    };
  },
);
