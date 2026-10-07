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
} from "../../ast/mod.ts";
import { analyzeFunctionCapabilities } from "../../policy/capability-analysis.ts";
import { registerLiftAppliedCallType } from "../../ast/type-inference.ts";
import { applyShrinkAndWrap } from "../../transformers/type-shrinking.ts";
import {
  planCaptureBindings,
  registerCaptureBindingTypes,
  rewriteCaptureBindingReferences,
} from "../../utils/capture-bindings.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  buildCapturePropertyAssignments,
  groupCapturesByRoot,
} from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  normalizeBindingName,
} from "../../utils/identifiers.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { createLiftAppliedInputSchema } from "../utils/schema-factory.ts";
import {
  type AvailabilityCaptureOverride,
  availabilityOverridesByPath,
  collectExplicitAvailabilityGuardCaptures,
  collectObservedAvailabilityCaptures,
  collectObservedAvailabilityInputPaths,
  createUnavailableInputPolicyOptions,
  mergeAvailabilityCaptureOverrides,
  partitionGuardCapturesByCallbackInput,
  renameAvailabilityCapturePaths,
} from "../../availability/captures.ts";
import {
  canonicalizeResultOfCaptures,
  rewriteResultOfAliasReferences,
} from "../../availability/analysis.ts";

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
  availabilityEntries: readonly AvailabilityCaptureOverride[],
  completeSchedulerScopeSummary: boolean,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression | undefined {
  const writePaths = inputParamSummary?.writePaths ?? [];
  const additionalProperties: ts.ObjectLiteralElementLike[] = [];
  if (writePaths.length > 0) {
    additionalProperties.push(
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
    );
  }

  if (completeSchedulerScopeSummary) {
    additionalProperties.push(
      factory.createPropertyAssignment(
        "completeSchedulerScopeSummary",
        factory.createTrue(),
      ),
    );
  }

  return createUnavailableInputPolicyOptions(
    availabilityEntries,
    factory,
    additionalProperties,
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
  const captureProperties = buildCapturePropertyAssignments(
    captureTree,
    factory,
    captureNameMap,
  );
  for (const property of captureProperties) properties.push(property);

  return factory.createObjectLiteralExpression(
    properties,
    properties.length > 1,
  );
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
  const { captures: authoredCaptureExpressions } = collector.analyze(
    callback,
  );
  const canonicalCaptures = canonicalizeResultOfCaptures(
    authoredCaptureExpressions,
    context,
    inputCall,
  );
  const captureExpressions = canonicalCaptures.captures;
  const captureTree = groupCapturesByRoot(captureExpressions);
  const canonicalCallbackBody = rewriteResultOfAliasReferences(
    callback.body,
    canonicalCaptures.aliases,
    context,
    context.tsContext,
  );
  const observedCaptureEntries = collectObservedAvailabilityCaptures(
    captureExpressions,
    context,
  );
  const rawGuardedEntries = collectExplicitAvailabilityGuardCaptures(
    canonicalCallbackBody,
    context,
  );
  const originalInputAvailabilityPaths = collectObservedAvailabilityInputPaths(
    originalInput,
    context,
  );
  if (
    captureExpressions.size === 0 &&
    originalInputAvailabilityPaths.length === 0
  ) {
    // No captures - no transformation needed
    return undefined;
  }

  let originalInputParamName = "input";
  if (ts.isIdentifier(originalInput)) {
    originalInputParamName = originalInput.text;
  } else if (ts.isPropertyAccessExpression(originalInput)) {
    originalInputParamName = originalInput.name.text;
  }
  const hadZeroParameters = callback.parameters.length === 0;
  const captureNameMap = resolveLiftAppliedCaptureNameCollisions(
    hadZeroParameters ? "" : originalInputParamName,
    captureTree,
  );
  const captureBindings = planCaptureBindings(
    captureExpressions,
    callback,
    captureNameMap,
    context,
    inputCall,
  );

  // Pre-register unwrapped types for captured identifiers BEFORE the visitor runs.
  // This allows nested transformations (like map -> mapWithPattern) to see the
  // correct unwrapped types for captured variables inside this lift-applied callback.
  registerCaptureBindingTypes(
    canonicalCallbackBody,
    captureBindings,
    context,
  );

  // Lower nested callbacks after assigning scope-safe capture names.
  const transformedBody = ts.visitNode(
    rewriteCaptureBindingReferences(
      canonicalCallbackBody,
      captureBindings,
      context,
    ),
    visitor,
  ) as ts.ConciseBody;

  const partitionedGuardEntries = partitionGuardCapturesByCallbackInput(
    rawGuardedEntries,
    callback,
  );
  const guardedInputEntries = !hadZeroParameters
    ? partitionedGuardEntries.callbackInput.map((entry) => ({
      ...entry,
      path: [originalInputParamName, ...entry.path],
    }))
    : [];
  const guardedCaptureEntries = partitionedGuardEntries.captures;

  const originalInputAvailabilityEntries = !hadZeroParameters
    ? originalInputAvailabilityPaths.map((entry) => ({
      ...entry,
      path: [originalInputParamName, ...entry.path],
    }))
    : [];
  const availabilityTypeEntries = mergeAvailabilityCaptureOverrides([
    ...originalInputAvailabilityEntries,
    ...guardedInputEntries,
    ...observedCaptureEntries,
    ...guardedCaptureEntries,
  ]);

  const availabilityPolicyEntries = mergeAvailabilityCaptureOverrides([
    ...originalInputAvailabilityEntries,
    ...guardedInputEntries,
    ...renameAvailabilityCapturePaths(
      [...observedCaptureEntries, ...guardedCaptureEntries],
      captureNameMap,
    ),
  ]);

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
  const rewrittenBody = rewriteCaptureBindingReferences(
    transformedBody,
    captureBindings,
    context,
    true,
  );

  // Initialize PatternBuilder
  const builder = new PatternBuilder(context);
  builder.setCaptureTree(captureTree);
  builder.setCaptureRenames(captureNameMap);
  builder.setCaptureBindingNames(
    new Map(
      [...captureBindings].map((
        [root, binding],
      ) => [root, binding.bindingName]),
    ),
  );

  // Reserve the original input parameter for other builder-generated names.
  // A zero-parameter callback has no input binding to reserve.
  if (!hadZeroParameters) {
    builder.registerUsedNames([originalInputParamName]);
  }

  // Infer result type from callback
  const signature = checker.getSignatureFromDeclaration(callback);
  let resultTypeNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;
  let hasTypeParameter = false;

  if (
    ts.isExpression(callback.body) &&
    ts.isCallExpression(callback.body) &&
    detectCallKind(callback.body, checker)?.kind === "availability-guard"
  ) {
    // As with synthesized direct guards, syntax-only transformer consumers can
    // see `any` for an unresolved commonfabric predicate. Classification still
    // proves this callback returns boolean.
    resultTypeNode = factory.createKeywordTypeNode(
      ts.SyntaxKind.BooleanKeyword,
    );
  } else if (callback.type) {
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
          state,
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
    availabilityOverridesByPath(availabilityTypeEntries),
    context,
  );
  const capabilityAnalysis = getCapabilityAnalysis(
    newCallback,
    checker,
    state.typeRegistry,
  );
  const inputParamSummary = capabilityAnalysis.firstParameter;
  if (inputParamSummary && availabilityTypeEntries.length === 0) {
    // Availability policy is evaluated against the complete serialized module
    // argument. Capability shrinking can remove an unused-but-present
    // observed property while the merged input and exact-path policy still
    // contain it, leaving type/schema/policy out of sync. Preserve the complete
    // observed input contract; capability analysis is still used below for
    // materializer write-path scheduler options.
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
    availabilityPolicyEntries,
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
