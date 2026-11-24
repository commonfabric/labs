/**
 * TRANSFORM REPRO: helper-owned JSX IIFE must account for local initializer dependencies
 *
 * The wrapper around this authored IIFE should capture the reactive roots that
 * feed local aliases declared inside the IIFE body. Capturing the inner locals
 * themselves (`tree`, `p`, `unsorted`, `items`) is wrong because they are not
 * in scope at the synthetic lift-applied call site.
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
  id: string;
  name: string;
  type: "file" | "folder";
  children?: Entry[];
}

function findChildren(
  tree: Writable<Entry[]>,
  path: readonly string[],
): readonly Entry[] {
  let current = tree.get();
  for (const name of path) {
    const folder = current.find(
      (entry: Entry) => entry.name === name && entry.type === "folder",
    );
    if (!folder || !folder.children) return [];
    current = folder.children;
  }
  return current;
}

interface Input {
  entries: Writable<Default<Entry[], []>>;
}

interface Output {
  [UI]: VNode;
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
          const tree = entries;
          const p = path.get() || [];
          const unsorted = findChildren(tree, p);
          const items = [...unsorted].sort((a: Entry, b: Entry) =>
            a.name.localeCompare(b.name)
          );

          return items.map((item: Entry) => {
            return (
              <button
                type="button"
                onClick={action(() => pushPath.send({ name: item.name }))}
              >
                {item.name}
              </button>
            );
          });
        })()}
      </div>
    ),
  };
});
