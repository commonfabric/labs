/**
 * Regression: .map() on a property access of a computed result inside
 * another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
 * so `result.tasks` is a plain array.
 */

import { computed, pattern, UI } from "commonfabric";

interface Item {
  name: string;
  done: boolean;
}

// FIXTURE: computed-property-access-map
// Verifies: .map() on a property access of a computed result inside another computed() is NOT transformed to .mapWithPattern()
//   computed(() => result.tasks.map(fn)) → lift(({ result }) => result.tasks.map(fn))({ result: { tasks: result.key("tasks") } })
// Context: Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
//   so `result.tasks` is a plain array. The .map() must remain untransformed.
//   This is a negative test for reactive .map() detection on property access paths.
//   Note the captures use result.key("tasks") to extract the needed sub-property.
export default pattern<{ items: Item[] }>(({ items }) => {
  const result = computed(() => ({
    tasks: items.filter((i) => !i.done),
    view: "inbox",
  }));

  return {
    [UI]: (
      <div>
        {computed(() => {
          return result.tasks.map((task) => <li>{task.name}</li>);
        })}
      </div>
    ),
  };
});
