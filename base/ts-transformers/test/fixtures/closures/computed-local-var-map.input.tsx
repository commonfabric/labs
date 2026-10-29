/**
 * Regression: .map() on a computed result assigned to a local variable
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
 * so `localVar` is a plain array and .mapWithPattern() doesn't exist on it.
 */

import { computed, pattern, UI } from "commonfabric";

interface Item {
  name: string;
  price: number;
}

// FIXTURE: computed-local-var-map
// Verifies: .map() on a local variable assigned from a computed result inside another computed() is NOT transformed to .mapWithPattern()
//   computed(() => { const localVar = filtered; return localVar.map(fn) }) → lift(({ filtered }) => { const localVar = filtered; return localVar.map(fn) })(...)
// Context: Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
//   so `localVar` is a plain array. The .map() must remain untransformed.
//   This is a negative test for reactive .map() detection on local aliases.
export default pattern<{ items: Item[] }>(({ items }) => {
  const filtered = computed(() => items.filter((i) => i.price > 100));

  return {
    [UI]: (
      <div>
        {computed(() => {
          const localVar = filtered;
          return localVar.map((item) => <li>{item.name}</li>);
        })}
      </div>
    ),
  };
});
