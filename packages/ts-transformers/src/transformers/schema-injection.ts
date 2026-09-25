import { unwrapTypeParentheses } from "@commonfabric/schema-generator/type-node";
import { FUNCTION_HARDENING_HELPER_NAME } from "@commonfabric/utils/sandbox-contract";
import ts from "typescript";

import {
  classifyArrayMethodCall,
  declaredVerbResultTypeNode,
  detectCallKind,
  detectNewExpressionKind,
  ensureTypeNodeRegistered,
  getLiftAppliedInnerCall,
  getNodeText,
  getTypeAtLocationWithFallback,
  getTypeFromTypeNodeWithFallback,
  getVariableInitializer,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  isAnyOrUnknownType,
  isCallbackReference,
  isCellLikeType,
  isFunctionLikeExpression,
  isSyntheticNode,
  isUnresolvedSchemaType,
  preserveSourceMapRange,
  registerSyntheticCallType,
  typeToSchemaTypeNode,
  unwrapCellLikeType,
  widenLiteralType,
} from "../ast/mod.ts";
import {
  createRegisteredTypeLiteral,
  getConstructedCellTypeNode,
  getPreservedTypeForBindingElement,
  namesValueBinding,
  type PreservedBindingType,
  reportUnknownReactiveType,
  typeToTypeNodeWithRegistry,
} from "../ast/type-building.ts";
import {
  type CapabilityParamSummary,
  type CrossStageState,
  type FunctionCapabilitySummary,
  HelpersOnlyTransformer,
  type SchemaHint,
  type SchemaHints,
  TransformationContext,
  type TypeRegistry,
} from "../core/mod.ts";
import { analyzeFunctionCapabilities } from "../policy/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { isPatternFactoryCalleeExpression } from "./structural-reactive-factory.ts";
import {
  applyShrinkAndWrap,
  type CapabilitySummaryApplicationMode,
  containsAnyOrUnknownTypeNode,
  getAuthoredCellValueTypeNode,
  isCellLikeTypeNode,
  overlayContractCapabilities,
  preservedWrapperFor,
  printTypeNode,
  validateShrinkCoverage,
} from "./type-shrinking.ts";

type UiContractHint = NonNullable<SchemaHint["cfcUiContract"]>;
type CellScope = "space" | "user" | "session";

/**
 * The scope each `commonfabric` scope wrapper declares, keyed by the wrapper's
 * name. `cellScopeFromType()` reads it from a type's alias and falls back to
 * the scope brand, which also covers a wrapper reached through an alias of the
 * author's own. `typeNodeContainsScopeWrapper()` reads it from authored
 * syntax, where only the spelling is available; a wrapper that spelling hides
 * behind an alias is still carried by the inferred type, whose alias and brand
 * schema generation reads.
 */
const SCOPE_ALIAS_TO_CELL_SCOPE: ReadonlyMap<string, CellScope | "any"> =
  new Map([
    ["PerSpace", "space"],
    ["PerUser", "user"],
    ["PerSession", "session"],
    ["PerAny", "any"],
  ]);

/**
 * Schema Injection Transformer - TypeRegistry Integration
 *
 * This transformer injects JSON schemas for Common Fabric core functions
 * (pattern, handler, lift) by analyzing TypeScript types and converting them to
 * runtime schemas.
 *
 * ## TypeRegistry Integration (Unified Approach)
 *
 * All transformation paths now consistently check the TypeRegistry for closure-captured types.
 * The TypeRegistry is a WeakMap<TypeNode, Type> that enables coordination between transformers:
 *
 * 1. **ClosureTransformer** (runs first):
 *    - Creates synthetic TypeNodes for closure-captured variables
 *    - Registers TypeNode -> Type mappings in TypeRegistry
 *    - Enables type information preservation through AST transformations
 *
 * 2. **SchemaInjectionTransformer** (this file):
 *    - Checks TypeRegistry for existing Type mappings before inferring types
 *    - Preserves closure-captured type information from ClosureTransformer
 *    - Registers newly inferred types back into TypeRegistry
 *
 * 3. **SchemaGeneratorTransformer** (runs last):
 *    - Uses TypeRegistry to find Type information for synthetic TypeNodes
 *    - Generates accurate JSON schemas even for transformed/synthetic nodes
 *
 * ## Pattern-Specific Behavior
 *
 * - **Handler**: Checks TypeRegistry for type arguments, uses `unknown` fallback
 * - **Pattern**: Checks TypeRegistry before inferring, registers inferred types
 * - **Pattern**: Checks TypeRegistry for type arguments
 * - **Lift**: Checks TypeRegistry for type arguments and inferred types
 *
 * ## Why This Matters
 *
 * Without TypeRegistry checking, closure-captured variables lose their type information
 * when ClosureTransformer creates synthetic AST nodes. By checking the registry first,
 * we preserve the original Type information and generate accurate schemas.
 *
 * Example: `const foo = { label: "test" }; pattern(() => ({ cell: foo }))`
 * - ClosureTransformer creates synthetic type for `foo`, registers it
 * - SchemaInjectionTransformer finds that type in TypeRegistry
 * - SchemaGeneratorTransformer uses it to create accurate schema for `foo`
 */

function shouldDropFallbackTypeForSchema(
  node: ts.TypeNode | undefined,
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  if (!node || !type) return false;
  if (containsAnyOrUnknownTypeNode(node)) return false;

  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  let rebuilt: ts.TypeNode | undefined;
  try {
    rebuilt = checker.typeToTypeNode(type, sourceFile, typeToNodeFlags);
  } catch (_e: unknown) {
    // typeToTypeNode can throw on deeply recursive or circular types.
    rebuilt = undefined;
  }
  if (!rebuilt) return false;
  return containsAnyOrUnknownTypeNode(rebuilt);
}

function normalizeTypeNodeText(text: string): string {
  return text.replace(/\s+/g, "");
}

function parameterUsesCellLikeMethods(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  index: number,
): boolean {
  const parameter = fn.parameters[index];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return false;
  }

  const parameterName = parameter.name.text;
  let usesCellLikeMethods = false;

  const visit = (node: ts.Node): void => {
    if (usesCellLikeMethods) return;
    if (
      node !== fn && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    ) {
      return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === parameterName &&
      (
        node.expression.name.text === "get" ||
        node.expression.name.text === "key"
      )
    ) {
      usesCellLikeMethods = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  if (fn.body) {
    visit(fn.body);
  }

  return usesCellLikeMethods;
}

function getSymbolTypeAtSource(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ts.Type {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ??
    sourceFile;
  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

// Per-context memo for the capability analyses this transformer runs.
// `analyzeFunctionCapabilities` consults `options.summaryCache` before
// traversing, but defaults it to a fresh WeakMap per call — so without a
// persistent cache every lookup re-walks the callback body (a single handler
// site queries the same callback three times: event param, state param,
// identity hints). Keyed by TransformationContext so entries live exactly one
// (stage, source file) pass and can't leak across programs. The two analysis
// variants used below produce different summaries, hence separate maps. No
// invalidation wiring is needed: the analysis is a pure function of the
// callback AST and checker (it reads no cross-stage registries), and
// transformed nodes have fresh identities, so entries can't go stale.
interface CapabilitySummaryMemo {
  /** `{ checker, includeNestedCallbacks: true }` analyses. */
  readonly nested: WeakMap<ts.Node, FunctionCapabilitySummary>;

  /** Non-nested analyses (fallback after a recorded-summary miss). */
  readonly fallback: WeakMap<ts.Node, FunctionCapabilitySummary>;
}

const capabilitySummaryMemos = new WeakMap<
  TransformationContext,
  CapabilitySummaryMemo
>();

function capabilitySummaryMemoFor(
  context: TransformationContext,
): CapabilitySummaryMemo {
  let memo = capabilitySummaryMemos.get(context);
  if (!memo) {
    memo = { nested: new WeakMap(), fallback: new WeakMap() };
    capabilitySummaryMemos.set(context, memo);
  }
  return memo;
}

function findCapabilitySummaryForParameter(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  index: number,
  context?: TransformationContext,
  options?: {
    readonly checker?: ts.TypeChecker;
    readonly includeNestedCallbacks?: boolean;
  },
): CapabilityParamSummary | undefined {
  const summary = options?.includeNestedCallbacks
    ? analyzeFunctionCapabilities(fn, {
      checker: options.checker,
      typeRegistry: context?.state.typeRegistry,
      includeNestedCallbacks: true,
      summaryCache: context
        ? capabilitySummaryMemoFor(context).nested
        : undefined,
    })
    : context
    ? (context.lookupCapabilitySummary(fn) ??
      analyzeFunctionCapabilities(fn, {
        checker: context.checker,
        typeRegistry: context.state.typeRegistry,
        summaryCache: capabilitySummaryMemoFor(context).fallback,
      }))
    : analyzeFunctionCapabilities(fn, {
      checker: options?.checker,
    });
  if (!summary) return undefined;
  if (context && summary.unreadableCellArguments) {
    // A cell argument reached an imported parameter the capability contract
    // could not classify, so its capability was silently lost. Deduped by
    // source range across the per-parameter calls that share this summary.
    for (const unreadable of summary.unreadableCellArguments) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "capability:unreadable-cell-argument",
        message: unreadable.message,
        node: unreadable.node,
      });
    }
  }
  const parameter = fn.parameters[index];
  if (!parameter) return undefined;
  const paramName = ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : `__param${index}`;
  return summary.params.find((param) => param.name === paramName);
}

function applyCapabilitySummaryToArgument(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  argumentNode: ts.TypeNode | undefined,
  argumentType: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  mode: CapabilitySummaryApplicationMode = "full",
  context?: TransformationContext,
  fnNode?: ts.Node,
): ts.TypeNode | undefined {
  if (!argumentNode) return argumentNode;

  const paramSummary = findCapabilitySummaryForParameter(
    fn,
    0,
    context,
    isSyntheticNode(argumentNode) &&
      context?.isSyntheticComputeCallback?.(fnNode ?? fn)
      ? {
        checker,
        includeNestedCallbacks: true,
      }
      : undefined,
  );
  if (!paramSummary) {
    return argumentNode;
  }
  if (mode === "contract") {
    // The contract half of docs/history/plans/verb-input-contract.md: the authored
    // event serves verbatim in structure, with capabilities overlaid from
    // the body's usage and unobserved cell positions made opaque. The
    // body's observed paths still validate against the authored type — a
    // read of an unknown-typed property is an authoring error under either
    // mode.
    const overlaid = overlayContractCapabilities(
      argumentNode,
      argumentType,
      paramSummary,
      checker,
      factory,
      sourceFile,
      context?.state.typeRegistry,
      context?.state,
    );
    if (context) {
      validateShrinkCoverage(
        paramSummary,
        argumentNode,
        argumentType,
        [
          ...paramSummary.readPaths,
          ...paramSummary.writePaths,
          ...paramSummary.fullShapePaths ?? [],
        ],
        overlaid,
        context,
        fnNode ?? fn,
        checker,
      );
    }
    return overlaid;
  }
  let innerTypeNode = getAuthoredCellValueTypeNode(argumentNode, checker);
  if (!innerTypeNode && argumentType && isCellLikeType(argumentType, checker)) {
    // A cell whose wrapper no node writes out, such as one reached through a
    // generic alias, has no authored value node, so its value type is printed.
    // Schema generation can read some prints only from the type behind them —
    // a name the emitting module does not import, the brand arm of an expanded
    // `Default` — so the node is registered with its type.
    const valueType = unwrapCellLikeType(argumentType, checker);
    innerTypeNode = typeToSchemaTypeNode(
      valueType,
      checker,
      sourceFile,
      context?.state,
    );
    if (innerTypeNode && valueType) {
      context?.state.typeRegistry.set(innerTypeNode, valueType);
    }
  }
  const shouldWrap = !!innerTypeNode;
  const preservedWrapper = shouldWrap
    ? preservedWrapperFor(argumentNode, argumentType, checker)
    : undefined;
  const baseTypeNode = innerTypeNode ?? argumentNode;
  let baseType = shouldWrap && argumentType
    ? (unwrapCellLikeType(argumentType, checker) ?? argumentType)
    : argumentType;

  if (!baseType) {
    baseType = getTypeFromTypeNodeWithFallback(
      baseTypeNode,
      checker,
      context?.state.typeRegistry,
    );
  }

  return applyShrinkAndWrap(
    paramSummary,
    baseTypeNode,
    baseType,
    shouldWrap,
    checker,
    sourceFile,
    factory,
    mode,
    mode === "defaults_only" ? "opaque" : paramSummary.capability,
    context,
    fnNode ?? fn,
    preservedWrapper,
  );
}

function applyCapabilitySummaryToParameter(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  parameterIndex: number,
  parameterNode: ts.TypeNode | undefined,
  parameterType: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  context?: TransformationContext,
  fnNode?: ts.Node,
  mode: CapabilitySummaryApplicationMode = "full",
): ts.TypeNode | undefined {
  if (!parameterNode) return parameterNode;

  const paramSummary = findCapabilitySummaryForParameter(
    fn,
    parameterIndex,
    context,
    {
      checker,
      includeNestedCallbacks: true,
    },
  );
  if (!paramSummary) {
    return parameterNode;
  }
  if (mode === "contract") {
    // See the matching branch in applyCapabilitySummaryToArgument.
    const overlaid = overlayContractCapabilities(
      parameterNode,
      parameterType,
      paramSummary,
      checker,
      factory,
      sourceFile,
      context?.state.typeRegistry,
      context?.state,
    );
    if (context) {
      validateShrinkCoverage(
        paramSummary,
        parameterNode,
        parameterType,
        [
          ...paramSummary.readPaths,
          ...paramSummary.writePaths,
          ...paramSummary.fullShapePaths ?? [],
        ],
        overlaid,
        context,
        fnNode ?? fn,
        checker,
      );
    }
    return overlaid;
  }

  const innerTypeNode = getAuthoredCellValueTypeNode(parameterNode, checker);
  const shouldWrap = !!innerTypeNode;
  const preservedWrapper = shouldWrap
    ? preservedWrapperFor(parameterNode, parameterType, checker)
    : undefined;
  const baseTypeNode = innerTypeNode ?? parameterNode;
  let baseType = shouldWrap && parameterType
    ? (unwrapCellLikeType(parameterType, checker) ?? parameterType)
    : parameterType;

  if (!baseType) {
    baseType = getTypeFromTypeNodeWithFallback(
      baseTypeNode,
      checker,
      context?.state.typeRegistry,
    );
  }

  return applyShrinkAndWrap(
    paramSummary,
    baseTypeNode,
    baseType,
    shouldWrap,
    checker,
    sourceFile,
    factory,
    mode,
    paramSummary.capability,
    context,
    fnNode ?? fn,
    preservedWrapper,
  );
}

function collectFunctionSchemaTypeNodes(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  fallbackArgType?: ts.Type,
  typeRegistry?: TypeRegistry,
  argumentCapabilityMode: CapabilitySummaryApplicationMode = "full",
  context?: TransformationContext,
): {
  argument?: ts.TypeNode;
  argumentType?: ts.Type; // Store the Type for registry
  result?: ts.TypeNode;
  resultType?: ts.Type; // Store the Type for registry
} {
  const signature = checker.getSignatureFromDeclaration(fn);
  if (!signature) return {};

  // 1. Get parameter TypeNode (prefer original if it exists)
  const parameter = fn.parameters.length > 0 ? fn.parameters[0] : undefined;
  let argumentNode: ts.TypeNode | undefined;
  let argumentType: ts.Type | undefined;

  // Check for underscore prefix FIRST - this convention overrides type inference
  // Underscore-prefixed parameters are intentionally unused and should be `never`
  if (isIntentionallyUnusedSchemaParameter(parameter)) {
    // Return never type directly - don't infer or use explicit type
    argumentNode = ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  } else if (parameter?.type) {
    // Use original TypeNode from source - preserves all type information!
    argumentNode = parameter.type;
    // Also get the Type for registry - use fallback for synthetic TypeNodes
    argumentType = getTypeFromTypeNodeWithFallback(
      parameter.type,
      checker,
      typeRegistry,
    );
  } else {
    // Need to infer - get type and convert to TypeNode
    const paramType = inferParameterType(
      parameter,
      signature,
      checker,
      fallbackArgType,
      typeRegistry,
    );
    if (paramType && !isAnyOrUnknownType(paramType)) {
      argumentType = paramType; // Store for registry
      argumentNode = typeToSchemaTypeNode(
        paramType,
        checker,
        sourceFile,
        context?.state,
      );
    }
    // If inference failed, leave argumentNode undefined - we'll use unknown below
  }

  // Capability-based shrinking and wrapper selection for the first parameter.
  const originalArgumentNode = argumentNode;
  const originalArgumentType = argumentType;
  argumentNode = applyCapabilitySummaryToArgument(
    fn,
    argumentNode,
    argumentType,
    checker,
    sourceFile,
    factory,
    argumentCapabilityMode,
    context,
    fn,
  );
  if (
    argumentNode && originalArgumentNode &&
    argumentNode !== originalArgumentNode
  ) {
    // The node was wrapped/shrunk synthetically; recover a concrete Type when
    // possible so schema generation does not degrade to unknown/true.
    let recovered: ts.Type | undefined;
    try {
      recovered = getTypeFromTypeNodeWithFallback(
        argumentNode,
        checker,
        typeRegistry,
      );
    } catch (_e: unknown) {
      // Synthetic wrapped/shrunk nodes may not be resolvable by the checker.
      recovered = undefined;
    }

    if (recovered && !isAnyOrUnknownType(recovered)) {
      argumentType = recovered;
    } else if (
      originalArgumentType && !isAnyOrUnknownType(originalArgumentType) &&
      normalizeTypeNodeText(printTypeNode(argumentNode, sourceFile)) ===
        normalizeTypeNodeText(printTypeNode(originalArgumentNode, sourceFile))
    ) {
      // If lowering recreated an equivalent TypeNode (new identity, same shape),
      // preserve the original inferred type to avoid degrading property schemas.
      argumentType = originalArgumentType;
    } else {
      argumentType = undefined;
    }
  }

  if (
    shouldDropFallbackTypeForSchema(
      argumentNode,
      argumentType,
      checker,
      sourceFile,
    )
  ) {
    argumentType = undefined;
  }

  // 2. Get return type TypeNode
  let resultNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;

  if (fn.type) {
    // Explicit return type annotation - use it directly!
    resultNode = fn.type;
    // Also get the Type for registry - use fallback for synthetic TypeNodes
    resultType = getTypeFromTypeNodeWithFallback(
      fn.type,
      checker,
      typeRegistry,
    );
  } else {
    // Need to infer return type
    const returnType = inferReturnType(fn, signature, checker);
    if (returnType && !isUnresolvedSchemaType(returnType)) {
      resultType = returnType; // Store for registry
      resultNode = typeToSchemaTypeNode(
        returnType,
        checker,
        sourceFile,
        context?.state,
      );
    }
    // If inference failed, leave resultNode undefined - we'll use unknown below
  }

  if (
    shouldDropFallbackTypeForSchema(
      resultNode,
      resultType,
      checker,
      sourceFile,
    )
  ) {
    resultType = undefined;
  }

  const returnExpr = getCallbackReturnExpression(fn);
  const unwrappedReturnExpr = returnExpr
    ? unwrapExpression(returnExpr)
    : undefined;
  const uiContractHint = context &&
      unwrappedReturnExpr &&
      ts.isObjectLiteralExpression(unwrappedReturnExpr)
    ? propagateUiContractHintsFromObjectLiteral(
      unwrappedReturnExpr,
      resultNode,
      context,
    )
    : undefined;

  if (
    uiContractHint &&
    context &&
    unwrappedReturnExpr &&
    ts.isObjectLiteralExpression(unwrappedReturnExpr)
  ) {
    const previousResultNode = resultNode;
    const synthesizedResult = buildObjectLiteralReturnTypeNode(
      unwrappedReturnExpr,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      context,
    );
    if (synthesizedResult) {
      preserveUiContractHint(
        previousResultNode,
        synthesizedResult,
        context,
      );
      resultNode = synthesizedResult;
      resultType = undefined;
    }
  }

  if (
    context &&
    unwrappedReturnExpr &&
    ts.isObjectLiteralExpression(unwrappedReturnExpr) &&
    objectLiteralHasPreservedValueTypeNodes(
      unwrappedReturnExpr,
      checker,
      context.state,
    )
  ) {
    const scopedResult = buildObjectLiteralReturnTypeNode(
      unwrappedReturnExpr,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      context,
    );
    if (scopedResult) {
      preserveUiContractHint(
        resultNode,
        scopedResult,
        context,
      );
      resultNode = scopedResult;
      resultType = undefined;
    }
  }

  const needsResultRecovery = !resultNode ||
    containsAnyOrUnknownTypeNode(resultNode) ||
    shouldDropFallbackTypeForSchema(
      resultNode,
      resultType,
      checker,
      sourceFile,
    );

  if (needsResultRecovery) {
    if (
      context &&
      unwrappedReturnExpr &&
      ts.isObjectLiteralExpression(unwrappedReturnExpr)
    ) {
      const recoveredNode = buildObjectLiteralReturnTypeNode(
        unwrappedReturnExpr,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        context,
      );
      if (recoveredNode) {
        preserveUiContractHint(
          resultNode,
          recoveredNode,
          context,
        );
        resultNode = recoveredNode;
        resultType = undefined;
      }
    }

    if (!resultNode || containsAnyOrUnknownTypeNode(resultNode)) {
      const projectedResult = recoverProjectedResultSchema(
        fn,
        checker,
        sourceFile,
        argumentNode,
        argumentType ?? fallbackArgType,
        typeRegistry,
        context?.state,
      );
      if (projectedResult?.result) {
        if (context) {
          preserveUiContractHint(
            resultNode,
            projectedResult.result,
            context,
          );
        }
        resultNode = projectedResult.result;
        resultType = projectedResult.resultType;
      }
    }
  }

  // 3. If we couldn't infer a type, we can't transform at all
  // Both types are required for lift-applied calls to work
  if (!argumentNode && !resultNode) {
    return {}; // No types could be determined
  }

  // Build result object with only defined properties
  const result: {
    argument?: ts.TypeNode;
    argumentType?: ts.Type;
    result?: ts.TypeNode;
    resultType?: ts.Type;
  } = {};

  if (argumentNode) {
    result.argument = argumentNode;
    if (argumentType) result.argumentType = argumentType;
  }
  if (resultNode) {
    result.result = resultNode;
    if (resultType) result.resultType = resultType;
  }

  return result;
}

function createToSchemaCall(
  { cfHelpers, factory }: Pick<
    TransformationContext,
    "cfHelpers" | "factory"
  >,
  typeNode: ts.TypeNode,
  options?: SchemaCallOptions,
): ts.CallExpression {
  const expr = cfHelpers.getHelperExpr("toSchema");

  const args: ts.Expression[] = [];
  if (isSchemaCallOptionExpressions(options)) {
    args.push(...options);
  } else if (options?.widenLiterals || options?.scope) {
    const properties: ts.ObjectLiteralElementLike[] = [];
    if (options.widenLiterals) {
      properties.push(
        factory.createPropertyAssignment(
          "widenLiterals",
          factory.createTrue(),
        ),
      );
    }
    if (options.scope) {
      properties.push(
        factory.createPropertyAssignment(
          "scope",
          factory.createStringLiteral(options.scope),
        ),
      );
    }
    args.push(factory.createObjectLiteralExpression(properties));
  }

  return factory.createCallExpression(
    expr,
    [typeNode],
    args,
  );
}

type SchemaCallOptions =
  | { widenLiterals?: boolean; scope?: CellScope }
  | readonly ts.Expression[];

function isSchemaCallOptionExpressions(
  options: SchemaCallOptions | undefined,
): options is readonly ts.Expression[] {
  return Array.isArray(options);
}

function isToSchemaCall(node: ts.Expression): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  if (!node.typeArguments || node.typeArguments.length !== 1) return false;

  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "toSchema";
  }

  return ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "toSchema";
}

function createUnknownSchemaTypeNode(factory: ts.NodeFactory): ts.TypeNode {
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

function typeToInjectableSchemaTypeNode(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: TypeRegistry | undefined,
  state: CrossStageState | undefined,
): ts.TypeNode | undefined {
  if (!type) return undefined;
  if (isUnresolvedSchemaType(type)) {
    return createUnknownSchemaTypeNode(factory);
  }
  // `printedFrom` retains the type behind the placeholder when the checker
  // cannot print its expanded brands, so schema generation reads that type.
  return typeToTypeNodeWithRegistry(
    type,
    { checker, factory, sourceFile, state },
    typeRegistry,
  );
}

function normalizeSchemaInjectionTypeNode(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
): ts.TypeNode {
  if (typeNodeContainsWrapperSemantics(typeNode)) {
    return typeNode;
  }

  try {
    const type = getTypeFromTypeNodeWithFallback(
      typeNode,
      checker,
      typeRegistry,
    );
    if (isUnresolvedSchemaType(type)) {
      return createUnknownSchemaTypeNode(factory);
    }
  } catch (_e: unknown) {
    // Some synthetic nodes may not round-trip through the checker cleanly.
  }

  return typeNode;
}

function typeNodeContainsWrapperSemantics(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapTypeParentheses(typeNode);
  if (ts.isUnionTypeNode(unwrapped)) {
    return unwrapped.types.some((member) =>
      typeNodeContainsWrapperSemantics(member)
    );
  }

  return isCellLikeTypeNode(unwrapped);
}

function inferSchemaContextualType(
  node: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  return checker.getContextualType(node) ?? inferContextualType(node, checker);
}

/**
 * The `T` TypeScript inferred for a `wish()` call written without a type
 * argument, when the call has a contextual type to infer it from.
 *
 * The schema `wish()` takes describes `T`, the resource the wish asks for; the
 * runtime wraps it in the `WishState<T>` the call returns. The contextual type
 * is that result, so it is not the schema's type: the inference that takes
 * `T` out of it is the call's own, whatever wrapper or alias the result sits
 * behind. A call with no contextual type gets no schema.
 */
function inferWishTypeArgument(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (!inferSchemaContextualType(node, checker)) return undefined;
  const signature = checker.getResolvedSignature(node);
  return signature
    ? checker.getTypeArgumentsForResolvedSignature(signature)?.[0]
    : undefined;
}

function scopedFactoryContextualScope(
  node: ts.Expression,
  checker: ts.TypeChecker,
): CellScope | undefined {
  const contextualType = checker.getContextualType(node) ??
    inferContextualType(node, checker);
  if (!contextualType) return undefined;
  return cellScopeFromType(contextualType, checker, node);
}

function cellScopeFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
): CellScope | undefined {
  const aliasScope = type.aliasSymbol
    ? SCOPE_ALIAS_TO_CELL_SCOPE.get(type.aliasSymbol.name)
    : undefined;
  if (aliasScope && aliasScope !== "any") {
    return aliasScope;
  }

  for (const prop of type.getProperties()) {
    if (!isScopeBrandProperty(prop)) continue;
    const scope = cellScopeFromScopeBrandType(
      checker.getTypeOfSymbolAtLocation(prop, location),
    );
    if (scope) return scope;
  }

  return undefined;
}

function isScopeBrandProperty(prop: ts.Symbol): boolean {
  if (prop.getName().includes("SCOPE_BRAND")) return true;
  return (prop.declarations ?? []).some((declaration) => {
    const name = "name" in declaration
      ? (declaration as { name?: ts.Node }).name
      : undefined;
    return !!name && getNodeText(name).includes("SCOPE_BRAND");
  });
}

function cellScopeFromScopeBrandType(type: ts.Type): CellScope | undefined {
  if (type.isStringLiteral()) {
    return isCellScopeValue(type.value) ? type.value : undefined;
  }
  if (type.isUnion()) {
    for (const member of type.types) {
      const scope = cellScopeFromScopeBrandType(member);
      if (scope) return scope;
    }
  }
  return undefined;
}

function isCellScopeValue(value: string): value is CellScope {
  return value === "space" || value === "user" || value === "session";
}

function scopedConstructorAccessorScope(
  node: ts.CallExpression | ts.NewExpression,
): CellScope | undefined {
  const callee = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  if (ts.isNewExpression(node)) {
    switch (callee.name.text) {
      case "perSpace":
        return "space";
      case "perUser":
        return "user";
      case "perSession":
        return "session";
      default:
        return undefined;
    }
  }

  const constructorView = unwrapExpression(callee.expression);
  if (!ts.isPropertyAccessExpression(constructorView)) return undefined;

  switch (constructorView.name.text) {
    case "perSpace":
      return "space";
    case "perUser":
      return "user";
    case "perSession":
      return "session";
    default:
      return undefined;
  }
}

function cellConstructorCallScope(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
): CellScope | undefined {
  return scopedConstructorAccessorScope(node) ??
    scopedFactoryContextualScope(node, checker);
}

function isAlreadyScopedFactoryCall(node: ts.CallExpression): boolean {
  const callee = unwrapExpression(node.expression);
  return ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "asScope";
}

/**
 * A callee can receive a contextual scope if it is itself callable AND exposes
 * an `asScope(scope)` method (the lowering target). This covers the schema-built
 * pattern/node/module factories (which `isPatternFactoryCalleeExpression` also
 * matches) plus opaque builtin factories like `sqliteDatabase`, whose public
 * type is just `(...) => Reactive<...>` with an `asScope` method and so lacks
 * the `argumentSchema`/`resultSchema` shape that check keys on.
 */
function calleeExposesAsScope(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const target = unwrapExpression(expression);
  try {
    const type = checker.getTypeAtLocation(target);
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0) {
      return false;
    }
    const asScope = type.getProperty("asScope");
    if (!asScope) return false;
    const asScopeType = checker.getTypeOfSymbolAtLocation(asScope, target);
    return checker.getSignaturesOfType(asScopeType, ts.SignatureKind.Call)
      .length > 0;
  } catch {
    return false;
  }
}

function maybeApplyFactoryContextualScope(
  node: ts.CallExpression,
  context: TransformationContext,
): ts.CallExpression | undefined {
  const { checker, factory } = context;
  if (isAlreadyScopedFactoryCall(node)) return undefined;
  if (
    !isPatternFactoryCalleeExpression(node.expression, checker) &&
    !calleeExposesAsScope(node.expression, checker)
  ) {
    return undefined;
  }

  const scope = scopedFactoryContextualScope(node, checker);
  if (!scope) return undefined;

  // smr only (see prependSchemaArguments): the `.asScope(scope)` callee wrapper
  // reifies node.expression scoped, so it carries that expression's position.
  const scopedFactory = preserveSourceMapRange(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        node.expression,
        factory.createIdentifier("asScope"),
      ),
      undefined,
      [factory.createStringLiteral(scope)],
    ),
    node.expression,
  );
  return factory.updateCallExpression(
    node,
    scopedFactory,
    node.typeArguments,
    node.arguments,
  );
}

interface ResolvedInjectableSchemaType {
  readonly typeNode?: ts.TypeNode;
  readonly type?: ts.Type;
  readonly inferred: boolean;
}

interface ResolvedDualSchemaBuilderTypes {
  readonly argumentTypeNode: ts.TypeNode;
  readonly argumentTypeValue: ts.Type | undefined;
  readonly resultTypeNode: ts.TypeNode;
  readonly resultTypeValue: ts.Type | undefined;
}

function resolveInjectableSchemaType(
  explicitTypeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: TypeRegistry | undefined,
  state: CrossStageState | undefined,
  inferType: () => ts.Type | undefined,
): ResolvedInjectableSchemaType {
  if (explicitTypeNode) {
    return {
      typeNode: explicitTypeNode,
      type: getTypeFromTypeNodeWithFallback(
        explicitTypeNode,
        checker,
        typeRegistry,
      ),
      inferred: false,
    };
  }

  const inferredType = inferType();
  return {
    typeNode: typeToInjectableSchemaTypeNode(
      inferredType,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      state,
    ),
    type: inferredType,
    inferred: true,
  };
}

/**
 * Creates a schema call and transfers TypeRegistry entry if it exists.
 * This is the unified pattern for all transformation paths to preserve
 * closure-captured type information from ClosureTransformer.
 *
 * @param context - Transformation context
 * @param typeNode - The TypeNode to create a schema for
 * @param typeRegistry - Optional TypeRegistry to check for existing types
 * @param options - Optional schema generation options
 * @returns CallExpression for toSchema() with TypeRegistry entry transferred
 */
function createSchemaCallWithRegistryTransfer(
  context: Pick<TransformationContext, "factory" | "cfHelpers" | "sourceFile">,
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
  options?: SchemaCallOptions,
  schemaHints?: SchemaHints,
): ts.CallExpression {
  const emittedTypeNode = normalizeSchemaInjectionTypeNode(
    typeNode,
    checker,
    context.factory,
    typeRegistry,
  );
  const schemaCall = createToSchemaCall(context, emittedTypeNode, options);
  // This leaf utility takes a narrowed `context` (Pick) and the schemaHints map
  // explicitly, so it can't use context.recordSchemaHint; preserve the
  // cfcUiContract hint directly on the raw map (mirroring to the original node).
  if (schemaHints) {
    const hint = schemaHints.get(typeNode)?.cfcUiContract ??
      schemaHints.get(ts.getOriginalNode(typeNode))?.cfcUiContract;
    if (hint) {
      schemaHints.set(schemaCall, { cfcUiContract: hint });
      const originalSchemaCall = ts.getOriginalNode(schemaCall);
      if (originalSchemaCall !== schemaCall) {
        schemaHints.set(originalSchemaCall, { cfcUiContract: hint });
      }
    }
  }

  // Transfer TypeRegistry entry from source typeNode to schema call
  // This preserves type information for closure-captured variables
  if (
    typeRegistry && emittedTypeNode === typeNode &&
    !containsAnyOrUnknownTypeNode(emittedTypeNode)
  ) {
    const typeFromRegistry = typeRegistry.get(typeNode);
    if (typeFromRegistry) {
      typeRegistry.set(schemaCall, typeFromRegistry);
    }
  }

  return schemaCall;
}

function applyIdentityArrayItemSchemaHints(
  typeNode: ts.TypeNode,
  identityPaths: readonly (readonly string[])[],
  context: TransformationContext,
): void {
  if (identityPaths.length === 0) return;

  const grouped = new Map<string, boolean>();
  for (const path of identityPaths) {
    const [head, second] = path;
    if (head && second !== undefined && /^\d+$/.test(second)) {
      grouped.set(head, true);
    }
  }
  if (grouped.size === 0) return;

  const visitObject = (node: ts.TypeNode): void => {
    if (ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name || !member.type) {
          continue;
        }
        const name = ts.isIdentifier(member.name) ||
            ts.isStringLiteral(member.name)
          ? member.name.text
          : undefined;
        if (name && grouped.has(name)) {
          context.recordSchemaHint(member.type, { items: false });
        }
      }
    }
  };

  visitObject(typeNode);
}

function createRegisteredSchemaCallFromResolvedType(
  context: Pick<TransformationContext, "factory" | "cfHelpers" | "sourceFile">,
  resolved: ResolvedInjectableSchemaType,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
  options?: SchemaCallOptions,
): ts.CallExpression | undefined {
  if (!resolved.typeNode) {
    return undefined;
  }

  const schemaCall = createSchemaCallWithRegistryTransfer(
    context,
    resolved.typeNode,
    checker,
    typeRegistry,
    options,
  );

  if (
    resolved.inferred &&
    typeRegistry &&
    resolved.type &&
    !isUnresolvedSchemaType(resolved.type)
  ) {
    typeRegistry.set(schemaCall, resolved.type);
  }

  return schemaCall;
}

/**
 * Gets type from TypeRegistry if available, otherwise uses fallback.
 * Used for inferred types that may have been created by ClosureTransformer.
 *
 * @param typeNode - The TypeNode to look up in registry
 * @param fallbackType - Type to use if not found in registry
 * @param typeRegistry - Optional TypeRegistry to check
 * @returns Type from registry or fallback type
 */
function getTypeFromRegistryOrFallback(
  typeNode: ts.TypeNode | undefined,
  fallbackType: ts.Type | undefined,
  typeRegistry?: TypeRegistry,
): ts.Type | undefined {
  if (typeNode && typeRegistry?.has(typeNode)) {
    return typeRegistry.get(typeNode);
  }
  return fallbackType;
}

function registerInjectedCallResultType(
  originalCall: ts.CallExpression,
  updatedCall: ts.CallExpression,
  resultTypeNode: ts.TypeNode,
  resultTypeValue: ts.Type | undefined,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): void {
  if (!typeRegistry) return;

  const resolvedType = getTypeFromRegistryOrFallback(
    resultTypeNode,
    resultTypeValue,
    typeRegistry,
  ) ?? getTypeFromTypeNodeWithFallback(resultTypeNode, checker, typeRegistry);

  if (!resolvedType || isAnyOrUnknownType(resolvedType)) {
    return;
  }

  registerSyntheticCallType(updatedCall, resolvedType, typeRegistry);
  registerSyntheticCallType(originalCall, resolvedType, typeRegistry);
}

function applyCallbackBuilderArgumentCapabilitySummary(
  callback: ts.ArrowFunction | ts.FunctionExpression | undefined,
  argumentTypeNode: ts.TypeNode,
  argumentTypeValue: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  context: TransformationContext,
  mode: CapabilitySummaryApplicationMode = "full",
): {
  argumentTypeNode: ts.TypeNode;
  argumentTypeValue: ts.Type | undefined;
} {
  if (!callback) {
    return { argumentTypeNode, argumentTypeValue };
  }

  const transformedArgumentType = applyCapabilitySummaryToArgument(
    callback,
    argumentTypeNode,
    argumentTypeValue,
    checker,
    sourceFile,
    factory,
    mode,
    context,
    callback,
  );

  if (!transformedArgumentType) {
    return { argumentTypeNode, argumentTypeValue };
  }

  return {
    argumentTypeNode: transformedArgumentType,
    argumentTypeValue: transformedArgumentType === argumentTypeNode
      ? argumentTypeValue
      : undefined,
  };
}

function resolveDualSchemaBuilderTypes(
  callback: ts.ArrowFunction | ts.FunctionExpression | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: TypeRegistry | undefined,
  context: TransformationContext,
  options?: {
    readonly fallbackArgumentType?: ts.Type;
    readonly explicitArgumentTypeNode?: ts.TypeNode;
    readonly explicitArgumentTypeValue?: ts.Type;
    readonly explicitResultTypeNode?: ts.TypeNode;
    readonly explicitResultTypeValue?: ts.Type;
    readonly fallbackArgumentNode?: ts.TypeNode;
    readonly capabilityMode?: CapabilitySummaryApplicationMode;
    readonly applyExplicitArgumentCapabilitySummary?: boolean;
  },
): ResolvedDualSchemaBuilderTypes | undefined {
  let argumentTypeNode = options?.explicitArgumentTypeNode;
  let argumentTypeValue = options?.explicitArgumentTypeValue ??
    (argumentTypeNode
      ? getTypeFromTypeNodeWithFallback(argumentTypeNode, checker, typeRegistry)
      : undefined);

  if (
    callback &&
    argumentTypeNode &&
    options?.applyExplicitArgumentCapabilitySummary !== false
  ) {
    ({
      argumentTypeNode,
      argumentTypeValue,
    } = applyCallbackBuilderArgumentCapabilitySummary(
      callback,
      argumentTypeNode,
      argumentTypeValue,
      checker,
      sourceFile,
      factory,
      context,
      options?.capabilityMode ?? "full",
    ));
  }

  let inferred:
    | ReturnType<typeof collectFunctionSchemaTypeNodes>
    | undefined;
  if (!argumentTypeNode || !options?.explicitResultTypeNode) {
    if (!callback) {
      return undefined;
    }
    inferred = collectFunctionSchemaTypeNodes(
      callback,
      checker,
      sourceFile,
      factory,
      options?.fallbackArgumentType,
      typeRegistry,
      options?.capabilityMode ?? "full",
      context,
    );
  }

  if (!argumentTypeNode) {
    argumentTypeNode = inferred?.argument ??
      options?.fallbackArgumentNode ??
      getParameterSchemaType(factory, callback?.parameters[0]);
    argumentTypeValue = getTypeFromRegistryOrFallback(
      argumentTypeNode,
      inferred?.argumentType,
      typeRegistry,
    );
  }

  if (
    callback &&
    !callback.parameters[0]?.type &&
    options?.fallbackArgumentType &&
    isCellLikeType(options.fallbackArgumentType, checker) &&
    parameterUsesCellLikeMethods(callback, 0)
  ) {
    const fallbackArgumentNode = typeToSchemaTypeNode(
      options.fallbackArgumentType,
      checker,
      sourceFile,
      context.state,
    );
    if (fallbackArgumentNode) {
      ({
        argumentTypeNode,
        argumentTypeValue,
      } = applyCallbackBuilderArgumentCapabilitySummary(
        callback,
        fallbackArgumentNode,
        options.fallbackArgumentType,
        checker,
        sourceFile,
        factory,
        context,
      ));
    } else {
      argumentTypeValue = options.fallbackArgumentType;
    }
  }

  if (
    callback &&
    !callback.parameters[0]?.type &&
    options?.fallbackArgumentType &&
    isCellLikeType(options.fallbackArgumentType, checker) &&
    containsAnyOrUnknownTypeNode(argumentTypeNode)
  ) {
    const fallbackArgumentNode = typeToSchemaTypeNode(
      options.fallbackArgumentType,
      checker,
      sourceFile,
      context.state,
    );
    if (fallbackArgumentNode) {
      ({
        argumentTypeNode,
        argumentTypeValue,
      } = applyCallbackBuilderArgumentCapabilitySummary(
        callback,
        fallbackArgumentNode,
        options.fallbackArgumentType,
        checker,
        sourceFile,
        factory,
        context,
      ));
    }
  }

  const resultTypeNode = options?.explicitResultTypeNode ??
    inferred?.result ??
    createUnknownSchemaTypeNode(factory);
  const resultTypeValue = options?.explicitResultTypeValue ??
    (options?.explicitResultTypeNode
      ? getTypeFromTypeNodeWithFallback(
        resultTypeNode,
        checker,
        typeRegistry,
      )
      : getTypeFromRegistryOrFallback(
        resultTypeNode,
        inferred?.resultType,
        typeRegistry,
      ));

  return {
    argumentTypeNode,
    argumentTypeValue,
    resultTypeNode,
    resultTypeValue,
  };
}

function visitInjectedDualSchemaBuilderCall(
  node: ts.CallExpression,
  argumentTypeNode: ts.TypeNode,
  argumentTypeValue: ts.Type | undefined,
  resultTypeNode: ts.TypeNode,
  resultTypeValue: ts.Type | undefined,
  context: TransformationContext,
  visit: (node: ts.Node) => ts.Node,
  transformation: ts.TransformationContext,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): ts.Node {
  const updated = prependSchemaArguments(
    context,
    node,
    argumentTypeNode,
    argumentTypeValue,
    resultTypeNode,
    resultTypeValue,
    typeRegistry,
    checker,
  );
  registerInjectedCallResultType(
    node,
    updated,
    resultTypeNode,
    resultTypeValue,
    checker,
    typeRegistry,
  );
  // Mark BEFORE re-descending: the re-descent below re-enters `updated` to
  // reach the callback body (catching pattern calls ClosureTransformer
  // created inside builder callbacks, e.g. from map transformations). Marking
  // first means that re-entry self-skips the builder/schema logic and only the
  // callback is visited.
  context.markSchemaInjected(updated);
  return ts.visitEachChild(updated, visit, transformation);
}

function createRegisteredWidenedSchemaCall(
  type: ts.Type,
  context: Pick<
    TransformationContext,
    "factory" | "cfHelpers" | "sourceFile" | "state"
  >,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): ts.CallExpression {
  const schemaTypeNode = typeToSchemaTypeNode(
    widenLiteralType(type, checker),
    checker,
    context.sourceFile,
    context.state,
  ) ?? context.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  const schemaCall = createSchemaCallWithRegistryTransfer(
    context,
    schemaTypeNode,
    checker,
    typeRegistry,
    { widenLiterals: true },
  );

  if (typeRegistry) {
    typeRegistry.set(schemaCall, type);
  }

  return schemaCall;
}

function visitPrependedWidenedSchemaCall(
  node: ts.CallExpression,
  args: readonly ts.Expression[],
  schemaTypes: readonly ts.Type[],
  context: TransformationContext,
  visit: (node: ts.Node) => ts.Node,
  transformation: ts.TransformationContext,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): ts.Node {
  const schemas = schemaTypes.map((type) =>
    createRegisteredWidenedSchemaCall(type, context, checker, typeRegistry)
  );

  // smr only (see prependSchemaArguments for the rationale).
  const updated = preserveSourceMapRange(
    context.factory.createCallExpression(
      node.expression,
      undefined,
      [...schemas, ...args],
    ),
    node,
  );

  context.markSchemaInjected(updated);
  return ts.visitEachChild(updated, visit, transformation);
}

/**
 * Rewrites a reactive conditional (`when`/`unless`/`ifElse`), authored as
 * `fn(condition, ...branches)`, to carry a generated schema for each argument
 * plus the call's result type, inserted ahead of the original arguments (what
 * visitPrependedWidenedSchemaCall does). The first argument is the reactive
 * condition, so it gets the unknown-capture check.
 *
 * `arity` is the authored argument count (2 for when/unless, 3 for ifElse). A
 * call that already has the schemas added has more arguments; an earlier marker
 * keeps it from being processed twice, so this length check just skips that
 * already-rewritten form.
 */
function visitReactiveConditional(
  node: ts.CallExpression,
  arity: number,
  context: TransformationContext,
  visit: (node: ts.Node) => ts.Node,
  transformation: ts.TransformationContext,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): ts.Node {
  const args = node.arguments;
  if (args.length !== arity) {
    // Other arities are the already-rewritten form (schemas prepended).
    return ts.visitEachChild(node, visit, transformation);
  }

  // getTypeAtLocationWithFallback handles synthetic nodes (e.g. lift-applied
  // calls) whose types live in the typeRegistry rather than at a source range.
  const typeOf = (expr: ts.Node): ts.Type =>
    getTypeAtLocationWithFallback(expr, checker, typeRegistry) ??
      checker.getTypeAtLocation(expr);

  const argTypes = args.map(typeOf);
  // Only the condition is checked. It is materialized here to choose a branch,
  // so an unknown condition silently reads back as a reference at this
  // boundary — which is truthy whenever the position holds anything, so a
  // condition that was meant to be `false` picks the other branch. The
  // branches are result values that flow outward unmaterialized — an unknown
  // branch is not lost here; it propagates as the call's unknown result and is
  // reported where that result is consumed (captured).
  reportUnknownReactiveType(context, args[0]!, argTypes[0], "condition");

  return visitPrependedWidenedSchemaCall(
    node,
    args,
    [...argTypes, typeOf(node)],
    context,
    visit,
    transformation,
    checker,
    typeRegistry,
  );
}

function inferLiftFactoryResultType(
  node: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  context?: TransformationContext,
): ts.Type | undefined {
  const valueInitializer = getVariableInitializer(node, checker);
  if (!valueInitializer || !ts.isCallExpression(valueInitializer)) {
    return undefined;
  }

  const factoryInitializer = getVariableInitializer(
    valueInitializer.expression,
    checker,
  );
  if (!factoryInitializer || !ts.isCallExpression(factoryInitializer)) {
    return undefined;
  }

  const callKind = detectCallKind(factoryInitializer, checker);
  if (callKind?.kind !== "builder" || callKind.builderName !== "lift") {
    return undefined;
  }

  const callback = resolveFunctionLikeExpression(
    factoryInitializer.arguments[0],
    checker,
    sourceFile,
  );
  if (!callback) {
    return undefined;
  }

  let fallbackArgType: ts.Type | undefined;
  if (factoryInitializer.typeArguments?.length) {
    const [argumentType] = factoryInitializer.typeArguments;
    if (argumentType) {
      fallbackArgType = getTypeFromTypeNodeWithFallback(
        argumentType,
        checker,
        typeRegistry,
      );
    }
  }

  const inferred = collectFunctionSchemaTypeNodes(
    callback,
    checker,
    sourceFile,
    factory,
    fallbackArgType,
    typeRegistry,
    "full",
    context,
  );
  const resultType = getTypeFromRegistryOrFallback(
    inferred.result,
    inferred.resultType,
    typeRegistry,
  ) ?? (inferred.result
    ? getTypeFromTypeNodeWithFallback(inferred.result, checker, typeRegistry)
    : undefined);

  if (!resultType || isAnyOrUnknownType(resultType)) {
    return undefined;
  }

  return resultType;
}

function getCallbackReturnExpression(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  if (ts.isExpression(fn.body)) {
    return fn.body;
  }

  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      return statement.expression;
    }
  }

  return undefined;
}

function getDirectProjectionPropertyName(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): string | undefined {
  const parameter = fn.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return undefined;
  }

  const body = getCallbackReturnExpression(fn);
  if (!body) {
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === parameter.name.text
  ) {
    return body.name.text;
  }

  if (
    ts.isElementAccessExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === parameter.name.text &&
    body.argumentExpression &&
    ts.isStringLiteralLike(body.argumentExpression)
  ) {
    return body.argumentExpression.text;
  }

  return undefined;
}

function findTypeLiteralPropertyTypeNode(
  argumentNode: ts.TypeNode,
  propertyName: string,
): ts.TypeNode | undefined {
  if (!ts.isTypeLiteralNode(argumentNode)) {
    return undefined;
  }

  const member = argumentNode.members.find((member) =>
    ts.isPropertySignature(member) &&
    member.type &&
    ((ts.isIdentifier(member.name) && member.name.text === propertyName) ||
      (ts.isStringLiteralLike(member.name) &&
        member.name.text === propertyName))
  );

  if (!member || !ts.isPropertySignature(member) || !member.type) {
    return undefined;
  }

  return member.type;
}

function recoverProjectedResultSchema(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  argumentNode: ts.TypeNode | undefined,
  argumentType: ts.Type | undefined,
  typeRegistry: TypeRegistry | undefined,
  state: CrossStageState | undefined,
): { result?: ts.TypeNode; resultType?: ts.Type } | undefined {
  const propertyName = getDirectProjectionPropertyName(fn);
  if (!propertyName) {
    return undefined;
  }

  if (argumentType && !isAnyOrUnknownType(argumentType)) {
    const property = argumentType.getProperty(propertyName);
    if (property) {
      const propertyType = getSymbolTypeAtSource(property, checker, sourceFile);
      if (!isAnyOrUnknownType(propertyType)) {
        const propertyTypeNode = typeToSchemaTypeNode(
          propertyType,
          checker,
          sourceFile,
          state,
        );
        if (propertyTypeNode) {
          typeRegistry?.set(propertyTypeNode, propertyType);
          return { result: propertyTypeNode, resultType: propertyType };
        }
      }
    }
  }

  if (!argumentNode) {
    return undefined;
  }

  const propertyTypeNode = findTypeLiteralPropertyTypeNode(
    argumentNode,
    propertyName,
  );
  if (propertyTypeNode) {
    return { result: propertyTypeNode };
  }

  return undefined;
}

function inferLiftAppliedResultTypeFromInitializer(
  node: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  context?: TransformationContext,
): ts.Type | undefined {
  const initializer = getVariableInitializer(node, checker);
  if (!initializer || !ts.isCallExpression(initializer)) {
    return undefined;
  }

  const callKind = detectCallKind(initializer, checker);
  if (callKind?.kind !== "lift-applied") {
    return undefined;
  }

  const liftAppliedArgs = resolveLiftAppliedInputAndCallback(
    initializer,
    checker,
    sourceFile,
  );
  if (!liftAppliedArgs) {
    return undefined;
  }
  const { input: firstArg, callback } = liftAppliedArgs;

  let argumentType =
    getTypeAtLocationWithFallback(firstArg, checker, typeRegistry) ??
      checker.getTypeAtLocation(firstArg);
  if (isAnyOrUnknownType(argumentType)) {
    const recoveredArgumentType = inferLiftFactoryResultType(
      firstArg,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      context,
    );
    if (recoveredArgumentType && !isAnyOrUnknownType(recoveredArgumentType)) {
      argumentType = recoveredArgumentType;
    }
  }

  const inferred = collectFunctionSchemaTypeNodes(
    callback,
    checker,
    sourceFile,
    factory,
    argumentType,
    typeRegistry,
    "full",
    context,
  );
  const resultType = getTypeFromRegistryOrFallback(
    inferred.result,
    inferred.resultType,
    typeRegistry,
  ) ?? (inferred.result
    ? getTypeFromTypeNodeWithFallback(inferred.result, checker, typeRegistry)
    : undefined);
  if (resultType && !isAnyOrUnknownType(resultType)) {
    return resultType;
  }

  return undefined;
}

function inferExpressionTypeWithInitializerFallback(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  context?: TransformationContext,
): ts.Type | undefined {
  const type = getTypeAtLocationWithFallback(expr, checker, typeRegistry) ??
    checker.getTypeAtLocation(expr);
  if (!isAnyOrUnknownType(type)) {
    return type;
  }

  const fromLift = inferLiftFactoryResultType(
    expr,
    checker,
    sourceFile,
    factory,
    typeRegistry,
    context,
  );
  if (fromLift && !isAnyOrUnknownType(fromLift)) {
    return fromLift;
  }

  const fromLiftApplied = inferLiftAppliedResultTypeFromInitializer(
    expr,
    checker,
    sourceFile,
    factory,
    typeRegistry,
    context,
  );
  if (fromLiftApplied && !isAnyOrUnknownType(fromLiftApplied)) {
    return fromLiftApplied;
  }

  return type;
}

function buildObjectLiteralReturnTypeNode(
  expr: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  context?: TransformationContext,
): ts.TypeNode | undefined {
  const members: ts.TypeElement[] = [];

  for (const property of expr.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return undefined;
    }

    const valueExpr = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;
    const valueType = inferExpressionTypeWithInitializerFallback(
      valueExpr,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      context,
    );
    if (!valueType || isAnyOrUnknownType(valueType)) {
      return undefined;
    }

    const explicit = getExplicitValueTypeNode(
      valueExpr,
      checker,
      typeRegistry,
      context?.state,
    );
    const valueTypeNode = explicit?.typeNode ??
      typeToSchemaTypeNode(valueType, checker, sourceFile, context?.state);
    if (!valueTypeNode) {
      return undefined;
    }
    // A node printed from a type is read by that type: the names it spells
    // resolve to nothing here, and the type carries the wrappers the body's
    // view of the binding has stripped. An authored node reads on its own.
    typeRegistry?.set(valueTypeNode, explicit?.printedFrom ?? valueType);
    const valueHint = context
      ? getUiContractHintFromNode(valueExpr, context)
      : undefined;
    if (valueHint && context) {
      context.recordSchemaHint(valueTypeNode, { cfcUiContract: valueHint });
    }

    members.push(
      factory.createPropertySignature(
        undefined,
        property.name,
        undefined,
        valueTypeNode,
      ),
    );
  }

  return createRegisteredTypeLiteral(
    members,
    { factory, checker, typeRegistry },
  );
}

/** The authored type of a returned cell expression or identifier declaration. */
function getExplicitValueTypeNode(
  valueExpr: ts.Expression,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  state?: CrossStageState,
): PreservedBindingType | undefined {
  const cellType = getConstructedCellTypeNode(valueExpr, checker, typeRegistry);
  if (cellType) return { typeNode: cellType };
  if (!ts.isIdentifier(valueExpr)) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(valueExpr);
  let declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
    const shorthandValueSymbol = checker.getShorthandAssignmentValueSymbol(
      declaration,
    );
    declaration = shorthandValueSymbol?.valueDeclaration ??
      shorthandValueSymbol?.declarations?.[0];
  }
  if (declaration && ts.isVariableDeclaration(declaration)) {
    return declaration.type ? { typeNode: declaration.type } : undefined;
  }
  if (declaration && ts.isBindingElement(declaration)) {
    return getPreservedTypeForBindingElement(
      declaration,
      checker,
      typeRegistry,
      state,
    );
  }
  return undefined;
}

function objectLiteralHasPreservedValueTypeNodes(
  expr: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  state: CrossStageState,
): boolean {
  for (const property of expr.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }

    const valueExpr = ts.isPropertyAssignment(property)
      ? unwrapExpression(property.initializer)
      : property.name;
    const explicit = getExplicitValueTypeNode(
      valueExpr,
      checker,
      undefined,
      state,
    );
    // Inference can erase a scope wrapper or print a writer binding as a
    // structural function type. Authored syntax retains both declarations.
    if (
      explicit &&
      (namesValueBinding(explicit.typeNode, checker) ||
        typeNodeContainsScopeWrapper(explicit.typeNode) ||
        (explicit.preservedTypeNode &&
          typeNodeContainsScopeWrapper(explicit.preservedTypeNode)))
    ) {
      return true;
    }
  }

  return false;
}

function typeNodeContainsScopeWrapper(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapTypeParentheses(typeNode);
  if (ts.isTypeReferenceNode(unwrapped)) {
    const name = ts.isIdentifier(unwrapped.typeName)
      ? unwrapped.typeName.text
      : unwrapped.typeName.right.text;
    return SCOPE_ALIAS_TO_CELL_SCOPE.has(name) ||
      (unwrapped.typeArguments?.some(typeNodeContainsScopeWrapper) ?? false);
  }
  if (ts.isUnionTypeNode(unwrapped) || ts.isIntersectionTypeNode(unwrapped)) {
    return unwrapped.types.some(typeNodeContainsScopeWrapper);
  }
  if (ts.isArrayTypeNode(unwrapped)) {
    return typeNodeContainsScopeWrapper(unwrapped.elementType);
  }
  if (ts.isTypeLiteralNode(unwrapped)) {
    return unwrapped.members.some((member) =>
      ts.isPropertySignature(member) &&
      !!member.type &&
      typeNodeContainsScopeWrapper(member.type)
    );
  }
  return false;
}

function propagateUiContractHintsFromObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  resultNode: ts.TypeNode | undefined,
  context: TransformationContext,
):
  | UiContractHint
  | undefined {
  if (!resultNode) {
    return undefined;
  }

  const target = unwrapTypeParentheses(resultNode);
  let resultHint:
    | UiContractHint
    | undefined;
  for (const property of expr.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }

    const valueExpr = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;
    const hint = getUiContractHintFromNode(valueExpr, context);
    if (!hint) {
      continue;
    }
    resultHint = resultHint ?? hint;

    if (ts.isTypeLiteralNode(target)) {
      const memberName = getObjectLiteralPropertyName(property.name);
      if (!memberName) {
        continue;
      }

      const member = target.members.find(
        (entry): entry is ts.PropertySignature =>
          ts.isPropertySignature(entry) &&
          getObjectLiteralPropertyName(entry.name) === memberName,
      );
      if (member?.type) {
        context.recordSchemaHint(member.type, { cfcUiContract: hint });
      }
    }
  }

  if (resultHint) {
    context.recordSchemaHint(target, { cfcUiContract: resultHint });
    return resultHint;
  }

  return undefined;
}

function getUiContractHintFromObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  context: TransformationContext,
):
  | UiContractHint
  | undefined {
  for (const property of expr.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const valueExpr = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;
    const hint = getUiContractHintFromNode(valueExpr, context);
    if (hint) {
      return hint;
    }
  }

  return undefined;
}

function setUiContractHint(
  target: ts.Node | undefined,
  hint: UiContractHint | undefined,
  context: TransformationContext,
): void {
  if (!target || !hint) {
    return;
  }

  context.recordSchemaHint(target, { cfcUiContract: hint });
}

function preserveUiContractHint(
  fromNode: ts.Node | undefined,
  toNode: ts.Node | undefined,
  context: TransformationContext,
): void {
  if (!fromNode || !toNode) {
    return;
  }

  const hint = context.lookupSchemaHint(fromNode)?.cfcUiContract;
  if (!hint) {
    return;
  }

  context.recordSchemaHint(toNode, { cfcUiContract: hint });
}

function getUiContractHintFromNode(
  node: ts.Node | undefined,
  context: TransformationContext,
):
  | UiContractHint
  | undefined {
  if (!node) {
    return undefined;
  }

  const storedHint = context.lookupSchemaHint(node)?.cfcUiContract;
  if (storedHint) {
    return storedHint;
  }

  return extractUiContractFromLoweredJsx(node);
}

function extractUiContractFromLoweredJsx(
  node: ts.Node,
):
  | UiContractHint
  | undefined {
  const attributes = ts.isJsxElement(node)
    ? node.openingElement.attributes.properties
    : ts.isJsxSelfClosingElement(node)
    ? node.attributes.properties
    : undefined;
  if (!attributes) {
    return undefined;
  }

  const getLiteralAttr = (name: string): string | undefined => {
    for (const attribute of attributes) {
      if (
        !ts.isJsxAttribute(attribute) ||
        !ts.isIdentifier(attribute.name) ||
        attribute.name.text !== name ||
        !attribute.initializer
      ) {
        continue;
      }
      if (ts.isStringLiteral(attribute.initializer)) {
        return attribute.initializer.text;
      }
      if (
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        ts.isStringLiteral(attribute.initializer.expression)
      ) {
        return attribute.initializer.expression.text;
      }
    }
    return undefined;
  };

  const action = getLiteralAttr("data-ui-action");
  if (action) {
    return { helper: "UiAction", action };
  }

  const surface = getLiteralAttr("data-ui-surface");
  if (surface) {
    const role = getLiteralAttr("data-ui-role");
    return role ? { helper: "UiPromptSlot", surface, role } : undefined;
  }

  const kind = getLiteralAttr("data-ui-disclosure-kind");
  return kind ? { helper: "UiDisclosure", kind } : undefined;
}

function getObjectLiteralPropertyName(
  name: ts.PropertyName,
): string | undefined {
  if (
    ts.isIdentifier(name) || ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression)
  ) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * Determines the appropriate schema TypeNode for a function parameter based on
 * whether it exists and whether it has explicit type annotation.
 *
 * Rules:
 * - No parameter → never (schema: false)
 * - Parameter with _ prefix and no type → never (schema: false)
 * - Parameter with explicit type → use that type
 * - Parameter without type → unknown (schema: true)
 */
function getParameterSchemaType(
  factory: ts.NodeFactory,
  param: ts.ParameterDeclaration | undefined,
): ts.TypeNode {
  // No parameter at all → never
  if (!param) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Has explicit type → use it
  if (param.type) {
    return param.type;
  }

  // Check if parameter name starts with _ (unused convention)
  if (isIntentionallyUnusedSchemaParameter(param)) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Parameter exists without type → unknown
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

/**
 * Infer schema type for a specific parameter, respecting underscore-prefix convention
 * and attempting type inference before falling back to never/unknown.
 */
function inferParameterSchemaType(
  factory: ts.NodeFactory,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  paramIndex: number,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  state: CrossStageState | undefined,
): ts.TypeNode {
  const param = fn.parameters[paramIndex];

  // Check underscore prefix first
  if (isIntentionallyUnusedSchemaParameter(param)) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Has explicit type annotation - use it
  if (param?.type) {
    return param.type;
  }

  // Try to infer from signature
  if (param) {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (signature && signature.parameters.length > paramIndex) {
      const paramSymbol = signature.parameters[paramIndex];
      if (paramSymbol) {
        const paramType = checker.getTypeOfSymbol(paramSymbol);
        if (paramType && !isAnyOrUnknownType(paramType)) {
          const typeNode = typeToSchemaTypeNode(
            paramType,
            checker,
            sourceFile,
            state,
          );
          if (typeNode) {
            return typeNode;
          }
        }
      }
    }
    // Inference failed - use unknown
    return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }

  // No parameter at all - use never
  return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
}

function isIntentionallyUnusedSchemaParameter(
  param: ts.ParameterDeclaration | undefined,
): boolean {
  if (!param || !ts.isIdentifier(param.name)) {
    return false;
  }

  const name = param.name.text;
  if (!name.startsWith("_")) {
    return false;
  }

  // Synthetic CTS parameters use internal "__cf_*" and "__param*" prefixes.
  // They still carry meaningful structural types and must not collapse to
  // never/false just because they start with underscores.
  if (name.startsWith("__cf_") || name.startsWith("__param")) {
    return false;
  }

  return true;
}

/**
 * True when the outer applied-call args are exactly a single empty object
 * literal `{}` — the no-capture placeholder LiftLoweringTransformer emits for
 * computed-origin lifts and which ClosureTransformer leaves untouched when the
 * computation captures nothing. By schema-injection time this reliably means
 * "zero input"; captured computeds carry a populated input object here.
 */
function isSingleEmptyObjectInput(
  args: readonly ts.Expression[],
): boolean {
  if (args.length !== 1) return false;
  const arg = args[0];
  return !!arg && ts.isObjectLiteralExpression(arg) &&
    arg.properties.length === 0;
}

function prependSchemaArguments(
  context: Pick<
    TransformationContext,
    "factory" | "cfHelpers" | "sourceFile" | "markSchemaInjected"
  >,
  node: ts.CallExpression,
  argumentTypeNode: ts.TypeNode,
  argumentType: ts.Type | undefined,
  resultTypeNode: ts.TypeNode,
  resultType: ts.Type | undefined,
  typeRegistry?: TypeRegistry,
  checker?: ts.TypeChecker,
): ts.CallExpression {
  const argSchemaCall = checker
    ? createSchemaCallWithRegistryTransfer(
      context,
      argumentTypeNode,
      checker,
      typeRegistry,
    )
    : createToSchemaCall(context, argumentTypeNode);
  const resSchemaCall = checker
    ? createSchemaCallWithRegistryTransfer(
      context,
      resultTypeNode,
      checker,
      typeRegistry,
    )
    : createToSchemaCall(context, resultTypeNode);

  // Register Types if they were inferred (not from original source)
  if (typeRegistry && checker) {
    if (argumentType && !isUnresolvedSchemaType(argumentType)) {
      typeRegistry.set(argSchemaCall, argumentType);
    }
    if (resultType && !isUnresolvedSchemaType(resultType)) {
      typeRegistry.set(resSchemaCall, resultType);
    }
  }

  // For the lift-applied shape (__cfHelpers.lift(cb)(input)), schemas are
  // spliced into the INNER lift call's arguments in function-first order:
  // `lift(cb, argSchema, resSchema, options?)`. The inner call's args are
  // `[callback, ...trailingOptions]` (an optional DeriveSchedulerOptions object
  // may follow the callback — see lift-applied-strategy). The schemas go AFTER
  // the callback but BEFORE any trailing options, mirroring the runtime
  // signature `lift(fn, argumentSchema?, resultSchema?, options?)`. The outer
  // applied call's input stays untouched.
  const innerLiftCall = getLiftAppliedInnerCall(node);
  if (innerLiftCall) {
    const [innerCallback, ...trailingInnerArgs] = innerLiftCall.arguments;
    const calleeArgs = innerCallback ? [innerCallback] : [];
    // No-input case: a single empty object literal `{}` as the outer input
    // means a genuinely zero-capture computation (computed-origin). By this
    // stage ClosureTransformer has already reified any captures into the
    // input, so an empty input here is final. Emit the canonical no-input
    // form `lift(cb, false)()`: `false` argument schema (matching computed's
    // runtime semantics — keeps the no-arg application valid) and no outer
    // input. We deliberately omit the result schema, again matching computed.
    // Each rebuild carries the sourceMapRange of the node it REPLACES (inner
    // lift call / outer applied call), so the hoisting stage — SchemaInjection
    // is its immediate predecessor and used to strip everything — can still
    // recover where the builder call was authored (CT-1868). smr ONLY, not
    // `factory.update*` or setTextRange/setOriginalNode: textRange feeds the
    // printer's layout decisions (real positions inside synthesized containers
    // reflow JSX/ternaries) and original feeds getOriginalNode fallbacks
    // (typeRegistry/type resolution, marker registries), both of which
    // observably change emitted output; sourceMapRange is emit-map metadata
    // read by neither. (For an authored `node`, getSourceMapRange(node)
    // returns the node itself, so its own range is what gets carried.)
    if (isSingleEmptyObjectInput(node.arguments)) {
      const completeSchedulerScopeSummary = context.factory
        .createObjectLiteralExpression([
          context.factory.createPropertyAssignment(
            "completeSchedulerScopeSummary",
            context.factory.createTrue(),
          ),
        ], false);
      const rebuiltInner = preserveSourceMapRange(
        context.factory.createCallExpression(
          innerLiftCall.expression,
          innerLiftCall.typeArguments,
          [
            ...calleeArgs,
            context.factory.createFalse(),
            // Keep the trusted scheduler options in lift's fourth parameter;
            // the no-input form intentionally has no result schema.
            context.factory.createIdentifier("undefined"),
            completeSchedulerScopeSummary,
            ...trailingInnerArgs,
          ],
        ),
        innerLiftCall,
      );
      // The inner lift is fully schema-injected now; mark it so the re-descent
      // (which re-enters the rebuilt tree to reach the callback body) self-skips
      // the builder-lift branch instead of injecting a second schema pair.
      context.markSchemaInjected(rebuiltInner);
      return preserveSourceMapRange(
        context.factory.createCallExpression(
          rebuiltInner,
          undefined,
          [],
        ),
        node,
      );
    }

    const rebuiltInner = preserveSourceMapRange(
      context.factory.createCallExpression(
        innerLiftCall.expression,
        innerLiftCall.typeArguments,
        [...calleeArgs, argSchemaCall, resSchemaCall, ...trailingInnerArgs],
      ),
      innerLiftCall,
    );
    // The inner lift is fully schema-injected now; mark it so the re-descent
    // does not re-enter the builder-lift branch and inject a second pair.
    context.markSchemaInjected(rebuiltInner);
    return preserveSourceMapRange(
      context.factory.createCallExpression(
        rebuiltInner,
        undefined,
        node.arguments,
      ),
      node,
    );
  }

  return preserveSourceMapRange(
    context.factory.createCallExpression(
      node.expression,
      undefined,
      [...node.arguments, argSchemaCall, resSchemaCall],
    ),
    node,
  );
}

/**
 * Helper to find the function argument in a builder call (pattern).
 * Searches from the end of the arguments array for the first function-like expression.
 */
function findFunctionArgument(
  argsArray: readonly ts.Expression[],
  checker: ts.TypeChecker,
  sourceFile?: ts.SourceFile,
): {
  expression: ts.Expression;
  callback: ts.ArrowFunction | ts.FunctionExpression;
} | undefined {
  for (let i = argsArray.length - 1; i >= 0; i--) {
    const arg = argsArray[i];
    const callback = arg &&
      resolveFunctionLikeExpression(arg, checker, sourceFile);
    if (arg && callback) {
      return { expression: arg, callback };
    }
  }
  return undefined;
}

function resolveLiftAppliedInputAndCallback(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): {
  input: ts.Expression;
  callback: ts.ArrowFunction | ts.FunctionExpression;
} | undefined {
  const callKind = detectCallKind(call, checker);
  if (callKind?.kind !== "lift-applied") {
    return undefined;
  }

  // Lift-applied `lift(...)(input)` is function-first: the callback is inner
  // argument zero even when schemas/options trail it; input is outer arg zero.
  const innerCall = getLiftAppliedInnerCall(call);
  if (!innerCall) {
    return undefined;
  }
  const callbackExpression = innerCall.arguments[0];
  const callback = callbackExpression
    ? resolveFunctionLikeExpression(callbackExpression, checker, sourceFile)
    : undefined;
  if (!callback) {
    return undefined;
  }
  const input = call.arguments[0];
  if (!input) {
    return undefined;
  }
  return { input, callback };
}

/**
 * The arrow or function expression `expression` denotes, looking through
 * parentheses, `as` / `satisfies` / type assertions, and the function-hardening
 * helper the pipeline wraps callbacks in. Syntactic by design: it answers
 * "which function node is this" for a node the transformer must rewrite, so it
 * resolves nothing it cannot point at in this file. Use
 * {@link isCallbackReference} for the semantic question of whether a value is
 * callable at all.
 */
function resolveFunctionLikeExpression(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
  sourceFile?: ts.SourceFile,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  return resolveFunctionLikeExpressionInner(
    expression,
    checker,
    sourceFile,
    new Set(),
  );
}

function resolveFunctionLikeExpressionInner(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile | undefined,
  seen: Set<ts.Node>,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!expression) {
    return undefined;
  }

  const unwrapped = unwrapExpression(expression);
  if (seen.has(unwrapped)) {
    return undefined;
  }
  seen.add(unwrapped);

  if (isFunctionLikeExpression(unwrapped)) {
    return unwrapped;
  }

  const hardened = unwrapHardenedFunctionExpression(unwrapped);
  if (hardened) {
    return resolveFunctionLikeExpressionInner(
      hardened,
      checker,
      sourceFile,
      seen,
    );
  }

  return undefined;
}

function unwrapHardenedFunctionExpression(
  expression: ts.Expression,
): ts.Expression | undefined {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) {
    return undefined;
  }

  const callee = unwrapExpression(expression.expression);
  if (
    !ts.isIdentifier(callee) ||
    !callee.text.startsWith(FUNCTION_HARDENING_HELPER_NAME)
  ) {
    return undefined;
  }

  return expression.arguments[0];
}

/**
 * Helper to detect and collect schema arguments (non-function, non-string expressions).
 * Returns an array of schema expressions found in the arguments.
 */
function detectSchemaArguments(
  argsArray: readonly ts.Expression[],
  functionArg: ts.Expression,
): ts.Expression[] {
  const schemas: ts.Expression[] = [];
  for (const arg of argsArray) {
    if (
      arg &&
      arg !== functionArg &&
      !ts.isStringLiteral(arg) &&
      !ts.isNoSubstitutionTemplateLiteral(arg)
    ) {
      schemas.push(arg);
    }
  }
  return schemas;
}

function isTopLevelAnyOrUnknownTypeNode(
  node: ts.TypeNode | undefined,
): boolean {
  if (!node) return false;
  const current = unwrapTypeParentheses(node);
  return current.kind === ts.SyntaxKind.AnyKeyword ||
    current.kind === ts.SyntaxKind.UnknownKeyword;
}

function shouldReportPermissiveInferredPatternResult(
  resultNode: ts.TypeNode | undefined,
  resultType: ts.Type | undefined,
): boolean {
  if (!resultNode) return true;
  if (isTopLevelAnyOrUnknownTypeNode(resultNode)) return true;
  return isAnyOrUnknownType(resultType);
}

function reportAnyResultSchema(
  context: TransformationContext,
  node: ts.CallExpression,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern:any-result-schema",
    message:
      `pattern() inferred result schema resolves to 'any' or 'unknown'. ` +
      `CTS only allows permissive output schemas when made explicit. ` +
      `Add an explicit Output type parameter: pattern<Input, Output>(...).`,
    node: node.expression,
  });
}

/**
 * Reports on a pattern's inferred result schema. A top-level `any`/`unknown`
 * result is an error (the whole output is permissive). A concrete result that
 * nests `unknown` fields is also an error: those fields lower to
 * `{ type: "unknown" }`, which a consumer does not materialize — it reads
 * them back as opaque references carrying no properties, the producer-side
 * form of the unknown-capture bug.
 */
function reportUnknownPatternResult(
  context: TransformationContext,
  node: ts.CallExpression,
  resultNode: ts.TypeNode | undefined,
  resultType: ts.Type | undefined,
): void {
  if (shouldReportPermissiveInferredPatternResult(resultNode, resultType)) {
    reportAnyResultSchema(context, node);
    return;
  }
  if (!resultNode) return;
  const paths = collectUnknownResultPaths(resultNode);
  if (paths.length === 0) return;
  const fields = paths.map((p) => `\`${p}\``).join(", ");
  context.reportDiagnosticOnce({
    severity: "error",
    type: "pattern-result:unknown-type",
    message:
      `pattern() output ${paths.length > 1 ? "fields" : "field"} ${fields} ` +
      `${
        paths.length > 1 ? "have" : "has"
      } inferred type \`unknown\`, so the ` +
      `output schema carries \`{ type: "unknown" }\` there. A consumer does ` +
      `not materialize such a field: it reads back as an opaque reference ` +
      `carrying no properties. Add an ` +
      `explicit Output type, e.g. pattern<Input, { /* shape */ }>(...).`,
    node: node.expression,
  });
}

/**
 * Collects dotted paths to `unknown`-typed leaves within a result type node,
 * descending object literals and array element types. A top-level `unknown` is
 * handled by the error path above, so this only sees nested occurrences.
 */
function collectUnknownResultPaths(resultNode: ts.TypeNode): string[] {
  const paths: string[] = [];
  const walk = (typeNode: ts.TypeNode, path: string): void => {
    const unwrapped = unwrapTypeParentheses(typeNode);
    if (unwrapped.kind === ts.SyntaxKind.UnknownKeyword) {
      paths.push(path || "(result)");
      return;
    }
    if (ts.isTypeLiteralNode(unwrapped)) {
      for (const member of unwrapped.members) {
        if (
          ts.isPropertySignature(member) && member.type && member.name &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        ) {
          const name = member.name.text;
          walk(member.type, path ? `${path}.${name}` : name);
        }
      }
    } else if (ts.isArrayTypeNode(unwrapped)) {
      walk(unwrapped.elementType, `${path}[]`);
    }
  };
  walk(resultNode, "");
  return paths;
}

function isMapWithPatternCallbackPatternCall(node: ts.CallExpression): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return false;
  }
  if (parent.arguments[0] !== node) {
    return false;
  }
  const arrayMethodInfo = classifyArrayMethodCall(parent);
  return !!arrayMethodInfo &&
    arrayMethodInfo.lowered &&
    arrayMethodInfo.family === "map";
}

/**
 * Handler for pattern schema injection.
 * Argument order is function-first: [function, inputSchema, resultSchema]
 *
 * @returns The transformed node, or undefined if no transformation was performed
 */
function handlePatternSchemaInjection(
  node: ts.CallExpression,
  context: TransformationContext,
  typeRegistry: TypeRegistry | undefined,
  visit: (node: ts.Node) => ts.Node,
): ts.Node | undefined {
  const { factory, checker, sourceFile, tsContext: transformation } = context;
  const typeArgs = node.typeArguments;
  const argsArray = Array.from(node.arguments);

  // Find the function argument
  const builderFunctionArg = findFunctionArgument(
    argsArray,
    checker,
    sourceFile,
  );
  if (!builderFunctionArg) {
    return undefined; // No function found - skip transformation
  }
  const builderFunction = builderFunctionArg.callback;
  const patternReturnExpr = getCallbackReturnExpression(builderFunction);
  const unwrappedPatternReturnExpr = patternReturnExpr
    ? unwrapExpression(patternReturnExpr)
    : undefined;

  const argumentCapabilityMode: CapabilitySummaryApplicationMode =
    context.isArrayMethodCallback(builderFunction) ||
      isMapWithPatternCallbackPatternCall(node)
      ? "full"
      : "defaults_only";

  // Helper to build final call with function-first argument order
  const buildCallExpression = (
    inputSchema: ts.Expression,
    resultSchema: ts.Expression,
  ): ts.CallExpression => {
    // smr only (see prependSchemaArguments for the rationale).
    return preserveSourceMapRange(
      factory.createCallExpression(node.expression, undefined, [
        builderFunctionArg.expression,
        inputSchema,
        resultSchema,
      ]),
      node,
    );
  };

  // Determine input and result schema TypeNodes based on type arguments
  let inputTypeNode: ts.TypeNode;
  let inputType: ts.Type | undefined;
  let resultTypeNode: ts.TypeNode;
  let resultType: ts.Type | undefined;

  if (typeArgs && typeArgs.length >= 2) {
    // Case 1: Two or more type arguments → both schemas from type args
    inputTypeNode = typeArgs[0]!;
    resultTypeNode = typeArgs[1]!;

    // Check TypeRegistry for closure-captured types
    if (typeRegistry) {
      inputType = typeRegistry.get(inputTypeNode);
      resultType = typeRegistry.get(resultTypeNode);
    }
    inputType ??= getTypeFromTypeNodeWithFallback(
      inputTypeNode,
      checker,
      typeRegistry,
    );
    resultType ??= getTypeFromTypeNodeWithFallback(
      resultTypeNode,
      checker,
      typeRegistry,
    );
    if (
      unwrappedPatternReturnExpr &&
      ts.isObjectLiteralExpression(unwrappedPatternReturnExpr)
    ) {
      setUiContractHint(
        resultTypeNode,
        getUiContractHintFromObjectLiteral(
          unwrappedPatternReturnExpr,
          context,
        ),
        context,
      );
    }
  } else if (typeArgs && typeArgs.length === 1) {
    // Case 2: One type argument → input from type arg, result inferred
    inputTypeNode = typeArgs[0]!;

    // Check TypeRegistry for input type
    if (typeRegistry) {
      inputType = typeRegistry.get(inputTypeNode);
    }
    inputType ??= getTypeFromTypeNodeWithFallback(
      inputTypeNode,
      checker,
      typeRegistry,
    );

    // Infer result type from function
    const inferred = collectFunctionSchemaTypeNodes(
      builderFunction,
      checker,
      sourceFile,
      factory,
      undefined,
      typeRegistry,
      argumentCapabilityMode,
      context,
    );
    reportUnknownPatternResult(
      context,
      node,
      inferred.result,
      inferred.resultType,
    );
    resultTypeNode = inferred.result ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    resultType = getTypeFromRegistryOrFallback(
      resultTypeNode,
      inferred.resultType,
      typeRegistry,
    );
  } else {
    // Case 3: No type arguments - check for schema arguments
    const schemaArgs = detectSchemaArguments(
      argsArray,
      builderFunctionArg.expression,
    );

    if (schemaArgs.length >= 2) {
      // Already has two schemas (input + result) - skip transformation
      return undefined;
    } else if (schemaArgs.length === 1) {
      // Case 3a: Has one schema argument but no type args
      // Use existing schema as input, infer result from function
      const existingInputSchema = schemaArgs[0]!;

      // Infer result type from function
      const inferred = collectFunctionSchemaTypeNodes(
        builderFunction,
        checker,
        sourceFile,
        factory,
        undefined,
        typeRegistry,
        argumentCapabilityMode,
        context,
      );
      reportUnknownPatternResult(
        context,
        node,
        inferred.result,
        inferred.resultType,
      );
      resultTypeNode = inferred.result ??
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      resultType = getTypeFromRegistryOrFallback(
        resultTypeNode,
        inferred.resultType,
        typeRegistry,
      );

      // Use existing schema directly as input, create result schema from type
      const toSchemaResult = createToSchemaCall(context, resultTypeNode);
      context.state.recordPatternResultSchemaCall(
        toSchemaResult,
        node.expression,
      );
      preserveUiContractHint(
        resultTypeNode,
        toSchemaResult,
        context,
      );
      preserveUiContractHint(
        getCallbackReturnExpression(builderFunction),
        toSchemaResult,
        context,
      );
      if (resultType && typeRegistry) {
        typeRegistry.set(toSchemaResult, resultType);
      }

      const updated = buildCallExpression(existingInputSchema, toSchemaResult);
      const visited = ts.visitEachChild(updated, visit, transformation);
      setUiContractHint(
        visited,
        unwrappedPatternReturnExpr &&
          ts.isObjectLiteralExpression(unwrappedPatternReturnExpr)
          ? getUiContractHintFromObjectLiteral(
            unwrappedPatternReturnExpr,
            context,
          )
          : undefined,
        context,
      );
      return visited;
    } else {
      // Case 3b: No type arguments, no schema args → infer both from function
      const inputParam = builderFunction.parameters[0];
      const inferred = collectFunctionSchemaTypeNodes(
        builderFunction,
        checker,
        sourceFile,
        factory,
        undefined,
        typeRegistry,
        argumentCapabilityMode,
        context,
      );
      reportUnknownPatternResult(
        context,
        node,
        inferred.result,
        inferred.resultType,
      );

      inputTypeNode = inferred.argument ??
        getParameterSchemaType(factory, inputParam);
      inputType = getTypeFromRegistryOrFallback(
        inputTypeNode,
        inferred.argumentType,
        typeRegistry,
      );

      resultTypeNode = inferred.result ??
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      resultType = getTypeFromRegistryOrFallback(
        resultTypeNode,
        inferred.resultType,
        typeRegistry,
      );
    }
  }

  const originalInputTypeNode = inputTypeNode;
  inputTypeNode = applyCapabilitySummaryToArgument(
    builderFunction,
    inputTypeNode,
    inputType,
    checker,
    sourceFile,
    factory,
    argumentCapabilityMode,
    context,
    builderFunction,
  ) ?? inputTypeNode;
  if (inputTypeNode !== originalInputTypeNode) {
    // Capability lowering produced a synthetic wrapped/shrunk node.
    // Avoid reusing stale type references from the pre-shrunk node.
    inputType = undefined;
  }

  // Create both schemas
  const inputSchemaCall = createSchemaCallWithRegistryTransfer(
    context,
    inputTypeNode,
    checker,
    typeRegistry,
  );
  if (inputType && typeRegistry) {
    typeRegistry.set(inputSchemaCall, inputType);
  }

  const resultSchemaCall = createSchemaCallWithRegistryTransfer(
    context,
    resultTypeNode,
    checker,
    typeRegistry,
  );
  context.state.recordPatternResultSchemaCall(
    resultSchemaCall,
    node.expression,
  );
  if (
    unwrappedPatternReturnExpr &&
    ts.isObjectLiteralExpression(unwrappedPatternReturnExpr)
  ) {
    setUiContractHint(
      resultSchemaCall,
      getUiContractHintFromObjectLiteral(
        unwrappedPatternReturnExpr,
        context,
      ),
      context,
    );
  }
  if (resultType && typeRegistry) {
    typeRegistry.set(resultSchemaCall, resultType);
  }

  const updated = buildCallExpression(inputSchemaCall, resultSchemaCall);
  const visited = ts.visitEachChild(updated, visit, transformation);
  setUiContractHint(
    visited,
    unwrappedPatternReturnExpr &&
      ts.isObjectLiteralExpression(unwrappedPatternReturnExpr)
      ? getUiContractHintFromObjectLiteral(
        unwrappedPatternReturnExpr,
        context,
      )
      : undefined,
    context,
  );
  return visited;
}

/**
 * Add the handler options object carrying the verb's declared result schema.
 *
 * `handler`'s trailing argument is its options object, and `resultSchema` is
 * the member the builder reads from it (`builder/module.ts`) to put the
 * declared result on the node's module — where the runner reads it when a
 * handling's result launches a pattern and the receipt needs a schema. The
 * result type reaches here in the third type-argument slot: authored directly
 * on `handler<Event, State, Result>`, or carried there by the `action<Event,
 * Result>` lowering (`closures/strategies/action-strategy.ts`).
 *
 * A call that already passes an options object keeps it, spread into the same
 * object, so one slot holds every option. A verb that declares no result gets
 * its arguments back untouched.
 */
function withDeclaredResultSchema(
  args: readonly ts.Expression[],
  node: ts.CallExpression,
  context: TransformationContext,
  checker: ts.TypeChecker,
  typeRegistry: TypeRegistry | undefined,
): ts.Expression[] {
  const next = [...args];
  const resultTypeNode = declaredVerbResultTypeNode(node, "handler");
  if (!resultTypeNode) return next;

  const { factory } = context;
  const resultSchemaCall = createSchemaCallWithRegistryTransfer(
    context,
    resultTypeNode,
    checker,
    typeRegistry,
  );
  const resultType = getTypeFromTypeNodeWithFallback(
    resultTypeNode,
    checker,
    typeRegistry,
  );
  if (resultType && typeRegistry) {
    typeRegistry.set(resultSchemaCall, resultType);
  }

  // Only an argument the author wrote AFTER the callback is an options object;
  // the callback itself, and the schemas prepended above, never are. The
  // identifier-aware resolver decides callback-ness, so a NAMED callback in
  // the trailing slot is never mistaken for options and spread-replaced.
  const authoredTail = node.arguments.length >= 2
    ? node.arguments[node.arguments.length - 1]
    : undefined;
  const authoredOptions = authoredTail !== undefined &&
      !isCallbackReference(authoredTail, checker)
    ? authoredTail
    : undefined;

  const options = factory.createObjectLiteralExpression([
    ...(authoredOptions
      ? [factory.createSpreadAssignment(authoredOptions)]
      : []),
    factory.createPropertyAssignment("resultSchema", resultSchemaCall),
  ]);

  if (authoredOptions) next[next.length - 1] = options;
  else next.push(options);
  return next;
}

export class SchemaInjectionTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, tsContext: transformation, checker } = context;
    const typeRegistry = context.state.typeRegistry;

    const visit = (node: ts.Node): ts.Node => {
      // Single idempotency guard: if SchemaInjection already finalized this
      // builder call/new node, do NOT re-process it — only descend into its
      // children (to reach callback bodies). This replaces the per-builder
      // arg-count guards (`args.length >= 5`, etc.) and the implicit
      // "drop the type args so re-detection fails" tricks. Producers call
      // `context.markSchemaInjected(...)`. The lift `isToSchemaCall` branch
      // additionally skips synthetic capability-wrapper re-entries inline
      // (see CT-1621) for nodes whose mark did not survive reconstruction.
      if (
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        context.isSchemaInjected(node)
      ) {
        return ts.visitEachChild(node, visit, transformation);
      }

      if (ts.isNewExpression(node)) {
        const callKind = detectNewExpressionKind(node, checker);
        if (callKind?.kind === "cell-factory") {
          const factory = transformation.factory;
          const typeArgs = node.typeArguments;
          const args = node.arguments ?? [];
          const scope = cellConstructorCallScope(node, checker);

          // If already has 2 arguments, the schema slot is filled — either we
          // injected it (idempotency) or the user supplied one. Either way,
          // leave it. (NOT replaced by the schema-injected marker: the marker
          // only covers our own output; a user-supplied 2-arg cell must also
          // be left alone, so this stays an argument-count check.)
          if (args.length >= 2) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const resolved = resolveInjectableSchemaType(
            typeArgs?.[0],
            checker,
            sourceFile,
            factory,
            typeRegistry,
            context.state,
            () => {
              const valueArg = args[0];
              if (valueArg) {
                const valueType = inferExpressionTypeWithInitializerFallback(
                  valueArg,
                  checker,
                  sourceFile,
                  factory,
                  typeRegistry,
                  context,
                );
                return valueType && !isUnresolvedSchemaType(valueType)
                  ? widenLiteralType(valueType, checker)
                  : valueType;
              }
              if (!scope) {
                return undefined;
              }
              const contextualType = inferSchemaContextualType(node, checker);
              return contextualType
                ? unwrapCellLikeType(contextualType, checker)
                : undefined;
            },
          );

          const schemaCall = createRegisteredSchemaCallFromResolvedType(
            context,
            resolved,
            checker,
            typeRegistry,
            resolved.inferred || scope
              ? { ...(resolved.inferred && { widenLiterals: true }), scope }
              : undefined,
          );

          if (schemaCall) {
            // Schema must always be the second argument. If no value was
            // provided, add undefined as the first argument.
            const newArgs = args.length === 0
              ? [factory.createIdentifier("undefined"), schemaCall]
              : [...args, schemaCall];

            const updated = factory.updateNewExpression(
              node,
              node.expression,
              node.typeArguments,
              newArgs,
            );
            context.markSchemaInjected(updated);
            return ts.visitEachChild(updated, visit, transformation);
          }
        }

        return ts.visitEachChild(node, visit, transformation);
      }

      if (!ts.isCallExpression(node)) {
        return ts.visitEachChild(node, visit, transformation);
      }

      const callKind = detectCallKind(node, checker);
      const scopedFactoryCall = maybeApplyFactoryContextualScope(node, context);
      if (scopedFactoryCall) {
        return ts.visitEachChild(scopedFactoryCall, visit, transformation);
      }

      if (callKind?.kind === "builder" && callKind.builderName === "pattern") {
        const result = handlePatternSchemaInjection(
          node,
          context,
          typeRegistry,
          visit,
        );
        if (result) return result;
        return ts.visitEachChild(node, visit, transformation);
      }

      if (
        callKind?.kind === "builder" && callKind.builderName === "handler"
      ) {
        const factory = transformation.factory;

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const eventType = node.typeArguments[0];
          const stateType = node.typeArguments[1];
          if (!eventType || !stateType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // The schema-first authored form — handler<E, T[, R]>(eventSchema,
          // stateSchema, callback[, options]) — already carries its schemas,
          // so nothing is prepended: injecting generated ones on top would
          // displace the callback out of the positions the runtime dispatch
          // and the sandbox verifier accept (argument 0 or 2). What only the
          // transformer can do — lowering a declared result onto the trailing
          // options object — still applies. Recognition uses the
          // identifier-aware resolver, so a NAMED callback recognizes the
          // form too — the SES verifier still demands a direct callback at
          // load, but the emission must not garble the call on the way there.
          if (
            node.arguments.length >= 3 &&
            !isCallbackReference(node.arguments[0], checker) &&
            !isCallbackReference(node.arguments[1], checker) &&
            isCallbackReference(node.arguments[2], checker)
          ) {
            const updated = preserveSourceMapRange(
              factory.createCallExpression(
                node.expression,
                undefined,
                withDeclaredResultSchema(
                  [...node.arguments],
                  node,
                  context,
                  checker,
                  typeRegistry,
                ),
              ),
              node,
            );
            context.markSchemaInjected(updated);
            return ts.visitEachChild(updated, visit, transformation);
          }

          let eventTypeNode: ts.TypeNode = eventType;
          let stateTypeNode: ts.TypeNode = stateType;
          const handlerCandidate = node.arguments[0];
          const handlerFn = resolveFunctionLikeExpression(
            handlerCandidate,
            checker,
            sourceFile,
          );
          if (handlerCandidate && handlerFn) {
            const eventTypeValue = getTypeFromTypeNodeWithFallback(
              eventType,
              checker,
              typeRegistry,
            );
            const stateTypeValue = getTypeFromTypeNodeWithFallback(
              stateType,
              checker,
              typeRegistry,
            );

            // The event is a verb's input contract: authored structure,
            // usage-derived capability values (docs/history/plans/verb-input-contract.md).
            // A synthetic event node has no authored structure to serve —
            // JSX handler events among them — so those keep the usage shrink.
            eventTypeNode = applyCapabilitySummaryToParameter(
              handlerFn,
              0,
              eventType,
              eventTypeValue,
              checker,
              sourceFile,
              factory,
              context,
              handlerFn,
              isSyntheticNode(eventType) ? "full" : "contract",
            ) ?? eventType;

            stateTypeNode = applyCapabilitySummaryToParameter(
              handlerFn,
              1,
              stateType,
              stateTypeValue,
              checker,
              sourceFile,
              factory,
              context,
              handlerFn,
            ) ?? stateType;
            const stateSummary = findCapabilitySummaryForParameter(
              handlerFn,
              1,
              context,
              { checker, includeNestedCallbacks: true },
            );
            applyIdentityArrayItemSchemaHints(
              stateTypeNode,
              stateSummary?.identityPaths ?? [],
              context,
            );
          }

          const toSchemaEvent = createSchemaCallWithRegistryTransfer(
            context,
            eventTypeNode,
            checker,
            typeRegistry,
          );
          const toSchemaState = createSchemaCallWithRegistryTransfer(
            context,
            stateTypeNode,
            checker,
            typeRegistry,
          );

          // smr only (see prependSchemaArguments for the rationale).
          const updated = preserveSourceMapRange(
            factory.createCallExpression(
              node.expression,
              undefined,
              withDeclaredResultSchema(
                [toSchemaEvent, toSchemaState, ...node.arguments],
                node,
                context,
                checker,
                typeRegistry,
              ),
            ),
            node,
          );

          context.markSchemaInjected(updated);
          return ts.visitEachChild(updated, visit, transformation);
        }

        if (node.arguments.length === 1) {
          const handlerCandidate = node.arguments[0];
          const handlerFn = resolveFunctionLikeExpression(
            handlerCandidate,
            checker,
            sourceFile,
          );
          if (handlerCandidate && handlerFn) {
            // Infer types from the handler function for both parameters. The
            // event is a verb's input contract, so an AUTHORED event type —
            // an explicit parameter annotation — is served in `contract`
            // mode: authored structure, usage-derived capability values. An
            // inferred event keeps the usage shrink, which for a handler with
            // no authored type is the only contract there is.
            const eventParameterTypeNode = handlerFn.parameters[0]?.type;
            const inferred = collectFunctionSchemaTypeNodes(
              handlerFn,
              checker,
              sourceFile,
              factory,
              undefined,
              typeRegistry,
              eventParameterTypeNode && !isSyntheticNode(eventParameterTypeNode)
                ? "contract"
                : "full",
              context,
            );

            // Event type: use inferred or fallback to never/unknown refinement.
            // Validation already ran inside collectFunctionSchemaTypeNodes (via
            // applyCapabilitySummaryToArgument), so don't pass `context` here
            // to avoid double-validation with degraded type info (the shrunk
            // node is synthetic and the recovered argumentType may be undefined).
            const eventTypeBase = inferred.argument ??
              getParameterSchemaType(factory, handlerFn.parameters[0]);
            const eventType = inferred.argument ??
              applyCapabilitySummaryToParameter(
                handlerFn,
                0,
                eventTypeBase,
                inferred.argumentType,
                checker,
                sourceFile,
                factory,
                undefined,
                handlerFn,
                "contract",
              ) ?? eventTypeBase;

            // State type: use helper for second parameter
            const stateTypeBase = inferParameterSchemaType(
              factory,
              handlerFn,
              1, // second parameter
              checker,
              sourceFile,
              context.state,
            );
            const stateParam = handlerFn.parameters[1];
            const stateTypeValue = stateParam
              ? checker.getTypeAtLocation(stateParam)
              : undefined;
            const stateType = applyCapabilitySummaryToParameter(
              handlerFn,
              1,
              stateTypeBase,
              stateTypeValue,
              checker,
              sourceFile,
              factory,
              context,
              handlerFn,
            ) ?? stateTypeBase;
            const stateSummary = findCapabilitySummaryForParameter(
              handlerFn,
              1,
              context,
              { checker, includeNestedCallbacks: true },
            );
            applyIdentityArrayItemSchemaHints(
              stateType,
              stateSummary?.identityPaths ?? [],
              context,
            );

            // Always transform - generate schemas regardless of parameter presence
            const toSchemaEvent = createSchemaCallWithRegistryTransfer(
              context,
              eventType,
              checker,
              typeRegistry,
            );
            const toSchemaState = createSchemaCallWithRegistryTransfer(
              context,
              stateType,
              checker,
              typeRegistry,
            );

            // smr only (see prependSchemaArguments for the rationale).
            const updated = preserveSourceMapRange(
              factory.createCallExpression(
                node.expression,
                undefined,
                [toSchemaEvent, toSchemaState, handlerCandidate],
              ),
              node,
            );

            context.markSchemaInjected(updated);
            return ts.visitEachChild(updated, visit, transformation);
          }
        }
      }

      if (callKind?.kind === "lift-applied") {
        const factory = transformation.factory;
        const liftAppliedArgs = resolveLiftAppliedInputAndCallback(
          node,
          checker,
          sourceFile,
        );

        // For the lift-applied shape (callee is itself a call), the generic
        // type arguments live on the *inner* lift call, not on the outer
        // applied call — the lowering builds the outer call with `undefined`
        // type args (see lift/transformer.ts). The `?? node.typeArguments`
        // fallback reads them off the outer call defensively.
        //
        // UNCERTAIN whether the fallback is still reachable: dropping it kept
        // the full fixture suite green (CT-1643), and the main lowering path
        // never puts type args on the outer call. But this wasn't proven dead
        // across all three lift-applied construction sites + schema-injection
        // re-entry, so it's kept as a cheap robustness guard rather than
        // removed. (It is NOT derive-specific; the prior comment misattributed
        // it to the removed "legacy derive shape.")
        const innerLiftCall = getLiftAppliedInnerCall(node);
        const sourceTypeArguments = innerLiftCall?.typeArguments ??
          node.typeArguments;

        if (sourceTypeArguments && sourceTypeArguments.length >= 2) {
          const [argumentType, resultType] = sourceTypeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // Always apply the capability-summary shrink to the explicit
          // argument TypeNode. (Previously this was suppressed for calls
          // marked by syntheticLiftAppliedCallRegistry, to avoid collapsing
          // array element types to `unknown`. That marker was verified inert
          // — a downstream array-shrink in type-shrinking re-collapses the
          // items to `unknown[]` regardless, so the emitted schema is
          // identical either way — and was removed in the registry-unification
          // effort. See docs/scratch/12-registry-unification-design.md.)
          const resolved = resolveDualSchemaBuilderTypes(
            liftAppliedArgs?.callback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            context,
            {
              explicitArgumentTypeNode: argumentType,
              explicitArgumentTypeValue: typeRegistry.get(argumentType),
              explicitResultTypeNode: resultType,
              explicitResultTypeValue: typeRegistry.get(resultType),
              applyExplicitArgumentCapabilitySummary: true,
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }

        if (liftAppliedArgs) {
          const { input: firstArg, callback } = liftAppliedArgs;

          // Special case: detect empty object literal {} and generate specific schema
          let argNode: ts.TypeNode | undefined;
          let argType: ts.Type | undefined;
          let fallbackArgType: ts.Type | undefined;

          if (
            ts.isObjectLiteralExpression(firstArg) &&
            firstArg.properties.length === 0
          ) {
            // Empty object literal - create a specific type for it
            // This should generate {type: "unknown"}
            argNode = factory.createTypeLiteralNode([]);
            ensureTypeNodeRegistered(argNode, checker, typeRegistry);
            // Don't set argType - let schema generator handle the synthetic node
          } else {
            // Normal case - infer from the argument type
            // Apply literal widening so `const x = 5; derive(x, fn)` produces `number`, not `5`
            // Use getTypeAtLocationWithFallback to handle synthetic nodes (e.g., mapWithPattern calls)
            // which have their types registered in the typeRegistry by ClosureTransformer
            fallbackArgType = widenLiteralType(
              getTypeAtLocationWithFallback(firstArg, checker, typeRegistry) ??
                checker.getTypeAtLocation(firstArg),
              checker,
            );
            if (isAnyOrUnknownType(fallbackArgType)) {
              const recoveredArgumentType = inferLiftFactoryResultType(
                firstArg,
                checker,
                sourceFile,
                factory,
                typeRegistry,
                context,
              );
              if (
                recoveredArgumentType &&
                !isAnyOrUnknownType(recoveredArgumentType)
              ) {
                fallbackArgType = recoveredArgumentType;
              }
            }
          }

          const resolved = resolveDualSchemaBuilderTypes(
            callback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            context,
            {
              fallbackArgumentType: fallbackArgType,
              explicitArgumentTypeNode: argNode,
              explicitArgumentTypeValue: argType,
              fallbackArgumentNode: getParameterSchemaType(
                factory,
                callback.parameters[0],
              ),
              applyExplicitArgumentCapabilitySummary: false,
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }
      }

      if (callKind?.kind === "builder" && callKind.builderName === "lift") {
        const factory = transformation.factory;

        const firstArgument = node.arguments[0] &&
          unwrapExpression(node.arguments[0]);
        if (firstArgument && isToSchemaCall(firstArgument)) {
          const argumentType = firstArgument.typeArguments?.[0];
          const liftCallback = resolveFunctionLikeExpression(
            node.arguments[2],
            checker,
            sourceFile,
          );
          if (argumentType && liftCallback) {
            // CT-1621: when the toSchema argument is a SYNTHETIC capability
            // wrapper TypeNode (pos < 0, e.g. `__cfHelpers.ComparableCell<…>`),
            // it is our OWN already-shrunk output that re-entered this branch —
            // the input schema is already correct and the callback's capability
            // summary was already applied upstream. Re-running the recover +
            // re-shrink here is redundant (it reproduces the same wrapper) and
            // was the SOLE consumer of narrowedWrapperTypeRegistry: the
            // synthetic wrapper resolves to `any`, so the re-shrink needed the
            // pre-shrink type fed back. Skip it — keep the already-injected
            // input, mark the node, and only descend into the callback body.
            // Authored `lift(toSchema<T>(), fn)` has a real-source T (pos >= 0)
            // that the checker resolves, so it falls through to the normal path.
            //
            // This is layered with the top-of-visit `nodeLinks.schemaInjected`
            // guard (see SchemaInjectionTransformer.transform) as defense-in-
            // depth: that guard catches re-entries on nodes whose mark survived
            // reconstruction; this one catches the structural re-entry case
            // (synthetic Cell-family / Stream wrapper as toSchema arg) for
            // nodes whose mark did not.
            if (
              isSyntheticNode(argumentType) && isCellLikeTypeNode(argumentType)
            ) {
              context.markSchemaInjected(node);
              return ts.visitEachChild(node, visit, transformation);
            }
            // Authored `lift(toSchema<T>(), fn)`: T is a real-source TypeNode
            // the checker resolves (the synthetic-wrapper re-entry case is
            // handled by the skip above).
            const argumentTypeValue = getTypeFromTypeNodeWithFallback(
              argumentType,
              checker,
              typeRegistry,
            );
            const {
              argumentTypeNode: narrowedArgumentType,
              argumentTypeValue: narrowedArgumentTypeValue,
            } = applyCallbackBuilderArgumentCapabilitySummary(
              liftCallback,
              argumentType,
              argumentTypeValue,
              checker,
              sourceFile,
              factory,
              context,
            );
            const inputSchema = createSchemaCallWithRegistryTransfer(
              context,
              narrowedArgumentType,
              checker,
              typeRegistry,
              firstArgument.arguments,
            );
            if (narrowedArgumentTypeValue) {
              typeRegistry.set(inputSchema, narrowedArgumentTypeValue);
            }
            // smr only (see prependSchemaArguments for the rationale).
            const updated = preserveSourceMapRange(
              factory.createCallExpression(
                node.expression,
                node.typeArguments,
                [inputSchema, ...node.arguments.slice(1)],
              ),
              node,
            );
            // Mark so the re-descent below does NOT re-enter this branch and
            // re-process the synthetic `inputSchema` wrapper.
            context.markSchemaInjected(updated);
            return ts.visitEachChild(updated, visit, transformation);
          }
        }

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const liftCallback = resolveFunctionLikeExpression(
            node.arguments[0],
            checker,
            sourceFile,
          );
          const resolved = resolveDualSchemaBuilderTypes(
            liftCallback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            context,
            {
              explicitArgumentTypeNode: argumentType,
              explicitArgumentTypeValue: typeRegistry.get(argumentType),
              explicitResultTypeNode: resultType,
              explicitResultTypeValue: typeRegistry.get(resultType),
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }

        if (node.typeArguments && node.typeArguments.length === 1) {
          const [argumentType] = node.typeArguments;
          if (!argumentType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const liftCallback = resolveFunctionLikeExpression(
            node.arguments[0],
            checker,
            sourceFile,
          );
          if (!liftCallback) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const resolved = resolveDualSchemaBuilderTypes(
            liftCallback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            context,
            {
              fallbackArgumentType: getTypeFromTypeNodeWithFallback(
                argumentType,
                checker,
                typeRegistry,
              ),
              explicitArgumentTypeNode: argumentType,
              explicitArgumentTypeValue: typeRegistry.get(argumentType),
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }

        if (
          node.arguments.length === 1
        ) {
          const callback = resolveFunctionLikeExpression(
            node.arguments[0],
            checker,
            sourceFile,
          );
          if (!callback) {
            return ts.visitEachChild(node, visit, transformation);
          }
          const resolved = resolveDualSchemaBuilderTypes(
            callback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            context,
            {
              fallbackArgumentNode: getParameterSchemaType(
                factory,
                callback.parameters[0],
              ),
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // Always transform with both schemas
          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }
      }

      if (callKind?.kind === "cell-factory") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;
        const scope = cellConstructorCallScope(node, checker);

        // If already has 2 arguments, assume schema is already present
        if (args.length >= 2) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          context.state,
          () => {
            const valueArg = args[0];
            if (valueArg) {
              const valueType = inferExpressionTypeWithInitializerFallback(
                valueArg,
                checker,
                sourceFile,
                factory,
                typeRegistry,
                context,
              );
              return valueType && !isUnresolvedSchemaType(valueType)
                ? widenLiteralType(valueType, checker)
                : valueType;
            }
            if (!scope) {
              return undefined;
            }
            const contextualType = inferSchemaContextualType(node, checker);
            return contextualType
              ? unwrapCellLikeType(contextualType, checker)
              : undefined;
          },
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
          resolved.inferred || scope
            ? { ...(resolved.inferred && { widenLiterals: true }), scope }
            : undefined,
        );

        if (schemaCall) {
          // Schema must always be the second argument. If no value was provided,
          // add undefined as the first argument.
          const newArgs = args.length === 0
            ? [factory.createIdentifier("undefined"), schemaCall]
            : [...args, schemaCall];

          // smr only (see prependSchemaArguments for the rationale).
          const updated = preserveSourceMapRange(
            factory.createCallExpression(
              node.expression,
              node.typeArguments,
              newArgs,
            ),
            node,
          );
          context.markSchemaInjected(updated);
          return ts.visitEachChild(updated, visit, transformation);
        }
      }

      if (callKind?.kind === "cell-for") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const scope = cellConstructorCallScope(node, checker);

        // Check if already wrapped in asSchema
        if (
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name.text === "asSchema"
        ) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          context.state,
          () => {
            const contextualType = inferSchemaContextualType(node, checker);
            return contextualType
              ? unwrapCellLikeType(contextualType, checker)
              : undefined;
          },
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
          scope ? { scope } : undefined,
        );

        if (schemaCall) {
          // Visit the original node's children first to ensure nested transformations happen
          const visitedNode = ts.visitEachChild(node, visit, transformation);

          const asSchema = factory.createPropertyAccessExpression(
            visitedNode,
            factory.createIdentifier("asSchema"),
          );
          // smr only (see prependSchemaArguments): the `.asSchema(...)` wrapper
          // replaces the cell-for call at its site, so it carries its position.
          const updated = preserveSourceMapRange(
            factory.createCallExpression(
              asSchema,
              undefined,
              [schemaCall],
            ),
            node,
          );
          // Return updated directly to avoid re-visiting the inner CallExpression which would trigger infinite recursion
          return updated;
        }
      }

      if (callKind?.kind === "wish") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;

        if (args.length >= 2) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          context.state,
          () => inferWishTypeArgument(node, checker),
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
        );

        if (schemaCall) {
          // smr only (see prependSchemaArguments for the rationale).
          const updated = preserveSourceMapRange(
            factory.createCallExpression(
              node.expression,
              node.typeArguments,
              [...args, schemaCall],
            ),
            node,
          );
          context.markSchemaInjected(updated);
          return ts.visitEachChild(updated, visit, transformation);
        }
      }

      if (callKind?.kind === "generate-object") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;

        // Check if schema is already present in options
        if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!)) {
          const props = (args[0] as ts.ObjectLiteralExpression).properties;
          if (
            props.some((p: ts.ObjectLiteralElementLike) =>
              p.name && ts.isIdentifier(p.name) && p.name.text === "schema"
            )
          ) {
            return ts.visitEachChild(node, visit, transformation);
          }
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          context.state,
          () => {
            const contextualType = inferSchemaContextualType(node, checker);
            const objectProp = contextualType?.getProperty("object");
            return objectProp
              ? checker.getTypeOfSymbolAtLocation(objectProp, node)
              : undefined;
          },
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
        );

        if (schemaCall) {
          let newOptions: ts.Expression;
          if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!)) {
            // Add schema property to existing object literal
            newOptions = factory.createObjectLiteralExpression(
              [
                ...(args[0] as ts.ObjectLiteralExpression).properties,
                factory.createPropertyAssignment("schema", schemaCall),
              ],
              true,
            );
          } else if (args.length > 0) {
            // Options is an expression (not literal) -> { ...opts, schema: ... }
            newOptions = factory.createObjectLiteralExpression(
              [
                factory.createSpreadAssignment(args[0]!),
                factory.createPropertyAssignment("schema", schemaCall),
              ],
              true,
            );
          } else {
            // No options -> { schema: ... }
            newOptions = factory.createObjectLiteralExpression(
              [factory.createPropertyAssignment("schema", schemaCall)],
              true,
            );
          }

          // smr only (see prependSchemaArguments for the rationale).
          const updated = preserveSourceMapRange(
            factory.createCallExpression(
              node.expression,
              node.typeArguments,
              [newOptions, ...args.slice(1)],
            ),
            node,
          );
          context.markSchemaInjected(updated);
          return ts.visitEachChild(updated, visit, transformation);
        }
      }

      // sqliteQuery<Row>({ db, sql, ... }) - lowers the Row type argument to an
      // injected `rowSchema` property (mirrors generate-object's `schema`). The
      // runtime builtin composes `result.items = rowSchema`, so a consumer's
      // schema carries `asCell` for Cell<> Row fields and `*_cf_link` result
      // columns rehydrate to live Cells (see
      // docs/specs/sqlite-builtin/plans/sqlite-query-row-lowering.md).
      if (
        callKind?.kind === "runtime-call" &&
        callKind.exportName === "sqliteQuery"
      ) {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;

        // Only the typed form is injectable. Untyped sqliteQuery(...) /
        // db.query(...) must compile and lower to NO schema (runtime falls back
        // to suffix/table detection).
        if (!typeArgs || typeArgs.length !== 1) {
          return ts.visitEachChild(node, visit, transformation);
        }

        // Two call shapes inject `rowSchema` into the OPTIONS object:
        //  - free function `sqliteQuery<Row>({ db, sql, ... })` → options is arg 0
        //  - method `db.query<Row>(sql, { ... })`              → options is arg 1
        const isMethod = ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "query";
        const optIdx = isMethod ? 1 : 0;
        const optArg = args[optIdx];

        // Idempotency: skip if a `rowSchema` property is already present.
        if (
          optArg && ts.isObjectLiteralExpression(optArg) &&
          optArg.properties.some(
            (p: ts.ObjectLiteralElementLike) =>
              p.name && ts.isIdentifier(p.name) && p.name.text === "rowSchema",
          )
        ) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          context.state,
          () => undefined,
        );
        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
        );

        if (schemaCall) {
          let newOptions: ts.Expression;
          if (optArg && ts.isObjectLiteralExpression(optArg)) {
            newOptions = factory.createObjectLiteralExpression(
              [
                ...optArg.properties,
                factory.createPropertyAssignment("rowSchema", schemaCall),
              ],
              true,
            );
          } else if (optArg) {
            newOptions = factory.createObjectLiteralExpression(
              [
                factory.createSpreadAssignment(optArg),
                factory.createPropertyAssignment("rowSchema", schemaCall),
              ],
              true,
            );
          } else {
            newOptions = factory.createObjectLiteralExpression(
              [factory.createPropertyAssignment("rowSchema", schemaCall)],
              true,
            );
          }

          // smr only (see prependSchemaArguments for the rationale).
          const updated = preserveSourceMapRange(
            factory.createCallExpression(
              node.expression,
              node.typeArguments,
              [
                ...args.slice(0, optIdx),
                newOptions,
                ...args.slice(optIdx + 1),
              ],
            ),
            node,
          );
          context.markSchemaInjected(updated);
          return ts.visitEachChild(updated, visit, transformation);
        }
      }

      // fetchJson<T>({ url, ... }) - lowers the T type argument to an
      // injected `schema` property (mirrors generate-object's `schema` and
      // sqliteQuery's `rowSchema`). The runtime builtin verifies the fetched
      // JSON against it at fetch time. A type argument is required;
      // fetchJsonUnchecked is the untyped escape hatch.
      if (
        callKind?.kind === "runtime-call" &&
        callKind.exportName === "fetchJson"
      ) {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;

        if (!typeArgs || typeArgs.length !== 1) {
          context.reportDiagnostic({
            severity: "error",
            type: "fetch-json:missing-type-argument",
            message: "fetchJson requires an explicit type argument, e.g. " +
              "fetchJson<MyResult>({ url }). Use fetchJsonUnchecked for JSON " +
              "whose shape isn't declared as a type.",
            node,
          });
          return ts.visitEachChild(node, visit, transformation);
        }

        {
          const paramsArg = args[0];

          // An explicit `schema` property takes precedence over injection.
          const hasExplicitSchema = paramsArg &&
            ts.isObjectLiteralExpression(paramsArg) &&
            paramsArg.properties.some(
              (p: ts.ObjectLiteralElementLike) =>
                p.name && ts.isIdentifier(p.name) && p.name.text === "schema",
            );

          if (!hasExplicitSchema) {
            const resolved = resolveInjectableSchemaType(
              typeArgs[0],
              checker,
              sourceFile,
              factory,
              typeRegistry,
              context.state,
              () => undefined,
            );
            const schemaCall = createRegisteredSchemaCallFromResolvedType(
              context,
              resolved,
              checker,
              typeRegistry,
            );

            if (schemaCall) {
              // The derived `schema` is emitted FIRST so any caller-written
              // property wins by later-property-wins semantics. The up-front
              // check only catches an identifier `schema` key on an object
              // literal; emitting first also lets a `schema` reached through
              // a spread or a computed key override the derived one, matching
              // the documented "explicit schema takes precedence" contract.
              const schemaProp = factory.createPropertyAssignment(
                "schema",
                schemaCall,
              );
              let newParams: ts.Expression;
              if (paramsArg && ts.isObjectLiteralExpression(paramsArg)) {
                newParams = factory.createObjectLiteralExpression(
                  [schemaProp, ...paramsArg.properties],
                  true,
                );
              } else if (paramsArg) {
                newParams = factory.createObjectLiteralExpression(
                  [schemaProp, factory.createSpreadAssignment(paramsArg)],
                  true,
                );
              } else {
                newParams = factory.createObjectLiteralExpression(
                  [schemaProp],
                  true,
                );
              }

              // smr only (see prependSchemaArguments for the rationale).
              const updated = preserveSourceMapRange(
                factory.createCallExpression(
                  node.expression,
                  node.typeArguments,
                  [newParams, ...args.slice(1)],
                ),
                node,
              );
              context.markSchemaInjected(updated);
              return ts.visitEachChild(updated, visit, transformation);
            }
          }
        }
      }

      // Reactive conditionals prepend a widened schema per argument plus the
      // result. when/unless are 2-arity (condition, value/fallback); ifElse is
      // 3-arity (condition, ifTrue, ifFalse).
      if (callKind?.kind === "when" || callKind?.kind === "unless") {
        return visitReactiveConditional(
          node,
          2,
          context,
          visit,
          transformation,
          checker,
          typeRegistry,
        );
      }
      if (callKind?.kind === "ifElse") {
        return visitReactiveConditional(
          node,
          3,
          context,
          visit,
          transformation,
          checker,
          typeRegistry,
        );
      }

      return ts.visitEachChild(node, visit, transformation);
    };

    return ts.visitEachChild(sourceFile, visit, transformation);
  }
}
