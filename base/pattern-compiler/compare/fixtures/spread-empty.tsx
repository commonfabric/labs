// A computed spreads a state cell that holds an empty list into the list it
// writes there: the element slot of the cell finds no element to read.
import { computed, Default, pattern, Writable } from "commonfabric";

export default pattern<{ trigger: number | Default<0> }>(({ trigger }) => {
  const list = new Writable<number[]>([]);
  const appended = computed(() => {
    const current = list.get();
    list.set([...current, trigger]);
    return current.length;
  });
  return { appended };
});
