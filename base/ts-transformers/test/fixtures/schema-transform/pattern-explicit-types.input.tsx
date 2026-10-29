import {
  computed,
  pattern,
} from "commonfabric";

interface Input {
  foo: string;
}

interface Output extends Input {
  bar: number;
}

// FIXTURE: pattern-explicit-types
// Verifies: explicit Input and Output type parameters generate separate input/output schemas
//   pattern<Input, Output>() → input schema from Input, output schema from Output (includes inherited fields)
//   Output extends Input → output schema includes both own (bar) and inherited (foo) properties
export default pattern<Input, Output>((input) => {
  return computed(() => ({ ...input, bar: 123 }));
});
