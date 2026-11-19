import ts from "typescript";

import {
  detectCallKind,
  getEnclosingFunctionLikeDeclaration,
} from "../ast/mod.ts";
import {
  isCommonFabricSymbol,
  resolvesToCommonFabricSymbol,
} from "@commonfabric/schema-generator/common-fabric-symbols";
import { unwrapExpression } from "../utils/expression.ts";
import { isBrandedCellType } from "./cell-type.ts";

export function isPatternFactoryCalleeExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const type = checker.getTypeAtLocation(unwrapExpression(expression));
  if (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0
  ) {
    return false;
  }

  const propertyNames = new Set(
    type.getProperties().map((property) => property.getName()),
  );
  return propertyNames.has("argumentSchema") &&
    propertyNames.has("resultSchema") &&
    !propertyNames.has("with");
}

export function returnsReactiveResult(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return isBrandedCellType(checker.getTypeAtLocation(expression), checker);
}

export function isPatternFactoryHelperExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols = new Set<ts.Symbol>(),
): boolean {
  return someResolvedHelperExpressionMatches(
    expression,
    checker,
    (target, nextSeenSymbols) =>
      ts.isCallExpression(target) &&
      (
        isPatternBuilderCall(target, checker) ||
        isPatternFactoryCalleeExpression(target.expression, checker) ||
        isPatternFactoryHelperExpression(
          target.expression,
          checker,
          nextSeenSymbols,
        )
      ),
    seenSymbols,
  );
}

function isPatternBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callKind = detectCallKind(call, checker);
  return callKind?.kind === "builder" && callKind.builderName === "pattern";
}

export function isStructuralReactiveFactoryExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols = new Set<ts.Symbol>(),
): boolean {
  return someResolvedHelperExpressionMatches(
    expression,
    checker,
    (target, nextSeenSymbols) => {
      if (!ts.isCallExpression(target)) {
        return false;
      }

      if (returnsReactiveResult(target, checker)) {
        return true;
      }

      if (isPatternFactoryCalleeExpression(target.expression, checker)) {
        return true;
      }

      const callKind = detectCallKind(target, checker);
      if (callKind) {
        switch (callKind.kind) {
          case "builder":
          case "lift-applied":
          case "cell-factory":
          case "cell-for":
          case "wish":
          case "generate-text":
          case "generate-object":
          case "pattern-tool":
          case "runtime-call":
            return true;
          default:
            break;
        }
      }

      return isStructuralReactiveFactoryExpression(
        target.expression,
        checker,
        nextSeenSymbols,
      );
    },
    seenSymbols,
  );
}

function isWishStateType(
  type: ts.Type,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  const symbols = [type.aliasSymbol, type.getSymbol()].filter(
    (symbol): symbol is ts.Symbol => !!symbol,
  );
  if (
    symbols.some((symbol) =>
      symbol.getName() === "WishState" && isCommonFabricSymbol(symbol)
    )
  ) {
    return true;
  }
  return (type.isUnion() || type.isIntersection()) &&
    type.types.some((member) => isWishStateType(member, seen));
}

/**
 * Follows local helper returns and callable aliases to determine whether calling
 * an expression creates a Wish factory node. Stored Wish values are not
 * followed: invoking a method on an existing Wish must not be mistaken for
 * creating another factory. The return-type check preserves fail-closed
 * behavior for external helpers whose implementation is unavailable.
 */
export function isWishFactoryExpression(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  seenSymbols = new Set<ts.Symbol>(),
): boolean {
  if (detectCallKind(expression, checker)?.kind === "wish") return true;
  if (isWishStateType(checker.getTypeAtLocation(expression))) {
    return !isProvenWishPassThrough(expression, checker, seenSymbols);
  }
  return wishFactoryHelperCallee(expression.expression, checker, seenSymbols);
}

/**
 * Proves that an invocation only returns a stored binding or delegates to
 * another pass-through. Arguments are binding reads or literals; property
 * reads, spreads, defaults, and destructuring have unproven evaluated effects.
 */
function isProvenWishPassThrough(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  if (
    !call.arguments.every((argument) => {
      const value = unwrapExpression(argument);
      return ts.isIdentifier(value) || ts.isLiteralExpression(value) ||
        value.kind === ts.SyntaxKind.TrueKeyword ||
        value.kind === ts.SyntaxKind.FalseKeyword ||
        value.kind === ts.SyntaxKind.NullKeyword;
    })
  ) return false;

  const callee = unwrapExpression(call.expression);
  if (!ts.isIdentifier(callee)) return false;
  const symbol = checker.getSymbolAtLocation(callee);
  if (!symbol) return false;
  const resolved = getAliasedSymbol(symbol, checker);
  if (seenSymbols.has(resolved)) return false;
  const nextSeen = new Set(seenSymbols);
  nextSeen.add(resolved);

  const declarations = resolved.getDeclarations() ?? [];
  const implemented = declarations.filter((declaration) =>
    ts.isVariableDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) && declaration.body !== undefined
  );
  if (implemented.length !== 1) return false;
  const declaration = implemented[0]!;
  if (hasCallableWrite(resolved, declaration.getSourceFile(), checker)) {
    return false;
  }
  let callable: ts.Node = declaration;
  if (ts.isVariableDeclaration(declaration)) {
    if (
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer
    ) return false;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isIdentifier(initializer)) {
      return isProvenWishPassThrough(
        ts.factory.updateCallExpression(
          call,
          initializer,
          call.typeArguments,
          call.arguments,
        ),
        checker,
        nextSeen,
      );
    }
    callable = initializer;
  }
  if (
    !(ts.isFunctionDeclaration(callable) || ts.isFunctionExpression(callable) ||
      ts.isArrowFunction(callable)) ||
    !callable.body ||
    callable.parameters.some((parameter) =>
      !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined
    )
  ) return false;
  const returned = getReturnedExpression(callable);
  if (!returned) return false;
  const value = unwrapExpression(returned);
  return ts.isIdentifier(value) ||
    ts.isCallExpression(value) &&
      isProvenWishPassThrough(value, checker, nextSeen);
}

/** Detects authored writes that invalidate a callable declaration's identity. */
function hasCallableWrite(
  symbol: ts.Symbol,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  return callableWrites(symbol, source, checker).length > 0;
}

function callableWrites(
  symbol: ts.Symbol,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): readonly ts.Node[] {
  const writes: ts.Node[] = [];
  const containsSymbol = (node: ts.Node): boolean =>
    ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol ||
    ts.isShorthandPropertyAssignment(node) &&
      checker.getShorthandAssignmentValueSymbol(node) === symbol ||
    ts.forEachChild(node, containsSymbol) === true;
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      containsSymbol(node.left)
    ) writes.push(node);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      containsSymbol(node.operand)
    ) writes.push(node);
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      containsSymbol(node.initializer)
    ) writes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

/** Selects only preceding straight-line callable assignments in the same block. */
function callableValueAtReference(
  declaration: ts.VariableDeclaration,
  reference: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
):
  | { kind: "selected"; expression: ts.Expression }
  | { kind: "ambiguous" }
  | undefined {
  const writes = callableWrites(symbol, declaration.getSourceFile(), checker);
  if (writes.length === 0) return undefined;
  const owner = getEnclosingFunctionLikeDeclaration(declaration);
  if (
    getEnclosingFunctionLikeDeclaration(reference) !== owner ||
    writes.some((write) => getEnclosingFunctionLikeDeclaration(write) !== owner)
  ) {
    return { kind: "ambiguous" };
  }
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) {
    return { kind: "ambiguous" };
  }
  const block = statement.parent;
  let use: ts.Node = reference;
  while (use.parent && use.parent !== block) use = use.parent;
  if (use.parent !== block) return { kind: "ambiguous" };
  const start = block.statements.indexOf(statement);
  const end = block.statements.findIndex((item) => item === use);
  if (end <= start) return { kind: "ambiguous" };
  const inside = (node: ts.Node, container: ts.Node): boolean => {
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    ) {
      if (current === container) return true;
    }
    return false;
  };
  if (writes.some((write) => inside(write, statement))) {
    return { kind: "ambiguous" };
  }
  let selected = declaration.initializer;
  let ambiguous = false;
  for (const item of block.statements.slice(start + 1, end)) {
    const changes = writes.filter((write) => inside(write, item));
    if (changes.length === 0) continue;
    const assignment = ts.isExpressionStatement(item)
      ? unwrapExpression(item.expression)
      : undefined;
    if (
      changes.length === 1 && assignment &&
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(assignment.left)) &&
      checker.getSymbolAtLocation(unwrapExpression(assignment.left)) === symbol
    ) {
      selected = assignment.right;
      ambiguous = false;
    } else {
      ambiguous = true;
    }
  }
  if (writes.some((write) => inside(write, use))) ambiguous = true;
  const candidate = selected && unwrapExpression(selected);
  if (
    candidate && !ts.isIdentifier(candidate) &&
    !ts.isArrowFunction(candidate) && !ts.isFunctionExpression(candidate)
  ) ambiguous = true;
  return ambiguous || !selected
    ? { kind: "ambiguous" }
    : { kind: "selected", expression: selected };
}

function wishFactoryHelperCallee(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const target = unwrapExpression(expression);
  if (ts.isCallExpression(target)) {
    return isWishFactoryExpression(target, checker, seenSymbols);
  }
  if (
    !ts.isIdentifier(target) &&
    !ts.isPropertyAccessExpression(target) &&
    !ts.isElementAccessExpression(target)
  ) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(target) ??
    (ts.isElementAccessExpression(target) &&
        ts.isStringLiteralLike(target.argumentExpression)
      ? checker.getTypeAtLocation(target.expression).getProperty(
        target.argumentExpression.text,
      )
      : undefined);
  if (!symbol) return false;
  if (resolvesToCommonFabricSymbol(symbol, checker, "wish")) return true;
  const resolvedSymbol = getAliasedSymbol(symbol, checker);
  if (seenSymbols.has(resolvedSymbol)) {
    return hasCallableWrite(resolvedSymbol, target.getSourceFile(), checker);
  }
  seenSymbols.add(resolvedSymbol);

  return (resolvedSymbol.getDeclarations() ?? []).some((declaration) => {
    if (
      ts.isBindingElement(declaration) &&
      hasCallableWrite(resolvedSymbol, declaration.getSourceFile(), checker)
    ) return true;
    if (ts.isVariableDeclaration(declaration)) {
      const current = callableValueAtReference(
        declaration,
        target,
        resolvedSymbol,
        checker,
      );
      if (current?.kind === "ambiguous") return true;
      if (current?.kind === "selected") {
        const candidate = unwrapExpression(current.expression);
        const returned =
          ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)
            ? getReturnedExpression(candidate)
            : candidate;
        return returned !== undefined &&
          returnedExpressionCreatesWish(returned, checker, seenSymbols);
      }
    }
    const returnedExpression = getReturnedExpression(declaration);
    if (returnedExpression) {
      return returnedExpressionCreatesWish(
        returnedExpression,
        checker,
        seenSymbols,
      );
    }
    return false;
  });
}

function returnedExpressionCreatesWish(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const target = unwrapExpression(expression);
  if (ts.isCallExpression(target)) {
    return isWishFactoryExpression(target, checker, seenSymbols);
  }
  if (
    (ts.isIdentifier(target) ||
      ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)) &&
    wishFactoryHelperCallee(target, checker, seenSymbols)
  ) {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    const receiver = unwrapExpression(target.expression);
    if (ts.isIdentifier(receiver)) return false;
    return returnedExpressionCreatesWish(
      receiver,
      checker,
      seenSymbols,
    );
  }
  return false;
}

function someResolvedHelperExpressionMatches(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  evaluateTarget: (
    target: ts.Expression,
    seenSymbols: Set<ts.Symbol>,
  ) => boolean,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const target = unwrapExpression(expression);
  if (evaluateTarget(target, seenSymbols)) {
    return true;
  }

  if (
    !ts.isIdentifier(target) &&
    !ts.isPropertyAccessExpression(target)
  ) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(target);
  if (!symbol) {
    return false;
  }

  const resolvedSymbol = getAliasedSymbol(symbol, checker);
  if (seenSymbols.has(resolvedSymbol)) {
    return false;
  }
  seenSymbols.add(resolvedSymbol);

  return (resolvedSymbol.getDeclarations() ?? []).some((declaration) => {
    const returnedExpression = getReturnedExpression(declaration);
    return !!returnedExpression &&
      someResolvedHelperExpressionMatches(
        returnedExpression,
        checker,
        evaluateTarget,
        seenSymbols,
      );
  });
}

function getAliasedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function getReturnedExpression(
  declaration: ts.Declaration,
): ts.Expression | undefined {
  if (ts.isPropertyAssignment(declaration)) {
    return declaration.initializer;
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration)
  ) {
    if (!declaration.body) {
      return undefined;
    }
    if (ts.isBlock(declaration.body)) {
      if (declaration.body.statements.length !== 1) {
        return undefined;
      }
      const [statement] = declaration.body.statements;
      return ts.isReturnStatement(statement) ? statement.expression : undefined;
    }
    return declaration.body;
  }

  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }

  const initializer = unwrapExpression(declaration.initializer);
  if (
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer)
  ) {
    return getReturnedExpression(initializer);
  }

  if (
    ts.isIdentifier(initializer) ||
    ts.isCallExpression(initializer) ||
    ts.isPropertyAccessExpression(initializer) ||
    ts.isElementAccessExpression(initializer)
  ) {
    return initializer;
  }

  return undefined;
}
