import {
  computed,
  pattern,
  UI,
  VNode,
} from "commonfabric";

// Simulates `any` leaking through a generic function (like generateObject)
declare function fetchAny(): any;

// FIXTURE: pattern-any-result-override
// Verifies: explicit Output type parameter overrides inferred `any` return type for schema generation
//   pattern<Input, string>() → output schema { type: "string" } instead of inferred any
//   pattern<Input, { [UI]: VNode }>() → output schema with $UI vnode $ref
// Context: simulates `any` leaking through generic functions; two named exports, no default
// Case 1: Explicit Output type overrides inferred `any` return
export const TypedFromAny = pattern<{ prompt: string }, string>(({ prompt }) => {
  const result = fetchAny();
  return computed(() => result?.title || prompt || "Untitled");
});

// Case 2: { [UI]: VNode } Output type instead of { [UI]: any }
type Entry = { name: string };
export const TypedUIOutput = pattern<Entry, { [UI]: VNode }>(({ name }) => {
  return {
    [UI]: (<div>{name}</div>),
  };
});
