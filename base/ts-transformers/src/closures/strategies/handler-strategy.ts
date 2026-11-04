import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import {
  isEventHandlerJsxAttribute,
  preserveSourceMapRange,
} from "../../ast/mod.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { unwrapArrowFunction } from "../utils/ast-helpers.ts";
import {
  createHandlerEventSchema,
  createHandlerStateSchema,
} from "../utils/schema-factory.ts";
import { buildCapturedHandlerClosureCall } from "../utils/capture-scaffold.ts";

/**
 * Rewrite a JSX event handler attribute so its callback's captures become
 * explicit handler params. Returns undefined for any other node.
 */
export function transformHandlerJsxAttribute(
  node: ts.Node,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.JsxAttribute | undefined {
  if (
    !ts.isJsxAttribute(node) ||
    !isEventHandlerJsxAttribute(node.name, context.checker)
  ) {
    return undefined;
  }

  const attribute = node;
  const initializer = attribute.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) {
    return undefined;
  }

  const expression = initializer.expression;
  if (!expression) {
    return undefined;
  }

  const callback = unwrapArrowFunction(expression);
  if (!callback) {
    return undefined;
  }

  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  const collector = new CaptureCollector(context.checker);
  const { captureTree } = collector.analyze(callback);
  const { factory } = context;

  const eventTypeNode = createHandlerEventSchema(callback, context);
  const stateTypeNode = createHandlerStateSchema(
    captureTree,
    callback.parameters[1] as ts.ParameterDeclaration | undefined,
    context,
  );

  const finalCall = buildCapturedHandlerClosureCall(
    expression,
    callback,
    transformedBody,
    captureTree,
    eventTypeNode,
    stateTypeNode,
    context,
    {
      eventParamName: "__cf_handler_event",
      paramsParamName: "__cf_handler_params",
    },
  );

  const newInitializer = preserveSourceMapRange(
    factory.createJsxExpression(
      initializer.dotDotDotToken,
      finalCall,
    ),
    initializer,
  );

  return preserveSourceMapRange(
    factory.createJsxAttribute(attribute.name, newInitializer),
    attribute,
  );
}
