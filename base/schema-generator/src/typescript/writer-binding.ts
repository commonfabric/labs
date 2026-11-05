/**
 * Resolves the binding a `WriteAuthorizedBy<T, typeof binding>` claim names
 * to the declaration it stands for. One resolver for everything that reads a
 * writer binding — the schema formatter that mints the claim, the direct-root
 * `toSchema` path, the validation pass, and the hardening pass that gives the
 * writer its runtime binding identity — so that each names the same module
 * and the same declared name, wherever the binding was written.
 *
 * The declaration is reached through the checker, across import bindings and
 * re-exports: a claim written in an importing module names the writer where
 * it is DECLARED, and the runtime verifies a write against that module's
 * provenance, never the importer's. The declared name, not the identifier's
 * spelling, is the binding's path: `import { writer as save }` cites
 * `["writer"]`.
 */

import ts from "typescript";

import { resolveAliasedSymbol } from "./literal-value.ts";

export interface WriterBinding {
  /** The variable or function declaration the binding names. */
  readonly declaration: ts.VariableDeclaration | ts.FunctionDeclaration;
  /** The declared name: the binding's path segment. */
  readonly name: string;
  /** The declaring module, as the program spells it. */
  readonly fileName: string;
}

/**
 * The declaration `binding` names, or `undefined` when the checker cannot
 * resolve it to a variable or function declaration in an authored module. A
 * declaration file's declaration is not a writer: it has no provenance for
 * the runtime to verify, and no module identity for a claim to be minted
 * with — resolving to one would have the minter throw for a missing identity
 * where the validation pass has a diagnostic to give. A caller minting a
 * claim from an unresolvable binding must decide its own fallback; a caller
 * validating one refuses.
 */
export function resolveWriterBinding(
  binding: ts.Identifier,
  checker: ts.TypeChecker,
): WriterBinding | undefined {
  const symbol = checker.getSymbolAtLocation(binding);
  const resolved = symbol && resolveAliasedSymbol(symbol, checker);
  const declaration = resolved?.valueDeclaration ??
    resolved?.declarations?.find((candidate) =>
      ts.isVariableDeclaration(candidate) ||
      ts.isFunctionDeclaration(candidate)
    );
  if (!declaration || declaration.getSourceFile().isDeclarationFile) {
    return undefined;
  }
  if (
    ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
  ) {
    return {
      declaration,
      name: declaration.name.text,
      fileName: declaration.getSourceFile().fileName,
    };
  }
  if (ts.isFunctionDeclaration(declaration) && declaration.name) {
    return {
      declaration,
      name: declaration.name.text,
      fileName: declaration.getSourceFile().fileName,
    };
  }
  return undefined;
}
