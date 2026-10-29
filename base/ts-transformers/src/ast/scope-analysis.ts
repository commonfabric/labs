import ts from "typescript";
import { isFunctionLikeExpression } from "./function-predicates.ts";
import { detectCallKind } from "./call-kind.ts";
import { recoverAuthoredPosition } from "./utils.ts";

/**
 * Check if a declaration is at module scope (top-level of source file).
 */
export function isModuleScopedDeclaration(decl: ts.Declaration): boolean {
  // Walk up to find the parent
  let parent = decl.parent;

  // For variable declarations, need to go up through VariableDeclarationList
  if (ts.isVariableDeclaration(decl)) {
    // VariableDeclaration -> VariableDeclarationList -> VariableStatement -> SourceFile
    parent = parent?.parent?.parent;
  }
  // For function declarations, parent is already SourceFile (if module-scoped)
  // No need to reassign

  return parent ? ts.isSourceFile(parent) : false;
}

/**
 * Check if a declaration represents a function (we can't serialize functions).
 * Uses TypeScript's type system to check if the declared value is a function type.
 */
export function isFunctionDeclaration(
  decl: ts.Declaration,
  checker?: ts.TypeChecker,
): boolean {
  // Direct function declarations
  if (ts.isFunctionDeclaration(decl)) {
    return true;
  }

  // Arrow functions or function expressions assigned to variables
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;

    // Direct function syntax
    if (isFunctionLikeExpression(init)) {
      return true;
    }

    // For call expressions, use type system to determine if result is a function
    // BUT: Common Fabric builder calls (action, handler, computed, etc.) return
    // callable factories that ARE meant to be captured and passed through the
    // reactive system. These should NOT be treated as plain functions.
    if (checker && ts.isCallExpression(init)) {
      // Check if this is a Common Fabric builder call - these return reactive
      // values that should be captured, not skipped as functions
      const callKind = detectCallKind(init, checker);
      if (callKind?.kind === "builder") {
        // action(), handler(), computed(), etc. - NOT a plain function
        return false;
      }

      const type = checker.getTypeAtLocation(init);
      // Check if the type has call signatures (making it a function type)
      const signatures = type.getCallSignatures();
      if (signatures.length > 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks whether a declaration belongs to a function's local scope.
 * Parameter comparisons follow authored lineage through transformed clones;
 * distinct same-named bindings remain separate declarations.
 */
export function isDeclaredWithinFunction(
  decl: ts.Declaration,
  func: ts.FunctionLikeDeclaration,
): boolean {
  // Parameter parents may belong to the source tree while the callback is cloned.
  if (ts.isParameter(decl)) {
    const original = ts.getOriginalNode(decl);
    if (
      func.parameters.some((parameter) =>
        ts.getOriginalNode(parameter) === original
      )
    ) return true;
  }

  const functionRange = recoverAuthoredPosition(func);
  const functionSource = func.getSourceFile();
  let current: ts.Node | undefined = decl;
  while (current) {
    if (current === func) return true;

    // Rebuilt callbacks retain authored ranges through their source maps.
    const currentRange = recoverAuthoredPosition(current);
    const currentSource = current.getSourceFile();
    if (
      functionRange && currentRange &&
      currentRange.pos === functionRange.pos &&
      currentRange.end === functionRange.end &&
      current.kind === func.kind &&
      (!functionSource || !currentSource || functionSource === currentSource)
    ) {
      return true;
    }

    // Stop at function boundaries (don't cross into nested functions)
    if (current !== decl && ts.isFunctionLike(current)) {
      return false;
    }

    current = current.parent;
  }

  return false;
}
