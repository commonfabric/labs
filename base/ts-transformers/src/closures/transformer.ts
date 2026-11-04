import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { setParentPointers, visitEachChildWithJsx } from "../ast/mod.ts";
import { transformActionCall } from "./strategies/action-strategy.ts";
import { transformArrayMethodCall } from "./strategies/array-method-strategy.ts";
import { transformLiftAppliedCall } from "./strategies/lift-applied-strategy.ts";
import { transformHandlerJsxAttribute } from "./strategies/handler-strategy.ts";

/** Rewrites one node, or returns undefined when it does not apply to it. */
type ClosureTransformation = (
  node: ts.Node,
  context: TransformationContext,
  visitor: ts.Visitor,
) => ts.Node | undefined;

/** Tried in order; the first one to return a node wins. */
const transformations: ClosureTransformation[] = [
  transformHandlerJsxAttribute,
  transformActionCall,
  transformArrayMethodCall,
  transformLiftAppliedCall,
];

export class ClosureTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    return transformClosures(context);
  }
}

function createClosureTransformVisitor(
  context: TransformationContext,
): ts.Visitor {
  const visit: ts.Visitor = (node: ts.Node) => {
    for (const transformation of transformations) {
      const transformed = transformation(node, context, visit);
      if (transformed) {
        if (transformed !== node) {
          setParentPointers(transformed, node.parent);
        }
        return transformed;
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return visit;
}

function transformClosures(context: TransformationContext): ts.SourceFile {
  const { sourceFile } = context;

  const visitor = createClosureTransformVisitor(context);
  return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
}
