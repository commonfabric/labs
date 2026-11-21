// A computed reads a state cell and writes it, and another reads the cell
// after that write, in one transaction.
import { computed, Default, pattern, Writable } from "commonfabric";

export default pattern<{ trigger: number | Default<0> }>(({ trigger }) => {
  const count = new Writable(0);
  const bumped = computed(() => {
    const current = count.get();
    count.set(current + trigger);
    return current;
  });
  const shown = computed(() => count.get() * 2);
  return { bumped, shown };
});
