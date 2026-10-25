/**
 * Shared types for the Notes pattern family.
 *
 * This file contains types shared across note.tsx, notebook.tsx, and note-md.tsx.
 */

import { type Default, NAME, type Stream, type Writable } from "commonfabric";

// ===== Core Entity Types =====
//
// IMPORTANT: Do NOT add [UI] to these entity types. Including [UI] in types
// that are used as references (e.g. in arrays, backlinks, mentioned lists)
// causes the runtime to deeply traverse and instantiate UI trees for every
// referenced piece, making everything extremely slow. Only pattern Output
// interfaces should declare [UI]. See NoteOutput, NotebookOutput, etc.

/**
 * A piece that can be mentioned via [[wiki-links]] and appear in backlinks.
 * Used for the bidirectional linking system.
 */
export interface MentionablePiece {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
}

/**
 * Minimal piece reference - just needs a name for display.
 * Used when we only need to identify/display a piece.
 */
export interface MinimalPiece {
  [NAME]?: string;
}

/**
 * A note's core data shape (without reactive wrappers).
 * Used for type-safe access to note properties.
 */
export interface NotePiece {
  [NAME]?: string;
  title?: string;
  content?: string;
  summary?: string;
  isHidden?: boolean;
  backlinks?: MentionablePiece[];
  parentNotebook?: NotebookPiece | null;
  setTitle?: Stream<string>;
}

/**
 * A notebook's core data shape (without reactive wrappers).
 */
export interface NotebookPiece {
  [NAME]?: string;
  title?: string;
  notes?: NotePiece[];
  backlinks?: MentionablePiece[];
  isNotebook?: boolean;
  isHidden?: boolean;

  createNote: Stream<{ title: string; content: string; navigate?: boolean }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<string>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
}

/**
 * A notebook cell with writable notes array.
 * Used when we need to add notes to a notebook accessed via cell operations.
 */
export interface NotebookCell {
  [NAME]?: string;
  title?: string;
  notes: Writable<NotePiece[]>;
  isNotebook?: boolean;
  isHidden?: boolean;
}

/**
 * A daily journal's core data shape.
 */
export interface DailyJournalPiece {
  [NAME]?: string;
  title?: string;
  entries?: NotePiece[];
  isJournal?: boolean;
  isHidden?: boolean;
}

// ===== Input Types =====

export interface NoteInput {
  title?: Writable<string | Default<"Untitled Note">>;
  content?: Writable<string | Default<"">>;
  isHidden?: boolean | Default<false>;

  /** Pattern JSON for [[wiki-links]]. Defaults to creating new Notes. */
  linkPattern?: Writable<string | Default<"">>;

  /** Parent notebook reference. Set at creation, can be updated for moves. */
  parentNotebook?: Writable<NotebookPiece | null | Default<null>>;

  /**
   * The note's mentions in reference form. Stored beside `content` because it
   * has to stay in lockstep with it: the text carries keys, and this is what
   * says where they point.
   *
   * The default has to be the same one `NoteOutput` declares. A map published
   * in the result under a different default than its input carries cannot be
   * materialized, and a consumer that captures the note then gets `undefined`
   * for the whole capture — which stops any action bound to it from running,
   * rather than merely leaving this field empty.
   */
  // `{}` is the default VALUE here, in the same spirit as `Default<"">` and
  // `Default<[]>` elsewhere in this file, and its permissiveness as a type is
  // exactly what is wanted: `Record<PropertyKey, never>` would say the map may
  // hold no entries, and a populated one then fails to materialize.
  // deno-lint-ignore ban-types
  references?: Writable<MentionRefMap | Default<{}>>;
}

export interface NotebookInput {
  title?: Writable<string | Default<"Notebook">>;
  notes?: Writable<NotePiece[] | Default<[]>>;
  isNotebook?: boolean | Default<true>;
  isHidden?: boolean | Default<false>;

  /** Parent notebook reference. Set at creation, can be updated for moves. */
  parentNotebook?: Writable<NotebookPiece | null | Default<null>>;
}

/**
 * One mention in reference form: where it points, and whether the label
 * carrying it in the text is the user's own wording rather than the
 * destination's name.
 *
 * `destination` is typed `unknown` because a mention may address any piece.
 * A read of it stops at the reference for that reason, carrying none of the
 * piece's fields, which is why an address is taken from the path to it
 * instead — the path survives where the value does not. The editor writes the same field under a schema that reads
 * it back as a cell (`asCell`,
 * `packages/ui/src/v2/core/mention-refs.ts`): one stored link, read the way
 * each side needs it.
 */
export interface MentionRef {
  destination: unknown;
  modifiedTitle: boolean;
}

/**
 * A note's mentions, keyed by the token that appears in its text. The keys are
 * local to one note and mean nothing anywhere else.
 */
export type MentionRefMap = Record<string, MentionRef>;

export interface NoteMdInput {
  /** Cell reference to note data (title + content + backlinks) */
  note?: NotePiece | Default<{ title: ""; content: ""; backlinks: [] }>;

  /** Direct reference to source note for Edit navigation */
  sourceNoteRef?: NotePiece;

  /** Writable content cell for checkbox updates */
  content?: Writable<string>;

  /** The note's mentions, for resolving `[Label][key]` in its content */
  references?: Writable<MentionRefMap>;
}

// ===== Utility Functions =====

/**
 * Simple random ID generator.
 * Note: crypto.randomUUID is not available in the pattern environment.
 */
export const generateId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

/**
 * Get a comparable name from a piece.
 * Handles both local pieces (title) and wish("#default") pieces ([NAME]).
 */
export const getPieceName = (
  piece?: { [NAME]?: string; title?: string },
): string => {
  return piece?.[NAME] ?? piece?.title ?? "";
};
