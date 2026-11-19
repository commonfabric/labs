/// <cts-enable />
import {
  Default,
  equalsKey,
  lift,
  pattern,
  type ReadonlyCell,
} from "commonfabric";

interface Item {
  name: string;
}

// A record whose members the body declares as handles: each member is a
// handle to its position, which names the cell the position links to.
const named = lift(
  (
    { byName }: {
      // deno-lint-ignore ban-types
      byName: Default<Record<string, ReadonlyCell<Item>>, {}>;
    },
  ): string[] =>
    Object.entries(byName).map(([key, member]) =>
      `${key}:${member.get()?.name}:${
        equalsKey(member) === equalsKey(byName.a)
      }`
    ),
);

export default pattern<{ byName: Record<string, Item> }>(({ byName }) => ({
  listed: named({ byName }),
}));
