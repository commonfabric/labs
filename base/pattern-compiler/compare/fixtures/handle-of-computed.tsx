/// <cts-enable />
import { lift, pattern, type ReadonlyCell } from "commonfabric";

interface Row {
  name: string;
}

// `named` computes an array whole, and `counted` declares a handle where
// it is given it: a handle bound to a value the instance computed
// (`footprint-analysis.md` §6.2), read through `get()` and `key()`.
const named = lift(({ names }: { names: string[] }): Row[] =>
  names.map((name) => ({ name }))
);

const counted = lift(({ rows }: { rows: ReadonlyCell<Row[]> }): string => {
  const count = rows.get()?.length ?? 0;
  return count === 0 ? "" : `${count}:${rows.key(0).key("name").get()}`;
});

export default pattern<{ names: string[] }>(({ names }) => {
  const rows = named({ names });
  return { rows, summary: counted({ rows }) };
});
