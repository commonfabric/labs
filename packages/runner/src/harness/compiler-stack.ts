/**
 * The ONLY static importer of the TypeScript compiler stack inside the runner.
 *
 * `typescript` is ~10MB and its CJS→ESM interop alone costs tens of ms of
 * every runtime-worker spawn, yet the steady-state boot path (evaluate
 * already-compiled patterns by identity) never compiles or parses. Keeping
 * every compiler-stack value import behind this module — loaded via the
 * dynamic import in `deferred-compiler-stack.ts` — defers that cost to the
 * first flow that actually compiles, resolves, or verifies source.
 *
 * Rules:
 * - Runtime modules must not import `typescript`, `@commonfabric/js-compiler`
 *   (the root or `./typescript` entries), or `@commonfabric/ts-transformers`
 *   (the root entry) as VALUES. `import type` is fine (erased); the
 *   typescript-free subpaths (`js-compiler/{program,specifier,source-map,
 *   errors,interface}`, `ts-transformers/runtime-contract`) are fine.
 * - Add new compiler-stack values HERE and reach them through
 *   `compilerStack()` after an `ensureCompilerStack()` on the owning flow.
 */

import ts from "typescript";
export { ts };
export {
  CommonFabricTransformerPipeline,
  createReactiveErrorTransformer,
  isLegacyInjectedEnvelope,
  transformCfDirective,
} from "@commonfabric/ts-transformers";
export {
  collectDataFileNames,
  collectImportSpecifiers,
  getTypeScriptEnvironmentTypes,
  scanModuleDeclarations,
  TypeScriptCompiler,
} from "@commonfabric/js-compiler";
export { resolveProgram, TARGET } from "@commonfabric/js-compiler/typescript";
