/// <cts-enable />
import { computed, pattern, type PerUser, Writable } from "commonfabric";
// The nickname's length and whether it is longer than 22 characters derive
// a count and a predicate from it, which differ between the principals.

// A `map` over an array of plain values in place whose body reads a value of
// the scope `user`: each row says who sees it, by the nickname a client
// writes.

interface Output {
  nickname?: PerUser<Writable<string>>;
  rows: { title: string; seen: string; size: number; long: boolean }[];
}

export default pattern<{ titles: Writable<string[]> }, Output>(
  ({ titles }) => {
    const nickname = new Writable.perUser("");
    return {
      nickname,
      rows: titles.map((title) => ({
        title,
        seen: computed(() => `${title} seen by ${nickname.get()}`),
        size: computed(() => nickname.get().length),
        long: computed(() => nickname.get().length > 22),
      })),
    };
  },
);
