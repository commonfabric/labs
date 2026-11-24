/**
 * The line editor's table: what each key does to a line being typed, and the
 * lines typed before it.
 *
 * Two places in shuttle read a line off the keyboard — the prompt and the
 * command line a view opens on `:` — and they bind the same keys, so the table
 * is one value both read rather than two that would drift. It sits below both
 * for that reason and holds no state: everything it acts on arrives as a
 * parameter, so a case drives the whole of it with a key and a buffer.
 */

import type { EditBuffer } from "../view/editbuffer.ts";
import type { Key } from "../view/keys.ts";
import { type LineHistory, recall } from "./history.ts";
import { holdsControlCharacter } from "./place.ts";

/**
 * What a key acts on: the line being typed, and the lines typed before it.
 *
 * The two travel together because the recall keys act on both at once — a
 * line put on the buffer is a position the traversal moved to — and a table
 * of motions over one value is what lets the second table modal editing wants
 * (`docs/plans/shuttle/futures.md`) bind the same acts.
 */
export interface Editing {
  /** The line being typed. */
  readonly buffer: EditBuffer;

  /** The lines this run typed, and where the traversal over them stands. */
  readonly history: LineHistory;
}

/**
 * The motions a key runs, by the key that runs it. Emacs bindings, because
 * they are what the substrate's own editor binds and what a terminal's other
 * line editors offer.
 *
 * A `Map` rather than an object, which holds what was put in it and answers
 * for nothing else — the shape the verb table takes, for the same reason and
 * against a wider door. What reaches this one is narrower: a key name is a
 * single character, a `ctrl-` or `alt-` compound, or one of the fixed names
 * `decodeKeys` writes, and none of those is a member every object carries.
 *
 * `ctrl-d` deletes forward here and ends the run in `runPrompt` (`prompt.ts`),
 * which reads it first: what the two spellings have in common is that each
 * removes what is in front of the cursor, and on an empty line there is only
 * the run.
 *
 * `up` and `down` walk the lines this run typed rather than the rows of the
 * buffer, and nothing is lost by that: a line is read one at a time, `enter`
 * being what ends it rather than what breaks it, so a buffer here has one row
 * and a vertical motion over it has nowhere to go. `ctrl-p` and `ctrl-n` are
 * bound beside them, those being what an Emacs binding spells the same two
 * motions as.
 */
const BINDINGS: ReadonlyMap<string, (editing: Editing) => void> = new Map([
  ["left", ({ buffer }) => buffer.moveLeft()],
  ["ctrl-b", ({ buffer }) => buffer.moveLeft()],
  ["right", ({ buffer }) => buffer.moveRight()],
  ["ctrl-f", ({ buffer }) => buffer.moveRight()],
  ["home", ({ buffer }) => buffer.moveLineStart()],
  ["ctrl-a", ({ buffer }) => buffer.moveLineStart()],
  ["end", ({ buffer }) => buffer.moveLineEnd()],
  ["ctrl-e", ({ buffer }) => buffer.moveLineEnd()],
  ["alt-b", ({ buffer }) => buffer.moveWordBackward()],
  ["alt-f", ({ buffer }) => buffer.moveWordForward()],
  ["backspace", ({ buffer }) => buffer.deleteBackward()],
  ["delete", ({ buffer }) => buffer.deleteForward()],
  ["ctrl-d", ({ buffer }) => buffer.deleteForward()],
  ["ctrl-k", ({ buffer }) => buffer.killLine()],
  ["ctrl-u", ({ buffer }) => buffer.killWholeLine()],
  ["ctrl-w", ({ buffer }) => buffer.killWordBackward()],
  ["alt-backspace", ({ buffer }) => buffer.killWordBackward()],
  ["alt-d", ({ buffer }) => buffer.killWordForward()],
  ["ctrl-y", ({ buffer }) => buffer.yank()],
  ["alt-y", ({ buffer }) => buffer.yankPop()],
  [
    "up",
    ({ buffer, history }) => recall(buffer, history.earlier(buffer.text())),
  ],
  [
    "ctrl-p",
    ({ buffer, history }) => recall(buffer, history.earlier(buffer.text())),
  ],
  [
    "down",
    ({ buffer, history }) => recall(buffer, history.later(buffer.text())),
  ],
  [
    "ctrl-n",
    ({ buffer, history }) => recall(buffer, history.later(buffer.text())),
  ],
]);

/**
 * Lets `key` act on `editing`: the motion it is bound to, or the character it
 * produced where it is bound to none.
 *
 * A key carrying a modifier produces no character, so a binding and an
 * insertion never both apply, and a key that is neither does nothing.
 *
 * A character a terminal acts on rather than prints is one of those neithers.
 * The decoder gives every byte below `0x20` a name and no character, so none
 * of those reaches here at all; what does is a C1 character, which arrives
 * whole out of a paste — and `U+009B` is a sequence introducer. There is
 * nowhere for such a character to be going: no place admits a part holding one
 * (`place.ts`), so a line carrying one is a line already refused. Both callers
 * draw the line they are editing on a terminal, and there a sequence
 * introducer drawn into it would take the rest of the line as a command — so
 * it would corrupt the screen on the way to a refusal it was always going to
 * get.
 */
export function apply(editing: Editing, key: Key): void {
  const motion = BINDINGS.get(key.alt === true ? `alt-${key.name}` : key.name);
  if (motion !== undefined) {
    motion(editing);
    return;
  }
  if (key.char !== undefined && !holdsControlCharacter(key.char)) {
    editing.buffer.insert(key.char);
  }
}

/**
 * The length of `text` in the unit a cursor is measured in. The buffer moves
 * its cursor a code point at a time, and this counts what stands in front of
 * it the same way, so the sum is an index into the line rather than a place on
 * the screen.
 */
export function codePoints(text: string): number {
  return [...text].length;
}
