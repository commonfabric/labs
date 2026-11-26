/// <cts-enable />
import { computed, pattern, type PerUser, Writable } from "commonfabric";
// The nickname's length and whether it is longer than 22 characters derive
// a count and a predicate from it, which differ between the principals.

// A `map` over the result of a `filter` over an array of references, whose
// body reads a value of the scope `user`: each row of an item that is not
// hidden says who sees it, by the nickname a client writes.

interface Item {
  title: string;
  hidden: boolean;
}

interface Output {
  nickname?: PerUser<Writable<string>>;
  rows: { title: string; seen: string; size: number; long: boolean }[];
}

export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser("");
  return {
    nickname,
    rows: items
      .filter((item) => !item.hidden)
      .map((item) => ({
        title: item.title,
        seen: computed(() => `${item.title} seen by ${nickname.get()}`),
        size: computed(() => nickname.get().length),
        long: computed(() => nickname.get().length > 22),
      })),
  };
});
