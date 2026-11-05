import { pattern } from "commonfabric";

interface Input {
  flag: boolean | null;
}

interface Output {
  flag: boolean | null;
}

// FIXTURE: nullable-boolean
// Verifies: pattern input and output schemas retain null in boolean unions.
//   boolean | null → { anyOf: [{ type: "boolean" }, { type: "null" }] }
export default pattern<Input, Output>(({ flag }) => ({ flag }));
