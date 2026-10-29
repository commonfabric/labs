import ts from "typescript";

import { ClosureTransformer } from "./closures/transformer.ts";
import {
  CrossStageState,
  TransformationDiagnostic,
  TransformationOptions,
  Transformer,
} from "./core/mod.ts";
import type {
  BuilderSourceSitesV1,
  CfcPolicyCompilerManifestV1,
} from "./core/runtime-contract.ts";
import { LiftLoweringTransformer } from "./lift/transformer.ts";
import {
  AssertDiagnosticsTransformer,
  BuilderCallHoistingTransformer,
  CastValidationTransformer,
  CfcPolicyAuthoringTransformer,
  CfcPolicyOfValidationTransformer,
  EmptyArrayOfValidationTransformer,
  HelperOwnedExpressionSiteLoweringTransformer,
  IndirectBuilderCallbackValidationTransformer,
  JsxExpressionSiteRouterTransformer,
  MergeablePushValidationTransformer,
  ModuleScopeCfDataTransformer,
  ModuleScopeFunctionHardeningTransformer,
  ModuleScopeShadowingTransformer,
  OpaqueGetValidationTransformer,
  PatternCallbackLoweringTransformer,
  PatternContextValidationTransformer,
  PatternCoverageTransformer,
  PatternOwnedExpressionSiteLoweringTransformer,
  ReactiveVariableForTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
  VerbReturnValidationTransformer,
  VerbTierMarkTransformer,
  WriteAuthorizedByValidationTransformer,
} from "./transformers/mod.ts";

type TransformerStage = new (options: TransformationOptions) => Transformer;

const CFC_TRANSFORMER_STAGES: readonly TransformerStage[] = [
  CastValidationTransformer,
  EmptyArrayOfValidationTransformer,
  OpaqueGetValidationTransformer,
  PatternContextValidationTransformer,
  MergeablePushValidationTransformer,
  VerbReturnValidationTransformer,
  IndirectBuilderCallbackValidationTransformer,
  CfcPolicyAuthoringTransformer,
  CfcPolicyOfValidationTransformer,
  JsxExpressionSiteRouterTransformer,
  // Runs before lift lowering so it sees the authored expression: the operand
  // labels it records are the author's own source text, and the lowering that
  // follows rewrites the operands inside its capture calls as it would any
  // other reactive expression.
  AssertDiagnosticsTransformer,
  LiftLoweringTransformer,
  ClosureTransformer,
  PatternOwnedExpressionSiteLoweringTransformer,
  HelperOwnedExpressionSiteLoweringTransformer,
  WriteAuthorizedByValidationTransformer,
  PatternCallbackLoweringTransformer,
  SchemaInjectionTransformer,
  BuilderCallHoistingTransformer,
  SchemaGeneratorTransformer,
  // After SchemaGenerator (state + result schemas are literals) and before
  // ReactiveVariableFor (returned identifiers not yet `.for(...)`-wrapped):
  // the one window where session-scope inference is pure syntax.
  VerbTierMarkTransformer,
  ReactiveVariableForTransformer,
  ModuleScopeShadowingTransformer,
  ModuleScopeCfDataTransformer,
  // Coverage runs before function hardening. That keeps coverage counters out
  // of the hardening helper output. The transformer does no work unless
  // pattern coverage is enabled.
  PatternCoverageTransformer,
  ModuleScopeFunctionHardeningTransformer,
];

// The names come from the classes, so a stage rename reaches the spec-sync and
// pipeline-order tests without a second edit here.
export const CFC_TRANSFORMER_STAGE_NAMES: readonly string[] =
  CFC_TRANSFORMER_STAGES.map((stage) => stage.name);

export class CommonFabricTransformerPipeline {
  readonly #transformers: Transformer[];
  readonly #diagnosticsCollector: TransformationDiagnostic[];
  readonly #state: CrossStageState;

  constructor(options: TransformationOptions = {}) {
    const state = options.state ?? new CrossStageState();
    const ops: TransformationOptions = {
      ...options,
      state,
    };
    // Create a shared diagnostics collector
    const sharedOps: TransformationOptions = {
      ...ops,
      diagnosticsCollector: [],
    };
    this.#transformers = CFC_TRANSFORMER_STAGES.map(
      (Stage) => new Stage(sharedOps),
    );

    // Store reference to shared collector
    // Note: We need to access it after construction, so we store the array reference
    this.#diagnosticsCollector = sharedOps.diagnosticsCollector!;
    this.#state = state;
  }

  toFactories(program: ts.Program): ts.TransformerFactory<ts.SourceFile>[] {
    return this.#transformers.map((t) => t.toFactory(program));
  }

  /**
   * Returns all diagnostics collected during transformation.
   * Call this after running the pipeline to get errors and warnings.
   */
  getDiagnostics(): readonly TransformationDiagnostic[] {
    return this.#diagnosticsCollector;
  }

  /**
   * Clears accumulated diagnostics.
   * Call this if reusing the pipeline for multiple files.
   */
  clearDiagnostics(): void {
    this.#diagnosticsCollector.length = 0;
  }

  getBuilderSourceSites(): ReadonlyMap<string, BuilderSourceSitesV1> {
    return this.#state.getBuilderSourceSites();
  }

  getPolicyManifests(): ReadonlyMap<
    string,
    readonly CfcPolicyCompilerManifestV1[]
  > {
    return this.#state.getPolicyManifests();
  }
}
