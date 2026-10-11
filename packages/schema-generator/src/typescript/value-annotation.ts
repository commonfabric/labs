/**
 * The annotation a read of a value is written with. A print of a type spells
 * a `typeof` binding as the structural type of the value it names, from which
 * no reader can tell the binding, so a reader that has the expression a value
 * is read from reads the binding from the annotation of the declaration that
 * expression reads, where that annotation denotes the type at hand.
 */

import ts from "typescript";

import { denotesSameType, readMemberAnnotation } from "./type-node.ts";

/**
 * Whether authored type syntax names a value binding (`typeof handler`)
 * instead of just a shape: in the node itself, in anything it holds, or in a
 * type alias or interface it refers to by name, through any import binding.
 * A generic alias is read without substituting its parameters, since the
 * question is only whether a `typeof` is written anywhere the reference
 * reaches; the reference's own arguments are read as the nodes it holds.
 *
 * Only declarations in authored modules are followed. A writer binding names
 * a value in authored code, so an alias that carries one is authored too, and
 * a declaration file's `typeof` (a brand key, say) names no writer.
 */
export function namesValueBinding(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): boolean {
  if (ts.isTypeQueryNode(node)) return true;
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName)
      ? node.typeName
      : node.typeName.right;
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    for (const declaration of symbol?.declarations ?? []) {
      if (
        !(ts.isTypeAliasDeclaration(declaration) ||
          ts.isInterfaceDeclaration(declaration)) ||
        declaration.getSourceFile().isDeclarationFile ||
        seen.has(declaration)
      ) continue;
      seen.add(declaration);
      if (namesValueBinding(declaration, checker, seen)) return true;
    }
  }
  return ts.forEachChild(
    node,
    (child) => namesValueBinding(child, checker, seen) || undefined,
  ) === true;
}

/**
 * The symbol of the value `identifier` reads. Written as a shorthand property
 * (`{ x }`), the identifier's own symbol is the property of the object literal
 * it writes, which declares nothing about the value; the value's symbol is the
 * binding `x` names.
 */
export function readValueSymbol(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol?.valueDeclaration &&
      ts.isShorthandPropertyAssignment(symbol.valueDeclaration)
    ? checker.getShorthandAssignmentValueSymbol(symbol.valueDeclaration) ??
      symbol
    : symbol;
}

/**
 * The property of a destructured aggregate that `identifier`, a binding the
 * destructuring declares, reads, or `undefined` for any other identifier. A
 * `{ x }` shorthand resolves to a value symbol, and the binding element keeps
 * none of the property's own flags, so what the property declares is read
 * from the aggregate's type. For a renamed binding (`{ source: local }`) the
 * property is the SOURCE one. The source key may be an identifier, string, or
 * numeric literal (`{ "k": local }`, `{ 0: local }`). A computed key
 * (`{ [expr]: local }`) is not statically resolvable, and a rest binding
 * (`{ ...local }`) reads no one property, so neither names one.
 */
export function destructuredSourceProperty(
  identifier: ts.Identifier,
  localName: string,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const binding = readValueSymbol(identifier, checker)?.valueDeclaration;
  if (
    !binding || !ts.isBindingElement(binding) ||
    !ts.isObjectBindingPattern(binding.parent)
  ) {
    return undefined;
  }
  const host = binding.parent.parent;
  const aggregateType = ts.isParameter(host)
    ? checker.getTypeAtLocation(host)
    : ts.isVariableDeclaration(host) && host.initializer
    ? checker.getTypeAtLocation(host.initializer)
    : undefined;
  const key = binding.propertyName;
  const sourceName = !key
    ? binding.dotDotDotToken ? undefined : localName
    : ts.isIdentifier(key) || ts.isStringLiteralLike(key) ||
        ts.isNumericLiteral(key)
    ? key.text
    : undefined;
  return sourceName === undefined
    ? undefined
    : aggregateType?.getProperty(sourceName);
}

/**
 * The node `symbol`'s declaration writes its type with, where it writes one:
 * the node schema generation reads a property through.
 */
export function declaredTypeNode(
  symbol: ts.Symbol | undefined,
): ts.TypeNode | undefined {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isVariableDeclaration(declaration))
    ? declaration.type
    : undefined;
}

/**
 * The symbol whose declaration spells the value `expression` reads, where it
 * reads one by name: the property of a destructured aggregate that a binding
 * reads (`destructuredSourceProperty()`), else the binding an identifier
 * names, or the member a property access names.
 */
export function readDeclaringSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (ts.isIdentifier(expression)) {
    return destructuredSourceProperty(expression, expression.text, checker) ??
      readValueSymbol(expression, checker);
  }
  return ts.isPropertyAccessExpression(expression)
    ? checker.getSymbolAtLocation(expression.name)
    : undefined;
}

/**
 * The annotation `declaring`'s declaration writes, where it denotes `type`,
 * the type the value is read at, and names a value binding
 * (`namesValueBinding()`), or `undefined` otherwise. A reader that has only
 * `type` reads such a value at this annotation in its place, as it reads a
 * member at the annotation its declaration writes.
 */
export function readBindingAnnotation(
  declaring: ts.Symbol | undefined,
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (!declaring) return undefined;
  const declared = declaredTypeNode(declaring);
  const annotation = readMemberAnnotation(declaring, type, checker) ??
    (declared && denotesSameType(checker.getTypeFromTypeNode(declared), type)
      ? declared
      : undefined);
  return annotation && namesValueBinding(annotation, checker)
    ? annotation
    : undefined;
}
