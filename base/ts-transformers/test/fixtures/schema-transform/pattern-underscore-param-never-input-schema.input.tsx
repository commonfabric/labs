import { pattern } from "commonfabric";

// FIXTURE: pattern-underscore-param-never-input-schema
// Verifies: underscore-prefixed authored pattern params still emit the `false`
// / never input schema while preserving the result schema.
export default pattern((_state: { name: string; count: number }) => {
  return { ok: true as const };
});
