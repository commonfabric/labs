import ts from "typescript";
import {
  classifyArrayMethodCall,
  classifyArrayMethodCallSite,
  detectCallKind,
  getCallArgumentPosition,
  getTypeAtLocationWithFallback,
  hasAuthoredSourceSite,
  isCollectionType,
  isEventHandlerJsxAttribute,
  isFunctionLikeExpression,
  isInRestrictedReactiveContext,
  isReactiveOriginTaggedTemplate,
  isSyntheticNode,
  type ReactiveContextInfo,
} from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import {
  isValueComputationExpressionKind,
  unwrapExpression,
} from "../utils/expression.ts";
import { getKnownComputedKeyExpression } from "../utils/reactive-keys.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";
import {
  type CallRootPolicyDecision,
  classifyCallRootPolicy,
  type ExpressionSiteCallRootKind,
  type ExpressionSiteHelperBoundaryKind,
  isCellReadTerminalCall,
  type SupportedCallRootKind,
  type UnsupportedCallRootKind,
} from "./call-root-support.ts";
import { shouldDeferFallbackMapReceiverRewrite } from "./expression-rewrite/fallback-array-method-rewrite.ts";
import {
  isJsxLocalRewriteContainer,
} from "./expression-rewrite/emitters/compute-wrap-invariants.ts";
import type { AnalyzeFn } from "./expression-rewrite/types.ts";
import { classifyOpaquePathTerminalCall } from "./opaque-roots.ts";
import type { ExpressionContainerKind } from "./expression-site-types.ts";
import {
  isPatternFactoryCalleeExpression,
  isStructuralReactiveFactoryExpression,
  returnsReactiveResult,
} from "./structural-reactive-factory.ts";

interface ExpressionSiteCallRootPolicyInfo {
  readonly reactiveContext: ReactiveContextInfo;
  readonly arrayMethodOwned: boolean;
  readonly helperBoundaryKind?: ExpressionSiteHelperBoundaryKind;
  readonly callRootKind?: ExpressionSiteCallRootKind;
}

interface ExpressionSitePolicyInfo extends ExpressionSiteCallRootPolicyInfo {
  readonly hasAuthoredSourceSite: boolean;
  readonly withinEventHandlerJsxAttribute: boolean;
  readonly syntheticComputeOwned: boolean;
  readonly deferredJsxArrayMethod: boolean;
  readonly controlFlowRewriteRoot: boolean;
}

type JsxExpressionSiteSkipReason =
  | "no-authored-source-site"
  | "event-handler-jsx-attribute"
  | "non-pattern-context"
  | "deferred-jsx-array-method-root"
  | "not-shared-jsx-root-kind";

/**
 * Who owns a lowered expression site — i.e. which lowering pass wraps it.
 * `array-method-receiver-method` and `array-method-callback-value` both route
 * to the array-method value-lift path (a receiver-method call vs a bare
 * value-expression such as `a === b`); see {@link isArrayMethodValueLiftOwner}.
 */
export type ExpressionSiteOwner =
  | "helper"
  | "array-method-callback-jsx"
  | "array-method-receiver-method"
  | "array-method-callback-value"
  | "jsx-root";

export type ExpressionSiteHandlingDecision =
  | {
    kind: "shared";
    lowerable: boolean;
    jsxRoute?: "shared-pre-closure" | "shared-post-closure";
  }
  | {
    kind: "owned";
    owner: ExpressionSiteOwner;
    lowerable: boolean;
  }
  | {
    kind: "skip";
    reason: JsxExpressionSiteSkipReason | "not-lowerable";
  };

export interface ExpressionSiteHandlingOptions {
  readonly allowDeferredRootOwner?: boolean;
}

export interface LowerableExpressionSite {
  readonly expression: ts.Expression;
  readonly containerKind: ExpressionContainerKind;
}

export type RestrictedReactiveComputationDecision =
  | {
    kind: "allowed";
    lowerableSite?: LowerableExpressionSite;
  }
  | {
    kind: "requires-computed";
  };

export function containsLogicalBinaryOperator(expr: ts.Expression): boolean {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    ) {
      return true;
    }
  }

  let found = false;
  expr.forEachChild((child) => {
    if (found || ts.isFunctionLike(child)) return;
    if (ts.isExpression(child) && containsLogicalBinaryOperator(child)) {
      found = true;
    }
  });
  return found;
}

function isLogicalBinaryExpression(
  expr: ts.Expression,
): expr is ts.BinaryExpression {
  return ts.isBinaryExpression(expr) &&
    (
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken
    );
}

function getControlFlowRewriteExpression(
  expr: ts.Expression,
): ts.Expression | undefined {
  const current = unwrapExpression(expr);
  if (
    ts.isConditionalExpression(current) || isLogicalBinaryExpression(current)
  ) {
    return current;
  }
  return undefined;
}

export function isControlFlowRewriteExpression(expr: ts.Expression): boolean {
  return !!getControlFlowRewriteExpression(expr);
}

function isPostClosureWrapperRewriteExpression(
  expr: ts.Expression,
  context: TransformationContext,
): boolean {
  const expression = unwrapExpression(expr);

  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isTemplateExpression(expression)
  ) {
    return true;
  }

  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return !!argument &&
      (
        ts.isLiteralExpression(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument) ||
        !!getKnownComputedKeyExpression(argument, context)
      );
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    return expression.operator === ts.SyntaxKind.ExclamationToken;
  }

  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    ) {
      return false;
    }

    if (operator === ts.SyntaxKind.QuestionQuestionToken) {
      return !shouldDeferFallbackMapReceiverRewrite(
        expression,
        context.checker,
      );
    }

    return true;
  }

  return false;
}

function isLocalValueReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return false;
  }

  const declarations = symbol.getDeclarations() ?? [];
  return declarations.some((declaration) =>
    !declaration.getSourceFile().isDeclarationFile && declaration.pos >= 0
  );
}

function getLeftmostMemberBase(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function classifyCallExpressionRoot(
  expression: ts.CallExpression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSiteCallRootKind {
  const callKind = detectCallKind(expression, context.checker);
  switch (callKind?.kind) {
    case "ifElse":
    case "when":
    case "unless":
      return "conditional-helper";
    case "builder":
    case "lift-applied":
    case "cell-factory":
    case "cell-for":
    case "wish":
    case "generate-text":
    case "generate-object":
    case "pattern-tool":
    case "runtime-call":
      return "other";
  }

  if (
    isPatternFactoryCalleeExpression(expression.expression, context.checker)
  ) {
    return "other";
  }

  const directCallee = unwrapExpression(expression.expression);
  if (
    expression.arguments.length > 0 &&
    (ts.isArrowFunction(directCallee) || ts.isFunctionExpression(directCallee))
  ) {
    return "parameterized-inline-call";
  }

  const callee = expression.expression;
  if (ts.isIdentifier(callee)) {
    if (
      returnsReactiveResult(expression, context.checker) ||
      isStructuralReactiveFactoryExpression(callee, context.checker)
    ) {
      return "other";
    }
    return "ordinary-call";
  }

  if (
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
  ) {
    const receiverAnalysis = analyze(callee.expression);
    if (receiverAnalysis.containsReactive) {
      return "receiver-method";
    }

    const base = getLeftmostMemberBase(callee);
    if (!ts.isIdentifier(base)) {
      return "other";
    }

    return "ordinary-call";
  }

  return "other";
}

function isSharedJsxLocalHelperCallRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  const callee = expression.expression;
  if (
    !ts.isIdentifier(callee) || !isLocalValueReference(callee, context.checker)
  ) {
    return false;
  }

  return analyze(expression).containsReactive;
}

function isSharedPostClosureCallRootKind(
  kind: ExpressionSiteCallRootKind | undefined,
): boolean {
  return kind === "ordinary-call" || kind === "parameterized-inline-call";
}

/**
 * True when a call site reads a cell — `count.get()` itself, or a call whose
 * receiver chain reaches one (`rows.get().toSorted(byDate)`,
 * `rows.get().items.join(", ")`).
 *
 * A cell read yields a plain snapshot, so the site holding it has to become a
 * lift for the value to stay reactive. `classifyCallRootPolicy` reports the read
 * as `restricted-get-call` and declines to classify a call over one, leaving
 * both shapes without a supported call root; the JSX router admits them anyway
 * (a bare read as an owned `jsx-root` site, a call over one as a shared
 * post-closure site). This is the same admission for the other container kinds,
 * so a binding, a return, an argument, or an object property holding a cell read
 * lowers into the lift its JSX spelling already gets.
 *
 * Receivers that are not cells are excluded by {@link isCellReadTerminalCall}:
 * a `.get()` on an opaque value is a mistake with its own diagnostic, not a
 * computation to lower.
 */
function isCellReadCallRootExpression(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  let current: ts.Expression = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) {
    return false;
  }

  while (true) {
    if (ts.isCallExpression(current)) {
      if (isCellReadTerminalCall(current, context)) {
        return true;
      }
      const callee = unwrapExpression(current.expression);
      if (
        !ts.isPropertyAccessExpression(callee) &&
        !ts.isElementAccessExpression(callee)
      ) {
        return false;
      }
      current = unwrapExpression(callee.expression);
      continue;
    }

    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = unwrapExpression(current.expression);
      continue;
    }

    return false;
  }
}

const STRUCTURAL_NESTED_CONTAINER_KINDS = new Set<ExpressionContainerKind>([
  "call-argument",
  "object-property",
  "array-element",
]);

const ARRAY_METHOD_SHARED_CALL_ROOT_CONTAINER_KINDS = new Set<
  ExpressionContainerKind
>([
  "return-expression",
  "object-property",
  "array-element",
]);

export function shouldPreferArrayMethodSharedCallRootSite(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const siteInfo = getExpressionSiteCallRootPolicyInfo(
    expression,
    context,
    analyze,
  );
  return siteInfo.arrayMethodOwned &&
    isSharedPostClosureCallRootKind(siteInfo.callRootKind) &&
    !isControlFlowRewriteExpression(expression);
}

function hasEnclosingArrayMethodSharedCallRootOwner(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  let current: ts.Node | undefined = expression.parent;

  while (current) {
    if (ts.isFunctionLike(current)) {
      return false;
    }

    if (
      ts.isCallExpression(current) &&
      shouldPreferArrayMethodSharedCallRootSite(current, context, analyze)
    ) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function isEligiblePatternOwnedWrapperCallbackSite(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return true;
  }

  const boundarySemantics = getCallbackBoundarySemantics(
    callbackContext.callback,
    context.checker,
    context,
  );
  return boundarySemantics.supportsPatternOwnedWrapperCallbackSite;
}

function hasEnclosingComputeLikeCallback(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return false;
  }

  let current: ts.Node | undefined = callbackContext.call.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const position = getCallArgumentPosition(current);
      if (position) {
        const callKind = detectCallKind(position.call, context.checker);
        if (callKind?.kind === "lift-applied") {
          return true;
        }
        if (
          callKind?.kind === "builder" &&
          (callKind.builderName === "computed" ||
            callKind.builderName === "action" ||
            callKind.builderName === "lift" ||
            callKind.builderName === "handler")
        ) {
          return true;
        }
      }
    }
    current = current.parent;
  }

  return false;
}

function isWithinComputeLikePlainArrayValueCallback(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return false;
  }

  const boundarySemantics = getCallbackBoundarySemantics(
    callbackContext.callback,
    context.checker,
    context,
  );

  return boundarySemantics.isPlainArrayValueCallback &&
    hasEnclosingComputeLikeCallback(expression, context);
}

function isAtomicWholeBranchIife(
  branch: ts.Expression,
): boolean {
  const current = unwrapExpression(branch);
  if (!ts.isCallExpression(current) || current.questionDotToken) {
    return false;
  }

  const callee = unwrapExpression(current.expression);
  if (!ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) {
    return false;
  }

  if (!ts.isBlock(callee.body)) {
    return false;
  }

  const statements = callee.body.statements;
  if (statements.length === 0) {
    return false;
  }

  const lastStatement = statements[statements.length - 1];
  if (
    !lastStatement ||
    !ts.isReturnStatement(lastStatement) ||
    !lastStatement.expression ||
    !isJsxLocalRewriteContainer(lastStatement.expression)
  ) {
    return false;
  }

  return statements.slice(0, -1).every((statement) =>
    ts.isVariableStatement(statement)
  );
}

function isSharedPreClosureAtomicControlFlowExpression(
  expression: ts.Expression,
): boolean {
  const current = getControlFlowRewriteExpression(expression);
  if (!current) {
    return false;
  }

  if (ts.isConditionalExpression(current)) {
    return isAtomicWholeBranchIife(current.whenTrue) ||
      isAtomicWholeBranchIife(current.whenFalse);
  }

  return false;
}

function isSharedPreClosureDeferredArrayMethodControlFlowExpression(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = getControlFlowRewriteExpression(expression);
  if (!current || !ts.isConditionalExpression(current)) {
    return false;
  }

  return isOwnedDeferredJsxArrayMethodRoot(
    current.whenTrue,
    context,
    analyze,
  ) ||
    isOwnedDeferredJsxArrayMethodRoot(current.whenFalse, context, analyze);
}

// An interpolation `${expr}` inside a TAGGED template (e.g. str`...${expr}...`).
// AST shape: expr.parent is a TemplateSpan, span.parent is a TemplateExpression,
// and that template's parent is a TaggedTemplateExpression. Untagged template
// literals are deliberately excluded — they already lower as a single reactive
// unit via emitTemplateExpression, so we must not also classify their spans as
// independent sites. Tagged templates (str/llm/…) lift over the *values* they
// receive, so a computed interpolation must be lifted per-span or it freezes.
function isTaggedTemplateSpanInterpolation(
  expression: ts.Expression,
  parent: ts.Node,
): boolean {
  if (!ts.isTemplateSpan(parent) || parent.expression !== expression) {
    return false;
  }
  const template = parent.parent;
  return !!template &&
    ts.isTemplateExpression(template) &&
    !!template.parent &&
    ts.isTaggedTemplateExpression(template.parent) &&
    template.parent.template === template;
}

// True when `expression` is an interpolation inside a tagged template whose tag
// is a reactive-origin runtime call (str/llm/…). Only those tags re-read the
// values they receive, so only there must a computed interpolation be lifted.
function isReactiveRuntimeCallTaggedTemplateSpan(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const span = expression.parent;
  if (!span || !ts.isTemplateSpan(span)) return false;
  const template = span.parent;
  if (!template || !ts.isTemplateExpression(template)) return false;
  const tagged = template.parent;
  if (!tagged || !ts.isTaggedTemplateExpression(tagged)) return false;
  return isReactiveOriginTaggedTemplate(tagged, context.checker);
}

/**
 * Deliberately parent-literal, unlike `getCallArgumentPosition`: visitors
 * classify a parenthesized expression at its paren node (the inner expression
 * reports no container), so looking through parens here would classify the
 * same site at two nesting levels and lower it twice.
 */
export function getExpressionContainerKind(
  expression: ts.Expression,
): ExpressionContainerKind | undefined {
  const parent = expression.parent;
  if (!parent) return undefined;

  if (ts.isJsxExpression(parent) && parent.expression === expression) {
    return "jsx-expression";
  }
  if (isTaggedTemplateSpanInterpolation(expression, parent)) {
    return "template-span";
  }
  if (
    (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
    parent.body === expression
  ) {
    return "return-expression";
  }
  if (ts.isReturnStatement(parent) && parent.expression === expression) {
    return "return-expression";
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
    return "variable-initializer";
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(expression)) {
    return "call-argument";
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === expression) {
    return "object-property";
  }
  if (
    ts.isArrayLiteralExpression(parent) && parent.elements.includes(expression)
  ) {
    return "array-element";
  }

  return undefined;
}

function isWithinEventHandlerJsxAttribute(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node;

  while (current) {
    if (ts.isJsxAttribute(current)) {
      return isEventHandlerJsxAttribute(current, checker);
    }
    current = current.parent;
  }

  return false;
}

/**
 * Whether `expression` sits in the body of a reactive collection callback,
 * such as the callback of `.map()` on a reactive array, which runs as a
 * pattern of its own over each element.
 */
export function isArrayMethodOwnedExpressionSite(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const contextInfo = context.getReactiveContext(expression);
  if (contextInfo.kind === "pattern" && contextInfo.owner === "array-method") {
    return true;
  }

  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return false;
  }

  const boundarySemantics = getCallbackBoundarySemantics(
    callbackContext.callback,
    context.checker,
    context,
  );
  return boundarySemantics.isReactiveArrayMethodCallback;
}

const HELPER_BOUNDARY_KINDS = new Set<ExpressionSiteHelperBoundaryKind>([
  "ifElse",
  "when",
  "unless",
  "builder",
  "pattern-tool",
]);

function getHelperBoundaryKind(
  expression: ts.Expression,
  context: TransformationContext,
): ExpressionSiteHelperBoundaryKind | undefined {
  let current: ts.Node | undefined = expression;

  while (current) {
    if (current !== expression && ts.isFunctionLike(current)) {
      return undefined;
    }

    const parent: ts.Node | undefined = current.parent;
    if (
      parent &&
      ts.isCallExpression(parent) &&
      !isSyntheticNode(parent) &&
      ts.isExpression(current) &&
      parent.arguments.includes(current)
    ) {
      const callKind = detectCallKind(parent, context.checker)?.kind;
      if (
        callKind &&
        HELPER_BOUNDARY_KINDS.has(callKind as ExpressionSiteHelperBoundaryKind)
      ) {
        return callKind as ExpressionSiteHelperBoundaryKind;
      }
    }

    current = parent;
  }

  return undefined;
}

function isDeferredJsxArrayMethodExpression(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) {
    return false;
  }

  const arrayMethodInfo = classifyArrayMethodCall(current);
  if (arrayMethodInfo && !arrayMethodInfo.lowered) {
    if (current.arguments.some(isFunctionLikeExpression)) {
      return true;
    }

    if (
      !ts.isPropertyAccessExpression(current.expression) &&
      !ts.isElementAccessExpression(current.expression)
    ) {
      return false;
    }

    const receiverAnalysis = analyze(current.expression.expression);
    if (receiverAnalysis.containsReactive) {
      return true;
    }
  }

  // The registry is what lets this stage agree with the closure stage about
  // a local it rewrote an array method over (`const view =
  // rows.get().filter(...)` — site-lifted, so structurally invisible to the
  // provenance walk). Without it the rewritten `*WithPattern` call reads as
  // plain, misses the deferral, and gets wrapped in a second, incoherent
  // lift. The typeRegistry keeps the walk's type rooting working on the
  // synthetic nodes that rewrite produced.
  const arrayMethodCallSite = classifyArrayMethodCallSite(
    current,
    context.checker,
    {
      typeRegistry: context.state.typeRegistry,
      syntheticReactiveCollectionRegistry: context.state
        .syntheticReactiveCollectionRegistry,
    },
  );
  return !!arrayMethodCallSite &&
    arrayMethodCallSite.ownership === "reactive";
}

function isOwnedDeferredJsxArrayMethodRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) {
    return false;
  }

  if (!isDeferredJsxArrayMethodExpression(current, context, analyze)) {
    return false;
  }

  const callee = current.expression;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }

  const receiverAnalysis = analyze(callee.expression);
  return receiverAnalysis.containsReactive;
}

export function isDirectArrayMethodRootExpression(
  expression: ts.Expression,
): boolean {
  const current = unwrapExpression(expression);
  return ts.isCallExpression(current) && !!classifyArrayMethodCall(current);
}

function isOwnedDynamicElementAccessRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  if (!ts.isElementAccessExpression(current)) {
    return false;
  }

  const argument = current.argumentExpression;
  if (!argument) {
    return false;
  }

  if (
    ts.isLiteralExpression(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument) ||
    getKnownComputedKeyExpression(argument, context)
  ) {
    return false;
  }

  return analyze(current).containsReactive;
}

function isOwnedObjectLiteralRoot(
  expression: ts.Expression,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(current) &&
    analyze(current).containsReactive;
}

function getExpressionSitePolicyInfo(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSitePolicyInfo {
  const callRootPolicyInfo = getExpressionSiteCallRootPolicyInfo(
    expression,
    context,
    analyze,
  );
  return {
    ...callRootPolicyInfo,
    hasAuthoredSourceSite: hasAuthoredSourceSite(expression),
    withinEventHandlerJsxAttribute: isWithinEventHandlerJsxAttribute(
      expression,
      context.checker,
    ),
    syntheticComputeOwned: context.isSyntheticComputeOwnedNode(expression),
    deferredJsxArrayMethod: containerKind === "jsx-expression" &&
      isDeferredJsxArrayMethodExpression(expression, context, analyze),
    controlFlowRewriteRoot: isControlFlowRewriteExpression(expression),
  };
}

function getExpressionSiteCallRootPolicyInfo(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSiteCallRootPolicyInfo {
  return {
    reactiveContext: context.getReactiveContext(expression),
    arrayMethodOwned: isArrayMethodOwnedExpressionSite(expression, context),
    helperBoundaryKind: getHelperBoundaryKind(expression, context),
    callRootKind: ts.isCallExpression(expression)
      ? classifyCallExpressionRoot(expression, context, analyze)
      : undefined,
  };
}

function getSupportedCallRootKind(
  callRootPolicy: CallRootPolicyDecision,
): SupportedCallRootKind | undefined {
  return callRootPolicy.kind === "supported"
    ? callRootPolicy.supportedKind
    : undefined;
}

function isBasePatternExpressionSite(
  siteInfo: ExpressionSitePolicyInfo,
): boolean {
  return siteInfo.hasAuthoredSourceSite &&
    !siteInfo.withinEventHandlerJsxAttribute &&
    siteInfo.reactiveContext.kind === "pattern";
}

function isExpressionSiteLowerable(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  siteInfo: ExpressionSitePolicyInfo,
  analysis: ReturnType<AnalyzeFn>,
): boolean {
  return analysis.requiresRewrite ||
    isOptionalAccessExpression(expression) ||
    isLogicalBinaryExpression(expression) ||
    (
      containerKind === "jsx-expression" &&
      siteInfo.controlFlowRewriteRoot &&
      analysis.containsReactive
    );
}

/**
 * The lowerable signal shared by the reactive-boundary value-lift classifiers
 * (helper-owned and array-method-owned): the expression reads a reactive value
 * (`containsReactive`) and the dataflow analysis says it must be rewritten to
 * resolve those reads (`requiresRewrite`).
 */
function hasReactiveComputationToLift(
  analysis: ReturnType<AnalyzeFn>,
): boolean {
  return analysis.containsReactive && analysis.requiresRewrite;
}

function createSharedExpressionSiteDecision(
  lowerable: boolean,
  jsxRoute?: "shared-pre-closure" | "shared-post-closure",
): ExpressionSiteHandlingDecision {
  return jsxRoute
    ? { kind: "shared", jsxRoute, lowerable }
    : { kind: "shared", lowerable };
}

function createOwnedExpressionSiteDecision(
  owner: ExpressionSiteOwner,
  lowerable: boolean,
): ExpressionSiteHandlingDecision {
  return { kind: "owned", owner, lowerable };
}

/**
 * The two owners that route to the array-method value-lift lowering: a
 * receiver-method call (`v.foo()`) and a bare value-expression (`v.x === y`,
 * `!x`, `a + b`). Both are wrapped by createReactiveWrapperForExpression, so the
 * array-method-callback lowering pass treats them identically.
 */
export function isArrayMethodValueLiftOwner(
  owner: ExpressionSiteOwner,
): boolean {
  return owner === "array-method-receiver-method" ||
    owner === "array-method-callback-value";
}

/**
 * CT-1779: does a `array-method-callback-value` candidate RESOLVE to a collection?
 *
 * The lift must be declined only for COLLECTION-valued callback returns: a
 * `flatMap(i => i.tags ?? [])` whose `??` resolves to an array MUST stay
 * structural (`i.key("tags") ?? []`) so the runtime `*WithPattern` flattens the
 * reactive collection. Keying on the RESULT type — rather than operand provenance,
 * the CT-1777 stopgap (`hasReactiveCollectionProvenance`, which fired for *any*
 * `??` over a reactive operand) — is what lets a SCALAR `??` through: a
 * `map(v => v.name ?? "default")` resolves to `string`, so it is lifted and the
 * `?? default` fallback runs on the resolved value instead of going inert.
 * Comparison/arithmetic/unary results are never collections, so they are
 * unaffected, exactly as before.
 *
 * Resolution uses `getTypeAtLocationWithFallback` (not a bare `getTypeAtLocation`)
 * so the synthetic destructure-lowered lift params the checker types as `any`
 * (#4244) still resolve; the collection test itself — including the union-of-arrays
 * case a bare `isArrayType` would miss — is shared with the sibling lowering and
 * provenance sites via `isCollectionType`.
 */
function arrayMethodCallbackValueResolvesToCollection(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  return isCollectionType(
    getTypeAtLocationWithFallback(
      expression,
      context.checker,
      context.state.typeRegistry,
    ),
    context.checker,
  );
}

function classifyHelperOwnedExpressionSiteHandling(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  siteInfo: ExpressionSitePolicyInfo,
  callRootPolicy: CallRootPolicyDecision,
  analysis: ReturnType<AnalyzeFn>,
): ExpressionSiteHandlingDecision | undefined {
  if (
    containerKind === "jsx-expression" ||
    !siteInfo.helperBoundaryKind ||
    !isBasePatternExpressionSite(siteInfo) ||
    siteInfo.deferredJsxArrayMethod ||
    siteInfo.syntheticComputeOwned
  ) {
    return undefined;
  }

  const supportedCallRootKind = getSupportedCallRootKind(callRootPolicy);
  if (
    !isValueComputationExpressionKind(expression) &&
    supportedCallRootKind !== "helper-owned-explicit-read" &&
    supportedCallRootKind !== "helper-owned-receiver-method"
  ) {
    return undefined;
  }

  return createOwnedExpressionSiteDecision(
    "helper",
    hasReactiveComputationToLift(analysis),
  );
}

export function classifyExpressionSiteHandling(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
  options?: ExpressionSiteHandlingOptions,
): ExpressionSiteHandlingDecision {
  if (isWithinComputeLikePlainArrayValueCallback(expression, context)) {
    return { kind: "skip", reason: "not-lowerable" };
  }

  const siteInfo = getExpressionSitePolicyInfo(
    expression,
    containerKind,
    context,
    analyze,
  );
  const callRootPolicy = classifyCallRootPolicy(expression, siteInfo, context);
  const supportedCallRootKind = getSupportedCallRootKind(callRootPolicy);
  let analysis: ReturnType<AnalyzeFn> | undefined;
  const getAnalysis = (): ReturnType<AnalyzeFn> => {
    analysis ??= analyze(expression);
    return analysis;
  };
  const jsxOwnedRootLowerable = (): boolean =>
    getAnalysis().requiresRewrite || isLogicalBinaryExpression(expression);
  const sharedLowerable = (): boolean =>
    isExpressionSiteLowerable(
      expression,
      containerKind,
      siteInfo,
      getAnalysis(),
    );
  const sharedDecision = (
    jsxRoute?: "shared-pre-closure" | "shared-post-closure",
  ): ExpressionSiteHandlingDecision =>
    createSharedExpressionSiteDecision(sharedLowerable(), jsxRoute);
  const ownedDecision = (
    owner: ExpressionSiteOwner,
    lowerable: boolean,
  ): ExpressionSiteHandlingDecision =>
    createOwnedExpressionSiteDecision(owner, lowerable);

  const helperOwned = classifyHelperOwnedExpressionSiteHandling(
    expression,
    containerKind,
    siteInfo,
    callRootPolicy,
    getAnalysis(),
  );
  if (helperOwned) {
    return helperOwned;
  }
  if (!siteInfo.hasAuthoredSourceSite) {
    return { kind: "skip", reason: "no-authored-source-site" };
  }

  if (siteInfo.withinEventHandlerJsxAttribute) {
    return { kind: "skip", reason: "event-handler-jsx-attribute" };
  }

  if (siteInfo.reactiveContext.kind !== "pattern") {
    return { kind: "skip", reason: "non-pattern-context" };
  }

  if (containerKind === "template-span") {
    // Interpolations inside a reactive tagged template (str/llm/…). The tag
    // lifts over the *values* it receives: a bare reactive read passes through
    // and is re-read by the tag, but a computed expression (call, binary, etc.)
    // must be lifted per-span or it freezes at construction. Treat it like a
    // shared post-closure site — sharedLowerable() lifts only when the span
    // requires a rewrite, leaving bare reads as bare `.key(...)` reads.
    if (!isReactiveRuntimeCallTaggedTemplateSpan(expression, context)) {
      return { kind: "skip", reason: "not-lowerable" };
    }
    return sharedDecision();
  }

  if (
    STRUCTURAL_NESTED_CONTAINER_KINDS.has(containerKind) &&
    hasEnclosingArrayMethodSharedCallRootOwner(expression, context, analyze)
  ) {
    return { kind: "skip", reason: "not-lowerable" };
  }

  if (containerKind === "jsx-expression") {
    if (siteInfo.arrayMethodOwned) {
      return ownedDecision(
        "array-method-callback-jsx",
        jsxOwnedRootLowerable(),
      );
    }

    if (siteInfo.deferredJsxArrayMethod) {
      if (
        options?.allowDeferredRootOwner &&
        isOwnedDeferredJsxArrayMethodRoot(expression, context, analyze)
      ) {
        return ownedDecision("jsx-root", jsxOwnedRootLowerable());
      }

      return {
        kind: "skip",
        reason: "deferred-jsx-array-method-root",
      };
    }

    if (isOwnedDynamicElementAccessRoot(expression, context, analyze)) {
      return ownedDecision("jsx-root", jsxOwnedRootLowerable());
    }

    if (siteInfo.callRootKind === "conditional-helper") {
      return ownedDecision("jsx-root", jsxOwnedRootLowerable());
    }

    if (isOwnedObjectLiteralRoot(expression, analyze)) {
      return createSharedExpressionSiteDecision(
        jsxOwnedRootLowerable(),
        "shared-post-closure",
      );
    }

    if (siteInfo.controlFlowRewriteRoot) {
      return sharedDecision(
        isSharedPreClosureAtomicControlFlowExpression(expression) ||
          isSharedPreClosureDeferredArrayMethodControlFlowExpression(
            expression,
            context,
            analyze,
          )
          ? "shared-pre-closure"
          : "shared-post-closure",
      );
    }

    if (
      isSharedPostClosureCallRootKind(siteInfo.callRootKind) ||
      isSharedJsxLocalHelperCallRoot(expression, context, analyze)
    ) {
      return sharedDecision("shared-post-closure");
    }

    if (siteInfo.callRootKind === "receiver-method") {
      if (
        ts.isCallExpression(expression) &&
        classifyOpaquePathTerminalCall(expression)
      ) {
        return ownedDecision("jsx-root", jsxOwnedRootLowerable());
      }

      return sharedDecision("shared-post-closure");
    }

    if (!isPostClosureWrapperRewriteExpression(expression, context)) {
      return { kind: "skip", reason: "not-shared-jsx-root-kind" };
    }

    return sharedDecision("shared-post-closure");
  }

  if (siteInfo.deferredJsxArrayMethod) {
    return {
      kind: "skip",
      reason: "deferred-jsx-array-method-root",
    };
  }

  if (
    supportedCallRootKind === "array-method-owned-receiver-method"
  ) {
    if (isDirectArrayMethodRootExpression(expression)) return sharedDecision();
    return ownedDecision(
      "array-method-receiver-method",
      getAnalysis().requiresRewrite,
    );
  }

  if (
    ARRAY_METHOD_SHARED_CALL_ROOT_CONTAINER_KINDS.has(containerKind) &&
    shouldPreferArrayMethodSharedCallRootSite(expression, context, analyze)
  ) {
    return sharedDecision();
  }

  // CT-1777: array-method-owned analog of classifyHelperOwnedExpressionSiteHandling.
  // A bare reactive VALUE-expression — a comparison `a === b`, an arithmetic/concat
  // `a + b`, a unary `!x`, etc. — in the return / object-property / array-element
  // position of a reactive map/filter/flatMap callback (lowered to *WithPattern)
  // must be lifted to operate on RESOLVED values, exactly as the same expression is
  // lifted inside a helper body or a JSX value site. Without this it is emitted raw
  // on Reactive proxies: a filter predicate `v.optionId === oid` becomes
  // proxy-vs-proxy `===` → a constant `false`.
  //
  // Two guards keep COLLECTION-valued expressions out, so they stay structurally
  // lowered (the runtime *WithPattern flatten/map depends on it):
  //   - control flow: `!controlFlowRewriteRoot` drops conditionals and logical
  //     `&&`/`||` (they lower via ifElse/unless, which already lift);
  //   - result type (CT-1779): `!arrayMethodCallbackValueResolvesToCollection`
  //     drops only `??` fallbacks whose RESULT is a reactive collection (e.g.
  //     `flatMap(i => i.tags ?? [])`, which must stay `i.key("tags") ?? []`), while
  //     still lifting a SCALAR `??` (`map(v => v.name ?? "default")` resolves to
  //     `string`, so the `?? default` fallback runs on the resolved value). CT-1777
  //     keyed this on operand provenance (`hasReactiveCollectionProvenance`), which
  //     over-excluded scalar `??`; comparison/arithmetic/unary results are never
  //     collections, so this never blocks them either way.
  if (
    siteInfo.arrayMethodOwned &&
    !siteInfo.controlFlowRewriteRoot &&
    isValueComputationExpressionKind(expression) &&
    hasReactiveComputationToLift(getAnalysis()) &&
    !arrayMethodCallbackValueResolvesToCollection(expression, context)
  ) {
    return ownedDecision("array-method-callback-value", true);
  }

  if (siteInfo.arrayMethodOwned && !siteInfo.controlFlowRewriteRoot) {
    return { kind: "skip", reason: "not-lowerable" };
  }

  if (!siteInfo.controlFlowRewriteRoot) {
    const sharedPostClosureCallRoot = isSharedPostClosureCallRootKind(
      siteInfo.callRootKind,
    );
    const patternOwnedReceiverMethod = supportedCallRootKind ===
      "pattern-owned-receiver-method";
    if (
      !sharedPostClosureCallRoot &&
      !patternOwnedReceiverMethod
    ) {
      if (
        !isPostClosureWrapperRewriteExpression(expression, context) &&
        !isCellReadCallRootExpression(expression, context)
      ) {
        return { kind: "skip", reason: "not-lowerable" };
      }

      if (!isEligiblePatternOwnedWrapperCallbackSite(expression, context)) {
        return { kind: "skip", reason: "not-lowerable" };
      }
    }
  }

  return sharedDecision();
}

export function classifyExpressionSiteCallRootPolicy(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): CallRootPolicyDecision {
  return classifyCallRootPolicy(
    expression,
    getExpressionSiteCallRootPolicyInfo(expression, context, analyze),
    context,
  );
}

export function classifyUnsupportedExpressionSiteCallRoot(
  expression: ts.CallExpression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): UnsupportedCallRootKind | undefined {
  if (!isInRestrictedReactiveContext(expression, context.checker, context)) {
    return undefined;
  }

  const decision = classifyExpressionSiteCallRootPolicy(
    expression,
    context,
    analyze,
  );
  return decision.kind === "unsupported" ? decision.unsupportedKind : undefined;
}

function isOptionalAccessExpression(
  expression: ts.Expression,
): expression is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) && !!expression.questionDotToken;
}

export function findLowerableExpressionSite(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): LowerableExpressionSite | undefined {
  let current: ts.Node | undefined = expression;
  let deferredArrayMethodReceiverSite: LowerableExpressionSite | undefined;

  while (current) {
    if (current !== expression && ts.isFunctionLike(current)) {
      return deferredArrayMethodReceiverSite;
    }

    if (ts.isExpression(current)) {
      const containerKind = getExpressionContainerKind(current);
      if (containerKind) {
        if (
          context.getReactiveContext(current).kind !== "pattern"
        ) {
          current = current.parent;
          continue;
        }

        const decision = classifyExpressionSiteHandling(
          current,
          containerKind,
          context,
          analyze,
        );
        if (
          decision.kind !== "skip" &&
          decision.lowerable
        ) {
          const site = {
            expression: current,
            containerKind,
          } as const;
          if (
            decision.kind === "owned" &&
            isArrayMethodValueLiftOwner(decision.owner)
          ) {
            deferredArrayMethodReceiverSite ??= site;
            current = current.parent;
            continue;
          }
          return {
            expression: site.expression,
            containerKind: site.containerKind,
          };
        }

        if (
          decision.kind === "skip" &&
          containerKind === "variable-initializer" &&
          shouldPreferArrayMethodSharedCallRootSite(current, context, analyze)
        ) {
          return {
            expression: current,
            containerKind,
          };
        }
      }
    }

    current = current.parent;
  }

  return deferredArrayMethodReceiverSite;
}

/**
 * A carrier site for an expression whose own site walk stops at a callback
 * boundary: the expression sits inside an inline callback argument, and the
 * callback's owning call lowers at an expression site of its own. The lift
 * wrapping that site absorbs the callback, so the expression runs on resolved
 * values — `rows.get().toSorted((a, b) => (a?.sentAt ?? 0) - (b?.sentAt ?? 0))`
 * carries the comparator's `?.` inside the lift body.
 *
 * Callbacks of the array-method families (`map`/`filter`/`flatMap`) are
 * excluded: those lower through their `*WithPattern` counterparts, whose
 * callback-pattern machinery models elements on its own terms.
 */
export function findInlineCallbackCarrierSite(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): LowerableExpressionSite | undefined {
  let current: ts.Node | undefined = expression.parent;

  while (current) {
    if (ts.isFunctionLike(current)) {
      const position = getCallArgumentPosition(current);
      if (!position) {
        return undefined;
      }

      if (classifyArrayMethodCall(position.call)) {
        return undefined;
      }

      const site = findLowerableExpressionSite(position.call, context, analyze);
      if (site) {
        return site;
      }

      current = position.call.parent;
      continue;
    }

    current = current.parent;
  }

  return undefined;
}

export function findPreferredNestedLowerableExpressionSite(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): LowerableExpressionSite | undefined {
  let nestedSite: LowerableExpressionSite | undefined;

  const visit = (node: ts.Node): void => {
    if (nestedSite) {
      return;
    }

    if (node !== expression && ts.isFunctionLike(node)) {
      return;
    }

    if (node !== expression && ts.isExpression(node)) {
      const containerKind = getExpressionContainerKind(node);
      if (
        containerKind &&
        STRUCTURAL_NESTED_CONTAINER_KINDS.has(containerKind) &&
        context.getReactiveContext(node).kind === "pattern"
      ) {
        const decision = classifyExpressionSiteHandling(
          node,
          containerKind,
          context,
          analyze,
        );
        if (decision.kind !== "skip" && decision.lowerable) {
          nestedSite = {
            expression: node,
            containerKind,
          };
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(expression);

  return nestedSite;
}

export function classifyRestrictedReactiveComputation(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): RestrictedReactiveComputationDecision {
  if (!isInRestrictedReactiveContext(expression, context.checker, context)) {
    return { kind: "allowed" };
  }

  const lowerableSite = findLowerableExpressionSite(
    expression,
    context,
    analyze,
  );
  if (lowerableSite) {
    return {
      kind: "allowed",
      lowerableSite,
    };
  }

  const analysis = analyze(expression);
  if (analysis.containsReactive && analysis.requiresRewrite) {
    return { kind: "requires-computed" };
  }

  return { kind: "allowed" };
}
