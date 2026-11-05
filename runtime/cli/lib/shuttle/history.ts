/**
 * The lines a run has typed, and the traversal `up` and `down` make over
 * them.
 *
 * It is the run's own memory and nothing outside the process holds it: a
 * shuttle that exits takes its lines with it. Persistent, searchable history
 * is a separate feature with a design of its own
 * (`docs/plans/shuttle/futures.md`), and nothing here is a step toward it —
 * what this holds is the lines you can still see the results of.
 *
 * A pure value like {@link EditBuffer}: it holds strings and reports them, so
 * it drives with no terminal, no keyboard and no clock behind it. What binds
 * a key to it is the prompt's table (`prompt.ts`).
 *
 * The traversal runs over the recorded lines *and the line being typed*,
 * which is one position past the last of them. That is one mechanism rather
 * than a mechanism plus a special case: the line you were writing when you
 * pressed `up` is held exactly as a recorded line you edit is held, so `down`
 * back past the newest line returns it without the draft being a thing of its
 * own.
 */

import type { EditBuffer } from "../view/editbuffer.ts";

/**
 * The lines one run typed, and where `up` and `down` currently stand among
 * them.
 *
 * Per instance rather than per process, for the reason `CurrentPlace` is
 * (`place.ts`): a run holding two prompts holds two sets of lines.
 */
export class LineHistory {
  /** The lines recorded, oldest first. */
  #lines: string[] = [];

  /**
   * The text left at a position the traversal moved off, by position.
   *
   * Position `#lines.length` is the line being typed, so the draft sits in
   * this map like any other edit and needs no field of its own.
   */
  #edits = new Map<number, string>();

  /** Where the traversal stands, `#lines.length` being the line being typed. */
  #at = 0;

  /**
   * Records `line` as a line this run typed, and returns the traversal to the
   * line being typed.
   *
   * Two lines are not recorded, and each is its own decision. A line that is
   * empty or all whitespace ran nothing, so recording it would put a position
   * with nothing on it between two lines that have something. And a line
   * identical to the one recorded last is not recorded twice, so `ls` pressed
   * three times is one position and `up` reaches the line before it in one
   * press. The comparison is against the last line alone: comparing against
   * every line would drop a line from the middle of the run and leave the
   * order no longer the order it was typed in.
   *
   * It is called where the line is taken rather than where it settles, which
   * is what makes `up` reach a line that is still running.
   */
  record(line: string): void {
    if (line.trim() !== "" && line !== this.#lines.at(-1)) {
      this.#lines.push(line);
    }
    this.abandon();
  }

  /**
   * Returns the traversal to the line being typed, dropping every edit,
   * without recording anything.
   *
   * This is what a line thrown away gets, and it is the same act recording
   * one ends with: the traversal and its edits belong to the line being
   * typed, so whatever ends that line ends them.
   */
  abandon(): void {
    this.#edits.clear();
    this.#at = this.#lines.length;
  }

  /**
   * The line `up` puts on the prompt, holding `current` at the position it
   * leaves, and nothing where there is no earlier line.
   *
   * Holding the current text is what lets a line be edited and come back
   * edited: the edit is kept against the position it was made at until the
   * line is ended, which is bash's default and the behavior a person who
   * types half a change and goes looking for the rest expects. What it never
   * does is change what was recorded — `up` twice and `down` twice reaches
   * the recorded line again only where nothing was typed in between, and the
   * recorded lines themselves are what a later run of the traversal walks.
   *
   * Nothing where there is nothing earlier, rather than the oldest line
   * again: a traversal that wrapped would put the newest line under `up` at
   * the oldest, which is a place a person arrives at by holding the key down.
   */
  earlier(current: string): string | undefined {
    if (this.#at === 0) return undefined;
    this.#edits.set(this.#at, current);
    this.#at -= 1;
    return this.#held(this.#at);
  }

  /**
   * The line `down` puts on the prompt, holding `current` at the position it
   * leaves, and nothing where the line being typed is already the position.
   */
  later(current: string): string | undefined {
    if (this.#at === this.#lines.length) return undefined;
    this.#edits.set(this.#at, current);
    this.#at += 1;
    return this.#held(this.#at);
  }

  /**
   * Helper for the two motions, which is what stands at position `at`: the
   * text left there where the traversal has been there, the recorded line
   * otherwise, and the empty string at the line being typed.
   */
  #held(at: number): string {
    return this.#edits.get(at) ?? this.#lines[at] ?? "";
  }
}

/**
 * Puts `line` on `buffer` with the cursor at its end, and leaves the buffer
 * alone where there is no line.
 *
 * The cursor lands at the end because a recalled line is one you are about to
 * add to or run: `ctrl-a` reaches its start in one key where a cursor left at
 * the start would need one key per character to reach its end.
 */
export function recall(buffer: EditBuffer, line: string | undefined): void {
  if (line === undefined) return;
  buffer.setText(line);
  buffer.moveLineEnd();
}
