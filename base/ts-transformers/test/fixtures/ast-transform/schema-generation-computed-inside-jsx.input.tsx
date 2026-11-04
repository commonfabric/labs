import { computed } from "commonfabric";

declare const value: number;

// FIXTURE: schema-generation-computed-inside-jsx
// Verifies: a reactive builder inside a JSX expression still gets schemas injected
//   computed(() => value * 2) → captures `value` and lowers to lift(inputSchema, outputSchema, ...)
// Context: computed() appears as a JSX child expression, not a standalone statement
export const result = (
  <div>
    {computed(() => value * 2)}
  </div>
);
