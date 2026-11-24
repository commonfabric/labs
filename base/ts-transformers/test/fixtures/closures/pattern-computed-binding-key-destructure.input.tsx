import { pattern } from "commonfabric";

const key = "foo" as const;

// FIXTURE: pattern-computed-binding-key-destructure
// Verifies: computed binding-name destructuring is lowered structurally
//   ({ [key]: foo }) → const foo = __cf_pattern_input.key(key)
export default pattern<{ foo: string }>(({ [key]: foo }) => <div>{foo}</div>);
