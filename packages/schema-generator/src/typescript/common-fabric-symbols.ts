/**
 * Decides whether a declaration, a symbol, or a type node is Common Fabric's
 * own — declared by the `commonfabric` API — or something of the author's
 * that shares its name. A wrapper's name means the wrapper only in the first
 * case, so both the transformer and the schema generator ask this before
 * treating a name such as `Writable` or `Default` as what `commonfabric`
 * declares.
 */

import ts from "typescript";

const COMMONFABRIC_DECLARATION = "commonfabric.d.ts";
const COMMONFABRIC_MODULE_NAME = "commonfabric";
const COMMONFABRIC_PACKAGE_PREFIX = "@commonfabric/";

export function isCommonFabricModuleName(moduleName: string): boolean {
  return moduleName === COMMONFABRIC_MODULE_NAME ||
    moduleName.startsWith(COMMONFABRIC_PACKAGE_PREFIX);
}

export function getImportTypeModuleName(
  typeNode: ts.ImportTypeNode,
): string | undefined {
  const argument = typeNode.argument;
  if (!ts.isLiteralTypeNode(argument)) return undefined;
  return ts.isStringLiteral(argument.literal)
    ? argument.literal.text
    : undefined;
}

export function isCommonFabricDeclaration(
  declaration: ts.Declaration,
): boolean {
  if (
    isCommonFabricDeclarationSourceFile(
      declaration.getSourceFile().fileName,
    )
  ) {
    return true;
  }

  let current: ts.Node | undefined = declaration;
  while (current) {
    if (
      ts.isModuleDeclaration(current) &&
      ts.isStringLiteral(current.name) &&
      isCommonFabricModuleName(current.name.text)
    ) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

function isCommonFabricDeclarationSourceFile(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");
  return normalized === COMMONFABRIC_DECLARATION ||
    normalized.endsWith(`/${COMMONFABRIC_DECLARATION}`) ||
    normalized.endsWith("/packages/api/index.ts") ||
    normalized.includes("/@commonfabric/api/") ||
    normalized.includes("/packages/runner/src/");
}

/**
 * Checks if a symbol comes from the Common Fabric library
 */
export function isCommonFabricSymbol(
  symbol: ts.Symbol,
): boolean {
  return (symbol.getDeclarations() ?? []).some(isCommonFabricDeclaration);
}

/**
 * Resolves a symbol to check if it represents a Common Fabric export
 */
export function resolvesToCommonFabricSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  targetName: string,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);

  if (symbol.getName() === targetName) {
    if (isCommonFabricSymbol(symbol)) {
      return true;
    }
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (
      aliased &&
      resolvesToCommonFabricSymbol(aliased, checker, targetName, seen)
    ) {
      return true;
    }
  }

  const declarations = symbol.getDeclarations();
  if (declarations) {
    for (const declaration of declarations) {
      if (ts.isTypeAliasDeclaration(declaration)) {
        const aliasType = declaration.type;
        if (aliasType && ts.isTypeReferenceNode(aliasType)) {
          const referenced = checker.getSymbolAtLocation(aliasType.typeName);
          if (
            resolvesToCommonFabricSymbol(
              referenced,
              checker,
              targetName,
              seen,
            )
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Checks if a type node represents a Common Fabric Default type
 */
function isCommonFabricDefaultTypeNode(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol> = new Set(),
): boolean {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return false;
  const symbol = checker.getSymbolAtLocation(typeNode.typeName);
  if (!symbol || visited.has(symbol)) return false;
  visited.add(symbol);
  if (resolvesToCommonFabricSymbol(symbol, checker, "Default")) {
    return true;
  }
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;
  for (const declaration of declarations) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const aliased = declaration.type;
      if (
        aliased && ts.isTypeReferenceNode(aliased) &&
        isCommonFabricDefaultTypeNode(aliased, checker, visited)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if a symbol declares a Common Fabric Default type
 */
export function symbolDeclaresCommonFabricDefault(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!symbol) return false;
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;
  return declarations.some((declaration) => {
    const nodeWithType = declaration as { type?: ts.TypeNode };
    if (
      nodeWithType.type &&
      isCommonFabricDefaultTypeNode(nodeWithType.type, checker)
    ) {
      return true;
    }
    if (ts.isPropertySignature(declaration) && declaration.type) {
      return isCommonFabricDefaultTypeNode(declaration.type, checker);
    }
    if (ts.isTypeAliasDeclaration(declaration) && declaration.type) {
      return isCommonFabricDefaultTypeNode(declaration.type, checker);
    }
    return false;
  });
}
