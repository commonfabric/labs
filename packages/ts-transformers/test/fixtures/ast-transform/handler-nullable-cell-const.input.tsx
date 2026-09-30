import { handler, pattern, type Writable } from "commonfabric";

interface State {
  profile?: Writable<string>;
  out: Writable<unknown>;
}

function maybeCell(
  cell: Writable<string> | undefined,
): Writable<string> | undefined {
  return cell;
}

// FIXTURE: handler-nullable-cell-const
// Verifies: a `const` whose initializer may be nullish gets an optional `.for()`
//   const a = state.profile?.resolveAsCell() → state.profile?.resolveAsCell()?.for("a", true)
//   const b = maybeCell(state.profile)       → maybeCell(state.profile)?.for("b", true)
//   const c = state.out.resolveAsCell()      → state.out.resolveAsCell().for("c", true)
// Context: An absent optional cell leaves the initializer `undefined`, and a
//   plain `.for()` on it throws.
const record = handler<void, State>((_, state) => {
  const a = state.profile?.resolveAsCell();
  const b = maybeCell(state.profile);
  const c = state.out.resolveAsCell();
  c.set([a, b]);
});

export default pattern<State>(({ profile, out }) => {
  return { record: record({ profile, out }) };
});
