/** Warns about scans of captured collections inside reactive array callbacks. */

import ts from "typescript";

import {
  classifyArrayMethodCallSite,
  hasReactiveCollectionProvenance,
  isCollectionType,
  unwrapOpaqueLikeType,
} from "../ast/mod.ts";
import { isDeclaredWithinFunction } from "../ast/scope-analysis.ts";
import type { TransformationContext } from "../core/mod.ts";
import { getOpaqueAccessInfo } from "../transformers/opaque-roots.ts";
import { unwrapExpression } from "../utils/expression.ts";

/** Reports authored nested scans without changing their execution. */
export function reportNestedCollectionScans(
  context: TransformationContext,
): void {
  const checker = context.checker;
  const visit = (
    node: ts.Node,
    insideCollection: ts.ArrowFunction | ts.FunctionExpression | undefined,
  ): void => {
    if (ts.isCallExpression(node)) {
      const site = classifyArrayMethodCallSite(node, checker);
      const target = unwrapExpression(node.expression);
      const callback = node.arguments[0] && unwrapExpression(node.arguments[0]);
      if (
        site?.ownership === "reactive" && !site.lowered &&
        (ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)) &&
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        isCollectionType(
          unwrapOpaqueLikeType(
            checker.getTypeAtLocation(target.expression),
            checker,
          ),
          checker,
        )
      ) {
        const root =
          getOpaqueAccessInfo(target.expression, context).rootIdentifier;
        const declarations = root &&
          checker.getSymbolAtLocation(root)?.getDeclarations();
        if (
          insideCollection && declarations?.length &&
          !ts.isElementAccessExpression(unwrapExpression(target.expression)) &&
          !declarations.some((declaration) =>
            isDeclaredWithinFunction(declaration, insideCollection)
          ) &&
          hasReactiveCollectionProvenance(target.expression, checker, {
            allowTypeBasedRoot: false,
            allowReactiveArrayCallbackParameters: false,
          })
        ) {
          context.reportDiagnostic({
            severity: "warning",
            type: "collection:nested-scan",
            message:
              "This scan reads a captured reactive collection inside another " +
              "collection callback. Work can grow with the product of the collection " +
              "sizes. Measure the demanded result; move shared work outside the " +
              "callback or use an indexed lookup or named aggregate when its " +
              "contract matches.",
            node,
          });
        }
        ts.forEachChild(node, (child) => {
          if (child === node.arguments[0]) visit(callback.body, callback);
          else visit(child, insideCollection);
        });
        return;
      }
    }
    // A different function owns its own work, even when declared in a callback.
    const nested = ts.isFunctionLike(node) ? undefined : insideCollection;
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  visit(context.sourceFile, undefined);
}
