/**
 * TRANSFORM REPRO: helper-owned JSX IIFE decomposes through local aliases
 *
 * We want the decomposed branch shape, not main's blanket outer-IIFE wrapping.
 * The important invariant is that local aliases like `const p = path.get() || []`
 * must not hide the explicit `path -> visible` dependency when later helper-owned
 * derives are created.
 */

import {
  action,
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
  const pushPath = action(({ name }: { name: string }) => {
    path.push(name);
  });

  return {
    [UI]: (
      <div>
        {(() => {
          const p = path.get() || [];
          if (p.length === 0) return null;
          return <div>{p[p.length - 1]}</div>;
        })()}
        {(() => {
          const p = path.get() || [];
          const visible = visibleEntries(entries, p[0] || "");
          return visible.map((entry) => (
            <button
              type="button"
              onClick={action(() => pushPath.send({ name: entry.name }))}
            >
              {entry.name}
            </button>
          ));
        })()}
      </div>
    ),
  };
});
