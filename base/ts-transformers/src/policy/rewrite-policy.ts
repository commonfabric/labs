import ts from "typescript";
import { getCellKind, isBrandedCellType } from "../transformers/cell-type.ts";
import { isReactiveValueExpression } from "../ast/call-kind.ts";
import type { ReactiveContextKind } from "../ast/reactive-context.ts";
import type { ExpressionContainerKind } from "../transformers/expression-site-types.ts";

export type ReactiveReceiverKind =
  | "plain"
  | "opaque_autounwrapped"
  | "celllike_requires_rewrite";

export function classifyReactiveReceiverKind(
  expression: ts.Expression,
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): ReactiveReceiverKind {
  if (type && isBrandedCellType(type, checker)) {
    const kind = getCellKind(type, checker);
    if (kind === "cell" || kind === "stream") {
      return "celllike_requires_rewrite";
    }

    // Opaque values auto-unwrap in compute callbacks.
    return "opaque_autounwrapped";
  }

  return isReactiveValueExpression(expression, checker)
    ? "opaque_autounwrapped"
    : "plain";
}

export function shouldLowerLogicalExpression(
  contextKind: ReactiveContextKind,
  _containerKind: ExpressionContainerKind,
  operator: ts.SyntaxKind,
): boolean {
  if (
    operator !== ts.SyntaxKind.AmpersandAmpersandToken &&
    operator !== ts.SyntaxKind.BarBarToken
  ) {
    return false;
  }

  // Policy: lower always in pattern-owned expression sites, never in compute/neutral sites.
  return contextKind === "pattern";
}

export function shouldRewriteCollectionMethod(
  contextKind: ReactiveContextKind,
  methodName: string,
  receiverKind: ReactiveReceiverKind,
): boolean {
  if (
    methodName !== "map" && methodName !== "filter" &&
    methodName !== "flatMap" &&
    methodName !== "count" && methodName !== "minBy" &&
    methodName !== "maxBy" &&
    methodName !== "groupBy" && methodName !== "keyBy"
  ) {
    return false;
  }

  if (receiverKind === "plain") {
    return false;
  }

  if (contextKind === "pattern") {
    return true;
  }

  if (contextKind === "compute") {
    return receiverKind === "celllike_requires_rewrite";
  }

  return false;
}
