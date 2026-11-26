/**
 * Sends a text that a stream sends again and again, such as a page's markup,
 * as the edits that turn the text the stream sent before into the new one.
 * Each rendering of the dashboard or of a live page differs from the one
 * before in a few places, so the edits are a small part of the whole.
 *
 * The server side (`textToSend`) finds the edits between the two texts split
 * into pieces, each after the first starting at a `<`, so that an edit to
 * markup replaces a few tags and the text after them. It finds the fewest
 * pieces to drop and insert (`shortestEditHunks`), and sends the whole text
 * when that would take more than `MAX_EDITED_PIECES`. The browser side
 * (`receivedText`) applies the edits to the text it was sent before.
 */

import { shortestEditHunks } from "@commonfabric/runner/storage/array-edit-script";

/**
 * One edit: keep `keep` characters of the earlier text, leave out the `drop`
 * characters after them, and put `insert` in their place.
 */
export type TextEdit = [keep: number, drop: number, insert: string];

/**
 * The edits that make a text from the text a stream sent before, which is
 * `from` characters long. The characters of the earlier text after the last
 * edit are kept.
 */
export interface TextEdits {
  from: number;
  edits: TextEdit[];
}

/** A text as a stream sends it: whole, or as `TextEdits`. */
export type SentText = string | TextEdits;

/**
 * The most pieces `textToSend` drops and inserts before it sends the whole
 * text instead. Finding the edits takes time in proportion to this times the
 * number of pieces in the texts.
 */
export const MAX_EDITED_PIECES = 1000;

/**
 * What to send a reader holding `before`, or holding nothing, so that it
 * holds `after`.
 */
export function textToSend(
  before: string | undefined,
  after: string,
): SentText {
  if (before === undefined) return after;
  const edits = before === after ? [] : textEdits(before, after);
  return edits ? { from: before.length, edits } : after;
}

/**
 * The text a reader holds once it applies `sent` to `before`, the text it
 * held. Throws a `RangeError` when the edits were made from a text of another
 * length, or reach past its end. This runs in the browser, so it uses nothing
 * outside itself.
 */
export function receivedText(before: string, sent: SentText): string {
  if (typeof sent === "string") return sent;
  if (sent.from !== before.length) {
    throw new RangeError(
      `edits made from ${sent.from} characters reached ${before.length}`,
    );
  }
  let text = "";
  let at = 0;
  for (const [keep, drop, insert] of sent.edits) {
    text += before.slice(at, at + keep) + insert;
    at += keep + drop;
  }
  if (at > before.length) {
    throw new RangeError(`edits reach past ${before.length} characters`);
  }
  return text + before.slice(at);
}

// The edits from `before` to `after`, or undefined when they would take more
// than `MAX_EDITED_PIECES` pieces.
function textEdits(before: string, after: string): TextEdit[] | undefined {
  const from = before.split(/(?=<)/);
  const to = after.split(/(?=<)/);
  const hunks = shortestEditHunks(
    from.length,
    to.length,
    (i, j) => from[i] === to[j],
    MAX_EDITED_PIECES,
  );
  if (!hunks) return undefined;
  // The length of the pieces of `from` from the first not yet passed up to
  // `end`, which are then passed.
  let passed = 0;
  const pass = (end: number): number => {
    let length = 0;
    for (; passed < end; passed++) length += from[passed].length;
    return length;
  };
  return hunks.map(({ start, remove, addStart, add }) => [
    pass(start),
    pass(start + remove),
    to.slice(addStart, addStart + add).join(""),
  ]);
}
