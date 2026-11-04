import { handler, pattern, type Writable } from "commonfabric";

interface State {
  profile?: Writable<string>;
  text: Writable<string>;
  count: Writable<number>;
  out: Writable<unknown>;
}

function cellOrString(cell: Writable<string>): Writable<string> | string {
  return cell;
}

function cellOrStringOrNone(
  cell: Writable<string> | undefined,
): Writable<string> | string | undefined {
  return cell;
}

function eitherCell(
  text: Writable<string>,
  count: Writable<number>,
): Writable<string> | Writable<number> {
  return text.get() ? text : count;
}

// FIXTURE: handler-cell-or-value-call
// Verifies: a cause goes on a value only when its type is a cell in every arm
//   a value can take
//   const a = cellOrString(state.text)        → unchanged (a string arm)
//   const b = cellOrStringOrNone(...)         → unchanged (a string arm)
//   const c = eitherCell(...)                 → eitherCell(...).for("c", true)
//   const d = state.profile?.resolveAsCell()! → state.profile?.resolveAsCell()!.for("d", true)
//   { text: a }                               → unchanged (a string arm)
//   { count: c }                              → { count: c.for(["e", "count"], true) }
// Context: `.for()` is not a method of a string, so a plain `.for()` on a
//   value that may be one throws, and a `?.for()` would throw the same way. A
//   non-null assertion says the value is present, so the access stays plain
//   even on an optional chain.
const record = handler<void, State>((_, state) => {
  const a = cellOrString(state.text);
  const b = cellOrStringOrNone(state.profile);
  const c = eitherCell(state.text, state.count);
  const d = state.profile?.resolveAsCell()!;
  const e = { text: a, count: c };
  state.out.set([a, b, c, d, e]);
});

export default pattern<State>(({ profile, text, count, out }) => {
  return { record: record({ profile, text, count, out }) };
});
