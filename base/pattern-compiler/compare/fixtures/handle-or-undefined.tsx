/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

// The state declares `item` as a handle or `undefined`, and the body
// reads through the handle.
const copy = handler<
  unknown,
  { item: Writable<Item> | undefined; out: Writable<string> }
>((_, { item, out }) => {
  if (!item) return;
  out.set(item.get().title);
});

export default pattern<{ item: Item }>(({ item }) => {
  const out = Writable.of("none");
  return { out, copy: copy({ item, out }) };
});
