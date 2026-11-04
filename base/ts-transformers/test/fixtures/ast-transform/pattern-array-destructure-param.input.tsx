import { pattern } from "commonfabric";

// FIXTURE: pattern-array-destructure-param
// Verifies: top-level array destructuring in pattern params lowers to index-based key access
//   ([first]) => <div>{first}</div> → const first = __cf_pattern_input.key("0")
export default pattern<[string]>(([first]) => <div>{first}</div>);
