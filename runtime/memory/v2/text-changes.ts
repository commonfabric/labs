/**
 * Text changes in the form pattern code writes them — `{ from, to, insert }`
 * against the string it read — and their encoding as a payload for the
 * `codemirror-changeset@1` codec. Nothing here imports CodeMirror, so the
 * runner can build a payload without loading an editor; the encoding is the one
 * `ChangeSet.toJSON()` produces, which the codec decodes with
 * `ChangeSet.fromJSON()`.
 */

import type { FabricValue, TextChange } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";

/**
 * Applies `changes` to `text` and returns the result. Every position refers to
 * `text`, and the changes run in ascending order without overlap: each one
 * starts at or after the end of the one before it, so two insertions at one
 * position land in list order.
 *
 * @throws RangeError when a position is not an integer, falls outside `text`,
 *   or breaks the ordering.
 * @throws TypeError when an `insert` is not a string.
 */
export const applyTextChanges = (
  text: string,
  changes: readonly TextChange[],
): string => {
  let result = "";
  let position = 0;
  for (const { from, to, insert } of orderedChanges(changes, text.length)) {
    result += text.slice(position, from) + insert;
    position = to;
  }
  return result + text.slice(position);
};

/**
 * Encodes successive batches of changes to `text` as a `codemirror-changeset@1`
 * payload: one update per batch, each batch's positions referring to the text
 * the batches before it left. `clientId` names the submitter to the editors
 * that receive the update.
 *
 * @throws RangeError or TypeError as {@link applyTextChanges} does.
 */
export const codeMirrorTextChangesPayload = (
  text: string,
  batches: readonly (readonly TextChange[])[],
  clientId: string,
): FabricValue => {
  const updates: FabricValue[] = [];
  let current = text;
  for (const batch of batches) {
    updates.push({ clientId, changes: changeSetJson(current.length, batch) });
    current = applyTextChanges(current, batch);
  }
  return { updates };
};

/** A change with its defaults filled in and its range checked. */
type CheckedChange = { from: number; to: number; insert: string };

/**
 * Helper for {@link applyTextChanges} and {@link codeMirrorTextChangesPayload},
 * which checks `changes` against a text of `length` code units and fills in
 * their defaults.
 */
const orderedChanges = (
  changes: readonly TextChange[],
  length: number,
): CheckedChange[] => {
  let position = 0;
  return changes.map((change) => {
    const { from } = change;
    const to = change.to ?? from;
    const insert = change.insert ?? "";
    if (
      !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 ||
      to < from || to > length
    ) {
      throw new RangeError(
        debugStr`text change range $quote${from} to $quote${to} falls ` +
          `outside a text of length ${length}`,
      );
    }
    if (from < position) {
      throw new RangeError(
        `text changes must run in ascending order without overlap: a change ` +
          `starts at ${from}, before the previous one ends at ${position}`,
      );
    }
    if (typeof insert !== "string") {
      throw new TypeError("a text change's `insert` must be a string");
    }
    position = to;
    return { from, to, insert };
  });
};

/**
 * Helper for {@link codeMirrorTextChangesPayload}, which writes one batch in
 * the section form of `ChangeSet.toJSON()`: a number keeps that many code
 * units, and an array replaces its first element's count of code units with
 * the lines that follow it.
 */
const changeSetJson = (
  length: number,
  changes: readonly TextChange[],
): FabricValue[] => {
  const sections: FabricValue[] = [];
  let position = 0;
  for (const { from, to, insert } of orderedChanges(changes, length)) {
    if (from > position) sections.push(from - position);
    if (to > from || insert !== "") {
      sections.push(
        insert === "" ? [to - from] : [to - from, ...insert.split("\n")],
      );
    }
    position = to;
  }
  if (position < length) sections.push(length - position);
  return sections;
};
