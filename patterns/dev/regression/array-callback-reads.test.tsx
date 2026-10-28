/**
 * An array method's callback reads every member it names of the elements it
 * is called with, wherever the transformer cannot follow the read.
 *
 * The builder's input schema is narrowed to the members its body reads, and
 * another callback here reads only `id`. A callback passed by name, a read
 * through the array a callback is handed, and the element `reduce` hands its
 * callback second all read `name` where the narrowing would not see it, so
 * the callback would read `undefined` and a filter would drop every row.
 *
 * Run: deno task cf test packages/patterns/regression/array-callback-reads.test.tsx
 */
import { assert, lift, pattern, TESTS, Writable } from "commonfabric";

interface Row {
  id: number;
  name: string;
}

const isA = (row: Row): boolean => row.name === "A";

const namesOf = (rows: readonly Row[]): string =>
  rows.map((row) => row.name).join(",");

const sortedCopyByName = lift(({ rows }: { rows: Row[] }): Row[] =>
  [...rows].sort((a, b) => a.id - b.id).filter(isA)
);

const sortedCopyThroughArray = lift(({ rows }: { rows: Row[] }): Row[] =>
  [...rows].sort((a, b) => a.id - b.id).filter((_, index, all) =>
    all[index].name === "A"
  )
);

const filteredByName = lift(({ rows }: { rows: Row[] }): Row[] =>
  rows.filter((row) => row.id > 0).filter(isA)
);

const anyNamedA = lift(({ rows }: { rows: Row[] }): boolean =>
  rows.filter((row) => row.id > 0).length > 0 &&
  rows.reduce((seen, row) => seen || row.name === "A", false)
);

const names = lift(({ rows }: { rows: Row[] }): string => namesOf(rows));

export default pattern(() => {
  const rows = new Writable<Row[]>([
    { id: 2, name: "B" },
    { id: 1, name: "A" },
  ]);
  const byName = names({ rows: sortedCopyByName({ rows }) });
  const throughArray = names({ rows: sortedCopyThroughArray({ rows }) });
  const filtered = names({ rows: filteredByName({ rows }) });
  const reduced = anyNamedA({ rows });

  const assert_named_callback_reads_name = assert(() => byName === "A");
  const assert_array_parameter_reads_name = assert(() => throughArray === "A");
  const assert_named_callback_on_filter_reads_name = assert(() =>
    filtered === "A"
  );
  const assert_reduce_element_reads_name = assert(() => reduced === true);

  return {
    [TESTS]: [
      { assertion: assert_named_callback_reads_name },
      { assertion: assert_array_parameter_reads_name },
      { assertion: assert_named_callback_on_filter_reads_name },
      { assertion: assert_reduce_element_reads_name },
    ],
  };
});
