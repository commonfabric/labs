/**
 * Cast Validation Transformer
 *
 * Validates type assertions (casts) and reports diagnostics for problematic patterns:
 * - `as unknown as X` (double-cast): ERROR - bypasses type safety
 * - `as Reactive<...>`: ERROR - framework handles Reactive wrapping automatically
 * - `as Cell<...>` and other cell-like types: ERROR - prefer proper type annotations
 */

import ts from "typescript";
import { unwrapTypeParentheses } from "@commonfabric/schema-generator/type-node";
import { spellingsWhere } from "@commonfabric/schema-generator/wrapper-names";
import {
  getImportTypeModuleName,
  HelpersOnlyTransformer,
  isCommonFabricDeclaration,
  isCommonFabricModuleName,
  TransformationContext,
} from "../core/mod.ts";

/**
 * Cell-like types that should trigger an error when cast to.
 * These types have special reactive semantics that casts can bypass.
 */
const CELL_LIKE_TYPE_NAMES = spellingsWhere({
  Cell: true,
  OpaqueCell: true,
  Stream: true,
  ComparableCell: true,
  ReadonlyCell: true,
  WriteonlyCell: true,
  Writable: true,
  CellTypeConstructor: true,
  ScopedCellTypeConstructor: false,
  SqliteDb: false,
  Reactive: false, // error, not warning — see FORBIDDEN_CAST_TYPE_NAMES
});

/**
 * Types that should trigger an error when cast to.
 * Casting to these types is never allowed.
 */
const FORBIDDEN_CAST_TYPE_NAMES = spellingsWhere({
  Reactive: true,
  Cell: false,
  Writable: false,
  ReadonlyCell: false,
  WriteonlyCell: false,
  ComparableCell: false,
  OpaqueCell: false,
  Stream: false,
  SqliteDb: false,
  CellTypeConstructor: false,
  ScopedCellTypeConstructor: false,
});

type CastTargetClassification =
  | { kind: "forbidden"; typeName: string }
  | { kind: "cellLike"; typeName: string };

export class CastValidationTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit = (node: ts.Node): ts.Node => {
      // Check for type assertions (both `as X` and `<X>` syntax)
      if (ts.isAsExpression(node)) {
        this.#validateAsExpression(node, context);
      } else if (ts.isTypeAssertionExpression(node)) {
        this.#validateTypeAssertion(node, context);
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  #validateAsExpression(
    node: ts.AsExpression,
    context: TransformationContext,
  ): void {
    // Check for double-cast pattern: `as unknown as X`
    if (this.#isDoubleUnknownCast(node)) {
      context.reportDiagnostic({
        severity: "error",
        type: "cast-validation:double-unknown",
        message: "Double-casting via 'as unknown as' is not allowed. " +
          "Casts bypass reactive tracking and type safety.",
        node,
      });
      return;
    }

    // Check the target type of the cast
    this.#validateCastTargetType(node.type, node, context);
  }

  #validateTypeAssertion(
    node: ts.TypeAssertion,
    context: TransformationContext,
  ): void {
    // Check for double-cast pattern with angle bracket syntax: `<X><unknown>expr`
    if (this.#isDoubleUnknownTypeAssertion(node)) {
      context.reportDiagnostic({
        severity: "error",
        type: "cast-validation:double-unknown",
        message: "Double-casting via '<unknown>' is not allowed. " +
          "Casts bypass reactive tracking and type safety.",
        node,
      });
      return;
    }

    // Check the target type of the cast
    this.#validateCastTargetType(node.type, node, context);
  }

  /**
   * Checks if this is a double-cast pattern: `expr as unknown as X`
   * Also handles mixed syntax: `(<unknown>expr) as X`
   */
  #isDoubleUnknownCast(node: ts.AsExpression): boolean {
    // Check if inner expression is an `as` expression casting to `unknown`
    if (ts.isAsExpression(node.expression)) {
      const innerType = node.expression.type;
      return this.#isUnknownType(innerType);
    }
    // Check for mixed syntax: `(<unknown>expr) as X`
    if (ts.isTypeAssertionExpression(node.expression)) {
      const innerType = node.expression.type;
      return this.#isUnknownType(innerType);
    }
    // Check for parenthesized expressions: `(expr as unknown) as X`
    if (ts.isParenthesizedExpression(node.expression)) {
      const inner = node.expression.expression;
      if (ts.isAsExpression(inner) && this.#isUnknownType(inner.type)) {
        return true;
      }
      if (
        ts.isTypeAssertionExpression(inner) && this.#isUnknownType(inner.type)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if this is a double-cast with angle bracket syntax: `<X><unknown>expr`
   * Also handles mixed syntax: `<X>(expr as unknown)`
   */
  #isDoubleUnknownTypeAssertion(
    node: ts.TypeAssertion,
  ): boolean {
    // Check for angle bracket inner: `<X><unknown>expr`
    if (ts.isTypeAssertionExpression(node.expression)) {
      const innerType = node.expression.type;
      return this.#isUnknownType(innerType);
    }
    // Check for mixed syntax: `<X>(expr as unknown)`
    if (ts.isAsExpression(node.expression)) {
      const innerType = node.expression.type;
      return this.#isUnknownType(innerType);
    }
    // Check for parenthesized expressions
    if (ts.isParenthesizedExpression(node.expression)) {
      const inner = node.expression.expression;
      if (ts.isAsExpression(inner) && this.#isUnknownType(inner.type)) {
        return true;
      }
      if (
        ts.isTypeAssertionExpression(inner) && this.#isUnknownType(inner.type)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if a type node represents the `unknown` type
   */
  #isUnknownType(typeNode: ts.TypeNode): boolean {
    return (
      typeNode.kind === ts.SyntaxKind.UnknownKeyword ||
      (ts.isTypeReferenceNode(typeNode) &&
        ts.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === "unknown")
    );
  }

  /**
   * Validates the target type of a cast and reports appropriate diagnostics
   */
  #validateCastTargetType(
    typeNode: ts.TypeNode,
    castNode: ts.Node,
    context: TransformationContext,
  ): void {
    const typeNames = this.#extractTypeNames(typeNode, context);
    const classification = this.#classifyCastTarget(typeNames);
    if (!classification) return;

    if (classification.kind === "forbidden") {
      context.reportDiagnostic({
        severity: "error",
        type: "cast-validation:forbidden-cast",
        message: `Casting to '${classification.typeName}<>' is not allowed. ` +
          "The framework handles this type conversion automatically.",
        node: castNode,
      });
      return;
    }

    context.reportDiagnostic({
      severity: "error",
      type: "cast-validation:cell-cast",
      message: `Casting to '${classification.typeName}<>' is not allowed. ` +
        "Use a type annotation instead.",
      node: castNode,
    });
  }

  #classifyCastTarget(
    typeNames: readonly string[],
  ): CastTargetClassification | undefined {
    const forbiddenTypeName = typeNames.find((typeName) =>
      FORBIDDEN_CAST_TYPE_NAMES.has(typeName)
    );
    if (forbiddenTypeName) {
      return { kind: "forbidden", typeName: forbiddenTypeName };
    }

    const cellLikeTypeName = typeNames.find((typeName) =>
      CELL_LIKE_TYPE_NAMES.has(typeName)
    );
    if (cellLikeTypeName) {
      return { kind: "cellLike", typeName: cellLikeTypeName };
    }

    return undefined;
  }

  /**
   * Extracts wrapper names from a cast target.
   * For example, `Cell<number>` returns "Cell".
   * A nested type like `Cell<number> | undefined` returns "Cell".
   */
  #extractTypeNames(
    typeNode: ts.TypeNode,
    context: TransformationContext,
    seenSymbols = new Set<ts.Symbol>(),
  ): string[] {
    const names = new Set<string>();

    const visit = (node: ts.TypeNode): void => {
      const unwrapped = unwrapTypeParentheses(node);
      if (
        ts.isUnionTypeNode(unwrapped) || ts.isIntersectionTypeNode(unwrapped)
      ) {
        for (const child of unwrapped.types) visit(child);
        return;
      }
      const name = this.#extractTypeReferenceName(
        unwrapped,
        context,
        seenSymbols,
      );
      if (name) names.add(name);
    };

    visit(typeNode);
    return [...names];
  }

  #extractTypeReferenceName(
    typeNode: ts.TypeNode,
    context: TransformationContext,
    seenSymbols: Set<ts.Symbol>,
  ): string | undefined {
    if (ts.isTypeReferenceNode(typeNode)) {
      return this.#resolveWrapperTypeName(
        typeNode.typeName,
        context,
        seenSymbols,
      );
    }
    if (ts.isImportTypeNode(typeNode)) {
      return this.#resolveImportTypeName(typeNode);
    }
    return undefined;
  }

  #resolveImportTypeName(
    typeNode: ts.ImportTypeNode,
  ): string | undefined {
    const qualifier = typeNode.qualifier;
    const moduleName = getImportTypeModuleName(typeNode);
    if (
      !qualifier ||
      !moduleName ||
      !isCommonFabricModuleName(moduleName)
    ) {
      return undefined;
    }
    const typeName = ts.isIdentifier(qualifier)
      ? qualifier.text
      : qualifier.right.text;
    return this.#isWrapperTypeName(typeName) ? typeName : undefined;
  }

  #resolveWrapperTypeName(
    typeName: ts.EntityName,
    context: TransformationContext,
    seenSymbols: Set<ts.Symbol>,
  ): string | undefined {
    const symbol = context.checker.getSymbolAtLocation(typeName);
    return symbol &&
      this.#resolveWrapperSymbolName(symbol, context, seenSymbols);
  }

  #resolveWrapperSymbolName(
    symbol: ts.Symbol,
    context: TransformationContext,
    seenSymbols: Set<ts.Symbol>,
  ): string | undefined {
    if (seenSymbols.has(symbol)) return undefined;
    seenSymbols.add(symbol);

    if (symbol.flags & ts.SymbolFlags.Alias) {
      const aliasedSymbol = context.checker.getAliasedSymbol(symbol);
      const aliasedName = this.#resolveWrapperSymbolName(
        aliasedSymbol,
        context,
        seenSymbols,
      );
      if (aliasedName) return aliasedName;
    }

    const symbolName = symbol.getName();
    if (
      this.#isWrapperTypeName(symbolName) &&
      this.#hasCommonFabricDeclaration(symbol)
    ) {
      return symbolName;
    }

    for (const declaration of symbol.declarations ?? []) {
      if (ts.isTypeAliasDeclaration(declaration)) {
        const typeNames = this.#extractTypeNames(
          declaration.type,
          context,
          seenSymbols,
        );
        const wrapperName = typeNames.find((name) =>
          this.#isWrapperTypeName(name)
        );
        if (wrapperName) return wrapperName;
      }

      if (ts.isInterfaceDeclaration(declaration)) {
        const wrapperName = this.#resolveInterfaceHeritageWrapperName(
          declaration,
          context,
          seenSymbols,
        );
        if (wrapperName) return wrapperName;
      }
    }

    return undefined;
  }

  #resolveInterfaceHeritageWrapperName(
    declaration: ts.InterfaceDeclaration,
    context: TransformationContext,
    seenSymbols: Set<ts.Symbol>,
  ): string | undefined {
    for (const clause of declaration.heritageClauses ?? []) {
      for (const heritageType of clause.types) {
        const symbol = context.checker.getSymbolAtLocation(
          heritageType.expression,
        );
        if (!symbol) continue;
        const wrapperName = this.#resolveWrapperSymbolName(
          symbol,
          context,
          seenSymbols,
        );
        if (wrapperName) return wrapperName;
      }
    }

    return undefined;
  }

  #isWrapperTypeName(typeName: string): boolean {
    return FORBIDDEN_CAST_TYPE_NAMES.has(typeName) ||
      CELL_LIKE_TYPE_NAMES.has(typeName);
  }

  #hasCommonFabricDeclaration(symbol: ts.Symbol): boolean {
    return (symbol.declarations ?? []).some((declaration) =>
      isCommonFabricDeclaration(declaration)
    );
  }
}
