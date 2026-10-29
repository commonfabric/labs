import { pattern, UI } from "commonfabric";

// FIXTURE: boolean-result-schema-normalization
// Verifies: boolean result schemas stay normalized as `type: "boolean"` instead
// of expanding into literal `true` / `false` enums.
export default pattern((state: { isPremium: boolean; score: number }) => {
  return {
    [UI]: <div>{state.isPremium || state.score > 100 ? "Premium" : "Regular"}</div>,
  };
});
