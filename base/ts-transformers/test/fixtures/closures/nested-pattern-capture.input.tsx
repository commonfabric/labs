import { pattern } from "commonfabric";

// FIXTURE: nested-pattern-capture
// Verifies: a nested pattern closes over an outer public input through the
// compiler-private params root without merging it into the child's input.
export default pattern<{ prefix: string }>(({ prefix }) => ({
  child: pattern<{ value: string }>(({ value }) => ({
    text: `${prefix}:${value}`,
  })),
}));
