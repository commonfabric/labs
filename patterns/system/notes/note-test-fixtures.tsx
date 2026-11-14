// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Pieces the notes tests list in the space so that the notes patterns' wishes
 * find them, and a handler that stands in for the backlinks index.
 */
import { type Default, handler, NAME, pattern, Writable } from "commonfabric";
import type { MentionablePiece, NotePiece } from "./schemas.tsx";

/**
 * A collection of notes that a `#notebook` wish finds by its name. A notebook
 * made in a test is not found that way: the wish matches a piece by the tag
 * its schema carries, and a link the test lists carries none.
 */
export const Shelf = pattern<
  { notes?: Writable<NotePiece[] | Default<[]>> },
  { [NAME]: string; notes: NotePiece[]; isNotebook: boolean }
>(({ notes }) => ({ [NAME]: "Notebook", notes, isNotebook: true }));

/** A piece named `name`, for a wish that finds a piece by its name. */
export const NamedPiece = pattern<{ name: string }, { [NAME]: string }>((
  { name },
) => ({ [NAME]: name }));

/** Writes a backlink into a piece's `backlinks`, as the backlinks index does. */
export const addBacklink = handler<
  void,
  {
    target: Writable<{ backlinks: MentionablePiece[] }>;
    source: Writable<MentionablePiece>;
  }
>((_, { target, source }) => {
  target.key("backlinks").push(source);
});
