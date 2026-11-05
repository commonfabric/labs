import ts from "typescript";

export type StaticJsonValue =
  | null
  | boolean
  | number
  | string
  | StaticJsonValue[]
  | { [key: string]: StaticJsonValue };

export type StaticJsonResult =
  | { readonly resolved: true; readonly value: StaticJsonValue }
  | { readonly resolved: false };

/**
 * Resolve a compiler-recognized expression through proven-stable const aliases.
 *
 * Unlike `evaluateStaticJson`, this does not interpret the terminal expression.
 * It is used for compiler intrinsics such as `toSchema<T>()`, whose result is
 * produced by the compiler rather than by executing authored JavaScript.
 */
export function resolveStableConstExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.Expression | undefined {
  const node = unwrap(expression);
  if (!ts.isIdentifier(node)) return node;

  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  const activeSymbol = symbol;
  seenSymbols.add(activeSymbol);
  try {
    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    for (const declaration of symbol.getDeclarations() ?? []) {
      if (
        !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
        !isStableConstJsonBinding(symbol, declaration, checker, new Set())
      ) {
        continue;
      }
      return resolveStableConstExpression(
        declaration.initializer,
        checker,
        seenSymbols,
      );
    }
    return undefined;
  } finally {
    seenSymbols.delete(activeSymbol);
  }
}

/**
 * Read a JSON-compatible compiler constant without executing authored code.
 *
 * This is deliberately narrower than JavaScript evaluation. It follows const
 * bindings and transparent TypeScript wrappers, and accepts object/array
 * literals (including statically resolvable spreads). Calls, getters, methods,
 * mutable bindings, and other executable expressions remain unresolved.
 */
export function evaluateStaticJson(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenNodes: Set<ts.Node> = new Set(),
  seenSymbols: Set<ts.Symbol> = new Set(),
): StaticJsonResult {
  const node = unwrap(expression);
  const original = ts.getOriginalNode(node);
  if (seenNodes.has(node) || seenNodes.has(original)) {
    return { resolved: false };
  }
  seenNodes.add(node);
  seenNodes.add(original);
  try {
    if (ts.isStringLiteralLike(node)) {
      return { resolved: true, value: node.text };
    }
    if (ts.isNumericLiteral(node)) {
      return { resolved: true, value: Number(node.text) };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return { resolved: true, value: true };
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return { resolved: true, value: false };
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) {
      return { resolved: true, value: null };
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken ||
        node.operator === ts.SyntaxKind.PlusToken)
    ) {
      const operand = evaluateStaticJson(
        node.operand,
        checker,
        seenNodes,
        seenSymbols,
      );
      if (!operand.resolved || typeof operand.value !== "number") {
        return { resolved: false };
      }
      return {
        resolved: true,
        value: node.operator === ts.SyntaxKind.MinusToken
          ? -operand.value
          : operand.value,
      };
    }
    if (ts.isArrayLiteralExpression(node)) {
      const result: StaticJsonValue[] = [];
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) return { resolved: false };
        if (ts.isSpreadElement(element)) {
          const spread = evaluateStaticJson(
            element.expression,
            checker,
            seenNodes,
            seenSymbols,
          );
          if (!spread.resolved || !Array.isArray(spread.value)) {
            return { resolved: false };
          }
          for (const item of spread.value) result.push(item);
          continue;
        }
        const value = evaluateStaticJson(
          element,
          checker,
          seenNodes,
          seenSymbols,
        );
        if (!value.resolved) return value;
        result.push(value.value);
      }
      return { resolved: true, value: result };
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, StaticJsonValue> = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluateStaticJson(
            property.expression,
            checker,
            seenNodes,
            seenSymbols,
          );
          if (
            !spread.resolved || Array.isArray(spread.value) ||
            spread.value === null || typeof spread.value !== "object"
          ) {
            return { resolved: false };
          }
          Object.assign(result, spread.value);
          continue;
        }

        const name = propertyName(property.name, checker);
        if (name === undefined) return { resolved: false };
        const initializer = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
        if (!initializer) return { resolved: false };
        const value = evaluateStaticJson(
          initializer,
          checker,
          seenNodes,
          seenSymbols,
        );
        if (!value.resolved) return value;
        result[name] = value.value;
      }
      return { resolved: true, value: result };
    }
    if (isTrustedSchemaIdentityCall(node, checker)) {
      return evaluateStaticJson(
        node.arguments[0]!,
        checker,
        seenNodes,
        seenSymbols,
      );
    }
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seenSymbols.has(symbol)) return { resolved: false };
      const activeSymbol = symbol;
      seenSymbols.add(activeSymbol);
      try {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        for (const declaration of symbol.getDeclarations() ?? []) {
          if (
            ts.isVariableDeclaration(declaration) && declaration.initializer &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0
          ) {
            if (
              !isStableConstJsonBinding(
                symbol,
                declaration,
                checker,
                new Set(),
              )
            ) {
              return { resolved: false };
            }
            return evaluateStaticJson(
              declaration.initializer,
              checker,
              seenNodes,
              seenSymbols,
            );
          }
          if (
            ts.isPropertyAssignment(declaration) ||
            ts.isShorthandPropertyAssignment(declaration)
          ) {
            const initializer = ts.isPropertyAssignment(declaration)
              ? declaration.initializer
              : declaration.name;
            return evaluateStaticJson(
              initializer,
              checker,
              seenNodes,
              seenSymbols,
            );
          }
        }
      } finally {
        seenSymbols.delete(activeSymbol);
      }
    }

    const constant = checker.getConstantValue(
      node as ts.PropertyAccessExpression | ts.ElementAccessExpression,
    );
    return typeof constant === "string" || typeof constant === "number"
      ? { resolved: true, value: constant }
      : { resolved: false };
  } finally {
    seenNodes.delete(node);
    seenNodes.delete(original);
  }
}

function isStableConstJsonBinding(
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  visiting: Set<ts.Symbol>,
): boolean {
  if (
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    (isExportedVariable(declaration) &&
      !isTrustedSchemaIdentityCall(declaration.initializer, checker))
  ) {
    return false;
  }
  if (visiting.has(symbol)) return false;
  visiting.add(symbol);
  try {
    let stable = true;
    const visit = (node: ts.Node): void => {
      if (!stable) return;
      if (ts.isIdentifier(node)) {
        if (isTypeOnlyReference(node)) return;
        const reference = canonicalSymbolAt(node, checker);
        if (reference === symbol && node !== declaration.name) {
          if (isTrustedFactorySchemaArgument(node, checker)) return;
          const consumer = containingConstInitializer(node);
          if (!consumer || consumer === declaration) {
            stable = false;
            return;
          }
          const consumerSymbol = ts.isIdentifier(consumer.name)
            ? canonicalSymbolAt(consumer.name, checker)
            : undefined;
          if (
            !consumerSymbol ||
            !isStableConstJsonBinding(
              consumerSymbol,
              consumer,
              checker,
              visiting,
            )
          ) {
            stable = false;
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
    return stable;
  } finally {
    visiting.delete(symbol);
  }
}

/**
 * `schema(literal)` is the public frozen-data identity helper. Recognizing its
 * syntax does not execute authored code; it exposes the literal argument to
 * the same static JSON evaluator while allowing the frozen result to be
 * exported safely.
 */
function isTrustedSchemaIdentityCall(
  node: ts.Node | undefined,
  checker: ts.TypeChecker,
): node is ts.CallExpression {
  if (!node || !ts.isCallExpression(node) || node.arguments.length !== 1) {
    return false;
  }
  const callee = unwrap(node.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "__cfHelpers" && callee.name.text === "schema"
  ) {
    return true;
  }
  if (!ts.isIdentifier(callee)) return false;
  const symbol = checker.getSymbolAtLocation(callee);
  return symbol?.declarations?.some((candidate) => {
    if (!ts.isImportSpecifier(candidate)) return false;
    const importDeclaration = candidate.parent.parent.parent;
    return ts.isImportDeclaration(importDeclaration) &&
      ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
      importDeclaration.moduleSpecifier.text === "commonfabric" &&
      (candidate.propertyName ?? candidate.name).text === "schema";
  }) ?? false;
}

function isTypeOnlyReference(node: ts.Identifier): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function isExportedVariable(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement) &&
    !!statement.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword ||
      modifier.kind === ts.SyntaxKind.DefaultKeyword
    );
}

function canonicalSymbolAt(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function containingConstInitializer(
  reference: ts.Identifier,
): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = reference;
  while (current?.parent) {
    const parent: ts.Node = current.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return ts.isVariableDeclarationList(parent.parent) &&
          (parent.parent.flags & ts.NodeFlags.Const) !== 0
        ? parent
        : undefined;
    }
    if (
      ts.isStatement(parent) || ts.isFunctionLike(parent) ||
      ts.isClassLike(parent)
    ) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

function isTrustedFactorySchemaArgument(
  reference: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  let expression: ts.Expression = reference;
  while (
    expression.parent && isTransparentExpressionParent(expression.parent) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const call = expression.parent;
  if (!ts.isCallExpression(call)) return false;
  const argumentIndex = call.arguments.indexOf(expression);
  if (argumentIndex < 0) return false;

  const callee = unwrap(call.expression);
  let builderName: string | undefined;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "__cfHelpers"
  ) {
    builderName = callee.name.text;
  } else {
    if (!ts.isIdentifier(callee)) return false;
    const symbol = checker.getSymbolAtLocation(callee);
    const importedBuilder = symbol?.declarations?.find((candidate) => {
      if (!ts.isImportSpecifier(candidate)) return false;
      const importDeclaration = candidate.parent.parent.parent;
      return ts.isImportDeclaration(importDeclaration) &&
        ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
        importDeclaration.moduleSpecifier.text === "commonfabric";
    });
    if (!importedBuilder || !ts.isImportSpecifier(importedBuilder)) {
      return false;
    }
    builderName = (importedBuilder.propertyName ?? importedBuilder.name).text;
  }

  return builderName === "pattern"
    ? argumentIndex === 1 || argumentIndex === 2
    : builderName === "lift"
    ? argumentIndex === 1 || argumentIndex === 2
    : builderName === "handler"
    ? argumentIndex === 0 || argumentIndex === 1
    : false;
}

function isTransparentExpressionParent(
  node: ts.Node,
): node is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.PartiallyEmittedExpression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) || ts.isPartiallyEmittedExpression(node);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) ||
      ts.isPartiallyEmittedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function propertyName(
  name: ts.PropertyName | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const value = evaluateStaticJson(name.expression, checker);
    return value.resolved &&
        (typeof value.value === "string" || typeof value.value === "number")
      ? String(value.value)
      : undefined;
  }
  return undefined;
}
