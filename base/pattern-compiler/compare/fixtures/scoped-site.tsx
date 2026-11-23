/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

// A pattern called through `asScope("user")` in the body of a `map` over
// an array of plain values in place, and once outside it: the call is
// compiled into the surrounding instance, and the state the callee
// declares is of the scope `user`.

const toggle = handler<unknown, { open: Writable<boolean> }>(
  (_event, { open }) => {
    open.set(!open.get());
  },
);

interface RowOutput {
  title: string;
  open: boolean;
  label: string;
  toggle: Stream<unknown>;
}

const Row = pattern<{ title: string }, RowOutput>(({ title }) => {
  const open = Writable.of(false);
  const label = computed(() => `${title}${open.get() ? " (open)" : ""}`);
  return { title, open, label, toggle: toggle({ open }) };
});

interface Output {
  rows: RowOutput[];
  first: RowOutput;
}

export default pattern<{ items: { title: string }[] }, Output>(
  ({ items }) => {
    const rows = items.map((item) =>
      Row.asScope("user")({ title: item.title })
    );
    const first = Row.asScope("user")({ title: "first" });
    return { rows, first };
  },
);
