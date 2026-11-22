/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

interface RowResult {
  title: string;
  shout: string;
}

// A pattern that a handler body instantiates, with an output computed from
// an input of the pattern that makes it: the instance's writes are of its
// own plan, and read a labeled document.
const Row = pattern<{ title: string; note: string }, RowResult>(
  ({ title, note }) => ({
    title,
    shout: computed(() => title + note),
  }),
);

const add = handler<
  { title: string },
  { rows: Writable<RowResult[]>; note: string }
>((event, { rows, note }) => {
  rows.push(Row({ title: event.title, note }));
});

export default pattern<{ note: string }>(({ note }) => {
  const rows = Writable.of<RowResult[]>([]);
  return { note, rows, add: add({ rows, note }) };
});
