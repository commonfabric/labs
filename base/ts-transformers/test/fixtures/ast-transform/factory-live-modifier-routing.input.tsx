// FIXTURE: factory-live-modifier-routing
// Verifies: directly derived live factories remain callable factory values.
// Expected: asScope()/inSpace() chains stay direct and are never wrapped in
//   __cf_data as plain module-scope values.
import { lift, pattern } from "commonfabric";
import "commonfabric/schema";

const basePattern = pattern<{ value: number }, { result: number }>(
  ({ value }) => ({ result: value }),
);
const baseModule = lift((input: { value: number }) => ({
  result: input.value,
}), {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
}, {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
});

export const scopedModule = baseModule.asScope("session");
export default basePattern.asScope("space").inSpace();
