import ts from "typescript";
import { CFHelpers } from "../../core/cf-helpers.ts";
import {
  getExpressionText,
  getTypeAtLocationWithFallback,
  preserveSourceMapRange,
  setParentPointers,
  unwrapOpaqueLikeType,
} from "../../ast/mod.ts";
import {
  buildCapturePropertyAssignments,
  groupCapturesByRoot,
  parseCaptureExpression,
} from "../../utils/capture-tree.ts";
import {
  createBindingElementsFromNames,
  createParameterFromBindings,
  createPropertyParamNames,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import {
  buildCaptureTypeElements,
  createRegisteredTypeLiteral,
  expressionToTypeNode,
  getConstructedCellTypeNode,
  typeToTypeNodeWithRegistry,
} from "../../ast/type-building.ts";
import { registerLiftAppliedCallType } from "../../ast/type-inference.ts";
import type { TransformationContext } from "../../core/mod.ts";

/**
 * Replace Reactive expressions with parameter identifiers in the callback body.
 * Also registers the new identifiers with their UNWRAPPED types in the typeRegistry,
 * so that type-based checks inside the lift-applied callback see the correct types.
 */
function replaceReactivesWithParams(
  expression: ts.Expression,
  refToParamName: Map<ts.Expression, string>,
  factory: ts.NodeFactory,
  tsContext: ts.TransformationContext,
  checker: ts.TypeChecker | undefined,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): ts.Expression {
  const visit = (node: ts.Node): ts.Node => {
    for (const [ref, paramName] of refToParamName) {
      if (node === ref) {
        const newIdentifier = factory.createIdentifier(paramName);

        // Register the new identifier with its UNWRAPPED type.
        // The ref has type Reactive<T>, but inside the lift-applied callback
        // the parameter has type T (unwrapped).
        if (checker && typeRegistry) {
          const refType = checker.getTypeAtLocation(ref);
          if (refType) {
            const unwrappedType = unwrapOpaqueLikeType(refType, checker);
            if (unwrappedType) {
              typeRegistry.set(newIdentifier, unwrappedType);
            }
          }
        }

        return newIdentifier;
      }
    }
    return ts.visitEachChild(node, visit, tsContext);
  };
  return visit(expression) as ts.Expression;
}

interface FallbackEntry {
  readonly ref: ts.Expression;
  readonly paramName: string;
  readonly propertyName: string;
}

export interface LiftAppliedCallOptions {
  /** Known output type of a synthetic expression. */
  readonly resultTypeNode?: ts.TypeNode;

  readonly factory: ts.NodeFactory;
  readonly tsContext: ts.TransformationContext;
  readonly cfHelpers: CFHelpers;
  readonly context: TransformationContext;
}

function planLiftAppliedInputEntries(
  refs: readonly ts.Expression[],
): {
  readonly captureTree: ReturnType<typeof groupCapturesByRoot>;
  readonly fallbackEntries: readonly FallbackEntry[];
  readonly refToParamName: Map<ts.Expression, string>;
} {
  const structured: ts.Expression[] = [];
  const fallback: ts.Expression[] = [];

  refs.forEach((ref) => {
    if (parseCaptureExpression(ref)) {
      structured.push(ref);
    } else {
      fallback.push(ref);
    }
  });

  const captureTree = groupCapturesByRoot(structured);
  const fallbackEntries: FallbackEntry[] = [];
  const refToParamName = new Map<ts.Expression, string>();

  const usedPropertyNames = new Set<string>();
  const usedParamNames = new Set<string>();

  fallback.forEach((ref, index) => {
    const { propertyName, paramName } = createPropertyParamNames(
      getExpressionText(ref),
      ts.isIdentifier(ref),
      index,
      usedPropertyNames,
      usedParamNames,
    );

    fallbackEntries.push({ ref, propertyName, paramName });
    refToParamName.set(ref, paramName);
  });

  return { captureTree, fallbackEntries, refToParamName };
}

function createParameterForPlan(
  factory: ts.NodeFactory,
  captureTree: ReturnType<typeof groupCapturesByRoot>,
  fallbackEntries: readonly FallbackEntry[],
  refToParamName: Map<ts.Expression, string>,
): ts.ParameterDeclaration {
  const bindings: ts.BindingElement[] = [];
  const usedNames = new Set<string>();

  const register = (candidate: string): ts.Identifier => {
    return reserveIdentifier(candidate, usedNames, factory);
  };

  bindings.push(
    ...createBindingElementsFromNames(captureTree.keys(), factory, register),
  );

  for (const entry of fallbackEntries) {
    const bindingIdentifier = register(entry.paramName);
    const currentName = refToParamName.get(entry.ref);
    if (currentName !== bindingIdentifier.text) {
      refToParamName.set(entry.ref, bindingIdentifier.text);
    }
    bindings.push(
      factory.createBindingElement(
        undefined,
        factory.createIdentifier(entry.propertyName),
        bindingIdentifier,
        undefined,
      ),
    );
  }

  return createParameterFromBindings(bindings, factory);
}

function createLiftAppliedInputArgs(
  factory: ts.NodeFactory,
  captureTree: ReturnType<typeof groupCapturesByRoot>,
  fallbackEntries: readonly FallbackEntry[],
): readonly ts.Expression[] {
  const properties: ts.ObjectLiteralElementLike[] = [];

  properties.push(...buildCapturePropertyAssignments(captureTree, factory));

  for (const entry of fallbackEntries) {
    if (ts.isIdentifier(entry.ref) && entry.propertyName === entry.ref.text) {
      properties.push(
        factory.createShorthandPropertyAssignment(entry.ref, undefined),
      );
    } else {
      properties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(entry.propertyName),
          entry.ref,
        ),
      );
    }
  }

  return [
    factory.createObjectLiteralExpression(properties, properties.length > 1),
  ];
}

// Caller must pass a non-empty refs array.
export function createLiftAppliedCall(
  expression: ts.Expression,
  refs: readonly ts.Expression[],
  options: LiftAppliedCallOptions,
): ts.Expression | undefined {
  if (refs.length === 0) {
    throw new Error("createLiftAppliedCall requires a non-empty refs array");
  }

  const { factory, tsContext, cfHelpers, context } = options;
  const { captureTree, fallbackEntries, refToParamName } =
    planLiftAppliedInputEntries(
      refs,
    );
  if (captureTree.size === 0 && fallbackEntries.length === 0) {
    return undefined;
  }

  context.markSyntheticComputeOwnedSubtree?.(expression);

  const parameter = createParameterForPlan(
    factory,
    captureTree,
    fallbackEntries,
    refToParamName,
  );

  const lambdaBody = replaceReactivesWithParams(
    expression,
    refToParamName,
    factory,
    tsContext,
    context.checker,
    context.state.typeRegistry,
  );

  // Callback arrow: source-map-range only (emit-safe position carry). See
  // preserveSourceMapRange.
  const arrowFunction = preserveSourceMapRange(
    factory.createArrowFunction(
      undefined,
      undefined,
      [parameter],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      lambdaBody,
    ),
    expression,
  );
  context.markAsSyntheticComputeCallback?.(arrowFunction);

  // Split into the lift-applied shape:
  //   __cfHelpers.lift<inputTypeNode, resultTypeNode>(callback)(inputObject)
  //
  // The input object is the outer applied call's single argument; the
  // callback (and type arguments, since lift<In, Out> is the generic) live
  // on the inner lift call. This matches the canonical post-Phase-1 shape
  // produced by LiftLoweringTransformer (see src/lift/transformer.ts) for
  // user-authored computed() calls.
  const [inputObject] = createLiftAppliedInputArgs(
    factory,
    captureTree,
    fallbackEntries,
  );
  if (!inputObject) {
    return undefined;
  }

  // Build input type node that preserves Cell<T> types
  const inputTypeNode = buildInputTypeNode(
    captureTree,
    fallbackEntries,
    context,
  );

  // Infer the expression result when the caller supplies no output type.
  const resultTypeNode = options.resultTypeNode ??
    buildResultTypeNode(expression, context);

  // Inner lift call: __cfHelpers.lift<inputTypeNode, resultTypeNode>(callback)
  const innerLiftCall = cfHelpers.createHelperCall(
    "lift",
    expression,
    [inputTypeNode, resultTypeNode],
    [arrowFunction],
  );

  // Outer applied call: (inputObject). Source-map-range ONLY: this wrapper
  // reifies the authored expression rather than replacing it as the same
  // semantic unit, and `expression` was marked compute-owned above
  // (markSyntheticComputeOwnedSubtree) — an original pointing into that marked
  // subtree would make identity-sensitive classifiers (getOriginalNode
  // fallbacks, e.g. the array-method compute-context invariant) falsely treat
  // the wrapper as compute-owned. smr carries the authored position without
  // identity (CT-1868).
  const liftAppliedCall = preserveSourceMapRange(
    factory.createCallExpression(
      innerLiftCall,
      undefined,
      [inputObject],
    ),
    expression,
  );

  // Register the type of the call expression itself in the typeRegistry
  // so that type inference works correctly for synthetic nodes. The
  // result type is the value the callback returns.
  registerLiftAppliedCallType(
    liftAppliedCall,
    resultTypeNode,
    undefined, // resultType not available in this code path
    context.checker,
    context.state.typeRegistry,
  );

  // Maintain parent chains and compute-wrapper ownership for later passes that
  // revisit synthetic lift-applied callbacks after post-closure lowering.
  setParentPointers(liftAppliedCall, expression.parent);

  return liftAppliedCall;
}

function buildInputTypeNode(
  captureTree: ReturnType<typeof groupCapturesByRoot>,
  fallbackEntries: readonly FallbackEntry[],
  context: TransformationContext,
): ts.TypeNode {
  const { factory } = context;
  const typeElements: ts.TypeElement[] = [];

  // Add type elements from capture tree (preserves Cell<T>)
  const captureTypeElements = buildCaptureTypeElements(
    captureTree,
    context,
  );
  typeElements.push(...captureTypeElements);

  // Add type elements for fallback entries
  for (const entry of fallbackEntries) {
    const typeNode = expressionToTypeNode(entry.ref, context);
    typeElements.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(entry.propertyName),
        undefined,
        typeNode,
      ),
    );
  }

  return createRegisteredTypeLiteral(
    typeElements,
    {
      factory,
      checker: context.checker,
      typeRegistry: context.state.typeRegistry,
    },
  );
}

function buildResultTypeNode(
  expression: ts.Expression,
  context: TransformationContext,
): ts.TypeNode {
  const { factory, checker } = context;
  const constructedCell = getConstructedCellTypeNode(
    expression,
    checker,
    context.state.typeRegistry,
  );
  if (constructedCell) return constructedCell;

  // Try to get the type of the result expression
  // Use getTypeAtLocationWithFallback to handle synthetic nodes that may have
  // their type registered from earlier transformation stages
  const resultType = getTypeAtLocationWithFallback(
    expression,
    checker,
    context.state.typeRegistry,
  );

  // If we couldn't get a type, fallback to unknown
  if (!resultType) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }

  // Convert to TypeNode via the canonical chokepoint: it normalizes
  // commonfabric refs to the always-resolvable `__cfHelpers.X` form (so the
  // emitted result type arg doesn't print `import("commonfabric").X`),
  // registers the Type for the SchemaGeneratorTransformer, and falls back to
  // `unknown` if conversion fails.
  return typeToTypeNodeWithRegistry(
    resultType,
    {
      checker,
      factory,
      sourceFile: context.sourceFile,
    },
    context.state.typeRegistry,
  );
}
