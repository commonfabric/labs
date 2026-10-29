import { isDeno } from "@commonfabric/utils/env";
import ports from "@commonfabric/ports" with { type: "json" };

// Environment configuration provided to patterns. Could
// eventually be e.g. `import.meta` exposed to patterns.
//
// /!\ These should not be globals (outside of pattern execution context).
// /!\ Execution needs to be sandboxed to prevent patterns setting these values.

// Environment configuration available to patterns.
export interface PatternEnvironment {
  readonly apiUrl: URL;
}

function clonePatternEnvironment(env: PatternEnvironment): PatternEnvironment {
  // Keep this clone explicit so future environment fields are reviewed for
  // mutability before they are exposed to authored code.
  return Object.freeze({
    apiUrl: new URL(env.apiUrl.href),
  });
}

let globalEnv = clonePatternEnvironment({
  apiUrl: isDeno()
    ? new URL(`http://localhost:${ports.toolshed}`)
    : new URL(new URL(globalThis.location.href).origin),
});

// Sets the `PatternEnvironment` for all patterns executed
// within this JavaScript context.
export function setPatternEnvironment(env: PatternEnvironment) {
  globalEnv = clonePatternEnvironment(env);
}

// Gets the `PatternEnvironment` for all patterns executed
// within this JavaScript context.
//
// User-visible.
export function getPatternEnvironment(): PatternEnvironment {
  return clonePatternEnvironment(globalEnv);
}
