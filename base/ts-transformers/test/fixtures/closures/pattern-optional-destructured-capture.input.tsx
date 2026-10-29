import { computed, pattern } from "commonfabric";

// FIXTURE: pattern-optional-destructured-capture
// Verifies: an optional pattern input (`opt?`) destructured and captured in a
//   closure is emitted optional in the derived lift's input schema (so it does
//   not gate the lift), while `ud: T | undefined` (no `?`) stays required. A
//   renamed binding tracks its source property's optionality whether the source
//   key is an identifier (`ren: renamed`) or a string literal (`"q-opt": qOpt`).
export default pattern<{
  req: string;
  opt?: string;
  ud: string | undefined;
  ren?: string;
  "q-opt"?: string;
}>(({ req, opt, ud, ren: renamed, "q-opt": qOpt }) => {
  const body = computed(() => ({
    req,
    ...(opt !== undefined && { opt }),
    ...(ud !== undefined && { ud }),
    ...(renamed !== undefined && { renamed }),
    ...(qOpt !== undefined && { qOpt }),
  }));
  return <div>{body}</div>;
});
