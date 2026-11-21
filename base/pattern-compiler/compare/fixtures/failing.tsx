/// <cts-enable />
import { computed, handler, lift, pattern, Writable } from "commonfabric";

const half = lift((n: number) => {
  if (n < 0) throw new Error("negative");
  return n / 2;
});

// Reads `halved`, which fails while `n` is negative.
const keep = handler<unknown, { halved: number; kept: Writable<number[]> }>(
  (_event, { halved, kept }) => {
    kept.push(halved);
  },
);

// Reads nothing that fails.
const mark = handler<unknown, { kept: Writable<number[]> }>(
  (_event, { kept }) => {
    kept.push(-1);
  },
);

const setTo = handler<{ to: number }, { cell: Writable<number> }>(
  (event, { cell }) => {
    cell.set(event.to);
  },
);

interface Input {
  rows: number[];
}

// The error state of `plan-and-label-templates.md` §5.2: the body of
// `half` throws for a negative number. `next` reads the failed value,
// `chosen` reads it in the branch it does not select, `steady` reads
// nothing of it, and `_try` writes `log` and then throws. `view` places
// the failed value among the children of a view node and reads nothing
// of it. `each` is a `map` over `rows`, an array of plain values in
// place, whose body fails for one element.
export default pattern<Input>(({ rows }) => {
  const n = Writable.of(4);
  const log = Writable.of("none");
  const kept = Writable.of<number[]>([]);
  const halved = half(n);
  const next = computed(() => halved + 1);
  const chosen = computed(() => n.get() < 0 ? "negative" : `half ${halved}`);
  const steady = computed(() => `n is ${n.get()}`);
  const _try = computed(() => {
    log.set(`tried ${n.get()}`);
    if (n.get() < 0) throw new Error("negative");
  });
  const each = rows.map((row) => half(row));
  return {
    n,
    halved,
    next,
    chosen,
    steady,
    log,
    each,
    view: <p>half: {halved}</p>,
    kept,
    keep: keep({ halved, kept }),
    mark: mark({ kept }),
    setN: setTo({ cell: n }),
  };
});
