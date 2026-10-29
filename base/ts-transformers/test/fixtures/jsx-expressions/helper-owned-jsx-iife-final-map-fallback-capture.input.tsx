/**
 * TRANSFORM REPRO: helper-owned JSX IIFE final map callback captures reactive state
 * after the local receiver has been rewritten through a synthetic fallback wrapper.
 */

import { pattern, UI, VNode } from "commonfabric";

interface Entry {
  name: string;
}

interface Input {
  entries: Entry[];
  prefix: string;
  labelPrefix: string;
}

interface Output {
  [UI]: VNode;
}

const visibleEntries = (entries: Entry[], prefix: string) =>
  entries.filter((entry) => entry.name.startsWith(prefix));

export default pattern<Input, Output>(({ entries, prefix, labelPrefix }) => ({
  [UI]: (
    <div>
      {(() => {
        const visible = visibleEntries(entries, prefix) || [];
        return visible.map((entry) => (
          <button type="button">
            {labelPrefix}:{entry.name}
          </button>
        ));
      })()}
    </div>
  ),
}));
