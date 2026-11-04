import { pattern } from "commonfabric";

// FIXTURE: pattern-computed-literal-member-default
// Verifies: literal-member destructuring defaults survive into schema defaults
//   ({ ["foo"]: foo = "fallback" }) → schema default on "foo"
export default pattern<{ ["foo"]: string; bar: string }>(
  ({ ["foo"]: foo = "fallback" }) => <div>{foo}</div>,
);
