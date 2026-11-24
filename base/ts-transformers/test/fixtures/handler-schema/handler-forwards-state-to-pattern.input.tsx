/// <cts-enable />
/**
 * A handler that only hands a state cell on to a pattern it instantiates takes
 * the cell as an opaque handle, whichever cell type the state declares, inside
 * a callback as well. A cell the handler also reads keeps what the read earns.
 */
import { handler, pattern, type ReadonlyCell, Writable } from "commonfabric";

interface ChildInput {
  rows: ReadonlyCell<readonly string[]>;
  count: ReadonlyCell<number>;
  label: string;
}

const Child = pattern<ChildInput, { label: string }>(({ label }) => ({ label }));

const withEach = <T,>(make: () => T): T => make();

export const addChild = handler<{ label: string }, {
  rows: ReadonlyCell<readonly string[]>;
  count: ReadonlyCell<number>;
  made: Writable<unknown[]>;
}>(({ label }, { rows, count, made }) => {
  if (count.get() > 10) return;
  made.push(withEach(() => Child({ rows, count, label })));
});
