export {
  type BeforeTransformersResult,
  type TransformerPipelineResult,
  TypeScriptCompiler,
  type TypeScriptCompilerOptions,
} from "./compiler.ts";
export {
  type AuthoredSource,
  type AuthoredSourceLookup,
  CompilationError,
  type CompilationErrorType,
  CompilerError,
  type DiagnosticMessageTransformer,
  formatTransformerDiagnostic,
  type TransformerDiagnosticInfo,
  TransformerError,
} from "./diagnostics/mod.ts";
export { getCompilerOptions, TARGET } from "./options.ts";
export {
  collectImportSpecifiers,
  resolveImportSpecifier,
  type ResolveModuleConfig,
  resolveProgram,
  type UnresolvedModuleHandling,
} from "./resolver.ts";
