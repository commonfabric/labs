import ts from "typescript";
import { symbolDeclaresCommonFabricDefault } from "@commonfabric/schema-generator/common-fabric-symbols";

import {
  getExpressionText,
  getMemberSymbol,
  isMethodCall,
  setParentPointers,
} from "./utils.ts";
import { isFunctionLikeExpression } from "./function-predicates.ts";
import { isBrandedCellType } from "../transformers/cell-type.ts";
import {
  unwrapExpression,
  unwrapTransparentWrapperOnce,
} from "../utils/expression.ts";
import { isSafeIdentifierText } from "../utils/identifiers.ts";
import {
  detectCallKind,
  isReactiveValueExpression,
  isReactiveValueSymbol,
} from "./call-kind.ts";
import { classifyOpaquePathTerminalCall } from "../transformers/opaque-roots.ts";

export interface DataFlowScopeParameter {
  readonly name: string;
  readonly symbol?: ts.Symbol;
  readonly declaration?: ts.ParameterDeclaration;
}

export interface DataFlowScope {
  readonly id: number;
  readonly parentId: number | null;
  readonly parameters: readonly DataFlowScopeParameter[];
}

export interface DataFlowNode {
  readonly id: number;
  readonly expression: ts.Expression;
  readonly canonicalKey: string;
  readonly parentId: number | null;
  readonly scopeId: number;
  readonly isExplicit: boolean; // True if this node represents an actual dependency, not a traversal artifact
}

export interface DataFlowGraph {
  readonly nodes: readonly DataFlowNode[];
  readonly scopes: readonly DataFlowScope[];
  readonly rootScopeId: number;
}

export type RewriteHint =
  | { kind: "call-if-else"; predicate: ts.Expression }
  | { kind: "skip-call-rewrite"; reason: "array-method" | "builder" }
  | undefined;

export interface DataFlowAnalysis {
  containsReactive: boolean;
  requiresRewrite: boolean;
  dataFlows: ts.Expression[];
  graph: DataFlowGraph;
  rewriteHint?: RewriteHint;
}

interface AnalyzerContext {
  nextNodeId: number;
  nextScopeId: number;
  readonly collectedNodes: DataFlowNode[]; // All nodes collected during analysis
  readonly scopes: Map<number, DataFlowScope>;
  readonly expressionToNodeId: Map<ts.Expression, number>; // For O(1) parent lookups
}

interface InternalAnalysis {
  containsReactive: boolean;
  requiresRewrite: boolean;
  dataFlows: ts.Expression[];
  rewriteHint?: RewriteHint;
}

const emptyAnalysis = (): InternalAnalysis => ({
  containsReactive: false,
  requiresRewrite: false,
  dataFlows: [],
  rewriteHint: undefined,
});

const mergeAnalyses = (...analyses: InternalAnalysis[]): InternalAnalysis => {
  let contains = false;
  let requires = false;
  const dataFlows: ts.Expression[] = [];
  for (const analysis of analyses) {
    if (!analysis) continue;
    contains ||= analysis.containsReactive;
    requires ||= analysis.requiresRewrite;
    dataFlows.push(...analysis.dataFlows);
  }
  return {
    containsReactive: contains,
    requiresRewrite: requires,
    dataFlows,
    rewriteHint: undefined,
  };
};

function isStructuralOpaqueKeyDataFlow(
  expression: ts.Expression,
): boolean {
  const target = unwrapExpression(expression);
  return ts.isCallExpression(target) &&
    classifyOpaquePathTerminalCall(target) === "key";
}

export interface DataFlowAnalyzerHooks {
  /**
   * Returns true if the given identifier is a reference to the per-element
   * parameter of an array-method pattern callback synthesized by
   * ClosureTransformer. Such bindings are typed as the plain user element
   * type for downstream consumers, so the analyzer needs an out-of-band
   * signal to recognize reads through them as reactive.
   *
   * The hook is given the identifier node (not its symbol) because symbol
   * identity can drift between pipeline stages when transformers create
   * new ASTs; node identity (with parent links) is durable.
   */
  readonly isArrayMethodElementBindingReference?: (
    identifier: ts.Identifier,
  ) => boolean;
}

export function createDataFlowAnalyzer(
  checker: ts.TypeChecker,
  hooks: DataFlowAnalyzerHooks = {},
): (expression: ts.Expression) => DataFlowAnalysis {
  // Per-expression memoization for `analyze()`. Lives inside this closure;
  // invalidated as a unit when
  // `TransformationContext.#invalidateReactiveAnalysisCaches` drops the
  // analyzer instance (see core/mod.ts cache-invalidation contract).
  const analysisCache = new WeakMap<ts.Expression, DataFlowAnalysis>();
  const resolvingConstAliases = new Set<ts.Symbol>();
  const isArrayMethodElementBindingReference =
    hooks.isArrayMethodElementBindingReference ?? (() => false);

  /**
   * Walk a property-access chain to its leftmost Identifier and ask the hook
   * whether it refers to an array-method element binding. Unwraps non-semantic
   * wrappers (parens, `as`, type assertions, `satisfies`, `!`, partially-
   * emitted) at every step so wrapped reads like `(elem).foo` or `elem!.foo`
   * are still recognized. Returns false for computed access or non-identifier
   * roots (call expressions, etc.).
   */
  const leftmostIdentifierIsArrayMethodElementBinding = (
    expression: ts.Expression,
  ): boolean => {
    let current: ts.Expression = unwrapExpression(expression);
    while (ts.isPropertyAccessExpression(current)) {
      current = unwrapExpression(current.expression);
    }
    return ts.isIdentifier(current) &&
      isArrayMethodElementBindingReference(current);
  };

  // Synthetic node helpers: These enable unified handling of both synthetic
  // (transformer-created) and non-synthetic (original source) nodes by
  // gracefully handling cases where the TypeChecker can't resolve symbols or
  // types.

  const isSynthetic = (node: ts.Node): boolean => !node.getSourceFile();

  type StaticBindingAccessSegment =
    | { readonly kind: "property"; readonly text: string }
    | { readonly kind: "index"; readonly text: string };

  const tryGetSymbol = (node: ts.Node): ts.Symbol | undefined => {
    try {
      return checker.getSymbolAtLocation(node) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const tryGetType = (node: ts.Node): ts.Type | undefined => {
    try {
      return checker.getTypeAtLocation(node);
    } catch {
      return undefined;
    }
  };

  const isConstVariableDeclaration = (
    declaration: ts.VariableDeclaration,
  ): boolean => {
    const declarationList = declaration.parent;
    return !!(
      declarationList &&
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.Const) !== 0
    );
  };

  const getEnclosingConstVariableDeclaration = (
    node: ts.Node | undefined,
  ): ts.VariableDeclaration | undefined => {
    let current = node;
    while (current) {
      if (ts.isVariableDeclaration(current)) {
        return isConstVariableDeclaration(current) ? current : undefined;
      }
      current = current.parent;
    }
    return undefined;
  };

  const getObjectBindingAccessSegment = (
    element: ts.BindingElement,
  ): StaticBindingAccessSegment | undefined => {
    if (!element.propertyName) {
      if (ts.isIdentifier(element.name)) {
        return { kind: "property", text: element.name.text };
      }
      return undefined;
    }

    if (ts.isIdentifier(element.propertyName)) {
      return { kind: "property", text: element.propertyName.text };
    }

    const propertyNameText = getStaticPropertyNameText(element.propertyName);
    if (propertyNameText !== undefined) {
      return { kind: "property", text: propertyNameText };
    }

    return undefined;
  };

  const getStaticPropertyNameText = (
    name: ts.PropertyName,
  ): string | undefined => {
    if (ts.isIdentifier(name)) {
      return name.text;
    }

    if (
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name) ||
      ts.isNoSubstitutionTemplateLiteral(name)
    ) {
      return name.text;
    }

    return undefined;
  };

  const getBindingElementStaticAccessPath = (
    element: ts.BindingElement,
  ): readonly StaticBindingAccessSegment[] | undefined => {
    const path: StaticBindingAccessSegment[] = [];
    let current: ts.BindingElement | undefined = element;

    while (current) {
      if (current.dotDotDotToken || current.initializer) {
        return undefined;
      }

      const parentPattern: ts.Node = current.parent;
      if (ts.isObjectBindingPattern(parentPattern)) {
        const segment = getObjectBindingAccessSegment(current);
        if (!segment) {
          return undefined;
        }
        path.unshift(segment);
      } else if (ts.isArrayBindingPattern(parentPattern)) {
        const index = parentPattern.elements.indexOf(current);
        if (index < 0) {
          return undefined;
        }
        path.unshift({ kind: "index", text: String(index) });
      } else {
        return undefined;
      }

      const owner: ts.Node = parentPattern.parent;
      if (ts.isVariableDeclaration(owner)) {
        return path;
      }
      if (ts.isBindingElement(owner)) {
        current = owner;
        continue;
      }
      return undefined;
    }

    return undefined;
  };

  const createStaticBindingAccessExpression = (
    root: ts.Expression,
    path: readonly StaticBindingAccessSegment[],
  ): ts.Expression => {
    let current = unwrapExpression(root);

    for (const segment of path) {
      if (segment.kind === "index") {
        current = ts.factory.createElementAccessExpression(
          current,
          ts.factory.createNumericLiteral(segment.text),
        );
        continue;
      }

      current = isSafeIdentifierText(segment.text)
        ? ts.factory.createPropertyAccessExpression(
          current,
          ts.factory.createIdentifier(segment.text),
        )
        : /^\d+$/.test(segment.text)
        ? ts.factory.createElementAccessExpression(
          current,
          ts.factory.createNumericLiteral(segment.text),
        )
        : ts.factory.createElementAccessExpression(
          current,
          ts.factory.createStringLiteral(segment.text),
        );
    }

    return current;
  };

  const getStableConstAliasInitializer = (
    symbol: ts.Symbol | undefined,
  ): ts.Expression | undefined => {
    if (!symbol || resolvingConstAliases.has(symbol)) {
      return undefined;
    }

    const declaration = symbol.valueDeclaration;
    if (!declaration) {
      return undefined;
    }

    if (
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      isConstVariableDeclaration(declaration)
    ) {
      return declaration.initializer;
    }

    if (
      ts.isBindingElement(declaration) &&
      ts.isIdentifier(declaration.name)
    ) {
      const variableDeclaration = getEnclosingConstVariableDeclaration(
        declaration,
      );
      if (!variableDeclaration?.initializer) {
        return undefined;
      }

      const path = getBindingElementStaticAccessPath(declaration);
      if (!path) {
        return undefined;
      }

      return createStaticBindingAccessExpression(
        variableDeclaration.initializer,
        path,
      );
    }

    return undefined;
  };

  const getStableConstAggregateInitializer = (
    symbol: ts.Symbol | undefined,
  ): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined => {
    const initializer = getStableConstAliasInitializer(symbol);
    if (!initializer) {
      return undefined;
    }

    const target = unwrapExpression(initializer);
    if (
      ts.isObjectLiteralExpression(target) ||
      ts.isArrayLiteralExpression(target)
    ) {
      return target;
    }

    return undefined;
  };

  const getStaticObjectLiteralPropertyInitializer = (
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
  ): ts.Expression | undefined => {
    for (let index = objectLiteral.properties.length - 1; index >= 0; index--) {
      const property = objectLiteral.properties[index];

      if (
        ts.isSpreadAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          ts.isComputedPropertyName(property.name)) ||
        (ts.isMethodDeclaration(property) &&
          ts.isComputedPropertyName(property.name)) ||
        (ts.isGetAccessorDeclaration(property) &&
          ts.isComputedPropertyName(property.name)) ||
        (ts.isSetAccessorDeclaration(property) &&
          ts.isComputedPropertyName(property.name))
      ) {
        return undefined;
      }

      if (ts.isPropertyAssignment(property)) {
        const staticName = getStaticPropertyNameText(property.name);
        if (staticName === propertyName) {
          return property.initializer;
        }
        continue;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text === propertyName) {
          return property.name;
        }
        continue;
      }

      if (
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        const staticName = getStaticPropertyNameText(property.name);
        if (staticName === propertyName) {
          return undefined;
        }
      }
    }

    return undefined;
  };

  const shouldPreserveConstAliasIdentity = (
    initializer: ts.Expression,
  ): boolean => {
    const target = unwrapExpression(initializer);

    return !(
      ts.isObjectLiteralExpression(target) ||
      isFunctionLikeExpression(target)
    );
  };

  // Convert symbols to enriched parameters with name and declaration info
  const toScopeParameters = (
    parameters: readonly ts.ParameterDeclaration[],
  ): DataFlowScopeParameter[] =>
    parameters.flatMap((parameter) => {
      const symbol = tryGetSymbol(parameter.name);
      if (symbol) {
        return [{
          name: symbol.getName(),
          symbol,
          declaration: parameter,
        }];
      }

      if (ts.isIdentifier(parameter.name)) {
        return [{
          name: parameter.name.text,
          declaration: parameter,
        }];
      }

      return [];
    });

  const createScope = (
    context: AnalyzerContext,
    parent: DataFlowScope | null,
    parameters: readonly ts.ParameterDeclaration[],
  ): DataFlowScope => {
    const scope: DataFlowScope = {
      id: context.nextScopeId++,
      parentId: parent ? parent.id : null,
      parameters: toScopeParameters(parameters),
    };
    context.scopes.set(scope.id, scope);
    return scope;
  };

  // Compute all parameters accessible from a scope (own + ancestors) on-demand
  const getAggregatedSymbols = (
    scope: DataFlowScope,
    scopes: Map<number, DataFlowScope>,
  ): Set<ts.Symbol> => {
    const result = new Set<ts.Symbol>();
    let current: DataFlowScope | undefined = scope;
    while (current) {
      for (const param of current.parameters) {
        if (param.symbol) {
          result.add(param.symbol);
        }
      }
      current = current.parentId !== null
        ? scopes.get(current.parentId)
        : undefined;
    }
    return result;
  };

  const createCanonicalKey = (
    expression: ts.Expression,
    scope: DataFlowScope,
  ): string => {
    const text = getExpressionText(expression);
    return `${scope.id}:${text}`;
  };

  // Determine how CallExpressions should be handled based on their call kind.
  // Returns the appropriate InternalAnalysis with correct requiresRewrite logic.
  const handleCallExpression = (
    expression: ts.CallExpression,
    merged: InternalAnalysis,
    callKind: ReturnType<typeof detectCallKind>,
    isArrayMethodFamily: boolean,
    callee: InternalAnalysis,
    rewriteHint: RewriteHint,
  ): InternalAnalysis => {
    // Builder calls (like pattern) don't need lift-applied wrapping
    if (callKind?.kind === "builder") {
      return {
        ...merged,
        requiresRewrite: false,
        rewriteHint,
      };
    }

    // Array-map calls preserve requiresRewrite from the callee
    // to handle cases like state.items.filter(...).map(...)
    if (isArrayMethodFamily) {
      return {
        ...merged,
        requiresRewrite: callee.requiresRewrite,
        rewriteHint,
      };
    }

    if (
      classifyOpaquePathTerminalCall(expression) !== "get" &&
      merged.dataFlows.length > 0 &&
      merged.dataFlows.every(isStructuralOpaqueKeyDataFlow)
    ) {
      return {
        ...merged,
        requiresRewrite: false,
        rewriteHint,
      };
    }

    // Default: CallExpressions require rewrite if they contain opaque refs
    return {
      ...merged,
      requiresRewrite: merged.containsReactive || merged.requiresRewrite,
      rewriteHint,
    };
  };

  // Helper: Check if an element access expression has a static (literal) index
  const isStaticElementAccess = (
    expression: ts.ElementAccessExpression,
  ): boolean => {
    const argumentExpression = expression.argumentExpression;
    return argumentExpression !== undefined &&
      ts.isExpression(argumentExpression) &&
      (ts.isLiteralExpression(argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(argumentExpression));
  };

  const isStructuralOpaqueTargetExpression = (
    expression: ts.Expression,
    seenSymbols = new Set<ts.Symbol>(),
  ): boolean => {
    const target = unwrapExpression(expression);

    if (ts.isCallExpression(target)) {
      return classifyOpaquePathTerminalCall(target) === "key";
    }

    if (ts.isPropertyAccessExpression(target)) {
      return isStructuralOpaqueTargetExpression(target.expression, seenSymbols);
    }

    if (ts.isElementAccessExpression(target)) {
      return isStaticElementAccess(target) &&
        isStructuralOpaqueTargetExpression(target.expression, seenSymbols);
    }

    if (!ts.isIdentifier(target)) {
      return false;
    }

    const symbol = tryGetSymbol(target);
    if (
      symbol &&
      (isReactiveValueSymbol(symbol, checker) ||
        symbolDeclaresCommonFabricDefault(symbol, checker))
    ) {
      return true;
    }

    if (!symbol || seenSymbols.has(symbol)) {
      return false;
    }

    seenSymbols.add(symbol);
    const initializer = getStableConstAliasInitializer(symbol);
    if (!initializer) {
      return false;
    }

    return isStructuralOpaqueTargetExpression(initializer, seenSymbols);
  };

  const analyzeExpression = (
    expression: ts.Expression,
    scope: DataFlowScope,
    context: AnalyzerContext,
  ): InternalAnalysis => {
    // Set parent pointers for synthetic nodes (needed for parent-based logic like method call detection)
    if (isSynthetic(expression)) {
      setParentPointers(expression);
    }

    // Helper functions (available for both synthetic and non-synthetic paths)

    const recordDataFlow = (
      expr: ts.Expression,
      ownerScope: DataFlowScope,
      parentId: number | null = null,
      isExplicit: boolean = false,
    ): DataFlowNode => {
      const node: DataFlowNode = {
        id: context.nextNodeId++,
        expression: expr,
        canonicalKey: createCanonicalKey(expr, ownerScope),
        parentId,
        scopeId: ownerScope.id,
        isExplicit,
      };
      context.collectedNodes.push(node);
      context.expressionToNodeId.set(expr, node.id);
      return node;
    };

    const findRootIdentifier = (
      expr: ts.Expression,
    ): ts.Identifier | undefined => {
      let current: ts.Expression = expr;
      while (true) {
        if (ts.isIdentifier(current)) return current;
        if (ts.isPropertyAccessExpression(current)) {
          current = current.expression;
          continue;
        }
        if (ts.isElementAccessExpression(current)) {
          current = current.expression;
          continue;
        }
        const unwrapped = unwrapTransparentWrapperOnce(current);
        if (unwrapped) {
          current = unwrapped;
          continue;
        }
        if (ts.isCallExpression(current)) {
          current = current.expression;
          continue;
        }
        return undefined;
      }
    };

    const isSymbolIgnored = (symbol: ts.Symbol | undefined): boolean => {
      if (!symbol) return false;
      const aggregated = getAggregatedSymbols(scope, context.scopes);
      if (
        aggregated.has(symbol) && isReactiveValueSymbol(symbol, checker)
      ) {
        return false;
      }
      return aggregated.has(symbol);
    };

    const originatesFromIgnored = (expr: ts.Expression): boolean => {
      if (ts.isIdentifier(expr)) {
        const symbol = tryGetSymbol(expr);
        return isSymbolIgnored(symbol);
      }
      if (
        ts.isPropertyAccessExpression(expr) ||
        ts.isElementAccessExpression(expr)
      ) {
        return originatesFromIgnored(expr.expression);
      }
      if (ts.isCallExpression(expr)) {
        return originatesFromIgnored(expr.expression);
      }
      return false;
    };

    // Expression type handlers

    if (ts.isIdentifier(expression)) {
      // Skip property names in property access expressions - they're not data flows.
      // For example, `toSchema` in `__cfHelpers.toSchema` is just a property name.
      if (
        expression.parent &&
        ts.isPropertyAccessExpression(expression.parent) &&
        expression.parent.name === expression
      ) {
        return emptyAnalysis();
      }

      const symbol = tryGetSymbol(expression);

      // Can't resolve symbol - if synthetic, treat as opaque parameter
      // This handles cases like `discount` where the whole identifier is synthetic
      if (!symbol && isSynthetic(expression)) {
        const hasSyntheticLocalParameter = scope.parameters.some((parameter) =>
          !parameter.symbol && parameter.name === expression.text
        );
        if (hasSyntheticLocalParameter) {
          return emptyAnalysis();
        }

        recordDataFlow(expression, scope, null, true); // Explicit: synthetic opaque parameter
        return {
          containsReactive: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }

      if (isSymbolIgnored(symbol)) {
        return emptyAnalysis();
      }

      const type = tryGetType(expression);
      if (
        (type && isBrandedCellType(type, checker)) ||
        isReactiveValueExpression(expression, checker)
      ) {
        recordDataFlow(expression, scope, null, true); // Explicit: direct Reactive
        return {
          containsReactive: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }
      if (isArrayMethodElementBindingReference(expression)) {
        // The synthesized `element` binding of an array-method pattern
        // callback is implicitly opaque, even though its TS type is the plain
        // user element type. Treat it the same as a direct Reactive so
        // `element.foo`-style reads are recorded as reactive dependencies and
        // can drive fine-grained subscriptions in downstream lowering.
        recordDataFlow(expression, scope, null, true);
        return {
          containsReactive: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }
      if (symbolDeclaresCommonFabricDefault(symbol, checker)) {
        recordDataFlow(expression, scope, null, true); // Explicit: Common Fabric default
        return {
          containsReactive: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }

      const stableConstInitializer = getStableConstAliasInitializer(symbol);
      if (symbol && stableConstInitializer) {
        resolvingConstAliases.add(symbol);
        try {
          const initializerAnalysis = analyzeExpression(
            stableConstInitializer,
            scope,
            context,
          );
          if (
            initializerAnalysis.containsReactive ||
            initializerAnalysis.requiresRewrite ||
            initializerAnalysis.dataFlows.length > 0
          ) {
            if (!shouldPreserveConstAliasIdentity(stableConstInitializer)) {
              return emptyAnalysis();
            }
            recordDataFlow(expression, scope, null, true);
            return {
              containsReactive: initializerAnalysis.containsReactive ||
                initializerAnalysis.requiresRewrite ||
                initializerAnalysis.dataFlows.length > 0,
              requiresRewrite: initializerAnalysis.requiresRewrite,
              dataFlows: [expression],
            };
          }
        } finally {
          resolvingConstAliases.delete(symbol);
        }
      }

      // Check if this identifier is a parameter to a builder or array-map call (like pattern)
      // These parameters become implicitly opaque even though their type isn't Reactive
      return emptyAnalysis();
    }

    if (ts.isPropertyAccessExpression(expression)) {
      const target = analyzeExpression(expression.expression, scope, context);
      if (ts.isIdentifier(expression.expression)) {
        const targetSymbol = tryGetSymbol(expression.expression);
        const aggregateInitializer = getStableConstAggregateInitializer(
          targetSymbol,
        );
        if (
          aggregateInitializer &&
          ts.isObjectLiteralExpression(aggregateInitializer)
        ) {
          const propertyInitializer = getStaticObjectLiteralPropertyInitializer(
            aggregateInitializer,
            expression.name.text,
          );
          if (propertyInitializer) {
            const propertyAnalysis = analyzeExpression(
              propertyInitializer,
              scope,
              context,
            );
            if (
              propertyAnalysis.containsReactive ||
              propertyAnalysis.requiresRewrite ||
              propertyAnalysis.dataFlows.length > 0
            ) {
              const parentId =
                context.expressionToNodeId.get(expression.expression) ?? null;
              recordDataFlow(expression, scope, parentId, true);
              return {
                containsReactive: true,
                requiresRewrite: false,
                dataFlows: [expression],
              };
            }
          }
        }
      }
      const propertyType = tryGetType(expression);

      if (propertyType && isBrandedCellType(propertyType, checker)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;
        recordDataFlow(expression, scope, parentId, true); // Explicit: Reactive property

        // If the target is a complex expression requiring rewrite (like ElementAccess),
        // propagate its dataFlows. Otherwise, add this property access as a dataFlow.
        if (target.requiresRewrite && target.dataFlows.length > 0) {
          return {
            containsReactive: true,
            requiresRewrite: target.requiresRewrite,
            dataFlows: target.dataFlows,
          };
        } else {
          return {
            containsReactive: true,
            requiresRewrite: target.requiresRewrite,
            dataFlows: [expression],
          };
        }
      }
      // For array-method element bindings, the property access result type is
      // the plain field type (e.g. `string`), not Reactive. But the read is
      // still a reactive fine-grained dependency: the runtime can subscribe to
      // `element.key("foo")` specifically. Record the property access (not
      // just the root identifier) as the dataflow so downstream lift-applied
      // input builders can emit the partial-key shape:
      //   { element: { foo: element.key("foo") } }
      // instead of the broader { element: element } whole-binding capture.
      if (
        target.containsReactive &&
        leftmostIdentifierIsArrayMethodElementBinding(expression)
      ) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;
        recordDataFlow(expression, scope, parentId, true);
        return {
          containsReactive: true,
          requiresRewrite: target.requiresRewrite,
          dataFlows: [expression],
        };
      }
      const propertySymbol = getMemberSymbol(expression, checker);
      if (symbolDeclaresCommonFabricDefault(propertySymbol, checker)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;
        recordDataFlow(expression, scope, parentId, true); // Explicit: Common Fabric property
        return {
          containsReactive: true,
          requiresRewrite: true,
          dataFlows: [expression],
        };
      }
      if (isReactiveValueExpression(expression, checker)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }

        // Check if this is a computed expression (property access on call result, etc.)
        const isPropertyOnCall = ts.isCallExpression(expression.expression);

        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;

        // If the target is a complex expression requiring rewrite (ElementAccess or Call),
        // propagate its dataFlows. Otherwise add this property access as a dataFlow.
        if (isPropertyOnCall || target.requiresRewrite) {
          // This is a computed expression - use the dependencies from the target
          recordDataFlow(expression, scope, parentId, false);
          return {
            containsReactive: true,
            requiresRewrite: true,
            dataFlows: target.dataFlows.length > 0
              ? target.dataFlows
              : [expression],
          };
        }

        // This is a direct property access on a Reactive (like state.pieces.length)
        // It should be its own explicit dependency
        recordDataFlow(expression, scope, parentId, true);
        return {
          containsReactive: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }

      if (isStructuralOpaqueTargetExpression(expression.expression)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;
        recordDataFlow(expression, scope, parentId, true);
        return {
          containsReactive: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }

      // For synthetic nodes where type/symbol resolution failed, check the root identifier
      if (isSynthetic(expression)) {
        const root = findRootIdentifier(expression);
        if (root && ts.isIdentifier(root)) {
          const rootSymbol = tryGetSymbol(root);
          if (rootSymbol) {
            // Root symbol found - check if it's structurally reactive.
            if (isReactiveValueSymbol(rootSymbol, checker)) {
              // This is element.price or similar - treat as opaque property access
              const parentId =
                context.expressionToNodeId.get(expression.expression) ?? null;
              recordDataFlow(expression, scope, parentId, true);
              return {
                containsReactive: true,
                requiresRewrite: true,
                dataFlows: [expression],
              };
            }
          } else {
            // Root symbol undefined - fully synthetic parameter (like `element`)
            // Skip __cfHelpers.* property accesses - these are helper functions
            if (root.text === "__cfHelpers") {
              return {
                containsReactive: target.containsReactive,
                requiresRewrite: target.requiresRewrite ||
                  target.containsReactive,
                dataFlows: target.dataFlows,
              };
            }
            // Skip method calls like element.trim()
            if (isMethodCall(expression)) {
              return {
                containsReactive: target.containsReactive,
                requiresRewrite: target.requiresRewrite ||
                  target.containsReactive,
                dataFlows: target.dataFlows,
              };
            }
            // Treat as opaque property access
            const parentId =
              context.expressionToNodeId.get(expression.expression) ?? null;
            recordDataFlow(expression, scope, parentId, true);
            return {
              containsReactive: true,
              requiresRewrite: true,
              dataFlows: [expression],
            };
          }
        }
      }

      return {
        containsReactive: target.containsReactive,
        requiresRewrite: target.requiresRewrite || target.containsReactive,
        dataFlows: target.dataFlows,
      };
    }

    if (ts.isElementAccessExpression(expression)) {
      const target = analyzeExpression(expression.expression, scope, context);
      const argumentExpression = expression.argumentExpression;
      const argument = argumentExpression &&
          ts.isExpression(argumentExpression)
        ? analyzeExpression(argumentExpression, scope, context)
        : emptyAnalysis();

      const isStaticIndex = isStaticElementAccess(expression);

      if (isStaticIndex) {
        const result = mergeAnalyses(target, argument);
        return result;
      }

      if (
        isReactiveValueExpression(expression.expression, checker) &&
        target.dataFlows.length === 0
      ) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;
        // Element access on implicit opaque ref - this is likely an explicit dependency
        recordDataFlow(expression, scope, parentId, true);
        return {
          containsReactive: true,
          requiresRewrite: true,
          dataFlows: [expression],
        };
      }
      return {
        containsReactive: target.containsReactive ||
          argument.containsReactive,
        requiresRewrite: true,
        dataFlows: [...target.dataFlows, ...argument.dataFlows],
      };
    }

    // A transparent wrapper is analyzed as the expression it wraps. This has to
    // name the whole set: an unlisted spelling falls to the generic child walk
    // below, which reaches the same operands but merges them through
    // `mergeAnalyses` and so drops the inner `rewriteHint`.
    const unwrappedTarget = unwrapTransparentWrapperOnce(expression);
    if (unwrappedTarget) {
      return analyzeExpression(unwrappedTarget, scope, context);
    }

    if (ts.isConditionalExpression(expression)) {
      const condition = analyzeExpression(expression.condition, scope, context);
      const whenTrue = analyzeExpression(expression.whenTrue, scope, context);
      const whenFalse = analyzeExpression(expression.whenFalse, scope, context);
      return {
        containsReactive: condition.containsReactive ||
          whenTrue.containsReactive ||
          whenFalse.containsReactive,
        requiresRewrite: true,
        dataFlows: [
          ...condition.dataFlows,
          ...whenTrue.dataFlows,
          ...whenFalse.dataFlows,
        ],
      };
    }

    if (ts.isBinaryExpression(expression)) {
      const left = analyzeExpression(expression.left, scope, context);
      const right = analyzeExpression(expression.right, scope, context);
      const merged = mergeAnalyses(left, right);
      return {
        ...merged,
        requiresRewrite: left.containsReactive || right.containsReactive,
      };
    }

    if (
      ts.isPrefixUnaryExpression(expression) ||
      ts.isPostfixUnaryExpression(expression)
    ) {
      const operand = analyzeExpression(expression.operand, scope, context);
      return {
        containsReactive: operand.containsReactive,
        requiresRewrite: operand.containsReactive,
        dataFlows: operand.dataFlows,
      };
    }

    if (ts.isTemplateExpression(expression)) {
      const parts = expression.templateSpans.map((span) =>
        analyzeExpression(span.expression, scope, context)
      );
      const merged = mergeAnalyses(...parts);
      return {
        ...merged,
        requiresRewrite: parts.some((part) => part.containsReactive),
      };
    }

    if (ts.isTaggedTemplateExpression(expression)) {
      if (ts.isTemplateExpression(expression.template)) {
        return analyzeExpression(expression.template, scope, context);
      }
      return emptyAnalysis();
    }

    if (ts.isCallExpression(expression)) {
      if (classifyOpaquePathTerminalCall(expression) === "key") {
        const callee = expression.expression;
        const parentId = (
            ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)
          )
          ? context.expressionToNodeId.get(callee.expression) ?? null
          : null;
        recordDataFlow(expression, scope, parentId, true);
        return {
          containsReactive: true,
          requiresRewrite: false,
          dataFlows: [expression],
          rewriteHint: undefined,
        };
      }

      const callee = analyzeExpression(expression.expression, scope, context);
      const analyses: InternalAnalysis[] = [callee];
      for (const arg of expression.arguments) {
        if (isFunctionLikeExpression(arg)) {
          const childScope = createScope(context, scope, arg.parameters);
          if (ts.isBlock(arg.body)) {
            const blockAnalyses: InternalAnalysis[] = [];
            for (const statement of arg.body.statements) {
              if (ts.isReturnStatement(statement) && statement.expression) {
                blockAnalyses.push(
                  analyzeExpression(statement.expression, childScope, context),
                );
              }
            }
            analyses.push(mergeAnalyses(...blockAnalyses));
          } else {
            analyses.push(analyzeExpression(arg.body, childScope, context));
          }
        } else if (ts.isExpression(arg)) {
          analyses.push(analyzeExpression(arg, scope, context));
        }
      }

      const callKind = detectCallKind(expression, checker);
      const isArrayMethodFamily = callKind?.kind === "array-method";
      const combined = mergeAnalyses(...analyses);
      const rewriteHint: RewriteHint | undefined = (() => {
        if (callKind?.kind === "ifElse" && expression.arguments.length > 0) {
          const predicate = expression.arguments[0];
          if (predicate) {
            return { kind: "call-if-else", predicate };
          }
        }
        if (callKind?.kind === "builder") {
          return { kind: "skip-call-rewrite", reason: "builder" };
        }
        if (isArrayMethodFamily) {
          return { kind: "skip-call-rewrite", reason: "array-method" };
        }
        return undefined;
      })();

      return handleCallExpression(
        expression,
        combined,
        callKind,
        isArrayMethodFamily,
        callee,
        rewriteHint,
      );
    }

    if (isFunctionLikeExpression(expression)) {
      const childScope = createScope(context, scope, expression.parameters);
      if (ts.isBlock(expression.body)) {
        const analyses: InternalAnalysis[] = [];
        for (const statement of expression.body.statements) {
          if (ts.isReturnStatement(statement) && statement.expression) {
            analyses.push(
              analyzeExpression(statement.expression, childScope, context),
            );
          }
        }
        return mergeAnalyses(...analyses);
      }
      return analyzeExpression(expression.body, childScope, context);
    }

    if (ts.isObjectLiteralExpression(expression)) {
      const analyses = expression.properties.map((prop) => {
        if (
          ts.isPropertyAssignment(prop) && ts.isExpression(prop.initializer)
        ) {
          return analyzeExpression(prop.initializer, scope, context);
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          return analyzeExpression(prop.name, scope, context);
        }
        return emptyAnalysis();
      });
      return mergeAnalyses(...analyses);
    }

    if (ts.isArrayLiteralExpression(expression)) {
      const analyses = expression.elements.map((element) => {
        if (ts.isExpression(element)) {
          return analyzeExpression(element, scope, context);
        }
        return emptyAnalysis();
      });
      return mergeAnalyses(...analyses);
    }

    // JSX Expression Handling: The analyzer provides complete data flow
    // analysis for JSX elements, including both attributes (like
    // `value={expr}`) and children. This makes the analyzer self-contained -
    // callers get correct results regardless of how they traverse the AST.

    // Helper: analyze JSX attributes (JsxAttribute and JsxSpreadAttribute)
    const analyzeJsxAttributes = (
      attributes: ts.JsxAttributes,
    ): InternalAnalysis[] => {
      const results: InternalAnalysis[] = [];
      for (const attr of attributes.properties) {
        if (ts.isJsxAttribute(attr)) {
          // <Component value={expr} /> - analyze the expression inside {expr}
          if (
            attr.initializer &&
            ts.isJsxExpression(attr.initializer) &&
            attr.initializer.expression
          ) {
            results.push(
              analyzeExpression(attr.initializer.expression, scope, context),
            );
          }
          // String literal initializers (value="string") have no dependencies
        } else if (ts.isJsxSpreadAttribute(attr)) {
          // <Component {...expr} /> - analyze the spread expression
          results.push(analyzeExpression(attr.expression, scope, context));
        }
      }
      return results;
    };

    // Helper: analyze JSX children
    const analyzeJsxChildren = (
      children: ts.NodeArray<ts.JsxChild>,
    ): InternalAnalysis[] => {
      const results: InternalAnalysis[] = [];
      for (const child of children) {
        if (ts.isJsxExpression(child) && child.expression) {
          // {expr} - analyze the inner expression
          results.push(analyzeExpression(child.expression, scope, context));
        } else if (
          ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)
        ) {
          // Nested JSX elements - recurse
          results.push(analyzeExpression(child, scope, context));
        }
        // JsxText nodes have no dependencies
      }
      return results;
    };

    if (ts.isJsxElement(expression)) {
      const attrAnalyses = analyzeJsxAttributes(
        expression.openingElement.attributes,
      );
      const childAnalyses = analyzeJsxChildren(expression.children);
      return mergeAnalyses(...attrAnalyses, ...childAnalyses);
    }

    if (ts.isJsxSelfClosingElement(expression)) {
      const attrAnalyses = analyzeJsxAttributes(expression.attributes);
      return mergeAnalyses(...attrAnalyses);
    }

    if (ts.isJsxFragment(expression)) {
      const childAnalyses = analyzeJsxChildren(expression.children);
      return mergeAnalyses(...childAnalyses);
    }

    const analyses: InternalAnalysis[] = [];
    expression.forEachChild((child) => {
      if (ts.isExpression(child)) {
        analyses.push(analyzeExpression(child, scope, context));
      }
    });
    if (analyses.length === 0) {
      return emptyAnalysis();
    }
    return mergeAnalyses(...analyses);
  };

  return (expression: ts.Expression) => {
    const cached = analysisCache.get(expression);
    if (cached) {
      return cached;
    }

    const context: AnalyzerContext = {
      nextNodeId: 0,
      nextScopeId: 0,
      collectedNodes: [],
      scopes: new Map(),
      expressionToNodeId: new Map(),
    };
    const rootScope = createScope(context, null, []);
    const result = analyzeExpression(expression, rootScope, context);
    const analysis = {
      ...result,
      graph: {
        nodes: context.collectedNodes,
        scopes: Array.from(context.scopes.values()),
        rootScopeId: rootScope.id,
      },
    };

    analysisCache.set(expression, analysis);
    return analysis;
  };
}
