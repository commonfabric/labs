/// <cts-enable />
import { lift, pattern, Writable } from "commonfabric";

interface Author {
  kind: string;
  name: string;
}

// `touch` takes the input as a handle, and `named` reads its members and
// returns it: the place has a slot of class `identity` and one of class
// `value`, and `named` declares a value there.
const touch = lift(
  (state: { author: Writable<Author | undefined> }): number =>
    state.author.get() === undefined ? 0 : 1,
);

const named = lift(({ author }: { author?: Author }): Author =>
  author && author.name.trim() ? author : { kind: "person", name: "" }
);

export default pattern<{ author?: Author }>(({ author }) => {
  const present = touch({ author });
  const shown = named({ author });
  return { present, shown };
});
