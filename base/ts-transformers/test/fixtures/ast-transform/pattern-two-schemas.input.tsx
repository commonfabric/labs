import { computed, pattern, type JSONSchema } from "commonfabric";
import "commonfabric/schema";

// Test that pattern with both schemas already present is not transformed
interface Input { count: number }
interface Result { doubled: number }

// FIXTURE: pattern-two-schemas
// Verifies: pattern with both input and output schemas already present preserves them
//   pattern<Input, Result>(fn, inputSchema, outputSchema) → pattern(fn, inputSchema, outputSchema) (schemas kept)
//   ({ count }) destructuring                              → __cf_pattern_input.key("count")
// Context: Schemas are user-provided, not generated; type args are stripped but schemas remain
export default pattern<Input, Result>(
  ({ count }) => {
    return {
      doubled: computed(() => count * 2)
    };
  },
  {
    type: "object",
    properties: {
      count: { type: "number" }
    },
    required: ["count"]
  } as const satisfies JSONSchema,
  {
    type: "object",
    properties: {
      doubled: { type: "number" }
    },
    required: ["doubled"]
  } as const satisfies JSONSchema,
);
