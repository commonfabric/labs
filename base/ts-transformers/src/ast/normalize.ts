import ts from "typescript";

import { unwrapTransparentWrapperOnce } from "../utils/expression.ts";

import type {
  DataFlowAnalysis,
  DataFlowGraph,
  DataFlowNode,
} from "./dataflow.ts";
import { classifyArrayMethodCallSite, detectCallKind } from "./call-kind.ts";
import {
  classifyReactiveContext,
  type ReactiveContextLookup,
} from "./reactive-context.ts";
import { getExpressionText } from "./utils.ts";

export interface NormalizedDataFlow {
  readonly canonicalKey: string;
  readonly expression: ts.Expression;
  readonly occurrences: readonly DataFlowNode[];
  readonly scopeId: number;
}

function originatesFromIgnoredParameter(
  expression: ts.Expression,
  scopeId: number,
  analysis: DataFlowAnalysis,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const scope = analysis.graph.scopes.find((candidate) =>
    candidate.id === scopeId
  );
  if (!scope) return false;

  const isIgnoredSymbol = (symbol: ts.Symbol | undefined): boolean => {
    if (!symbol) return false;
    const symbolName = symbol.getName();
    return scope.parameters.some((parameter) => {
      if (parameter.symbol === symbol || parameter.name === symbolName) {
        if (
          parameter.declaration &&
          isOpaqueCallParameter(parameter.declaration, checker, lookup)
        ) {
          return false;
        }
        return true;
      }
      return false;
    });
  };

  const inner = (expr: ts.Expression): boolean => {
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr);

      if (!symbol) {
        return scope.parameters.some((parameter) => {
          if (parameter.name !== expr.text) {
            return false;
          }
          if (
            parameter.declaration &&
            isOpaqueCallParameter(
              parameter.declaration,
              checker,
              lookup,
            )
          ) {
            return false;
          }
          return true;
        });
      }

      return isIgnoredSymbol(symbol);
    }
    if (
      ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)
    ) {
      return inner(expr.expression);
    }
    if (ts.isCallExpression(expr)) {
      return inner(expr.expression);
    }
    return false;
  };

  return inner(expression);
}

function isOpaqueCallParameter(
  declaration: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  let functionNode: ts.Node | undefined = declaration.parent;
  while (functionNode && !ts.isFunctionLike(functionNode)) {
    functionNode = functionNode.parent;
  }
  if (!functionNode) return false;

  let candidate: ts.Node | undefined = functionNode.parent;
  while (candidate && !ts.isCallExpression(candidate)) {
    candidate = candidate.parent;
  }
  if (!candidate) return false;

  const callKind = detectCallKind(candidate, checker);
  if (callKind?.kind === "builder") {
    return true;
  }

  const arrayMethodCallSite = classifyArrayMethodCallSite(candidate, checker);
  if (arrayMethodCallSite?.ownership !== "reactive") {
    return false;
  }

  if (!lookup) {
    return true;
  }

  const reactiveContext = classifyReactiveContext(
    candidate,
    checker,
    lookup,
  );
  return reactiveContext.kind === "pattern";
}

function filterRelevantDataFlows(
  dataFlows: readonly NormalizedDataFlow[],
  analysis: DataFlowAnalysis,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): readonly NormalizedDataFlow[] {
  const hasSyntheticRoot = (expr: ts.Expression): boolean => {
    let current = expr;
    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
    }
    if (ts.isIdentifier(current)) {
      return !checker.getSymbolAtLocation(current);
    }
    return false;
  };

  const filterIgnoredParams = (
    candidateFlows: readonly NormalizedDataFlow[],
  ): readonly NormalizedDataFlow[] =>
    candidateFlows.filter((dataFlow) =>
      !originatesFromIgnoredParameter(
        dataFlow.expression,
        dataFlow.scopeId,
        analysis,
        checker,
        lookup,
      )
    );

  const syntheticDataFlows = dataFlows.filter((df) =>
    hasSyntheticRoot(df.expression)
  );

  if (syntheticDataFlows.length > 0) {
    const hasSyntheticMapParams = syntheticDataFlows.some((df) => {
      let rootExpr: ts.Expression = df.expression;
      while (
        ts.isPropertyAccessExpression(rootExpr) ||
        ts.isElementAccessExpression(rootExpr)
      ) {
        rootExpr = rootExpr.expression;
      }
      if (ts.isIdentifier(rootExpr)) {
        const name = rootExpr.text;
        return name === "element" || name === "index" || name === "array";
      }
      return false;
    });

    if (hasSyntheticMapParams) {
      const nonSyntheticDataFlows = dataFlows.filter((df) =>
        !hasSyntheticRoot(df.expression)
      );

      const isInMarkedCallback = !!lookup?.isArrayMethodCallback &&
        dataFlows.some((df) => {
          const scope = analysis.graph.scopes.find((s) => s.id === df.scopeId);
          if (!scope || scope.parameters.length === 0) return false;

          const firstParam = scope.parameters[0];
          if (!firstParam?.declaration) return false;

          let node: ts.Node | undefined = firstParam.declaration.parent;
          while (node) {
            if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
              return lookup.isArrayMethodCallback(node);
            }
            node = node.parent;
          }
          return false;
        });

      return filterIgnoredParams(
        nonSyntheticDataFlows.length === 0 || isInMarkedCallback
          ? dataFlows
          : nonSyntheticDataFlows,
      );
    }
  }

  return filterIgnoredParams(dataFlows);
}

export function normalizeDataFlows(
  graph: DataFlowGraph,
  requestedDataFlows?: ts.Expression[],
): readonly NormalizedDataFlow[] {
  // If specific dataFlows were requested, only process nodes corresponding to those expressions
  // This prevents suppressing nodes that are explicitly needed as dependencies
  let nodesToProcess = graph.nodes;
  if (requestedDataFlows && requestedDataFlows.length > 0) {
    const requestedTexts = new Set(
      requestedDataFlows.map((expr) => getExpressionText(expr)),
    );
    nodesToProcess = graph.nodes.filter((node) =>
      requestedTexts.has(getExpressionText(node.expression))
    );
  }

  const grouped = new Map<string, {
    expression: ts.Expression;
    nodes: DataFlowNode[];
    scopeId: number;
  }>();

  const normalizeExpression = (node: DataFlowNode): ts.Expression => {
    let current: ts.Expression = node.expression;

    // Only normalize away truly meaningless wrappers that don't change semantics
    while (true) {
      // Remove transparent wrappers - parentheses are purely syntactic, and
      // the assertion forms do not affect runtime behavior. Two data flows that
      // differ only by one of these normalize to the same expression and group
      // together, so the set has to be the whole one.
      const unwrapped = unwrapTransparentWrapperOnce(current);
      if (unwrapped) {
        current = unwrapped;
        continue;
      }

      // Special case: for method calls like obj.method(), we need to normalize
      // back to the object so the transformation can wrap it properly
      // e.g., state.user.name.toUpperCase() -> state.user.name
      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        if (ts.isPropertyAccessExpression(callee)) {
          // This is a method call - normalize to the object
          current = callee.expression;
          continue;
        }
      }

      // Also handle property access when it's being called as a method
      // e.g., when we see state.user.name.toUpperCase (without the call),
      // but it's the callee of a call expression
      if (ts.isPropertyAccessExpression(current)) {
        if (
          current.parent &&
          ts.isCallExpression(current.parent) &&
          current.parent.expression === current
        ) {
          // This property is being called as a method
          current = current.expression;
          continue;
        }
      }

      // That's it! Keep all other meaningful distinctions:
      // - state.items vs state.items.length (different reactive dependencies)
      // - array[0] vs array (different values)
      break;
    }

    return current;
  };

  for (const node of nodesToProcess) {
    const expression = normalizeExpression(node);
    const key = `${node.scopeId}:${getExpressionText(expression)}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        expression,
        nodes: [],
        scopeId: node.scopeId,
      };
      grouped.set(key, group);
    }
    group.nodes.push(node);
  }

  const suppressed = new Set<string>();
  const explicitChildrenByParentId = new Set(
    graph.nodes
      .filter((node) => node.isExplicit && node.parentId !== null)
      .map((node) => node.parentId!),
  );

  // Parent suppression: suppress parents that have more specific children
  // BUT: If we're working with explicitly requested dataFlows, don't suppress any of them
  // They were all explicitly requested as dependencies
  if (!requestedDataFlows || requestedDataFlows.length === 0) {
    for (const [canonicalKey, group] of grouped.entries()) {
      if (group.nodes.some((node) => explicitChildrenByParentId.has(node.id))) {
        suppressed.add(canonicalKey);
      }
    }
  }

  const filtered = Array.from(grouped.entries())
    .filter(([canonicalKey]) => !suppressed.has(canonicalKey));

  return filtered.map(([canonicalKey, value]) => ({
    canonicalKey,
    expression: value.expression,
    occurrences: value.nodes,
    scopeId: value.scopeId,
  })).sort((a, b) => {
    const aId = a.occurrences[0]?.id ?? -1;
    const bId = b.occurrences[0]?.id ?? -1;
    return aId - bId;
  });
}

export function getRelevantDataFlows(
  analysis: DataFlowAnalysis,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): readonly NormalizedDataFlow[] {
  const normalized = normalizeDataFlows(
    analysis.graph,
    analysis.dataFlows,
  );
  return filterRelevantDataFlows(
    normalized,
    analysis,
    checker,
    lookup,
  );
}

const isWithin = (outer: ts.Node, inner: ts.Node): boolean => {
  return inner.pos >= outer.pos && inner.end <= outer.end;
};

export function selectDataFlowsWithin(
  dataFlows: readonly NormalizedDataFlow[],
  node: ts.Node,
): NormalizedDataFlow[] {
  return dataFlows.filter((dataFlow) =>
    dataFlow.occurrences.some((occurrence) =>
      isWithin(node, occurrence.expression)
    )
  );
}

/**
 * Selects data flows that are referenced (used) within a node, based on expression text matching.
 * This is complementary to selectDataFlowsWithin, which uses position-based checking.
 *
 * This is particularly useful for finding parameter references where the parameter declaration
 * is outside the node (e.g., in conditional branches of ternary expressions).
 *
 * @param set The normalized data flow set to filter
 * @param node The node to check for references within
 * @returns Data flows whose expressions are referenced within the node
 */
export function selectDataFlowsReferencedIn(
  dataFlows: readonly NormalizedDataFlow[],
  node: ts.Node,
): NormalizedDataFlow[] {
  const referencedExpressions = new Set<string>();

  // Find all expressions used in the node
  const visit = (n: ts.Node) => {
    if (ts.isExpression(n)) {
      referencedExpressions.add(getExpressionText(n));
    }
    ts.forEachChild(n, visit);
  };
  visit(node);

  // Return data flows whose expression text matches any referenced expression
  return dataFlows.filter((dataFlow) => {
    const flowExprText = getExpressionText(dataFlow.expression);
    return referencedExpressions.has(flowExprText);
  });
}
