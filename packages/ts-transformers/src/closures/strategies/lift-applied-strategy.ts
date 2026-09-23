import ts from "typescript";
import type {
  CapabilityParamSummary,
  FunctionCapabilitySummary,
  TransformationContext,
} from "../../core/mod.ts";
import {
  detectCallKind,
  getLiftAppliedInputAndCallback,
  getTypeFromTypeNodeWithFallback,
  isSyntheticNode,
  preserveLineage,
  qualifyCommonFabricTypeRefs,
  setParentPointers,
  typeToTypeNodeWithRegistry,
  unwrapOpaqueLikeType,
} from "../../ast/mod.ts";
import { analyzeFunctionCapabilities } from "../../policy/capability-analysis.ts";
import { registerLiftAppliedCallType } from "../../ast/type-inference.ts";
import { applyShrinkAndWrap } from "../../transformers/type-shrinking.ts";
import { getCellKind } from "../../transformers/cell-type.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import { buildCapturePropertyAssignments } from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  normalizeBindingName,
} from "../../utils/identifiers.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { createLiftAppliedInputSchema } from "../utils/schema-factory.ts";

/**
 * Pre-register unwrapped types for captured identifiers in a callback body.
 * This allows nested transformations (like map -> mapWithPattern decisions)
 * to see the correct unwrapped types for captured variables.
 *
 * Inside a lift-applied callback:
 * - Reactive<T> captures become T parameters (unwrapped)
 * - Cell<T> captures remain Cell<T> (NOT unwrapped)
 *
 * We register this before the visitor runs so decisions are made correctly.
 */
function preRegisterCaptureTypes(
  body: ts.ConciseBody,
  captureExpressions: Set<ts.Expression>,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): void {
  if (!typeRegistry) return;

  // Build map: capture name -> type to register
  // Only unwrap Reactive types (kind === "opaque"), not Cell types
  const captureTypes = new Map<string, ts.Type>();
  for (const expr of captureExpressions) {
    if (ts.isIdentifier(expr)) {
      const exprType = checker.getTypeAtLocation(expr);
      if (exprType) {
        const kind = getCellKind(exprType, checker);

        // Only unwrap if it's a Reactive (kind === "opaque")
        // Cell and Stream types should NOT be unwrapped
        if (kind === "opaque") {
          const unwrapped = unwrapOpaqueLikeType(exprType, checker);
          if (unwrapped && unwrapped !== exprType) {
            captureTypes.set(expr.text, unwrapped);
          }
        }
        // For Cell/Stream types, we don't register anything - let TypeScript's natural type be used
      }
    }
    // NOTE: Property access captures like state.items are handled separately
  }

  if (captureTypes.size === 0) return;

  // Walk the body and register unwrapped types for all matching identifiers
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const unwrappedType = captureTypes.get(node.text);
      if (unwrappedType) {
        typeRegistry.set(node, unwrappedType);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(body);
}

/**
 * Check if a call expression is a lift-applied call (the lowered form of a
 * user-source computed() call) from commonfabric.
 */
function isLiftAppliedCall(
  node: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const callKind = detectCallKind(node, context.checker);
  return callKind?.kind === "lift-applied";
}

function getCapabilityAnalysis(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): {
  summary: FunctionCapabilitySummary;
  firstParameter: CapabilityParamSummary | undefined;
} {
  const summary = analyzeFunctionCapabilities(callback, {
    checker,
    typeRegistry,
    includeNestedCallbacks: true,
  });
  const parameter = callback.parameters[0];
  const parameterName = parameter && ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : "__param0";
  return {
    summary,
    firstParameter: summary.params.find((param) =>
      param.name === parameterName
    ),
  };
}

/**
 * The capability analysis is the existing conservative completeness seam for
 * source-authored lifts.  A marker is emitted only when that analysis can
 * account for every cell-bearing parameter use.  In particular, an empty
 * summary is meaningful proof for a source-backed zero-input computation; it
 * is not inferred later from an empty runtime observation.
 */
function hasCompleteSchedulerScopeSummary(
  summary: FunctionCapabilitySummary,
): boolean {
  if (
    summary.recursive ||
    (summary.unreadableCellArguments?.length ?? 0) > 0
  ) {
    return false;
  }
  return summary.params.every((param) =>
    !param.wildcard &&
    !param.hasUnverifiedCellUse &&
    !param.passthrough &&
    param.capability !== "opaque" &&
    (param.opaquePaths?.length ?? 0) === 0
  );
}

function createDeriveSchedulerOptions(
  inputParamSummary: CapabilityParamSummary | undefined,
  completeSchedulerScopeSummary: boolean,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression | undefined {
  const writePaths = inputParamSummary?.writePaths ?? [];
  if (writePaths.length === 0 && !completeSchedulerScopeSummary) {
    return undefined;
  }

  return factory.createObjectLiteralExpression(
    [
      ...(writePaths.length > 0
        ? [
          factory.createPropertyAssignment(
            "materializerWriteInputPaths",
            factory.createArrayLiteralExpression(
              writePaths.map((path) =>
                factory.createArrayLiteralExpression(
                  path.map((segment) => factory.createStringLiteral(segment)),
                  false,
                )
              ),
              false,
            ),
          ),
        ]
        : []),
      ...(completeSchedulerScopeSummary
        ? [
          factory.createPropertyAssignment(
            "completeSchedulerScopeSummary",
            factory.createTrue(),
          ),
        ]
        : []),
    ],
    false,
  );
}

/**
 * Resolve capture name collisions with the original input parameter name.
 * If a capture has the same name as originalInputParamName, rename it (e.g., multiplier -> multiplier_1).
 * Returns a mapping from original capture names to their potentially renamed versions.
 */
function resolveLiftAppliedCaptureNameCollisions(
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
): Map<string, string> {
  const captureNameMap = new Map<string, string>();
  const usedNames = new Set<string>([originalInputParamName]);

  for (const [captureName] of captureTree) {
    if (captureName === originalInputParamName) {
      // Collision detected - rename the capture
      let renamed = `${captureName}_1`;
      let suffix = 1;
      while (usedNames.has(renamed) || captureTree.has(renamed)) {
        suffix++;
        renamed = `${captureName}_${suffix}`;
      }
      captureNameMap.set(captureName, renamed);
      usedNames.add(renamed);
    } else {
      // No collision - use original name
      captureNameMap.set(captureName, captureName);
      usedNames.add(captureName);
    }
  }

  return captureNameMap;
}

/**
 * Build the merged input object containing both the original input and captures.
 * Example: {value, multiplier} where value is the original input and multiplier is a capture.
 *
 * When hadZeroParameters is true, skip the original input and only include captures.
 * This handles the case where the user wrote computed(() => ...) (which lowers to
 * lift(() => ...)({})) and we only need captures.
 */
function buildLiftAppliedInputObject(
  originalInput: ts.Expression,
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  factory: ts.NodeFactory,
  hadZeroParameters: boolean,
): ts.ObjectLiteralExpression {
  const properties: ts.ObjectLiteralElementLike[] = [];

  // Add the original input as a property UNLESS callback had zero parameters
  // When hadZeroParameters, we only include captures
  if (!hadZeroParameters) {
    if (
      ts.isIdentifier(originalInput) &&
      originalInput.text === originalInputParamName
    ) {
      properties.push(
        factory.createShorthandPropertyAssignment(originalInput, undefined),
      );
    } else {
      properties.push(
        factory.createPropertyAssignment(
          createPropertyName(originalInputParamName, factory),
          originalInput,
        ),
      );
    }
  }

  // Add captures with potentially renamed property names
  properties.push(
    ...buildCapturePropertyAssignments(captureTree, factory, captureNameMap),
  );

  return factory.createObjectLiteralExpression(
    properties,
    properties.length > 1,
  );
}

/**
 * Rewrite the callback body to use renamed capture identifiers.
 * For example, if `multiplier` was renamed to `multiplier_1`, replace all
 * references to the captured `multiplier` with `multiplier_1`.
 *
 * Also registers the new identifiers with their UNWRAPPED types in typeRegistry,
 * so type-based checks inside the lift-applied callback see the correct types.
 */
function rewriteCaptureReferences(
  body: ts.ConciseBody,
  captureNameMap: Map<string, string>,
  captureExpressions: Set<ts.Expression>,
  factory: ts.NodeFactory,
  checker: ts.TypeChecker | undefined,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): ts.ConciseBody {
  // Build a map: identifier name -> unwrapped type
  // We need to register all capture references (not just renamed ones) with unwrapped types
  const captureTypes = new Map<string, ts.Type>();
  if (checker) {
    for (const expr of captureExpressions) {
      // Get the root identifier name from the expression
      let rootName: string | undefined;
      if (ts.isIdentifier(expr)) {
        rootName = expr.text;
      } else if (ts.isPropertyAccessExpression(expr)) {
        // For property access like `state.items`, we want to register `items`
        // but the capture tree uses the full path
        // For now, skip these - they get handled separately
        continue;
      }

      if (rootName) {
        const exprType = checker.getTypeAtLocation(expr);
        if (exprType) {
          const unwrapped = unwrapOpaqueLikeType(exprType, checker);
          if (unwrapped) {
            captureTypes.set(rootName, unwrapped);
          }
        }
      }
    }
  }

  // Build a map: original name -> renamed name (for all captures, not just renamed)
  const substitutions = new Map<string, string>();
  for (const [originalName, renamedName] of captureNameMap) {
    substitutions.set(originalName, renamedName);
  }

  if (substitutions.size === 0) {
    return body; // No captures to substitute
  }

  const visitor = (node: ts.Node, parent?: ts.Node): ts.Node => {
    // Handle shorthand property assignments specially
    // { multiplier } needs to become { multiplier: multiplier_1 } if multiplier is renamed
    if (ts.isShorthandPropertyAssignment(node)) {
      const substituteName = substitutions.get(node.name.text);
      if (substituteName) {
        const newIdentifier = factory.createIdentifier(substituteName);
        // Register with unwrapped type
        const unwrappedType = captureTypes.get(node.name.text);
        if (unwrappedType && typeRegistry) {
          typeRegistry.set(newIdentifier, unwrappedType);
        }
        // Expand shorthand into full property assignment
        return factory.createPropertyAssignment(
          node.name, // Property name stays the same
          newIdentifier, // Value uses renamed identifier
        );
      }
      // No substitution needed, keep as shorthand
      return node;
    }

    // Don't substitute identifiers that are property names
    if (ts.isIdentifier(node)) {
      // Skip if this identifier is the property name in a property access (e.g., '.get' in 'obj.get')
      if (
        parent && ts.isPropertyAccessExpression(parent) && parent.name === node
      ) {
        return node;
      }

      // Skip if this identifier is a property name in an object literal (e.g., 'foo' in '{ foo: value }')
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
        return node;
      }

      const substituteName = substitutions.get(node.text);
      if (substituteName) {
        const newIdentifier = factory.createIdentifier(substituteName);
        // Register with unwrapped type
        const unwrappedType = captureTypes.get(node.text);
        if (unwrappedType && typeRegistry) {
          typeRegistry.set(newIdentifier, unwrappedType);
        }
        return newIdentifier;
      }
    }

    return ts.visitEachChild(
      node,
      (child: ts.Node) => visitor(child, node),
      undefined,
    );
  };

  return ts.visitNode(
    body,
    (node: ts.Node) => visitor(node, undefined),
  ) as ts.ConciseBody;
}

/**
 * Transform a lift-applied call that has closures in its callback. Returns
 * undefined for any other node.
 * Converts: lift((v) => v * multiplier.get())(value)
 * To: lift(
 *   ({ value: v, multiplier }) => v * multiplier,
 *   inputSchema,
 *   resultSchema,
 * )({ value, multiplier })
 */
export function transformLiftAppliedCall(
  node: ts.Node,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node) || !isLiftAppliedCall(node, context)) {
    return undefined;
  }
  const inputCall = node;
  const { factory, checker, state } = context;

  // Extract callback
  const liftAppliedArgs = getLiftAppliedInputAndCallback(inputCall, checker);
  if (!liftAppliedArgs) {
    return undefined;
  }
  const { input: originalInput, callback } = liftAppliedArgs;

  // Collect captures
  const collector = new CaptureCollector(checker);
  const { captures: captureExpressions, captureTree } = collector.analyze(
    callback,
  );
  if (captureExpressions.size === 0) {
    // No captures - no transformation needed
    return undefined;
  }

  // Pre-register unwrapped types for captured identifiers BEFORE the visitor runs.
  // This allows nested transformations (like map -> mapWithPattern) to see the
  // correct unwrapped types for captured variables inside this lift-applied callback.
  preRegisterCaptureTypes(
    callback.body,
    captureExpressions,
    checker,
    state.typeRegistry,
  );

  // Recursively transform the callback body first
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Determine parameter name for the original input
  let originalInputParamName = "input"; // Fallback for complex expressions

  if (ts.isIdentifier(originalInput)) {
    originalInputParamName = originalInput.text;
  } else if (ts.isPropertyAccessExpression(originalInput)) {
    originalInputParamName = originalInput.name.text;
  }

  // Check if callback originally had zero parameters
  const hadZeroParameters = callback.parameters.length === 0;

  // Resolve capture name collisions with the original input parameter name
  const captureNameMap = resolveLiftAppliedCaptureNameCollisions(
    hadZeroParameters ? "" : originalInputParamName,
    captureTree,
  );

  // Build merged input object
  const mergedInput = buildLiftAppliedInputObject(
    originalInput,
    originalInputParamName,
    captureTree,
    captureNameMap,
    factory,
    hadZeroParameters,
  );

  // Rewrite the body to use renamed capture identifiers
  // Also registers new identifiers with unwrapped types for correct type inference
  const rewrittenBody = rewriteCaptureReferences(
    transformedBody,
    captureNameMap,
    captureExpressions,
    factory,
    checker,
    state.typeRegistry,
  );

  // Initialize PatternBuilder
  const builder = new PatternBuilder(context);
  builder.setCaptureTree(captureTree);
  builder.setCaptureRenames(captureNameMap);

  // Reserve the original input parameter name in the builder's used-names so
  // captures that collide with it get renamed by reserveIdentifier. Skip
  // reserving when the callback had zero parameters — there's no original
  // input binding to collide with, and reserving anyway would cause a capture
  // that happens to share the fallback name ("input") to be renamed to
  // input_1, leaving the body's references pointing at the outer-scoped
  // identifier via lexical closure instead of the destructured binding.
  if (!hadZeroParameters) {
    builder.registerUsedNames([originalInputParamName]);
  }

  // Infer result type from callback
  const signature = checker.getSignatureFromDeclaration(callback);
  let resultTypeNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;
  let hasTypeParameter = false;

  if (callback.type) {
    // Explicit return type annotation. This may be a synthesized annotation
    // attached upstream (pos < 0) that still carries raw
    // `import("commonfabric").X` refs, so normalize it to `__cfHelpers.X`
    // before it flows into the emitted lift type argument. The normalizer's
    // ImportTypeNode branch is purely syntactic, so it works without a paired
    // Type; pass the registered Type when available so it both qualifies nested
    // bare refs and carries the registry association onto the rewritten node.
    resultTypeNode = qualifyCommonFabricTypeRefs(
      callback.type,
      state.typeRegistry.get(callback.type),
      { checker, factory, typeRegistry: state.typeRegistry },
    );
  } else if (signature) {
    // Infer from callback signature
    resultType = signature.getReturnType();

    // Check if this is an uninstantiated type parameter
    const resultFlags = resultType.flags;
    const isTypeParam = (resultFlags & ts.TypeFlags.TypeParameter) !== 0;

    if (isTypeParam) {
      hasTypeParameter = true;
    } else {
      // Convert via the canonical chokepoint so commonfabric refs in the
      // result type are normalized to the always-resolvable `__cfHelpers.X`
      // form (otherwise the emitted `lift<In, Out>` second type arg prints
      // `import("commonfabric").X`). It also registers the result Type in the
      // typeRegistry for downstream schema generation.
      resultTypeNode = typeToTypeNodeWithRegistry(
        resultType,
        {
          checker,
          factory,
          sourceFile: context.sourceFile,
        },
        state.typeRegistry,
      );
    }
  }

  // Add original input parameter if needed
  if (!hadZeroParameters) {
    const originalParam = callback.parameters[0];
    if (originalParam) {
      builder.addParameter(
        originalInputParamName,
        normalizeBindingName(originalParam.name, factory, new Set()),
        originalInputParamName,
        originalParam.initializer,
      );
    }
  }

  // Build the new callback
  const originalCallback = ts.getOriginalNode(callback) as
    | ts.ArrowFunction
    | ts.FunctionExpression;
  const hasExplicitReturnType = originalCallback.type &&
    !isSyntheticNode(originalCallback.type);

  const newCallback = builder.buildCallback(
    callback,
    rewrittenBody,
    null, // lift-applied merges captures into top-level object
    hasExplicitReturnType ? resultTypeNode : null,
  );
  setParentPointers(newCallback);

  // Build TypeNodes for schema generation
  let inputTypeNode = createLiftAppliedInputSchema(
    originalInputParamName,
    originalInput,
    captureTree,
    captureNameMap,
    hadZeroParameters,
    context,
  );
  const capabilityAnalysis = getCapabilityAnalysis(
    newCallback,
    checker,
    state.typeRegistry,
  );
  const inputParamSummary = capabilityAnalysis.firstParameter;
  if (inputParamSummary) {
    inputTypeNode = applyShrinkAndWrap(
      inputParamSummary,
      inputTypeNode,
      getTypeFromTypeNodeWithFallback(
        inputTypeNode,
        checker,
        state.typeRegistry,
      ),
      false,
      checker,
      context.sourceFile,
      factory,
      "full",
      inputParamSummary.capability,
      context,
      newCallback,
    );
  }
  const schedulerOptions = createDeriveSchedulerOptions(
    inputParamSummary,
    hasCompleteSchedulerScopeSummary(capabilityAnalysis.summary),
    factory,
  );

  // Build the lift-applied call expression:
  //   __cfHelpers.lift<inputTypeNode, resultTypeNode>(newCallback)(mergedInput)
  //
  // Type arguments (when present) live on the inner lift call — lift<In, Out>
  // is the generic. The outer applied call carries the merged input object.
  const innerLiftCall = context.cfHelpers.createHelperCall(
    "lift",
    inputCall,
    hasTypeParameter
      ? undefined
      : (resultTypeNode ? [inputTypeNode, resultTypeNode] : [inputTypeNode]),
    [newCallback, ...(schedulerOptions ? [schedulerOptions] : [])],
  );
  const rebuiltCall = preserveLineage(
    factory.createCallExpression(
      innerLiftCall,
      undefined,
      [mergedInput],
    ),
    inputCall,
  );

  // Register the type of the call expression itself
  registerLiftAppliedCallType(
    rebuiltCall,
    resultTypeNode,
    resultType,
    checker,
    state.typeRegistry,
  );

  return rebuiltCall;
}
