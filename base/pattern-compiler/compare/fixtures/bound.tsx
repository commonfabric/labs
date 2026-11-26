/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

const setTo = handler<{ to: number }, { cell: Writable<number> }>(
  (event, { cell }) => {
    cell.set(event.to);
  },
);

// The bound on the evaluations of a cone instance in one transaction
// (`scheduler-and-serving-loop.md` §8.1). `_ping` and `_pong` each write
// the cell the other reads and never settle. `_cap` and `_back` do the
// same and settle by value. `sum` reads the two cells of the first pair,
// and `double` reads neither pair. No per-element construct is here.
export default pattern<Record<string, never>>(() => {
  const a = Writable.of(0);
  const b = Writable.of(0);
  const _ping = computed(() => {
    b.set(a.get() + 1);
  });
  const _pong = computed(() => {
    a.set(b.get() + 1);
  });
  const sum = computed(() => a.get() + b.get());

  const raw = Writable.of(50);
  const capped = Writable.of(0);
  const _cap = computed(() => {
    capped.set(Math.min(raw.get(), 10));
  });
  const _back = computed(() => {
    raw.set(capped.get());
  });

  const other = Writable.of(1);
  const double = computed(() => other.get() * 2);
  return {
    a,
    b,
    sum,
    raw,
    capped,
    double,
    setA: setTo({ cell: a }),
    setRaw: setTo({ cell: raw }),
    setOther: setTo({ cell: other }),
  };
});
