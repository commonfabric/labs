import { type Cell, Default, handler, pattern } from "commonfabric";

interface OptionalBranch {
  counter?: number;
  label?: string;
}

interface OptionalNested {
  branch?: OptionalBranch;
}

interface NestedOptionalState {
  nested?: OptionalNested;
}

interface NestedOptionalArgs {
  // deno-lint-ignore ban-types
  state: Default<NestedOptionalState, {}>;
}

const increment = handler(
  (_, context: { state: Cell<NestedOptionalState> }) => {
    const current = context.state.get() ?? {};
    const branch = current.nested?.branch ?? {};
    const counter = (branch.counter ?? 0) + 1;
    context.state.set({ nested: { branch: { counter } } });
  },
);

// FIXTURE: nested-default-optional
// Verifies: nested optional interfaces with Default<> generate schemas with $ref/$defs and "default" values
//   Default<NestedOptionalState, {}> → schema property with "default": {}
//   Optional nested fields → $ref without "required" entries
//   handler() → injects event/context schemas with asCell annotations
//   pattern<Args>() → generates input schema, output schema (with asOpaque/asStream)
// Context: deeply nested optional types (OptionalBranch inside OptionalNested inside NestedOptionalState)
export default pattern<NestedOptionalArgs>(
  ({ state }) => {
    return {
      state,
      increment: increment({ state }),
    };
  },
);
