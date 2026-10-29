/**
 * TRANSFORM REPRO: helper-owned JSX IIFE final filter callback captures reactive state.
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
  const labelPrefix = new Writable("a");

  return {
    [UI]: (
      <div>
        {(() => {
          const p = path.get() || [];
          const visible = visibleEntries(entries, p[0] || "");
          const filtered = visible.filter((entry) =>
            entry.name.startsWith(`${labelPrefix}`)
          );
          return filtered.map((entry) => <button type="button">{entry.name}</button>);
        })()}
      </div>
    ),
  };
});
