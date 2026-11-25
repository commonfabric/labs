/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

const set = handler<
  { count?: number; useLeft?: boolean },
  { count: Writable<number>; useLeft: Writable<boolean> }
>(
  (event, { count, useLeft }) => {
    if (event.count !== undefined) count.set(event.count);
    if (event.useLeft !== undefined) useLeft.set(event.useLeft);
  },
);

// A record built from `parity`, which reads `left` or `right` by `useLeft`:
// where the two have one parity, `parity` is evaluated again after
// `useLeft` changed and gives the value it gave, so `box` is not evaluated
// again and holds the record it held, while the inputs its template names
// are another position. `next` changes with `count`, so the result is
// placed again.
export default pattern<
  {
    count: Writable<number>;
    useLeft: Writable<boolean>;
    left: number;
    right: number;
  }
>(
  ({ count, useLeft, left, right }) => {
    const parity = computed(() => (useLeft.get() ? left : right) % 2);
    const box = computed(() => {
      const held = { parity, label: "parity" };
      return held;
    });
    return {
      next: computed(() => count.get() + 1),
      box,
      set: set({ count, useLeft }),
    };
  },
);
