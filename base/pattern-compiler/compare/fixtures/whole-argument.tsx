/// <cts-enable />
import { pattern, Writable } from "commonfabric";

interface ContextInput {
  input: string;
  count: Writable<number>;
  label: string;
  "jam": Writable<number>;
}

// A pattern that is compiled into its caller and passes its whole
// argument on.
const Context = pattern<ContextInput, ContextInput>((context) => context);

// The call binds `input` to a value that the caller computes, `count`
// and `jam` to an input, the second under a computed key that is a
// string literal, and `label` to a literal.
export default pattern<{ note: string; count: Writable<number> }>(
  ({ note, count }) => {
    const input = note + "!";
    const context = Context({ input, count, label: "l", ["jam"]: count });
    return { context };
  },
);
