/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

interface RowResult {
  title: string;
  count: number;
  bump: Stream<{ by: number }>;
  tally: Stream<{ by: number }>;
}

// A pattern that a function body instantiates. It has a state cell and
// two bindings of its own: one writes its cell, and one a cell that the
// caller passed in.
const Row = pattern<{ title: string; total: Writable<number> }, RowResult>(
  ({ title, total }) => {
    const count = Writable.of(0);
    return {
      title,
      count,
      bump: bump({ count }),
      tally: bump({ count: total }),
    };
  },
);

const add = handler<
  { title: string },
  { rows: Writable<RowResult[]>; total: Writable<number> }
>((event, { rows, total }) => {
  rows.push(Row({ title: event.title, total }));
});

// A pattern instantiated in a function body, and a handler bound in one
// (PL §3.14, §3.15; ES §2.8). `add` instantiates `Row` once per event,
// and the list holds a reference to each instance's result. `buttons` is
// a `computed` whose body binds `bump` once per member it returns.
export default pattern<{ note: string }>(({ note }) => {
  const rows = Writable.of<RowResult[]>([]);
  const total = Writable.of(0);
  const pressed = Writable.of(0);
  const buttons = computed(() =>
    [1, 2].map((by) => ({ by, press: bump({ count: pressed }) }))
  );
  return { note, rows, total, pressed, buttons, add: add({ rows, total }) };
});
