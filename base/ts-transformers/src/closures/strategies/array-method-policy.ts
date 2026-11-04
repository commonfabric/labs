import ts from "typescript";

import {
  classifyArrayMethodCall,
  detectCallKind,
  getCallArgumentPosition,
  getEnclosingFunctionLikeDeclaration,
  getTypeAtLocationWithFallback,
  hasReactiveCollectionProvenance,
  isConsumedByTerminalChainCall,
  isReactiveValueExpression,
} from "../../ast/mod.ts";
import type { TransformationContext } from "../../core/mod.ts";
import {
  classifyReactiveReceiverKind,
  shouldRewriteCollectionMethod,
} from "../../policy/mod.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import { isFallbackOperator } from "../../utils/reactive-keys.ts";
import { classifyOpaquePathTerminalCall } from "../../transformers/opaque-roots.ts";
import { classifyExpressionSiteHandling } from "../../transformers/expression-site-policy.ts";

/**
 * Detects a fallback-guarded reactive receiver: `(<reactive> ?? fallback)` or
 * `(<reactive> || fallback)`, where `<reactive>` is a reactive value (e.g. a
 * `cell.get()` lowered to a lift-applied call, a `.key(...)` access, or any
 * other Reactive-producing expression).
 *
 * The `?? []` (or `|| []`) guard is the documented defense against a scoped
 * cell reading `undefined` before sync. But it also collapses the receiver's
 * static type to a plain array and hides the reactive provenance from the
 * type-based receiver classifier, so `(cell.get() ?? []).map(...)` would
 * otherwise be left as a raw `CellImpl.map` — which throws at construction when
 * its callback closes over a sibling pattern cell (CT-1626). Recognizing the
 * shape here lets the inner `.map` lower to `mapWithPattern` like the
 * unguarded `cell.map(...)` form already does.
 */
function isReactiveFallbackReceiver(
  mapTarget: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const receiver = unwrapExpression(mapTarget);
  if (
    !ts.isBinaryExpression(receiver) ||
    !isFallbackOperator(receiver.operatorToken.kind)
  ) {
    return false;
  }
  return isReactiveFallbackLeft(unwrapExpression(receiver.left), checker);
}

function isReactiveFallbackLeft(
  left: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (isReactiveValueExpression(left, checker)) {
    return true;
  }
  // A `cell.get()` / `cell.key(...)` read isn't reactive-producing on its own
  // (it's a read), but when its receiver is reactive the whole `.get()` result
  // is still a Reactive at runtime once lowered — so the fallback receiver
  // needs the WithPattern rewrite. Match `<reactive>.get()` / `.key(...)`.
  if (
    ts.isCallExpression(left) &&
    classifyOpaquePathTerminalCall(left) !== undefined &&
    ts.isPropertyAccessExpression(left.expression)
  ) {
    return isReactiveValueExpression(
      unwrapExpression(left.expression.expression),
      checker,
    );
  }
  return false;
}

function hasSharedReactiveCollectionProvenance(
  expression: ts.Expression,
  context: TransformationContext,
  options: {
    sameScope?: ts.FunctionLikeDeclaration;
    allowTypeBasedRoot?: boolean;
    allowImplicitReactiveParameters?: boolean;
  } = {},
): boolean {
  return hasReactiveCollectionProvenance(
    expression,
    context.checker,
    {
      ...options,
      typeRegistry: context.state.typeRegistry,
      syntheticReactiveCollectionRegistry: context.state
        .syntheticReactiveCollectionRegistry,
    },
  );
}

/**
 * Whether the receiver is a pattern-scope variable whose initializer the
 * expression-site machinery lifts — `const view = rows.get().filter(...)`,
 * `const linksView = asArray(links.get()).filter((l) => l)`. The lift is
 * created by PatternOwnedExpressionSiteLowering, which runs AFTER the closure
 * stage (C-002), so at decision time the binding still reads as its authored
 * initializer and no registry entry can exist yet — the same decision-time
 * race CT-1778 records for helper-call results. The cure is the same: decide
 * from the shape that will exist, by asking the site machinery itself whether
 * the initializer classifies as a lowerable site. A binding whose initializer
 * is site-lifted holds a Reactive at runtime, so an array method over it must
 * take the WithPattern form or the runtime rejects it.
 */
function getSiteLiftedCollectionLocalSymbol(
  mapTarget: ts.Expression,
  context: TransformationContext,
): ts.Symbol | undefined {
  const target = unwrapExpression(mapTarget);
  if (!ts.isIdentifier(target)) {
    return undefined;
  }

  const originalTarget = ts.getOriginalNode(target);
  const symbol = context.checker.getSymbolAtLocation(target) ??
    (
      originalTarget !== target && ts.isIdentifier(originalTarget)
        ? context.checker.getSymbolAtLocation(originalTarget)
        : undefined
    );
  const declaration = symbol?.valueDeclaration;
  if (
    !declaration || !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer
  ) {
    return undefined;
  }

  const initializer = declaration.initializer;
  if (context.getReactiveContext(initializer).kind !== "pattern") {
    return undefined;
  }

  // Only bindings in the pattern-builder callback body itself are
  // site-lifted. A local inside a JSX IIFE is owned by the IIFE
  // decomposition, and a local inside any other callback by that callback's
  // own lowering — treating either as already-reactive here would misroute
  // it.
  let enclosing: ts.Node | undefined = declaration.parent;
  while (enclosing && !ts.isFunctionLike(enclosing)) {
    enclosing = enclosing.parent;
  }
  if (
    !enclosing ||
    !(ts.isArrowFunction(enclosing) || ts.isFunctionExpression(enclosing))
  ) {
    return undefined;
  }
  const builderPosition = getCallArgumentPosition(enclosing);
  if (!builderPosition) {
    return undefined;
  }
  const builderKind = detectCallKind(builderPosition.call, context.checker);
  if (
    builderKind?.kind !== "builder" ||
    (builderKind.builderName !== "pattern" &&
      builderKind.builderName !== "render")
  ) {
    return undefined;
  }

  const analyze = context.getDataFlowAnalyzer();
  const decision = classifyExpressionSiteHandling(
    initializer,
    "variable-initializer",
    context,
    analyze,
  );
  return decision.kind !== "skip" && decision.lowerable ? symbol : undefined;
}

/**
 * Check if an array method call should be transformed to its WithPattern variant.
 *
 * Type-based approach with context awareness (CT-1186 fix):
 * 1. computed()/lift() calls always return Reactive at runtime -> TRANSFORM
 * 2. Inside safe wrappers (computed/lift/etc), Reactive gets auto-unwrapped
 *    to a plain array, so we should NOT transform Reactive method calls there.
 *    However, Cell and Stream do NOT get auto-unwrapped, so we still transform those.
 * 3. Local aliases created by nested computed()/lift() calls inside the current
 *    compute callback become opaque again and should transform.
 * 4. Outside safe wrappers, transform all cell-like types (Reactive, Cell, Stream).
 */
export function shouldTransformArrayMethod(
  methodCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  if (!ts.isPropertyAccessExpression(methodCall.expression)) return false;

  const arrayMethodInfo = classifyArrayMethodCall(methodCall);
  if (!arrayMethodInfo || arrayMethodInfo.lowered) {
    return false;
  }
  const methodName = arrayMethodInfo.family;

  if (isConsumedByTerminalChainCall(methodCall)) {
    return false;
  }

  const mapTarget = methodCall.expression.expression;
  const contextInfo = context.getReactiveContext(methodCall);

  const targetType = getTypeAtLocationWithFallback(
    mapTarget,
    context.checker,
    context.state.typeRegistry,
  );
  const receiverKind = classifyReactiveReceiverKind(
    mapTarget,
    targetType,
    context.checker,
  );

  if (
    contextInfo.kind === "pattern" &&
    hasSharedReactiveCollectionProvenance(mapTarget, context)
  ) {
    return true;
  }

  if (contextInfo.kind === "pattern") {
    const siteLiftedLocal = getSiteLiftedCollectionLocalSymbol(
      mapTarget,
      context,
    );
    if (siteLiftedLocal) {
      // Registering here is what keeps the later stages coherent with this
      // decision: the site-lowering stages run after the closure stage and
      // consult the same provenance walk, which without the registry entry
      // still reads the binding as plain — and would wrap the already
      // rewritten `*WithPattern` call in a lift. The registry is the same
      // channel ReactiveVariableFor uses for the CT-1778 shapes.
      context.state.syntheticReactiveCollectionRegistry.add(siteLiftedLocal);
      return true;
    }
  }

  const enclosingFunction = getEnclosingFunctionLikeDeclaration(methodCall);
  if (
    contextInfo.kind === "compute" &&
    enclosingFunction &&
    hasSharedReactiveCollectionProvenance(mapTarget, context, {
      sameScope: enclosingFunction,
      allowTypeBasedRoot: false,
      allowImplicitReactiveParameters: false,
    })
  ) {
    return true;
  }

  if (
    ts.isCallExpression(mapTarget) &&
    detectCallKind(mapTarget, context.checker)?.kind === "lift-applied"
  ) {
    return contextInfo.kind === "pattern";
  }

  // `(reactive ?? fallback).map(...)`: the fallback guard hides the reactive
  // receiver from the type-based classifier above (it sees a plain array), but
  // at runtime the receiver is still a Reactive and needs the WithPattern
  // rewrite. Mirror the lift-applied special-case (CT-1626).
  if (isReactiveFallbackReceiver(mapTarget, context.checker)) {
    return contextInfo.kind === "pattern";
  }

  return shouldRewriteCollectionMethod(
    contextInfo.kind,
    methodName,
    receiverKind,
  );
}
