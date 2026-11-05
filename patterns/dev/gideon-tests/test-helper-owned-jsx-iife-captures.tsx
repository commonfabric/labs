// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TRANSFORM REPRO: helper-owned JSX IIFE drops captured reactive inputs
 *
 * Compare on main vs transformer branch:
 *   deno task cf check patterns/dev/gideon-tests/test-helper-owned-jsx-iife-captures.tsx --show-transformed --no-run
 *
 * Expected main shape:
 * - the second helper-owned JSX closure captures `path`, `entries`, and
 *   `pushPath` in its generated derive params
 *
 * Current branch bug:
 * - the branch rewrites the closure into a different shape that only derives
 *   `path`, leaving `entries` and `pushPath` outside the generated param
 *   bundle even though they are still used in the closure body
 */
import { action, Default, pattern, UI, VNode, Writable } from "commonfabric";

interface Entry {
  name: string;
}

interface Input {
  entries: Writable<Entry[] | Default<[]>>;
}

export interface Output {
  [UI]: VNode;
}

function visibleEntries(
  entries: Writable<Entry[] | Default<[]>>,
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
