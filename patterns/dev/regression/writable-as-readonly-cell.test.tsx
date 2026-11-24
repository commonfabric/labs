/**
 * A `Writable` passes where a helper, a handler's state, or a pattern's input
 * declares a `ReadonlyCell`, and each reads the cell's current value through
 * it.
 *
 * `sizeOf()` declares the `ReadonlyCell` it reads. A `computed()` in the test
 * pattern and the `addRow` handler hand it a `Writable`; `Size` declares a
 * `ReadonlyCell` input and is given the same `Writable`; `recordSize` declares
 * a `ReadonlyCell` in its state and is bound to it too.
 *
 * Run: deno task cf test patterns/dev/regression/writable-as-readonly-cell.test.tsx
 */
import {
  assert,
  computed,
  handler,
  pattern,
  type ReadonlyCell,
  TESTS,
  Writable,
} from "commonfabric";

/** How many rows `rows` holds. */
function sizeOf(rows: ReadonlyCell<string[]>): number {
  return rows.get().length;
}

const Size = pattern<{ rows: ReadonlyCell<string[]> }, { size: number }>(
  ({ rows }) => ({ size: computed(() => sizeOf(rows)) }),
);

const addRow = handler<{ row: string }, { rows: Writable<string[]> }>(
  ({ row }, { rows }) => {
    if (sizeOf(rows) < 3) rows.set([...rows.get(), row]);
  },
);

const recordSize = handler<
  void,
  { rows: ReadonlyCell<string[]>; recorded: Writable<number> }
>((_, { rows, recorded }) => {
  recorded.set(sizeOf(rows));
});

export default pattern(() => {
  const rows = new Writable<string[]>([]);
  const recorded = new Writable(0);
  const fromHelper = computed(() => sizeOf(rows));
  const fromPattern = Size({ rows });
  const add = addRow({ rows });
  const record = recordSize({ rows, recorded });

  const assertEmpty = assert(() => fromHelper === 0 && fromPattern.size === 0);
  const assertTwo = assert(() => fromHelper === 2 && fromPattern.size === 2);
  const assertRecorded = assert(() => recorded.get() === 2);
  const assertCapped = assert(() => rows.get().length === 3);

  return {
    [TESTS]: [
      { assertion: assertEmpty },
      { action: add, event: { row: "a" } },
      { action: add, event: { row: "b" } },
      { assertion: assertTwo },
      { action: record },
      { assertion: assertRecorded },
      { action: add, event: { row: "c" } },
      { action: add, event: { row: "d" } },
      { assertion: assertCapped },
    ],
  };
});
