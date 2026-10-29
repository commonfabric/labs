import { toSchema } from "commonfabric";

interface Config {
  count: number;
  label: string;
  offset: number;
}

const configSchema = toSchema<Config>({
  // Parentheses and the type-only assertion forms change no value, but each is
  // a distinct AST node. Evaluating the options object without seeing through
  // them drops the property entirely -- for EVERY option type, not just
  // numbers.
  description: ("a description"),
  "default": {
    count: (1),
    label: ("text"),
    // Nested inside a sign, where unwrapping at the outermost level cannot
    // reach it.
    offset: -(1 as number),
  },
  examples: [("one"), (2), (3 satisfies number)],
});
// FIXTURE: wrapped-options
// Verifies: a value wrapped in parentheses or a type-only assertion survives in
// the toSchema options object, whatever its type and however deeply the wrapper
// is nested. Each of these properties was silently dropped before -- including
// plainly non-numeric ones, which is why the unwrapping belongs in the options
// evaluator rather than in its numeric special case.
export { configSchema };
