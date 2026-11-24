/**
 * Regression: .map() on a destructured property from a computed result
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
 * so destructured `tasks` is a plain array.
 */

import { computed, pattern, UI } from "commonfabric";

interface Item {
  name: string;
  done: boolean;
}

// FIXTURE: computed-destructured-map
// Verifies: .map() on a destructured property of a computed result inside another computed() is NOT transformed to .mapWithPattern()
//   computed(() => { const { tasks } = result; return tasks.map(fn) }) → lift(({ result }) => { const { tasks } = result; return tasks.map(fn) })(...)
// Context: Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
//   so destructured `tasks` is a plain array. The .map() must remain untransformed.
//   This is a negative test for reactive .map() detection on derived values.
export default pattern<{ items: Item[] }>(({ items }) => {
  const result = computed(() => ({
    tasks: items.filter((i) => !i.done),
    view: "inbox",
  }));

  return {
    [UI]: (
      <div>
        {computed(() => {
          const { tasks } = result;
          return tasks.map((task) => <li>{task.name}</li>);
        })}
      </div>
    ),
  };
});
