/// <cts-enable />
import { computed, pattern, type PerUser, Writable } from "commonfabric";

// A `map` over an array of plain values in place whose body reads a value of
// the scope `user`: each row says who sees it, by the nickname a client
// writes.

interface Output {
  nickname?: PerUser<Writable<string>>;
  rows: { title: string; seen: string }[];
}

export default pattern<{ titles: Writable<string[]> }, Output>(
  ({ titles }) => {
    const nickname = new Writable.perUser("");
    return {
      nickname,
      rows: titles.map((title) => ({
        title,
        seen: computed(() => `${title} seen by ${nickname.get()}`),
      })),
    };
  },
);
