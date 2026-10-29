export type {
  AuthoredSourceRewrite,
  BuilderSourceSiteOptions,
  DiagnosticSeverity,
  PatternCoverageKind,
  PatternCoverageOptions,
  PatternCoverageSpan,
  TransformationContext,
  TransformationDiagnostic,
  TransformationOptions,
} from "./core/mod.ts";
export {
  CrossStageState,
  injectCfHelpers,
  isLegacyInjectedEnvelope,
  PATTERN_COVERAGE_GLOBAL,
  transformCfDirective,
  Transformer,
} from "./core/mod.ts";
export type {
  BuilderSourceSite,
  BuilderSourceSitesV1,
  CfcPolicyCompilerManifestV1,
} from "./core/runtime-contract.ts";
export { isBuilderSourceSitesV1 } from "./core/runtime-contract.ts";
export {
  CFC_CANONICAL_ALIAS_NAMES,
  type CfcCanonicalAliasName,
} from "./cfc-authoring.ts";

export {
  CastValidationTransformer,
  JsxExpressionSiteRouterTransformer,
  PatternCallbackLoweringTransformer,
  PatternContextValidationTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
} from "./transformers/mod.ts";
export { ClosureTransformer } from "./closures/transformer.ts";
export { CommonFabricTransformerPipeline } from "./cf-pipeline.ts";
export { createReactiveErrorTransformer } from "./diagnostics/mod.ts";
