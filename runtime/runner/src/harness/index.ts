export {
  CompilerStackLoadError,
  ensureCompilerStack,
} from "./deferred-compiler-stack.ts";
export { Engine, EngineProgramResolver } from "./engine.ts";
export type { EngineOptions } from "./engine.ts";
export type {
  HarnessedFunction,
  RuntimeProgram,
  TypeScriptHarnessProcessOptions,
} from "./types.ts";
export { Console, ConsoleEvent, ConsoleMethod } from "./console.ts";
export {
  computeEntryIdentity,
  type EntryIdentityOptions,
  resolveEntryIdentity,
} from "./entry-identity.ts";
