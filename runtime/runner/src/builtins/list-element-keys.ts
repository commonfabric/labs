import type { CellScope } from "../builder/types.ts";
import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { ElementRun } from "./list-element-rollback.ts";
import { cellIdentityKey } from "./scope-policy.ts";

/**
 * The identity key of each element the list currently holds, by position.
 * Sparse holes are skipped: they get no key and so no element run.
 *
 * A list may hold the same identity more than once, so the key also carries how
 * many times that identity has already appeared. Each occurrence then keeps an
 * element run of its own.
 */
export function listElementKeys(list: Cell<any>[]): Map<number, string> {
  const occurrences = new Map<string, number>();
  const keys = new Map<number, string>();
  for (let i = 0; i < list.length; i++) {
    if (!(i in list)) continue;
    const { dedupKey, linkKey } = cellIdentityKey(list[i]);
    const occurrence = occurrences.get(dedupKey) ?? 0;
    occurrences.set(dedupKey, occurrence + 1);
    keys.set(i, JSON.stringify([...linkKey, occurrence]));
  }
  return keys;
}

/**
 * Drop the element runs whose elements the list no longer holds, releasing the
 * child each one launched. When a scope is supplied, a child from another
 * scope is released even if its element remains present.
 *
 * It is a release rather than a stop, so an element result that something
 * opened in its own right keeps running; `docs/specs/runner-child-run-ownership.md`
 * defines the two authorities. A reconcile whose transaction does not become
 * durable has released children for a removal that never landed. The next
 * reconcile reads a list that still holds those elements and sets them up
 * again, on the same deterministic result cells, so their values return.
 *
 * An entry is dropped only once its child is released, so a release that
 * throws leaves the entry for the retry and for the coordinator's teardown to
 * find. Every other child is released either way, and the failures are raised
 * together at the end: one child whose cleanup throws must not keep its
 * siblings running. Passing an empty set releases every child, which is what
 * teardown and an input that went undefined both want.
 */
export function releaseRemovedElements(
  runtime: Runtime,
  elementRuns: Map<string, ElementRun>,
  currentKeys: ReadonlySet<string>,
  scope?: CellScope,
): void {
  const errors: unknown[] = [];
  for (const [elementKey, entry] of [...elementRuns]) {
    if (
      currentKeys.has(elementKey) &&
      (scope === undefined ||
        entry.resultCell.getAsNormalizedFullLink().scope === scope)
    ) continue;
    try {
      runtime.runner.releaseChild(entry.resultCell, undefined);
      elementRuns.delete(elementKey);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple list child releases failed");
  }
}
