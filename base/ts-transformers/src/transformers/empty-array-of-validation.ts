/**
 * Empty Array `.of()` Validation Transformer
 *
 * Reports a compile-time error when `Cell.of([])`, `Writable.of([])`, or any
 * other CellLike class's `.of()` is called with an empty array literal.
 *
 * TypeScript infers `[]` as `never[]`, so `Cell.of([])` produces `Cell<never[]>`
 * — an array you can never push objects into. The fix is to provide an explicit
 * type argument: `Cell.of<MyType[]>([])`.
 */

import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { detectCallKind, detectNewExpressionKind } from "../ast/call-kind.ts";

export class EmptyArrayOfValidationTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, checker);
        if (callKind?.kind === "cell-factory") {
          this.#validateNotEmptyArray(node, callKind.factoryName, context);
        }
      }
      if (ts.isNewExpression(node)) {
        const callKind = detectNewExpressionKind(node, checker);
        if (callKind?.kind === "cell-factory") {
          this.#validateNotEmptyArray(node, callKind.factoryName, context);
        }
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  #validateNotEmptyArray(
    call: ts.CallExpression | ts.NewExpression,
    factoryName: string,
    context: TransformationContext,
  ): void {
    const firstArg = call.arguments?.[0];
    if (!firstArg) return;

    if (
      ts.isArrayLiteralExpression(firstArg) &&
      firstArg.elements.length === 0 &&
      !call.typeArguments?.length
    ) {
      // Build a display name matching the actual call site.
      // For `Cell.of([])` the expression is a PropertyAccessExpression → "Cell.of";
      // for the deprecated `cell([])` it's just an identifier → "cell".
      const callee = call.expression;
      const displayName = ts.isNewExpression(call)
        ? `new ${factoryName}`
        : ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression)
        ? `${callee.expression.text}.${factoryName}`
        : factoryName;

      context.reportDiagnostic({
        severity: "error",
        type: "cell-factory:empty-array",
        message:
          `${displayName}([]) creates a Cell<never[]> because TypeScript infers [] as never[]. ` +
          `Provide an explicit type argument: ${displayName}<MyType[]>([])`,
        node: call,
      });
    }
  }
}
