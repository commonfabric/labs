import ts from "typescript";

import {
  getLoweredArrayMethodName,
  getTypeAtLocationWithFallback,
  preserveLineage,
  preserveSourceMapRange,
  registerSyntheticCallType,
  setParentPointers,
  typeToTypeNodeWithRegistry,
  visitEachChildWithJsx,
} from "../../ast/mod.ts";
import type { TransformationContext } from "../../core/mod.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  normalizeBindingName,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import {
  createPathRead,
  type PathSegment,
} from "../../transformers/destructuring-lowering.ts";
import { createReactiveWrapperForExpression } from "../../transformers/expression-rewrite/rewrite-helpers.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import { getStaticKeySegment } from "../../utils/reactive-keys.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { buildCaptureParamsObject } from "../utils/capture-scaffold.ts";
import { expandCapturedObjectSpreads } from "../utils/captured-object-spread.ts";
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { createArrayMethodCallbackSchema } from "../utils/schema-factory.ts";
import {
  analyzeElementBinding,
  rewriteCallbackBody,
} from "./array-method-utils.ts";
import type { ComputedAliasInfo } from "./array-method-utils.ts";
import type { SourceArrayMethodCall } from "./array-method-policy.ts";

export interface ArrayMethodCallbackTransformOptions {
  readonly rewriteTransformedBody?: (
    body: ts.ConciseBody,
    context: TransformationContext,
  ) => ts.ConciseBody;
}

function lowerMapReceiverMemberAccess(
  expression: ts.Expression,
  context: TransformationContext,
): ts.Expression {
  const segments: PathSegment[] = [];
  let current = unwrapExpression(expression);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = unwrapExpression(current.expression);
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      const segment = getStaticKeySegment(
        current.argumentExpression,
        context,
      );
      if (segment === undefined) {
        return expression;
      }
      segments.unshift(segment);
      current = unwrapExpression(current.expression);
      continue;
    }

    break;
  }

  if (!ts.isIdentifier(current) || segments.length === 0) {
    return expression;
  }

  return preserveSourceMapRange(
    createPathRead(
      context.factory.createIdentifier(current.text),
      segments,
      context.factory,
    ),
    expression,
  );
}

function createPatternCallWithParams(
  methodCall: SourceArrayMethodCall,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  elemParam: ts.ParameterDeclaration | undefined,
  indexParam: ts.ParameterDeclaration | undefined,
  arrayParam: ts.ParameterDeclaration | undefined,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
  visitor: ts.Visitor,
  options: ArrayMethodCallbackTransformOptions,
): ts.CallExpression {
  const { factory } = context;
  const usedBindingNames = new Set<string>();

  const createBindingIdentifier = (name: string): ts.Identifier => {
    return reserveIdentifier(name, usedBindingNames, factory);
  };

  const elementAnalysis = analyzeElementBinding(
    elemParam,
    captureTree,
    context,
    usedBindingNames,
    createBindingIdentifier,
  );

  const computedAliasNames = new Set(
    elementAnalysis.computedAliases.map((alias) => alias.aliasName),
  );
  const filteredCaptureTree = new Map(
    Array.from(captureTree.entries()).filter(
      ([key]) => !computedAliasNames.has(key),
    ),
  );

  const builder = new PatternBuilder(context);
  builder.registerUsedNames(usedBindingNames);
  builder.setCaptureTree(filteredCaptureTree);

  builder.addParameter(
    "element",
    elementAnalysis.bindingName,
    elementAnalysis.bindingName.kind === ts.SyntaxKind.Identifier &&
      elementAnalysis.bindingName.text === "element"
      ? undefined
      : "element",
  );

  if (indexParam) {
    builder.addParameter(
      "index",
      normalizeBindingName(indexParam.name, factory, usedBindingNames),
    );
  }

  if (arrayParam) {
    builder.addParameter(
      "array",
      normalizeBindingName(arrayParam.name, factory, usedBindingNames),
    );
  }

  const visitedAliases: ComputedAliasInfo[] = elementAnalysis
    .computedAliases.map((info) => {
      const keyExpression = ts.visitNode(
        info.keyExpression,
        visitor,
        ts.isExpression,
      ) ?? info.keyExpression;
      return { ...info, keyExpression };
    });

  const { checker } = context;
  const typeRegistry = context.state.typeRegistry;
  let resultTypeNode: ts.TypeNode | undefined;

  if (callback.type) {
    resultTypeNode = callback.type;
    const type = getTypeAtLocationWithFallback(
      callback.type,
      checker,
      typeRegistry,
    );
    if (type) {
      typeRegistry.set(callback.type, type);
    }
  } else {
    const signature = checker.getSignatureFromDeclaration(callback);
    if (signature) {
      const resultType = signature.getReturnType();
      const isTypeParam = (resultType.flags & ts.TypeFlags.TypeParameter) !== 0;

      if (!isTypeParam) {
        // Convert via the canonical chokepoint so commonfabric refs in the
        // result type normalize to `__cfHelpers.X` (otherwise the emitted
        // pattern<…, Out> second type arg prints `import("commonfabric").X`).
        // It also registers the result Type for downstream schema generation.
        resultTypeNode = typeToTypeNodeWithRegistry(
          resultType,
          {
            checker,
            factory,
            sourceFile: context.sourceFile,
            state: context.state,
          },
          typeRegistry,
        );
      }
    }
  }

  const family = methodCall.expression.name.text;
  const isSelector = family === "groupBy" || family === "keyBy";
  if (isSelector && resultTypeNode) {
    resultTypeNode = factory.createTypeLiteralNode([
      factory.createPropertySignature(
        undefined,
        "isCell",
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
      ),
      factory.createPropertySignature(
        undefined,
        "value",
        undefined,
        resultTypeNode,
      ),
    ]);
  }

  const bodyWithKeyValues = isSelector
    ? tagSelectorReturns(transformedBody, context, "evaluate", resultTypeNode)
    : transformedBody;
  const bodyForRewrite = options.rewriteTransformedBody
    ? options.rewriteTransformedBody(bodyWithKeyValues, context)
    : bodyWithKeyValues;

  const rewrittenBody = rewriteCallbackBody(
    bodyForRewrite,
    {
      bindingName: elementAnalysis.bindingName,
      elementIdentifier: elementAnalysis.elementIdentifier,
      destructureStatement: elementAnalysis.destructureStatement,
      computedAliases: visitedAliases,
    },
    context,
  );

  const newCallback = builder.buildCallback(callback, rewrittenBody, "params");
  context.markAsArrayMethodCallback(newCallback);

  const callbackParamTypeNode = createArrayMethodCallbackSchema(
    methodCall,
    elemParam,
    indexParam,
    arrayParam,
    filteredCaptureTree,
    context,
  );

  const typeArgs = [callbackParamTypeNode];
  if (resultTypeNode) {
    typeArgs.push(resultTypeNode);
  }

  const patternCall = context.cfHelpers.createHelperCall(
    "pattern",
    methodCall,
    typeArgs,
    [newCallback],
  );

  const paramsObject = buildCaptureParamsObject(filteredCaptureTree, factory);

  const visitedArrayExpr = ts.visitNode(
    methodCall.expression.expression,
    visitor,
    ts.isExpression,
  ) ?? methodCall.expression.expression;
  const loweredArrayExpr = lowerMapReceiverMemberAccess(
    visitedArrayExpr,
    context,
  );

  const mapWithPatternAccess = factory.createPropertyAccessExpression(
    loweredArrayExpr,
    factory.createIdentifier(getLoweredArrayMethodName(family)),
  );

  const args: ts.Expression[] = [patternCall, paramsObject];
  const thisArg = methodCall.arguments[1];
  if (thisArg) {
    args.push(ts.visitNode(thisArg, visitor, ts.isExpression) ?? thisArg);
  }

  const mapWithPatternCall = preserveLineage(
    factory.createCallExpression(
      mapWithPatternAccess,
      methodCall.typeArguments,
      args,
    ),
    methodCall,
  );

  const mapResultType = context.checker.getTypeAtLocation(methodCall);
  registerSyntheticCallType(mapWithPatternCall, mapResultType, typeRegistry);

  return mapWithPatternCall;
}

/**
 * Tags selector returns and builds their reactive evaluation wrappers.
 * Evaluation preserves primitive values and Cell identities across the selector
 * pattern's serialization boundary.
 */
function tagSelectorReturns(
  body: ts.ConciseBody,
  context: TransformationContext,
  phase: "tag" | "evaluate" = "tag",
  resultTypeNode?: ts.TypeNode,
): ts.ConciseBody {
  const tag = (value: ts.Expression) => {
    if (phase === "evaluate") {
      const analysis = context.getDataFlowAnalyzer()(value);
      const reads = context.getRelevantDataFlowsFromAnalysis(analysis);
      return createReactiveWrapperForExpression(value, reads, context, {
        allowDirectExpressionWrap: true,
        preferInputBoundWrapper: true,
        resultTypeNode,
      }) ?? value;
    }
    const call = context.cfHelpers.createHelperCall(
      "tagCollectionKey",
      value,
      undefined,
      [value],
    );
    setParentPointers(call, value.parent);
    return call;
  };
  if (!ts.isBlock(body)) return tag(body);
  const visitor: ts.Visitor = (node) => {
    if (ts.isFunctionLike(node)) return node;
    if (ts.isReturnStatement(node)) {
      return context.factory.updateReturnStatement(
        node,
        tag(
          node.expression ??
            context.factory.createVoidExpression(
              context.factory.createNumericLiteral(0),
            ),
        ),
      );
    }
    return visitEachChildWithJsx(node, visitor, context.tsContext);
  };
  const rewritten = ts.visitNode(body, visitor, ts.isBlock)!;
  const last = rewritten.statements.at(-1);
  if (
    phase === "tag" &&
    (!last || (!ts.isReturnStatement(last) && !ts.isThrowStatement(last)))
  ) {
    return context.factory.updateBlock(rewritten, [
      ...rewritten.statements,
      context.factory.createReturnStatement(
        tag(
          context.factory.createVoidExpression(
            context.factory.createNumericLiteral(0),
          ),
        ),
      ),
    ]);
  }
  return rewritten;
}

/**
 * Transform an array method callback for Reactive arrays.
 * Always transforms to use pattern + the WithPattern variant, even with no
 * captures, to ensure callback parameters become opaque.
 */
export function transformArrayMethodCallback(
  methodCall: SourceArrayMethodCall,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
  options: ArrayMethodCallbackTransformOptions = {},
): ts.CallExpression {
  const { checker } = context;

  context.markAsArrayMethodCallback(callback);

  const collector = new CaptureCollector(checker);
  const { captureTree } = collector.analyzeCurrentAndOriginal(callback);

  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const indexParam = originalParams[1];
  const arrayParam = originalParams[2];

  const family = methodCall.expression.name.text;
  const body = family === "groupBy" || family === "keyBy"
    ? tagSelectorReturns(callback.body, context)
    : callback.body;
  const transformedBody = expandCapturedObjectSpreads(
    ts.visitNode(body, visitor) as ts.ConciseBody,
    callback,
    new Set(captureTree.keys()),
    context,
  );

  return createPatternCallWithParams(
    methodCall,
    callback,
    transformedBody,
    elemParam,
    indexParam,
    arrayParam,
    captureTree,
    context,
    visitor,
    options,
  );
}
