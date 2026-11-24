/**
 * TRANSFORM REPRO: helper-owned JSX IIFE final map callback captures reactive state
 *
 * The decomposed helper-owned IIFE path currently leaves the final `visible.map(...)`
 * as a plain map call. That is only safe when the callback depends only on the mapped
 * element. If it captures outer reactive state, it must lower through mapWithPattern.
 */

import {
  Default,
  pattern,
  UI,
  VNode,
  Writable,
} from "commonfabric";

interface Entry {
  name: string;
}

interface Input {
  entries: Writable<Default<Entry[], []>>;
}

interface Output {
  [UI]: VNode;
}

function visibleEntries(
  entries: Writable<Default<Entry[], []>>,
  prefix: string,
): Entry[] {
  const list = entries.get();
  return list.filter((entry) =>
    prefix.length === 0 || entry.name.startsWith(prefix)
  );
}

export default pattern<Input, Output>(({ entries }) => {
  const path = new Writable<string[]>([]);
  const labelPrefix = new Writable("prefix:");

  return {
    [UI]: (
      <div>
        {(() => {
          const p = path.get() || [];
          const visible = visibleEntries(entries, p[0] || "");
          return visible.map((entry) => (
            <button type="button">
              {labelPrefix}:{entry.name}
            </button>
          ));
        })()}
      </div>
    ),
  };
});
