import { pattern } from "commonfabric";

const identity = <T,>(value: T) => value;

// FIXTURE: pattern-top-level-root-lowering
// Verifies: top-level non-JSX ordinary helper calls with reactive inputs are
//   lifted as whole calls instead of lowering only inner argument expressions.
//   identity(state.user.name)     -> lift-applied local-helper root
//   identity(state.maybeUser?.name) -> lift-applied optional property access
//   Math.max(state.a, state.b)    -> lift-applied free-function root
//   parseInt(state.float)         -> lift-applied free-function root
//   state.label ?? "Pending"      -> lift-applied nullish root
//   state.items?.[0]              -> lowered optional element access
export default pattern<{
  user: { name: string };
  maybeUser?: { name: string };
  a: number;
  b: number;
  float: string;
  label?: string | null;
  items?: string[];
}>((state) => {
  const label = identity(state.user.name);
  const maybeLabel = identity(state.maybeUser?.name);

  return {
    label,
    maybeLabel,
    maxValue: Math.max(state.a, state.b),
    parsedValue: parseInt(state.float),
    fallbackLabel: state.label ?? "Pending",
    firstItem: state.items?.[0],
  };
});
