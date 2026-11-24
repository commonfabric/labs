/**
 * computed() result used as a lift-applied capture should use .key("count"),
 * not plain property access. The computed() return value is an
 * Reactive, so rewritePatternBody correctly treats it as opaque.
 */

import { computed, pattern, UI } from "commonfabric";

interface State {
  items: Array<{ name: string; done: boolean }>;
}

// FIXTURE: computed-result-in-derive-captures
// Verifies: computed() result properties captured in a subsequent lift-applied computation use .key() access
//   computed(() => `${stats.count} of ${stats.total} done`) → lift(({ stats }) => ...)({ stats: { count: stats.key("count"), total: stats.key("total") } })
// Context: The first computed() returns a Reactive with { count, total }.
//   When the second computed() captures stats.count and stats.total, the
//   transform rewrites them to stats.key("count") and stats.key("total") in
//   the captures object because stats is a Reactive.
export default pattern<State>((state) => {
  const stats = computed(() => ({
    count: state.items.filter((i) => i.done).length,
    total: state.items.length,
  }));

  return {
    [UI]: (
      <div>
        {computed(() => `${stats.count} of ${stats.total} done`)}
      </div>
    ),
  };
});
