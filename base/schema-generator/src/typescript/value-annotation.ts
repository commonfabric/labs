/**
 * The annotation a read of a value is written with. A print of a type spells
 * a `typeof` binding as the structural type of the value it names, from which
 * no reader can tell the binding, so a reader that has the expression a value
 * is read from reads the binding from the annotation of the declaration that
 * expression reads, where that annotation denotes the type at hand.
 */

import ts from "typescript";

import { resolveAliasedSymbol } from "./literal-value.ts";
import { denotesSameType, readMemberAnnotation } from "./type-node.ts";

/**
 * The member `PolicyOf<Rules>` is: `{ readonly __ct_cfc_policy_of__?: Rules }`
 * (`@commonfabric/api/cfc`).
 */
export const CFC_POLICY_OF_BRAND = "__ct_cfc_policy_of__";

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
 * Whether every value binding `node` names, read as `namesValueBinding()`
 * reads it, is the rules a `PolicyOf<typeof rules>` names: no `typeof`
 * outside a `PolicyOf`, which is how a writer is named. Such a node names
 * confidentiality policies, and no writer policy.
 */
export function namesOnlyPolicyBindings(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): boolean {
  if (ts.isTypeQueryNode(node)) return false;
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName)
      ? node.typeName
      : node.typeName.right;
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    // `PolicyOf` is recognized by its brand, as the label reader recognizes
    // it, so an author's alias of that name is walked as any other.
    const declared = symbol &&
      checker.getDeclaredTypeOfSymbol(resolveAliasedSymbol(symbol, checker));
    const properties = declared && (declared.flags & ts.TypeFlags.Object)
      ? checker.getPropertiesOfType(declared)
      : [];
    if (
      properties.length === 1 && properties[0]!.name === CFC_POLICY_OF_BRAND
    ) {
      return true;
    }
    for (const declaration of symbol?.declarations ?? []) {
      if (
        !(ts.isTypeAliasDeclaration(declaration) ||
          ts.isInterfaceDeclaration(declaration)) ||
        declaration.getSourceFile().isDeclarationFile ||
        seen.has(declaration)
      ) continue;
      seen.add(declaration);
      if (!namesOnlyPolicyBindings(declaration, checker, seen)) return false;
    }
  }
  return ts.forEachChild(
    node,
    (child) => namesOnlyPolicyBindings(child, checker, seen) ? undefined : true,
  ) !== true;
}

/**
 * Whether `a` and `b`, two annotations, spell one value: the same node, or
 * two nodes that denote one type and name the same value bindings in the
 * same order, as two members each declared `Secret` do. The type alone does
 * not settle it: `PolicyOf<typeof readers>` and `PolicyOf<typeof writers>`
 * denote one type where the two rules share one. Bindings are read as
 * `namesValueBinding()` reads them, through aliases declared in authored
 * modules; a `typeof` whose binding does not resolve, as one in a node built
 * without positions does not, leaves the two incomparable, so `false`.
 * `typeOf` resolves a node's type, for a caller holding nodes the checker
 * does not resolve on its own.
 */
export function spellSameValue(
  a: ts.TypeNode,
  b: ts.TypeNode,
  checker: ts.TypeChecker,
  typeOf: (node: ts.TypeNode) => ts.Type = (node) =>
    checker.getTypeFromTypeNode(node),
): boolean {
  if (a === b) return true;
  if (!denotesSameType(typeOf(a), typeOf(b))) return false;
  const bound = namedBindings(a, checker);
  const other = namedBindings(b, checker);
  return bound !== undefined && other !== undefined &&
    bound.length === other.length &&
    bound.every((symbol, index) => symbol === other[index]);
}

/**
 * The value bindings `node` names, in order, read as `namesValueBinding()`
 * reads them, or `undefined` where one does not resolve.
 */
function namedBindings(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): ts.Symbol[] | undefined {
  if (ts.isTypeQueryNode(node)) {
    const name = ts.isIdentifier(node.exprName)
      ? node.exprName
      : node.exprName.right;
    const symbol = checker.getSymbolAtLocation(name);
    return symbol ? [resolveAliasedSymbol(symbol, checker)] : undefined;
  }
  const found: ts.Symbol[] = [];
  let unresolved = false;
  const collect = (part: ts.Node): void => {
    const within = namedBindings(part, checker, seen);
    if (within) {
      for (const bound of within) found.push(bound);
    } else {
      unresolved = true;
    }
  };
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
      collect(declaration);
    }
  }
  ts.forEachChild(node, collect);
  return unresolved ? undefined : found;
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
  // The pattern's type is the aggregate it destructures, at any depth of a
  // nested pattern (`{ nested: { x } }`).
  const aggregateType = checker.getTypeAtLocation(binding.parent);
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
 * the node schema generation reads a property through. A getter writes the
 * type it returns.
 */
export function declaredTypeNode(
  symbol: ts.Symbol | undefined,
): ts.TypeNode | undefined {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isGetAccessorDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isVariableDeclaration(declaration))
    ? declaration.type
    : undefined;
}

/**
 * The symbol whose declaration spells the value `written` reads, where it
 * reads one by name, inside any parentheses: the property of a destructured
 * aggregate that a binding reads (`destructuredSourceProperty()`), else the
 * binding an identifier names, or the member a property access names.
 */
export function readDeclaringSymbol(
  written: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  let expression = written;
  while (ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
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
