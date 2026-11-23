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

// Two outputs that are evaluated again and give the value they gave.
// `parity` reads `count` and holds the same value for 1 and for 3: its
// inputs are the same positions. `chosen` reads `left` or `right` by
// `useLeft`, and holds the same value where the two are equal: its inputs
// are another position after `useLeft` changed.
export default pattern<
  {
    count: Writable<number>;
    useLeft: Writable<boolean>;
    left: number;
    right: number;
  }
>(
  ({ count, useLeft, left, right }) => ({
    parity: computed(() => count.get() % 2),
    chosen: computed(() => (useLeft.get() ? left : right) > 0),
    set: set({ count, useLeft }),
  }),
);
