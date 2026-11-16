import type { FabricValue } from "@commonfabric/api";
import { valueEqual } from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/js-values/arrays";
import { isObjectNotArray } from "@commonfabric/js-values/types";

/**
 * Whether a transaction that read the paths `reads` of a stream sidecar
 * document and wrote the paths `writes`, all while the document held
 * `before`, may commit now that it holds `after`: the document changed only
 * by entries appended at the tail of its `value.entries` log, and the
 * transaction neither saw the log's length nor touched anything but entries
 * it already held. Paths are document paths, so a sidecar's log is at
 * `["value", "entries"]`.
 *
 * An event append adds an entry after the last one and changes nothing else,
 * and the only writers a sidecar admits beside the serving loop are such
 * appends (memory `validateEventAppends`). A served delivery marks its entry
 * `consequenced` in the handler's own transaction, so a client firing the
 * stream's next event while that transaction runs changes the sidecar under
 * it. Each entry the transaction held keeps its index and its value, so the
 * mark lands as written; the wave commutes the two the same way
 * (serving-loop.md §3d).
 */
export function commutesWithTailAppends(
  before: FabricValue | undefined,
  after: FabricValue | undefined,
  reads: readonly (readonly string[])[],
  writes: readonly (readonly string[])[],
): boolean {
  const held = sidecarEntries(before);
  const now = sidecarEntries(after);
  if (held === undefined || now === undefined) return false;
  if (now.length < held.length) return false;
  if (!agreeOutsideEntries(before, after)) return false;
  for (let i = 0; i < held.length; i++) {
    if (!valueEqual(held[i], now[i])) return false;
  }
  const heldEntryIndex = (path: readonly string[]): boolean =>
    path.length >= 3 && isArrayIndexPropertyName(path[2]) &&
    Number(path[2]) < held.length;
  const withinLog = (path: readonly string[]): boolean =>
    path.slice(0, 2).every((segment, i) => segment === ["value", "entries"][i]);
  // Outside the log the two values agree, so a read there saw what is still
  // there. A read of the log as a whole, of its length, or of a slot past the
  // entries the transaction held saw what the appends changed.
  if (reads.some((path) => withinLog(path) && !heldEntryIndex(path))) {
    return false;
  }
  return writes.every((path) =>
    path.length >= 3 && withinLog(path) && heldEntryIndex(path)
  );
}

/** A stream sidecar document's `value.entries` log, or `undefined` for a
 * value of another shape. */
function sidecarEntries(
  document: FabricValue | undefined,
): readonly FabricValue[] | undefined {
  if (!isObjectNotArray(document)) return undefined;
  const value = document.value;
  if (!isObjectNotArray(value)) return undefined;
  const entries = value.entries;
  return Array.isArray(entries) ? entries : undefined;
}

/** Whether two stream sidecar documents agree on everything but their
 * `value.entries` logs. */
function agreeOutsideEntries(
  a: FabricValue | undefined,
  b: FabricValue | undefined,
): boolean {
  if (!isObjectNotArray(a) || !isObjectNotArray(b)) return false;
  const aValue = a.value;
  const bValue = b.value;
  if (!isObjectNotArray(aValue) || !isObjectNotArray(bValue)) return false;
  return agreeExcept(a, b, "value") && agreeExcept(aValue, bValue, "entries");
}

function agreeExcept(
  a: Readonly<Record<string, FabricValue>>,
  b: Readonly<Record<string, FabricValue>>,
  skip: string,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete(skip);
  for (const key of keys) {
    if ((key in a) !== (key in b) || !valueEqual(a[key], b[key])) return false;
  }
  return true;
}
