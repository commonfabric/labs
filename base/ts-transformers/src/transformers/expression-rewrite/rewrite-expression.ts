import ts from "typescript";

import {
  classifyArrayMethodCall,
  detectCallKind,
  visitEachChildWithJsx,
} from "../../ast/mod.ts";

import type {
  AnalyzeFn,
  Emitter,
  EmitterContext,
  RewriteParams,
} from "./types.ts";
import { isArrayMethodReceiverExpression } from "./rewrite-helpers.ts";
import {
  emitBinaryExpression,
  emitCallExpression,
  emitConditionalExpression,
  emitContainerExpression,
  emitElementAccessExpression,
  emitPrefixUnaryExpression,
  emitPropertyAccess,
  emitTemplateExpression,
} from "./emitters/mod.ts";
import {
  getOpaqueAccessInfo,
  isLocalOpaqueOriginBindingReference,
} from "../opaque-roots.ts";

const EMITTERS: readonly Emitter[] = [
  emitPropertyAccess,
  emitBinaryExpression,
  emitCallExpression,
  emitTemplateExpression,
  emitConditionalExpression,
  emitElementAccessExpression,
  emitPrefixUnaryExpression,
  emitContainerExpression,
];

function isSameReactiveContextBoundary(
  source: ts.Expression,
  target: ts.Expression,
  context: RewriteParams["context"],
): boolean {
  const sourceInfo = context.getReactiveContext(source);
  const targetInfo = context.getReactiveContext(target);
  return sourceInfo.kind === targetInfo.kind &&
    sourceInfo.owner === targetInfo.owner;
}

function hasSyntheticComputeCallbackAncestor(
  node: ts.Node,
  context: RewriteParams["context"],
): boolean {
  let current = node.parent;
  while (current) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      context.isSyntheticComputeCallback(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isInsideKnownSafeCallbackWrapper(
  node: ts.Node,
  context: RewriteParams["context"],
): boolean {
  const info = context.getReactiveContext(node);
  if (info.kind === "compute" && isArrayMethodReceiverExpression(node)) {
    return false;
  }
  return info.kind === "compute" &&
    (info.owner !== "unknown" ||
      context.isSyntheticComputeOwnedNode(node) ||
      hasSyntheticComputeCallbackAncestor(node, context));
}

function canLowerLocalOpaqueMemberInPlace(
  expression: ts.Expression,
  context: RewriteParams["context"],
): boolean {
  if (
    !ts.isPropertyAccessExpression(expression) &&
    !ts.isElementAccessExpression(expression)
  ) {
    return false;
  }
  const info = getOpaqueAccessInfo(expression, context);
  return info.dynamic === false && info.path.length > 0 &&
    info.rootIdentifier !== undefined &&
    isLocalOpaqueOriginBindingReference(info.rootIdentifier, context);
}

function rewriteChildExpressions(
  node: ts.Expression,
  context: RewriteParams["context"],
  analyze: AnalyzeFn,
  reactiveContextKind: RewriteParams["reactiveContextKind"],
  containerKind: RewriteParams["containerKind"],
  inSafeContext?: boolean,
  preferInputBoundWrappers?: boolean,
): ts.Expression {
  const visitor = (child: ts.Node): ts.Node => {
    if (ts.isExpression(child)) {
      // A direct member read on a local reactive-origin binding already is a
      // key-specific reactive value. Leave it structural so the late pattern
      // pass can lower the path in place instead of capturing the whole root
      // in a synthetic lift.
      if (canLowerLocalOpaqueMemberInPlace(child, context)) {
        return child;
      }

      if (ts.isCallExpression(child)) {
        const arrayMethodCall =
          detectCallKind(child, context.checker)?.kind === "array-method"
            ? classifyArrayMethodCall(child)
            : undefined;
        if (arrayMethodCall) {
          if (arrayMethodCall.lowered) {
            return child;
          }

          const rewrittenArguments = child.arguments.map((argument) =>
            rewriteChildExpressions(
              argument,
              context,
              analyze,
              reactiveContextKind,
              containerKind,
              inSafeContext,
              preferInputBoundWrappers,
            )
          );

          if (
            rewrittenArguments.some((argument, index) =>
              argument !== child.arguments[index]
            )
          ) {
            return context.factory.updateCallExpression(
              child,
              child.expression,
              child.typeArguments,
              rewrittenArguments,
            );
          }

          return child;
        }
      }

      const analysis = analyze(child);
      if (analysis.containsReactive && analysis.requiresRewrite) {
        // Skip wrapping if inside a safe callback wrapper (computed/lift/action/etc.)
        // This prevents double-wrapping expressions already in a reactive context
        if (isInsideKnownSafeCallbackWrapper(child, context)) {
          return visitEachChildWithJsx(child, visitor, context.tsContext);
        }

        const result = rewriteExpression({
          expression: child,
          analysis,
          context,
          analyze,
          reactiveContextKind,
          containerKind,
          inSafeContext,
          preferInputBoundWrappers,
        });
        if (result) {
          return result;
        }
      }
    }
    return visitEachChildWithJsx(child, visitor, context.tsContext);
  };

  return visitEachChildWithJsx(
    node,
    visitor,
    context.tsContext,
  ) as ts.Expression;
}

export function rewriteExpression(
  params: RewriteParams,
): ts.Expression | undefined {
  const inSafeContext = params.inSafeContext ?? false;
  const reactiveContextKind = params.reactiveContextKind ?? "neutral";
  const preferInputBoundWrappers = params.preferInputBoundWrappers ?? false;
  const emitterContext: EmitterContext = {
    rewriteChildren(node: ts.Expression): ts.Expression {
      return rewriteChildExpressions(
        node,
        params.context,
        params.analyze,
        reactiveContextKind,
        params.containerKind,
        inSafeContext,
        preferInputBoundWrappers,
      );
    },
    rewriteSubexpression(node: ts.Expression): ts.Expression {
      if (
        !isSameReactiveContextBoundary(
          params.expression,
          node,
          params.context,
        )
      ) {
        return rewriteChildExpressions(
          node,
          params.context,
          params.analyze,
          reactiveContextKind,
          params.containerKind,
          inSafeContext,
          preferInputBoundWrappers,
        );
      }

      const analysis = params.analyze(node);
      if (analysis.containsReactive && analysis.requiresRewrite) {
        return rewriteExpression({
          expression: node,
          analysis,
          context: params.context,
          analyze: params.analyze,
          reactiveContextKind,
          containerKind: params.containerKind,
          inSafeContext,
          preferInputBoundWrappers,
        }) ?? rewriteChildExpressions(
          node,
          params.context,
          params.analyze,
          reactiveContextKind,
          params.containerKind,
          inSafeContext,
          preferInputBoundWrappers,
        );
      }

      return rewriteChildExpressions(
        node,
        params.context,
        params.analyze,
        reactiveContextKind,
        params.containerKind,
        inSafeContext,
        preferInputBoundWrappers,
      );
    },
    ...params,
    inSafeContext,
    preferInputBoundWrappers,
    reactiveContextKind,
    containerKind: params.containerKind,
    dataFlows: params.context.getRelevantDataFlowsFromAnalysis(params.analysis),
  };

  for (const emitter of EMITTERS) {
    const result = emitter(emitterContext);
    if (result) {
      return result;
    }
  }
  return undefined;
}
