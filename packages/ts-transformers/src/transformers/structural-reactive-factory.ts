import ts from "typescript";

import { detectCallKind } from "../ast/mod.ts";
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
  const target = unwrapExpression(expression);

  try {
    const type = checker.getTypeAtLocation(target);
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (signatures.length === 0) {
      return false;
    }

    const propertyNames = new Set(
      type.getProperties().map((property) => property.getName()),
    );
    if (
      !propertyNames.has("argumentSchema") ||
      !propertyNames.has("resultSchema") ||
      propertyNames.has("with")
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function returnsReactiveResult(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  try {
    const type = checker.getTypeAtLocation(expression);
    return isBrandedCellType(type, checker);
  } catch {
    return false;
  }
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
 * Follow local helper returns and callable aliases to determine whether calling
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
  if (isWishStateType(checker.getTypeAtLocation(expression))) return true;
  return wishFactoryHelperCallee(expression.expression, checker, seenSymbols);
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
  if (seenSymbols.has(resolvedSymbol)) return false;
  seenSymbols.add(resolvedSymbol);

  return (resolvedSymbol.getDeclarations() ?? []).some((declaration) => {
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
  if (!(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol;
  }

  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
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
