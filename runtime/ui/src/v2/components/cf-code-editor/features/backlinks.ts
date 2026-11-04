import { EditorState, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/**
 * Represents a parsed backlink with position and content info
 */
export interface BacklinkInfo {
  from: number; // Start of [[
  to: number; // End of ]]
  nameFrom: number; // Start of name (after [[)
  nameTo: number; // End of name (before " (id)" or "]]")
  id: string; // The piece ID (empty string if incomplete)
  name: string; // The display name text
}

/**
 * Parse all backlinks from a document string
 */
export function parseBacklinks(doc: string): BacklinkInfo[] {
  const backlinks: BacklinkInfo[] = [];
  const backlinkRegex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = backlinkRegex.exec(doc)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    const innerText = match[1];

    // Parse: check if has ID in format "Name (id)"
    const idMatch = innerText.match(/^(.+?)\s+\(([^)]+)\)$/);
    const hasId = idMatch !== null;
    const name = hasId ? idMatch[1] : innerText;
    const id = hasId ? idMatch[2] : "";

    const nameFrom = from + 2; // After [[
    const nameTo = nameFrom + name.length;

    backlinks.push({ from, to, nameFrom, nameTo, id, name });
  }

  return backlinks;
}

/**
 * StateField to track all backlink positions in the document.
 * Updated whenever the document changes.
 */
export const backlinkField = StateField.define<BacklinkInfo[]>({
  create(state) {
    return parseBacklinks(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return parseBacklinks(tr.newDoc.toString());
  },
});

/**
 * Create atomic ranges that make cursor skip over [[ and (id)]] portions.
 * This prevents the cursor from entering the ID area during navigation.
 * Note: We must ensure ranges don't span line breaks.
 */
export const atomicBacklinkRanges = EditorView.atomicRanges.of((view) => {
  const backlinks = view.state.field(backlinkField);
  const doc = view.state.doc;
  const decorations: Range<Decoration>[] = [];

  for (const bl of backlinks) {
    if (!bl.id) continue; // Only protect complete backlinks with IDs

    // Safety: ensure the backlink is on a single line
    const startLine = doc.lineAt(bl.from).number;
    const endLine = doc.lineAt(bl.to).number;
    if (startLine !== endLine) continue; // Skip multi-line backlinks

    // Make [[ atomic (cursor skips from before [[ to after [[)
    if (bl.from < bl.nameFrom) {
      decorations.push(Decoration.mark({}).range(bl.from, bl.nameFrom));
    }

    // Make " (id)]]" atomic (cursor skips from end of name to after ]])
    if (bl.nameTo < bl.to) {
      decorations.push(Decoration.mark({}).range(bl.nameTo, bl.to));
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations);
});

/**
 * Transaction filter to prevent edits from corrupting the ID portion of backlinks.
 * - Blocks edits that start within the ID portion
 * - Truncates edits that span from name into ID
 * - Allows full backlink deletions
 */
export const backlinkEditFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;

  const backlinks = tr.startState.field(backlinkField);
  if (backlinks.length === 0) return tr;

  let needsModification = false;

  // Check each change to see if it affects any backlink's protected area
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    for (const bl of backlinks) {
      if (!bl.id) continue; // Only protect complete backlinks

      // Case: Edit starts in the ID portion " (id)]]" - block it
      if (fromA > bl.nameTo && fromA < bl.to) {
        needsModification = true;
        return;
      }

      // Case: Edit spans from name into ID - needs truncation
      if (fromA <= bl.nameTo && toA > bl.nameTo && toA < bl.to) {
        needsModification = true;
        return;
      }
    }
  });

  // If we detected a problematic edit, we need to filter/modify the transaction
  // For now, we'll rely on atomicRanges to prevent cursor entry,
  // and handle edge cases like paste operations here
  if (needsModification) {
    // Build a modified changes array that respects backlink boundaries
    const specs: { from: number; to: number; insert: string }[] = [];

    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const adjustedFrom = fromA;
      let adjustedTo = toA;
      let shouldInclude = true;

      for (const bl of backlinks) {
        if (!bl.id) continue;

        // Block edits that start in ID area
        if (fromA > bl.nameTo && fromA < bl.to) {
          shouldInclude = false;
          break;
        }

        // Truncate edits that span into ID area
        if (fromA <= bl.nameTo && toA > bl.nameTo && toA < bl.to) {
          adjustedTo = bl.nameTo;
        }
      }

      if (shouldInclude) {
        specs.push({
          from: adjustedFrom,
          to: adjustedTo,
          insert: inserted.toString(),
        });
      }
    });

    // Return the modified transaction whenever any change was blocked or
    // truncated (blocked covers ID-start edits; the truncation path only sets
    // adjustedTo, so we always need to return specs when needsModification).
    return {
      changes: specs,
      selection: tr.selection,
      effects: tr.effects,
    };
  }

  return tr;
});

/**
 * Create a plugin to decorate backlinks with focus-aware styling.
 * - When cursor is outside: show as collapsed pill (hide brackets and ID)
 * - When cursor is adjacent/inside: show [[Name]] with visible brackets (ID never visible)
 * - Incomplete backlinks show as pending pills or [[text]] when editing
 *
 * The piece ID is never shown to the user - it's stored in the document
 * as [[Name (id)]] but displayed as [[Name]] when editing or just Name when collapsed.
 */
export function createBacklinkDecorationPlugin() {
  const editingMark = Decoration.mark({ class: "cm-backlink-editing" });
  const pillMark = Decoration.mark({ class: "cm-backlink-pill" });
  const pendingMark = Decoration.mark({ class: "cm-backlink-pending" });
  const hiddenReplace = Decoration.replace({});

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.getBacklinkDecorations(view);
      }

      update(update: ViewUpdate) {
        // Update on doc changes, viewport changes, selection changes, OR focus changes
        if (
          update.docChanged || update.viewportChanged ||
          update.selectionSet || update.focusChanged
        ) {
          this.decorations = this.getBacklinkDecorations(update.view);
        }
      }

      getBacklinkDecorations(view: EditorView) {
        const decorations: Range<Decoration>[] = [];
        const doc = view.state.doc;
        const hasFocus = view.hasFocus;
        const cursorPos = view.state.selection.main.head;
        const selectionFrom = view.state.selection.main.from;
        const selectionTo = view.state.selection.main.to;

        // Use the StateField for backlink positions
        const backlinks = view.state.field(backlinkField);

        for (const bl of backlinks) {
          const { from: start, to: end, nameFrom, nameTo, id } = bl;
          const hasId = id !== "";

          // Safety: skip backlinks that span multiple lines (would cause decoration errors)
          const startLine = doc.lineAt(start).number;
          const endLine = doc.lineAt(end).number;
          if (startLine !== endLine) continue;

          // Check if cursor is anywhere within the backlink (including hidden areas)
          // This ensures editing mode triggers when cursor is adjacent to visible pill
          const cursorInBacklink = hasFocus && cursorPos >= start &&
            cursorPos <= end;
          // Check if selection overlaps with the entire backlink
          const selectionOverlaps = hasFocus && selectionFrom < end &&
            selectionTo > start;

          if (hasId && (cursorInBacklink || selectionOverlaps)) {
            // EDITING MODE: Show plain [[Name]] text, hide only the " (id)" portion
            // The closing ]] stays visible so user sees [[Name]]
            // Safety check: only hide if there's actually content between nameTo and end-2
            const idStart = nameTo;
            const idEnd = end - 2; // Position before ]]
            if (idEnd > idStart) {
              decorations.push(hiddenReplace.range(idStart, idEnd)); // Hide " (id)"
            }
          } else if (!hasId) {
            // Incomplete backlink - show as pending pill or full text when editing
            const cursorInside = hasFocus && cursorPos >= start &&
              cursorPos <= end;
            if (cursorInside || selectionOverlaps) {
              // Cursor inside or adjacent - show full [[mention]] with editing style
              decorations.push(editingMark.range(start, end));
            } else {
              // Cursor away - show as pending pill
              decorations.push(hiddenReplace.range(start, start + 2)); // Hide [[
              decorations.push(pendingMark.range(start + 2, end - 2)); // Style inner text
              decorations.push(hiddenReplace.range(end - 2, end)); // Hide ]]
            }
          } else {
            // Complete backlink, cursor outside - show as navigable pill
            decorations.push(hiddenReplace.range(start, start + 2)); // Hide [[
            decorations.push(pillMark.range(nameFrom, nameTo)); // Style name only
            decorations.push(hiddenReplace.range(nameTo, end)); // Hide (id)]]
          }
        }

        // Sort decorations by position (required by CodeMirror)
        decorations.sort((a, b) => a.from - b.from || a.to - b.to);

        return Decoration.set(decorations);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
