import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import { preserveSourceMapRange } from "../../ast/mod.ts";
import {
  buildCapturePropertyAssignments,
  type CaptureTreeNode,
} from "../../utils/capture-tree.ts";
import { PatternBuilder } from "./pattern-builder.ts";

export function buildCaptureParamsObject(
  captureTree: Map<string, CaptureTreeNode>,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const paramProperties = buildCapturePropertyAssignments(captureTree, factory);
  return factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );
}

export function buildCapturedHandlerClosureCall(
  originalNode: ts.Node,
  callback: ts.ArrowFunction,
  transformedBody: ts.ConciseBody,
  captureTree: Map<string, CaptureTreeNode>,
  eventTypeNode: ts.TypeNode,
  stateTypeNode: ts.TypeNode,
  context: TransformationContext,
  options?: {
    readonly eventParamName?: string;
    readonly paramsParamName?: string;

    /**
     * The verb's declared result type, carried into `handler`'s third
     * type-argument slot so SchemaInjection can lower it to the module's
     * result schema. Omitted for a value-less verb.
     */
    readonly resultTypeNode?: ts.TypeNode;
  },
): ts.CallExpression {
  const builder = new PatternBuilder(context);
  builder.setCaptureTree(captureTree);

  // The moved body keeps original parent links, so mark both callback nodes as
  // safe handler contexts for later expression-site rewrites.
  context.markAsSyntheticComputeCallback(callback);
  const handlerCallback = builder.buildHandlerCallback(
    callback,
    transformedBody,
    options?.eventParamName ?? "event",
    options?.paramsParamName ?? "params",
  );
  context.markAsSyntheticComputeCallback(handlerCallback);

  const handlerCall = context.cfHelpers.createHelperCall(
    "handler",
    originalNode,
    options?.resultTypeNode
      ? [eventTypeNode, stateTypeNode, options.resultTypeNode]
      : [eventTypeNode, stateTypeNode],
    [handlerCallback],
  );

  // Outer applied handler call: source-map-range only, so the hoisting stage
  // can recover the authored position (CT-1868). Not full lineage: this call
  // survives to the printer at the original JSX site, and a real textRange
  // there changes ternary/JSX line-break layout (setOriginalNode likewise
  // feeds getOriginalNode fallbacks). See preserveSourceMapRange.
  return preserveSourceMapRange(
    context.factory.createCallExpression(
      handlerCall,
      undefined,
      [buildCaptureParamsObject(captureTree, context.factory)],
    ),
    originalNode,
  );
}
