/**
 * Fixture for the verb-result walkthrough (`verbs-over-the-cli.sh`, documented
 * in `docs/common/verbs/over-the-cli.md`).
 *
 * It exists so the walkthrough owns its subject: the shipped patterns are used
 * elsewhere, and a change to one of them should never break a demonstration of
 * how the CLI verb surface works. Nothing else deploys this file.
 *
 * Between them the verbs cover every result shape a caller can meet:
 *
 * - `createNote` returns the child piece it created — the reference result,
 *   which reaches a caller on any runtime because a return carrying cells
 *   travels the result-pattern projection path.
 * - `setLabel` returns a plain record of what it wrote, which rides the
 *   `plainResultReceipts` option.
 * - `touch` declares nothing and stays the value-less shape.
 * - Every mutating verb throws on an unusable payload, so the walkthrough can
 *   show that a refusal does not spend the caller's invocation id.
 */

import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

/** One note. Deliberately small: this fixture is about what a verb hands back,
 * not about modeling notes. */
export interface NoteOutput {
  [NAME]: string;
  title: string;
  body: string;

  /** Bumped by `append`, so a caller can tell a write happened. */
  revision: number;

  /** Append a line to the body. */
  append: Stream<AppendEvent, AppendResult>;
}

interface NoteInput {
  title?: Writable<string | Default<"">>;
  body?: Writable<string | Default<"">>;
  revision?: Writable<number | Default<0>>;
}

interface AppendEvent {
  text: string;
}

interface AppendResult {
  /** The body as persisted, so a caller can confirm the append landed. */
  body: string;
}

/** One note, deployed as a child of the board below. It carries a verb of its
 * own so the walkthrough can do the thing a reference result exists for: take
 * the piece a create handed back, resolve its address with `--show-links`, and
 * call it. */
export const Note = pattern<NoteInput, NoteOutput>(
  ({ title, body, revision }) => {
    const append = action<AppendEvent, AppendResult>((event) => {
      const addition = (event.text ?? "").trim();
      if (!addition) throw new Error("append: text must be non-empty");
      const next = [(body.get() ?? "").trim(), addition]
        .filter((part) => part.length > 0)
        .join("\n");
      body.set(next);
      revision.set((revision.get() ?? 0) + 1);
      return { body: next };
    });

    return {
      [NAME]: title,
      title,
      body,
      revision,
      append,
    };
  },
);

interface CreateNoteEvent {
  title: string;
  body?: string;
}

interface CreateNoteResult {
  /** The note this call created — the piece itself, not a minted identifier.
   * It reaches the caller as a link the CLI can render as an address. */
  note: NoteOutput;
}

interface SetLabelEvent {
  label: string;
}

interface SetLabelResult {
  /** The label as persisted — verbatim, so a caller can confirm the round
   * trip rather than assuming it. */
  label: string;

  /** The revision this write produced. A caller cannot compute it: it depends
   * on what was already stored. */
  revision: number;
}

interface BoardInput {
  notes?: Writable<NoteOutput[] | Default<[]>>;
  label?: Writable<string | Default<"untitled">>;
  revision?: Writable<number | Default<0>>;
}

interface BoardOutput {
  [NAME]: string;
  notes: NoteOutput[];
  noteCount: number;
  label: string;
  revision: number;
  createNote: Stream<CreateNoteEvent, CreateNoteResult>;
  setLabel: Stream<SetLabelEvent, SetLabelResult>;
  touch: Stream<void>;
}

export default pattern<BoardInput, BoardOutput>(
  ({ notes, label, revision }) => {
    const createNote = action<CreateNoteEvent, CreateNoteResult>((event) => {
      const trimmed = (event.title ?? "").trim();
      if (!trimmed) throw new Error("createNote: title must be non-empty");
      const note = Note({
        title: trimmed,
        body: event.body ?? "",
        revision: 0,
      });
      notes.push(note);
      return { note };
    });

    const setLabel = action<SetLabelEvent, SetLabelResult>((event) => {
      const trimmed = (event.label ?? "").trim();
      if (!trimmed) throw new Error("setLabel: label must be non-empty");
      const next = (revision.get() ?? 0) + 1;
      label.set(trimmed);
      revision.set(next);
      return { label: trimmed, revision: next };
    });

    // A value-less verb beside the others: its receipt stays the empty witness
    // whatever the plainResultReceipts option says.
    const touch = action(() => {
      notes.get();
    });

    return {
      [NAME]: "Verb result fixture",
      notes,
      noteCount: computed(() => (notes.get() ?? []).length),
      label,
      revision,
      createNote,
      setLabel,
      touch,
    };
  },
);
