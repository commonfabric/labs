/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

// A total reduced over an array of plain values in place that a cell
// holds, and its rows mapped beside it.
const cents = (amount: number): number => Math.round((amount || 0) * 100);

export default pattern<{ entries: Writable<{ amount: number }[]> }>(
  ({ entries }) => {
    const total = computed(() =>
      entries.get().reduce((sum, entry) => sum + cents(entry.amount), 0) / 100
    );
    const rows = entries.map((entry) => entry.amount);
    return { total, rows };
  },
);
