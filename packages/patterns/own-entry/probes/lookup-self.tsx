import { type Cell, type KeyIndex, lift, pattern, SELF } from "commonfabric";

interface Row {
  member: Cell<{ title?: string }>;
  name: string;
}

interface Input {
  index: KeyIndex<Cell<{ title?: string }>, Row>;
}

interface Output {
  title: string;
  name?: string;
}

const nameOfRow = lift((
  { row }: { row: { name: string } | undefined },
): string | undefined => row?.name);

export default pattern<Input, Output>(({ index, [SELF]: self }) => {
  const name = nameOfRow({
    row: index.lookup(self as Cell<{ title?: string }>),
  });
  return { title: "x", name };
});
