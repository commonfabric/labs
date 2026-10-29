import { Default, pattern, UI } from "commonfabric";

interface PollState {
  users: Default<string[], []>;
}

// FIXTURE: ternary-binary-condition-body-alias
// Verifies: a JSX ternary whose condition is a binary comparison over a
//   body-level alias of a reactive read lowers without crashing the
//   compute-wrap invariant (lunch-poll PR #4928 shape 1):
//   const userCount = users.length; ... {userCount > 0 ? <div/> : null}
//     -> ifElse(<derived boolean>, <branch>, null)
// Context: regression companion to the builder-argument computation
//   diagnostic — this shape is supported and must keep lowering cleanly.
export default pattern<PollState>(({ users }) => {
  const userCount = users.length;
  return {
    [UI]: (
      <div>
        {userCount > 0 ? <div>has users</div> : null}
      </div>
    ),
  };
});
