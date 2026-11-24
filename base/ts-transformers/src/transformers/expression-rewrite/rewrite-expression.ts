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
import {
  hasSyntheticComputeCallbackAncestor,
  isArrayMethodReceiverExpression,
} from "./rewrite-helpers.ts";
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

function rewriteChildExpressions(
  node: ts.Expression,
  context: RewriteParams["context"],
  analyze: AnalyzeFn,
  reactiveContextKind: RewriteParams["reactiveContextKind"],
  containerKind: RewriteParams["containerKind"],
  preferInputBoundWrappers?: boolean,
): ts.Expression {
  const visitor = (child: ts.Node): ts.Node => {
    if (ts.isExpression(child)) {
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
          preferInputBoundWrappers,
        }) ?? rewriteChildExpressions(
          node,
          params.context,
          params.analyze,
          reactiveContextKind,
          params.containerKind,
          preferInputBoundWrappers,
        );
      }

      return rewriteChildExpressions(
        node,
        params.context,
        params.analyze,
        reactiveContextKind,
        params.containerKind,
        preferInputBoundWrappers,
      );
    },
    ...params,
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
