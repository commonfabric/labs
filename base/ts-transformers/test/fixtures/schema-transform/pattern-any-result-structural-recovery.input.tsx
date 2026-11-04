import { pattern } from "commonfabric";

declare function fetchAny(): any;

// FIXTURE: pattern-any-result-structural-recovery
// Verifies: inferred pattern results can still emit concrete object schemas when
// `any` only appears in nested properties.
//   pattern<Input>(fn) → pattern(fn, inputSchema, objectResultSchema)
// Context: the top-level result stays structural, but `title` degrades to `true`.
export default pattern<{ prompt: string }>(({ prompt }) => {
  return { title: fetchAny().title, prompt };
});
