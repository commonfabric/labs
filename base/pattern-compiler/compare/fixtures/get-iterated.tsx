/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

const show = handler<unknown, { shown: Writable<boolean> }>(
  (_event, { shown }) => {
    shown.set(true);
  },
);

interface Output {
  byGet: string;
  byKey: string;
  show: Stream<unknown>;
}

// The titles of an array of references, each item a document whose title
// carries a clause its own type declares, which this pattern's type of an
// item does not declare: once read through each element of the
// array that `get()` gives, and once by position through the handle. Both
// are read only once `show` was sent, so that the start reads no title.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const shown = Writable.of(false);
  const byGet = computed(() => {
    if (!shown.get()) return "";
    let titles = "";
    for (const item of items.get()) titles += `${item.title};`;
    return titles;
  });
  const byKey = computed(() => {
    if (!shown.get()) return "";
    let titles = "";
    const count = items.get().length;
    for (let index = 0; index < count; index++) {
      titles += `${items.key(index).key("title").get()};`;
    }
    return titles;
  });
  return { byGet, byKey, show: show({ shown }) };
});
