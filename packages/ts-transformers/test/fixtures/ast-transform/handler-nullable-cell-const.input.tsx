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
// Verifies: a cause for a value that may be nullish goes on an optional `.for()`
//   const a = state.profile?.resolveAsCell() → state.profile?.resolveAsCell()?.for("a", true)
//   const b = maybeCell(state.profile)       → maybeCell(state.profile)?.for("b", true)
//   const c = state.out.resolveAsCell()      → state.out.resolveAsCell().for("c", true)
//   { profile: a }                           → { profile: a?.for(["d", "profile"], true) }
// Context: An absent optional cell leaves the value `undefined`, and a plain
//   `.for()` on it throws.
const record = handler<void, State>((_, state) => {
  const a = state.profile?.resolveAsCell();
  const b = maybeCell(state.profile);
  const c = state.out.resolveAsCell();
  const d = { profile: a };
  c.set([a, b, d]);
});

export default pattern<State>(({ profile, out }) => {
  return { record: record({ profile, out }) };
});
