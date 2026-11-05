/**
 * Fixture pattern: a list of notes that only `add` writes, through a reviewed
 * action, and a `pick` stream whose event carries a link to one note.
 */

import {
  type Cell,
  handler,
  pattern,
  type Stream,
  type TrustedActionWrite,
  type Writable,
} from "commonfabric";

export const SURFACE = "NoteSurface";
export const ADD = "AddNote";

/** One note, as a handler reads it. */
export interface NoteRecord {
  text: string;
}

/** A stored note, which only `add` writes. */
export type StoredNote = TrustedActionWrite<
  NoteRecord,
  typeof add,
  typeof ADD,
  typeof SURFACE
>;

/**
 * What `add` is bound to. An interface rather than a type literal, which would
 * make `add`'s type depend on itself through `StoredNote`.
 */
interface NotesState {
  notes: Writable<StoredNote[]>;
}

const add = handler<{ text: string }, NotesState>((event, { notes }) => {
  notes.push({ text: event.text });
});

const pick = handler<{ note: Cell<NoteRecord> }, { picked: Writable<string> }>(
  (event, { picked }) => {
    picked.set(event.note.get().text);
  },
);

export default pattern<
  { notes: Writable<StoredNote[]>; picked: Writable<string> },
  {
    notes: Writable<StoredNote[]>;
    add: Stream<{ text: string }>;
    pick: Stream<{ note: Cell<NoteRecord> }>;
    picked: string;
  }
>(({ notes, picked }) => ({
  notes,
  add: add({ notes }),
  pick: pick({ picked }),
  picked,
}));
