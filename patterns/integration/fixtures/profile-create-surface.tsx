/// <cts-enable />
// FIXTURE (multi-runtime integration): wishes for `#profile` in a space that
// holds none, which is what makes the runtime open the profile-create surface.
//
// The whole wish state is on the output, not just its `result`, so the test
// can walk into the `[UI]` node the wish renders and reach the surface's own
// piece behind it.
import { NAME, pattern, UI, type VNode, wish } from "commonfabric";

interface Output {
  [NAME]: string;
  [UI]: VNode;
  profile: unknown;
}

export default pattern<void, Output>(() => {
  const profile = wish<unknown>({ query: "#profile" });
  return {
    [NAME]: "profile-create-surface (multi-runtime fixture)",
    [UI]: <div>{profile[UI]}</div>,
    profile,
  };
});
