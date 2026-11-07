import { linkEqualityKey } from "../link-equality.ts";
import { topFrame } from "./frame-context.ts";

/**
 * Returns a string that two values share exactly when `equals()` returns
 * `true` for them in the same run, or `undefined` for a value `equals()` has no
 * referent for. A `Set` or a `Map` keyed by it finds the distinct references in
 * a list, or joins one list to another, in one pass where `equals()` compares
 * them in pairs.
 *
 * Like `equals()`, it follows links in the running frame's transaction, and
 * compares links as given where the frame has none, so an alias and what it
 * names share a key only inside a handler or a reactive computation.
 */
export function equalsKey(value: unknown): string | undefined {
  const frame = topFrame();
  return linkEqualityKey(
    value,
    undefined,
    frame?.tx !== undefined,
    frame?.tx,
    frame?.runtime,
  );
}
