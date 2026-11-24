// Expose `getPatternEnvironment` even if unused so that (dynamic) patterns
// can still import from the host context.
export { getPatternEnvironment, setPatternEnvironment } from "./builder/env.ts";
