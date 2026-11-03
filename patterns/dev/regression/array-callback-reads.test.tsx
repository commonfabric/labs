/**
 * An array method's callback reads every member it names of the elements it
 * is called with, wherever the transformer cannot follow the read.
 *
 * The builder's input schema is narrowed to the members its body reads, and
 * another callback here reads only `id`. A callback passed by name, a read
 * through the array a callback is handed, the element `reduce` hands its
 * callback second, and the element `reduce` or `reduceRight` starts its
 * accumulator at when given no initial value all read `name` where the
 * narrowing would not see it, so the callback would read `undefined` and a
 * filter would drop every row. The named callback reads the same through a
 * conditional or a fallback around the copy it filters, and an inline
 * callback, a destructured parameter, an array parameter and a named
 * callback read the same where the
 * conditional's other branch is a second array or an array literal of
 * objects.
 *
 * Run: deno task cf test patterns/dev/regression/array-callback-reads.test.tsx
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

const conditionalCopyByName = lift(
  ({ rows, enabled }: { rows: Row[]; enabled: boolean }): Row[] =>
    (enabled ? [...rows].sort((a, b) => a.id - b.id) : []).filter(isA),
);

const fallbackCopyByName = lift(({ rows }: { rows: Row[] }): Row[] =>
  ([...rows].sort((a, b) => a.id - b.id) ?? []).filter(isA)
);

type Mixed = { rows: Row[]; other: Row[]; enabled: boolean };

const mixedInline = lift(({ rows, other, enabled }: Mixed): Row[] =>
  (enabled ? [...rows].sort((a, b) => a.id - b.id) : other)
    .filter((row) => row.name === "A")
);

const mixedDestructured = lift(({ rows, other, enabled }: Mixed): Row[] =>
  (enabled ? [...rows].sort((a, b) => a.id - b.id) : other)
    .filter(({ name }) => name === "A")
);

const mixedThroughArray = lift(({ rows, other, enabled }: Mixed): Row[] =>
  (enabled ? [...rows].sort((a, b) => a.id - b.id) : other)
    .filter((_, index, all) => all[index].name === "A")
);

const mixedWithLiteral = lift(({ rows, other, enabled }: Mixed): Row[] =>
  (enabled
    ? [...rows].sort((a, b) => a.id - b.id)
    : [{ id: other[0].id, name: "A" }]).filter(isA)
);

const filteredByName = lift(({ rows }: { rows: Row[] }): Row[] =>
  rows.filter((row) => row.id > 0).filter(isA)
);

const anyNamedA = lift(({ rows }: { rows: Row[] }): boolean =>
  rows.filter((row) => row.id > 0).length > 0 &&
  rows.reduce((seen, row) => seen || row.name === "A", false)
);

const firstName = lift(({ rows }: { rows: Row[] }): string =>
  rows.reduce((first, row) => ({ id: first.id + row.id, name: first.name }))
    .name
);

const lastName = lift(({ rows }: { rows: Row[] }): string =>
  rows.reduceRight((last, row) => ({ id: last.id + row.id, name: last.name }))
    .name
);

const names = lift(({ rows }: { rows: Row[] }): string => namesOf(rows));

export default pattern(() => {
  const rows = new Writable<Row[]>([
    { id: 2, name: "B" },
    { id: 1, name: "A" },
  ]);
  const byName = names({ rows: sortedCopyByName({ rows }) });
  const throughArray = names({ rows: sortedCopyThroughArray({ rows }) });
  const conditional = names({
    rows: conditionalCopyByName({ rows, enabled: true }),
  });
  const fallback = names({ rows: fallbackCopyByName({ rows }) });
  const other = [{ id: 3, name: "C" }];
  const inline = names({ rows: mixedInline({ rows, other, enabled: true }) });
  const destructured = names({
    rows: mixedDestructured({ rows, other, enabled: true }),
  });
  const mixedArray = names({
    rows: mixedThroughArray({ rows, other, enabled: true }),
  });
  const withLiteral = names({
    rows: mixedWithLiteral({ rows, other, enabled: true }),
  });
  const filtered = names({ rows: filteredByName({ rows }) });
  const reduced = anyNamedA({ rows });
  const first = firstName({ rows });
  const last = lastName({ rows });

  const assert_named_callback_reads_name = assert(() => byName === "A");
  const assert_array_parameter_reads_name = assert(() => throughArray === "A");
  const assert_conditional_copy_callback_reads_name = assert(() =>
    conditional === "A"
  );
  const assert_fallback_copy_callback_reads_name = assert(() =>
    fallback === "A"
  );
  const assert_mixed_inline_callback_reads_name = assert(() => inline === "A");
  const assert_mixed_destructured_parameter_reads_name = assert(() =>
    destructured === "A"
  );
  const assert_mixed_array_parameter_reads_name = assert(() =>
    mixedArray === "A"
  );
  const assert_mixed_literal_branch_keeps_name = assert(() =>
    withLiteral === "A"
  );
  const assert_named_callback_on_filter_reads_name = assert(() =>
    filtered === "A"
  );
  const assert_reduce_element_reads_name = assert(() => reduced === true);
  const assert_reduce_accumulator_reads_name = assert(() => first === "B");
  const assert_reduce_right_accumulator_reads_name = assert(() => last === "A");

  return {
    [TESTS]: [
      { assertion: assert_named_callback_reads_name },
      { assertion: assert_array_parameter_reads_name },
      { assertion: assert_conditional_copy_callback_reads_name },
      { assertion: assert_fallback_copy_callback_reads_name },
      { assertion: assert_mixed_inline_callback_reads_name },
      { assertion: assert_mixed_destructured_parameter_reads_name },
      { assertion: assert_mixed_array_parameter_reads_name },
      { assertion: assert_mixed_literal_branch_keeps_name },
      { assertion: assert_named_callback_on_filter_reads_name },
      { assertion: assert_reduce_element_reads_name },
      { assertion: assert_reduce_accumulator_reads_name },
      { assertion: assert_reduce_right_accumulator_reads_name },
    ],
  };
});
