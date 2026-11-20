/**
 * A count of the elements of a list whose elements declare a clause on one
 * member. `items.length` observes which elements the list has (PL §2.1,
 * `enumeration`), and nothing of what an element holds: the label of `count`
 * holds no clause that only a member of an element declares.
 */
import { computed, type Confidential, pattern } from "commonfabric";

interface Item {
  note: Confidential<string, readonly ["item-note"]>;
  amount: number;
}

interface State {
  items: Item[];
}

export default pattern<State>(({ items }) => ({
  count: computed(() => items.length),
}));
