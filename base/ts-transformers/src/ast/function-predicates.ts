import ts from "typescript";

/**
 * Checks if an expression is a function expression (arrow or function expression).
 * Use this for checking callback arguments in builder calls.
 */
export function isFunctionLikeExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

/** The way a function puts off running its own body. */
export type DeferredFunctionKind = "async" | "generator";

/**
 * Classifies a function whose body does not run to completion inside the call
 * that invokes it. An async function can resume after its caller has returned,
 * and a generator runs none of its body until something iterates the result.
 * An async generator counts as a generator, because calling it runs nothing.
 * Returns undefined for a function that runs synchronously.
 */
export function getDeferredFunctionKind(
  fn: ts.FunctionLikeDeclaration,
): DeferredFunctionKind | undefined {
  if (fn.asteriskToken) {
    return "generator";
  }

  const isAsync = (fn.modifiers ?? []).some((modifier) =>
    modifier.kind === ts.SyntaxKind.AsyncKeyword
  );
  return isAsync ? "async" : undefined;
}

export function getEnclosingFunctionLikeDeclaration(
  node: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}
