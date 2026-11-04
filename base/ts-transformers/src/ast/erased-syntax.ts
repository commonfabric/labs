import ts from "typescript";

/**
 * Whether `node`, and everything under it, is erased at emit, so that no name
 * written there refers to a runtime value: a type, an interface or type alias
 * declaration, a `const enum` declaration (each use of a member is replaced by
 * its value), an `implements` clause or an interface's `extends` clause, a
 * class's index signature, and a declaration with no body (an overload
 * signature or an abstract member).
 *
 * `ExpressionWithTypeArguments` is the one type node that can hold a value.
 * The expression of a class's `extends` clause, and of an instantiation
 * expression such as `factory<string>`, is evaluated; only its type arguments
 * are erased, and each of those is a type node of its own.
 */
export function isErasedAtEmit(node: ts.Node): boolean {
  if (ts.isExpressionWithTypeArguments(node)) {
    const clause = node.parent;
    return clause !== undefined && ts.isHeritageClause(clause) &&
      (clause.token === ts.SyntaxKind.ImplementsKeyword ||
        ts.isInterfaceDeclaration(clause.parent));
  }
  if (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isIndexSignatureDeclaration(node)
  ) {
    return true;
  }
  if (ts.isEnumDeclaration(node)) {
    return ts.getModifiers(node)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ConstKeyword
    ) ?? false;
  }
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isAccessor(node)) &&
    node.body === undefined;
}

/**
 * Whether every declaration of `symbol` is erased at emit, so that no runtime
 * binding carries the name: a `const enum`, whose uses become the member's
 * value, or a declaration that names a type only.
 */
export function hasOnlyErasedDeclarations(symbol: ts.Symbol): boolean {
  const declarations = symbol.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every(isErasedAtEmit);
}
