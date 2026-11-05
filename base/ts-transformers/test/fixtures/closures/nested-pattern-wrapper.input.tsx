import { pattern } from "commonfabric";

// FIXTURE: nested-pattern-wrapper
// Verifies: each nested wrapper receives its own base factory and exactly one
// curry rather than rebinding an already-bound inner factory.
export default pattern<{ prefix: string }>(({ prefix }) => ({
  outer: pattern<{ suffix: string }>(({ suffix }) => ({
    inner: pattern<{ value: string }>(({ value }) => ({
      text: `${prefix}:${suffix}:${value}`,
    })),
  })),
}));
