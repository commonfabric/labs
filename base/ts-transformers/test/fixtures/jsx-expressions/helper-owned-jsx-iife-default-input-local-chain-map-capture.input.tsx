/**
 * TRANSFORM REPRO: helper-owned JSX IIFE with defaulted array input, local
 * initializer chain, and final map callback captures.
 *
 * The final callback array method should lower to mapWithPattern, but the
 * IIFE itself should stay decomposed rather than being blanket-wrapped.
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
  contentType?: string;
}

function findChildren(
  tree: readonly Entry[],
  path: readonly string[],
): readonly Entry[] {
  let current: readonly Entry[] = tree;
  for (const name of Array.isArray(path) ? path : []) {
    const folder = current.find(
      (entry: Entry) => entry.name === name && entry.type === "folder",
    );
    if (!folder || !folder.children) return [];
    current = folder.children;
  }
  return current;
}

interface Input {
  entries: Default<Entry[], []>;
}

interface Output {
  [UI]: VNode;
}

export default pattern<Input, Output>(({ entries }) => {
  const path = new Writable<string[]>([]);
  const handleNavigateInto = action(({ name }: { name: string }) => {
    path.push(name);
  });
  const handleOpenFile = action(({ item }: { item: Entry }) => {
    void item;
  });

  return {
    [UI]: (
      <div>
        {(() => {
          const tree = (entries || []) as Entry[];
          const p = (path.get() || []) as string[];
          const unsorted = findChildren(tree, p) as Entry[];
          const items = [...unsorted].sort((a: Entry, b: Entry) => {
            if (a.type === b.type) return 0;
            return a.type === "file" ? -1 : 1;
          });

          return items.map((item: Entry) => {
            const isFolder = item.type === "folder";
            const isOpenable =
              !isFolder &&
              !!item.contentType &&
              item.contentType !== "binary";

            return (
              <button
                type="button"
                onClick={
                  isFolder
                    ? action(() =>
                        handleNavigateInto.send({
                          name: item.name,
                        })
                      )
                    : isOpenable
                    ? action(() => handleOpenFile.send({ item }))
                    : undefined
                }
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
