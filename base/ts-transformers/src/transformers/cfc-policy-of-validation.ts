import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { CFC_AUTHORING_MODULES } from "./cfc-policy-authoring.ts";
import { unwrapExpression } from "../utils/expression.ts";

export class CfcPolicyOfValidationTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit: ts.Visitor = (node) => {
      if (ts.isTypeReferenceNode(node) && isPolicyOfReference(node, context)) {
        validatePolicyOf(node, context);
      }
      return ts.visitEachChild(node, visit, context.tsContext);
    };
    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

function isPolicyOfReference(
  node: ts.TypeReferenceNode,
  context: TransformationContext,
): boolean {
  if (!ts.isIdentifier(node.typeName)) return false;
  return isImportedCfcAuthoringBinding(node.typeName, "PolicyOf", context);
}

function validatePolicyOf(
  node: ts.TypeReferenceNode,
  context: TransformationContext,
): void {
  const binding = node.typeArguments?.[0];
  if (
    node.typeArguments?.length !== 1 || !binding ||
    !ts.isTypeQueryNode(binding) || !ts.isIdentifier(binding.exprName)
  ) {
    report(
      context,
      node,
      "PolicyOf requires one direct typeof exportedRules binding.",
    );
    return;
  }
  const symbol = context.checker.getSymbolAtLocation(binding.exprName);
  const declarationSymbol = symbol && (symbol.flags & ts.SymbolFlags.Alias)
    ? context.checker.getAliasedSymbol(symbol)
    : symbol;
  const declaration = declarationSymbol?.valueDeclaration ??
    declarationSymbol?.declarations?.[0];
  if (
    !declaration || !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) || !declaration.initializer ||
    !isExchangeRulesCall(declaration.initializer, context)
  ) {
    report(
      context,
      binding,
      "PolicyOf binding must resolve to an exchangeRules() declaration.",
    );
    return;
  }
  if (!isExportedVariable(declaration)) {
    report(
      context,
      binding,
      "PolicyOf binding must be exported by its defining module.",
    );
  }
}

function isExchangeRulesCall(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const target = unwrapExpression(expression);
  if (!ts.isCallExpression(target)) return false;
  const callee = target.expression;
  if (!ts.isIdentifier(callee)) return false;
  return isImportedCfcAuthoringBinding(callee, "exchangeRules", context);
}

function isImportedCfcAuthoringBinding(
  identifier: ts.Identifier,
  importedName: string,
  context: TransformationContext,
): boolean {
  const symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return false;
  return (symbol.declarations ?? []).some((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return false;
    if (
      (declaration.propertyName?.text ?? declaration.name.text) !== importedName
    ) {
      return false;
    }
    const importDeclaration = declaration.parent.parent.parent;
    return ts.isImportDeclaration(importDeclaration) &&
      ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
      CFC_AUTHORING_MODULES.has(importDeclaration.moduleSpecifier.text);
  });
}

function isExportedVariable(declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const declarationName = declaration.name.text;
  const statement = declaration.parent.parent;
  if (
    ts.isVariableStatement(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  ) return true;
  const sourceFile = declaration.getSourceFile();
  return sourceFile.statements.some((candidate) =>
    ts.isExportDeclaration(candidate) && !candidate.moduleSpecifier &&
    candidate.exportClause && ts.isNamedExports(candidate.exportClause) &&
    candidate.exportClause.elements.some((element) =>
      element.propertyName === undefined &&
      element.name.text === declarationName
    )
  );
}

function report(
  context: TransformationContext,
  node: ts.Node,
  message: string,
): void {
  context.reportDiagnostic({ node, type: "cfc-policy-of", message });
}
