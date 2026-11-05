import { pattern } from "commonfabric";

interface Input {
  foo: string;
  count: number;
  enabled: boolean;
}

// FIXTURE: pattern-interface-default-sibling-fields
// Verifies: interface-backed destructuring defaults keep schema defaults and non-default sibling fields
//   ({ foo = "fallback", count = 0 }) → schema defaults for foo/count
//   enabled stays present in the input schema even though it is not destructured
export default pattern<Input>(({ foo = "fallback", count = 0 }) => (
  <div>
    {foo}:{count}
  </div>
));
