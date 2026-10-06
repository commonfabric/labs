import ts from "typescript";

import { isSafeIdentifierText } from "../utils/identifiers.ts";

type StaticBindingAccessSegment =
  | { readonly kind: "property"; readonly text: string }
  | { readonly kind: "index"; readonly text: string };

export function getStaticPropertyNameText(
  name: ts.PropertyName,
): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (
    ts.isStringLiteral(name) || ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  const declarationList = declaration.parent;
  return ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & ts.NodeFlags.Const) !== 0;
}

function enclosingConstVariableDeclaration(
  node: ts.Node | undefined,
): ts.VariableDeclaration | undefined {
  let current = node;
  while (current) {
    if (ts.isVariableDeclaration(current)) {
      return isConstVariableDeclaration(current) ? current : undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function objectBindingAccessSegment(
  element: ts.BindingElement,
): StaticBindingAccessSegment | undefined {
  if (!element.propertyName) {
    return ts.isIdentifier(element.name)
      ? { kind: "property", text: element.name.text }
      : undefined;
  }
  const text = getStaticPropertyNameText(element.propertyName);
  return text === undefined ? undefined : { kind: "property", text };
}

function bindingElementStaticAccessPath(
  element: ts.BindingElement,
): readonly StaticBindingAccessSegment[] | undefined {
  const path: StaticBindingAccessSegment[] = [];
  let current: ts.BindingElement | undefined = element;

  while (current) {
    if (current.dotDotDotToken || current.initializer) return undefined;

    const parentPattern: ts.Node = current.parent;
    if (ts.isObjectBindingPattern(parentPattern)) {
      const segment = objectBindingAccessSegment(current);
      if (!segment) return undefined;
      path.unshift(segment);
    } else if (ts.isArrayBindingPattern(parentPattern)) {
      const index = parentPattern.elements.indexOf(current);
      if (index < 0) return undefined;
      path.unshift({ kind: "index", text: String(index) });
    } else {
      return undefined;
    }

    const owner: ts.Node = parentPattern.parent;
    if (ts.isVariableDeclaration(owner)) return path;
    if (!ts.isBindingElement(owner)) return undefined;
    current = owner;
  }
  return undefined;
}

function createStaticBindingAccessExpression(
  root: ts.Expression,
  path: readonly StaticBindingAccessSegment[],
  factory: ts.NodeFactory,
): ts.Expression {
  let current = root;
  for (const segment of path) {
    if (segment.kind === "index") {
      current = factory.createElementAccessExpression(
        current,
        factory.createNumericLiteral(segment.text),
      );
    } else if (isSafeIdentifierText(segment.text)) {
      current = factory.createPropertyAccessExpression(current, segment.text);
    } else if (/^\d+$/.test(segment.text)) {
      current = factory.createElementAccessExpression(
        current,
        factory.createNumericLiteral(segment.text),
      );
    } else {
      current = factory.createElementAccessExpression(
        current,
        factory.createStringLiteral(segment.text),
      );
    }
  }
  return current;
}

/**
 * Resolve a stable const binding to its initializer, reconstructing static
 * object and array destructuring paths as property access expressions.
 */
export function getStableConstAliasInitializer(
  symbol: ts.Symbol | undefined,
  factory: ts.NodeFactory = ts.factory,
  normalizeRoot: (expression: ts.Expression) => ts.Expression = (value) =>
    value,
): ts.Expression | undefined {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;

  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) && declaration.initializer &&
    isConstVariableDeclaration(declaration)
  ) {
    return declaration.initializer;
  }

  if (
    !ts.isBindingElement(declaration) || !ts.isIdentifier(declaration.name)
  ) {
    return undefined;
  }
  const variableDeclaration = enclosingConstVariableDeclaration(declaration);
  if (!variableDeclaration?.initializer) return undefined;

  const path = bindingElementStaticAccessPath(declaration);
  return path
    ? createStaticBindingAccessExpression(
      normalizeRoot(variableDeclaration.initializer),
      path,
      factory,
    )
    : undefined;
}
