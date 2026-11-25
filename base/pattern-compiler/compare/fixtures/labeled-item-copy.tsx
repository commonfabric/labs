/// <cts-enable />
import {
  computed,
  type Confidential,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

type Title = Confidential<string, readonly ["item-title"]>;

const name = handler<{ title: string }, { title: Writable<Title> }>(
  (event, { title }) => {
    title.set(event.title);
  },
);

interface Output {
  title: Title;
  name: Stream<{ title: string }>;
}

// `labeled-item.tsx` whose result holds a copy of the title in place, a
// value a `computed` derives from the state cell, where that one holds the
// state cell itself.
export default pattern<Record<string, never>, Output>(() => {
  const held = Writable.of<Title>("");
  const title = computed(() => held.get());
  return { title, name: name({ title: held }) };
});
