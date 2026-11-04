import ts from "typescript";

import type {
  DataFlowAnalysis,
  NormalizedDataFlow,
  ReactiveContextKind,
} from "../../ast/mod.ts";
import { TransformationContext } from "../../core/mod.ts";
import type { ExpressionContainerKind } from "../expression-site-types.ts";

export type ReactiveHelperName =
  | "lift"
  | "ifElse"
  | "when"
  | "unless"
  | "toSchema";
export type AnalyzeFn = (expression: ts.Expression) => DataFlowAnalysis;

export interface RewriteParams {
  readonly expression: ts.Expression;
  readonly analysis: DataFlowAnalysis;
  readonly context: TransformationContext;
  readonly analyze: AnalyzeFn;

  /**
   * Effective reactive context at the rewrite site.
   */
  readonly reactiveContextKind?: ReactiveContextKind;

  readonly containerKind?: ExpressionContainerKind;

  /**
   * True when inside a safe callback wrapper (action, handler, computed, etc.)
   * where opaque reading is allowed. In safe contexts, we still need to apply
   * semantic transformations (&&->when, ||->unless) but NOT lift-applied wrappers.
   */
  readonly inSafeContext?: boolean;

  /**
   * When true, reactive compute wrappers introduced during rewriting should
   * be emitted as a lift-applied form bound to its captured inputs
   * (`__cfHelpers.lift(cb)(inputs)`) rather than a zero-input thunk
   * (`__cfHelpers.lift(() => expr)({})`). Pre-CT-1615 this flag's name
   * referred to "derive vs computed" emission shapes; post-Phase-1 both
   * shapes are forms of lift-applied. The flag still controls whether
   * captured refs flow through the input object or via lexical closure
   * (with closures later lifted by ClosureTransformer when possible).
   * Used by post-closure lowering passes that run after
   * LiftLoweringTransformer.
   */
  readonly preferInputBoundWrappers?: boolean;
}

export interface EmitterContext extends RewriteParams {
  readonly dataFlows: readonly NormalizedDataFlow[];
  readonly inSafeContext: boolean;
  readonly reactiveContextKind: ReactiveContextKind;
  readonly containerKind?: ExpressionContainerKind;
  readonly preferInputBoundWrappers: boolean;
  rewriteChildren(node: ts.Expression): ts.Expression;
  rewriteSubexpression(node: ts.Expression): ts.Expression;
}

export type Emitter = (params: EmitterContext) => ts.Expression | undefined;
