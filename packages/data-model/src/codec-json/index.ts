// Loaded for its effect, and before anything else here: it installs the debug
// renderers, which the package's modules reach through
// `value-debug-internal.ts`.
import "@/value-debug/index.ts";

export { createBaseJsonRegistry } from "./createBaseJsonRegistry.ts";
export { JsonCodecEngine } from "./JsonCodecEngine.ts";
