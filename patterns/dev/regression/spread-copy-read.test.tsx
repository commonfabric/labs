/**
 * A builder that copies an array with a spread reads, through the copy, every
 * member it names.
 *
 * The builder's input schema is narrowed to the members its body reads, and a
 * comparator or a lookup reads only some members of the source's elements.
 * The copy carries those elements on whole: held in a local and read again,
 * or handed to a helper, it must keep every member the later read names, or
 * the builder reads that member as `undefined`. Each case reads `name` only
 * through the copy, after something else has read `id`.
 *
 * Run: deno task cf test patterns/dev/regression/spread-copy-read.test.tsx
 */
import { assert, lift, pattern, TESTS, Writable } from "commonfabric";

interface Row {
  id: number;
  name: string;
}

const namesOf = (rows: readonly Row[]): string =>
  rows.map((row) => row.name).join(",");

const sortedNamesFromLocal = lift(({ rows }: { rows: Row[] }): string => {
  const copy = [...rows].sort((a, b) => a.id - b.id);
  return copy.map((row) => row.name).join(",");
});

const sortedNamesFromHelper = lift(({ rows }: { rows: Row[] }): string =>
  namesOf([...rows].sort((a, b) => a.id - b.id))
);

const firstIdAndNames = lift(({ rows }: { rows: Row[] }): string => {
  const first = rows.find((row) => row.id === 1);
  return `${first?.id}:${namesOf([...rows])}`;
});

export default pattern(() => {
  const rows = new Writable<Row[]>([
    { id: 2, name: "B" },
    { id: 1, name: "A" },
  ]);
  const fromLocal = sortedNamesFromLocal({ rows });
  const fromHelper = sortedNamesFromHelper({ rows });
  const besideLookup = firstIdAndNames({ rows });

  const assert_local_copy_keeps_names = assert(() => fromLocal === "A,B");
  const assert_helper_copy_keeps_names = assert(() => fromHelper === "A,B");
  const assert_copy_beside_lookup_keeps_names = assert(() =>
    besideLookup === "1:B,A"
  );

  return {
    [TESTS]: [
      { assertion: assert_local_copy_keeps_names },
      { assertion: assert_helper_copy_keeps_names },
      { assertion: assert_copy_beside_lookup_keeps_names },
    ],
  };
});
