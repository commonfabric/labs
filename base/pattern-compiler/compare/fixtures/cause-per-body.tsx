/// <cts-enable />
import { lift, pattern, Writable } from "commonfabric";

// Two bodies make a cell under the same cause and return it, as the rows
// of Topics' board are made: each is a cell of its own body
// (`plan-and-label-templates.md` §1.3), so neither overwrites the
// other's.
const first = lift(({ name }: { name: string }): Writable<string> => {
  const cell = Writable.for<string>("row");
  cell.set(`first ${name}`);
  return cell;
});

const second = lift(({ name }: { name: string }): Writable<string> => {
  const cell = Writable.for<string>("row");
  cell.set(`second ${name}`);
  return cell;
});

export default pattern<{ name: string }>(({ name }) => ({
  a: first({ name }),
  b: second({ name }),
}));
