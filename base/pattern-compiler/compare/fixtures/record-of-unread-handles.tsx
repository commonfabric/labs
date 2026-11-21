/// <cts-enable />
import { Default, lift, pattern, type ReadonlyCell } from "commonfabric";

interface Row {
  member: unknown;
  name: string;
}

// A record whose members the body declares as handles and reads through
// none of: each row holds the handle, which is written as a reference to
// the cell the member's position links to (the form of `namesTable` in
// `patterns/product/collection-naming/naming.ts`).
const table = lift(
  (
    { byName }: {
      // deno-lint-ignore ban-types
      byName: Default<Record<string, ReadonlyCell<unknown>>, {}>;
    },
  ): Row[] =>
    Object.entries(byName).map(([name, member]) => ({ member, name })),
);

export default pattern<{ byName: Record<string, unknown> }>(({ byName }) => ({
  rows: table({ byName }),
}));
