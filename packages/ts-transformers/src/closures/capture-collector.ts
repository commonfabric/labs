import ts from "typescript";
import { getMethodCallTarget, isMethodCall } from "../ast/mod.ts";
import {
  isDeclaredWithinFunction,
  isFunctionDeclaration,
  isModuleScopedDeclaration,
} from "../ast/scope-analysis.ts";
import { groupCapturesByRoot } from "../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../utils/capture-tree.ts";
import { extractBindingNames } from "../utils/identifiers.ts";

export interface CaptureAnalysis {
  readonly captures: Set<ts.Expression>;
  readonly captureTree: Map<string, CaptureTreeNode>;
}

export interface CaptureCollectorOptions {
  readonly captureNonModuleExternalIdentifiers?: boolean;
  readonly captureNonModuleExternalPropertyAccesses?: boolean;
  readonly captureModuleScopedIdentifierWhen?: (
    identifier: ts.Identifier,
    type: ts.Type,
    checker: ts.TypeChecker,
  ) => boolean;
}

export class CaptureCollector {
  readonly #checker: ts.TypeChecker;
  readonly #options: CaptureCollectorOptions;

  constructor(
    checker: ts.TypeChecker,
    options: CaptureCollectorOptions = {},
  ) {
    this.#checker = checker;
    this.#options = options;
  }

  analyze(func: ts.FunctionLikeDeclaration): CaptureAnalysis {
    const captures = this.#collectCaptures(func);
    const captureTree = groupCapturesByRoot(captures);
    return { captures, captureTree };
  }

  analyzeCurrentAndOriginal(
    func: ts.FunctionLikeDeclaration,
  ): CaptureAnalysis {
    const current = this.analyze(func);
    const original = ts.getOriginalNode(func);
    if (
      !this.#isFunctionLikeDeclaration(original) ||
      original === func
    ) {
      return current;
    }

    // Earlier rewrites can hand later closure strategies a cloned callback node
    // whose current body no longer exposes all authored captures. Merge the
    // current and authored-original capture sets so the generated callback
    // params satisfy both the transformed body and its source-level closure
    // requirements.
    const originalAnalysis = this.analyze(original);
    if (originalAnalysis.captures.size === 0) {
      return current;
    }

    const captures = new Set(current.captures);
    for (const capture of originalAnalysis.captures) {
      captures.add(capture);
    }
    return {
      captures,
      captureTree: groupCapturesByRoot(captures),
    };
  }

  /**
   * Detects captured variables in a function using TypeScript's symbol table.
   * Returns all captured expressions (both reactive and non-reactive).
   */
  #collectCaptures(
    func: ts.FunctionLikeDeclaration,
  ): Set<ts.Expression> {
    const captures = new Set<ts.Expression>();

    const visit = (node: ts.Node) => {
      // A type is erased before the callback runs, so nothing named inside
      // one is a value it closes over: not a function type's parameters
      // (`(next: string) => void` in a cast), not a `typeof` query, not a type
      // argument. The expression of an `extends Base<T>` clause is a value,
      // so that node is still walked; its type arguments are skipped here.
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
        return;
      }

      // For nested functions, recursively collect their captures too
      // Even though they have their own scope for parameters, they still
      // close over variables from outer scopes, and we need to know about
      // all such captures for the lift-applied/handler transformation
      if (node !== func && this.#isFunctionLikeDeclaration(node)) {
        const nestedCaptures = this.#collectCaptures(node);
        // Filter out captures that are parameters of the current function
        //
        // CRITICAL: We must filter based on root identifiers for property accesses.
        // Example: Outer map has parameter `item`, inner map uses `item.name`
        //   - Without this filtering: `item.name` gets added to outer params -> collision with `element: item` -> generates `item_1`
        //   - With this filtering: Recognizes `item` is outer param -> filters out `item.name` -> only `state` in outer params
        // This prevents spurious name collisions when nested callbacks reference outer parameters.
        const funcParams = new Set<string>(
          func.parameters.flatMap((p: ts.ParameterDeclaration) =>
            extractBindingNames(p.name)
          ),
        );

        for (const capture of nestedCaptures) {
          if (this.#shouldAddNestedCapture(capture, func, funcParams)) {
            captures.add(capture);
          }
        }
        // Don't visit children since we just recursively processed them
        return;
      }

      // For property access like state.discount, capture the whole expression
      if (ts.isPropertyAccessExpression(node)) {
        // If this is a method call, try to capture the object instead of the method
        // Example: state.counter.set() -> capture state.counter, not state.counter.set
        // But if the object is just an identifier (multiplier.get()), skip this and
        // let the identifier visitor handle it
        const methodTarget = getMethodCallTarget(node);
        if (methodTarget) {
          // Method call on a property access (e.g., state.counter.set())
          const captured = this.#shouldCapturePropertyAccess(
            methodTarget,
            func,
          );
          if (captured) {
            captures.add(captured);
            // Don't visit children
            return;
          }
        } else if (!isMethodCall(node)) {
          // Not a method call, capture the property access normally
          const captured = this.#shouldCapturePropertyAccess(node, func);
          if (captured) {
            captures.add(captured);
            // Don't visit children - we've captured the whole property access chain
            return;
          }
          // If not captured, continue visiting children to check for opaque values
          // in the expression part (e.g., for state.arr[index].length, we need to
          // visit state.arr[index] even though .length itself isn't captured)
        }
        // For method calls on identifiers (multiplier.get()), don't capture the property access
        // The identifier will be captured separately
      }

      // For plain identifiers
      if (ts.isIdentifier(node)) {
        const captured = this.#shouldCaptureIdentifier(node, func);
        if (captured) {
          captures.add(captured);
        }
      }

      ts.forEachChild(node, visit);
    };

    // Visit parameter initializers first
    // Captures in default values (e.g. (a = captured) => ...) need to be detected
    for (const param of func.parameters) {
      if (param.initializer) {
        visit(param.initializer);
      }
    }

    if (func.body) {
      visit(func.body);
    }

    return captures;
  }

  /**
   * Check if a property access expression should be captured.
   * Returns the expression to capture, or undefined if it shouldn't be captured.
   */
  #shouldCapturePropertyAccess(
    node: ts.PropertyAccessExpression,
    func: ts.FunctionLikeDeclaration,
  ): ts.PropertyAccessExpression | undefined {
    // Get the root object (e.g., 'state' in 'state.discount')
    let root = node.expression;
    while (ts.isPropertyAccessExpression(root)) {
      root = root.expression;
    }

    if (!ts.isIdentifier(root)) {
      return undefined;
    }

    const symbol = this.#checker.getSymbolAtLocation(root);
    if (!symbol) return undefined;

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return undefined;

    // Skip imports - they're module-scoped and don't need to be captured
    const isImport = declarations.some((decl) =>
      ts.isImportSpecifier(decl) ||
      ts.isImportClause(decl) ||
      ts.isNamespaceImport(decl)
    );
    if (isImport) {
      return undefined;
    }

    // Skip module-scoped declarations; property-access captures are only used
    // for non-module closure extraction, not for patternTool-style module captures.
    if (
      declarations.some((decl: ts.Declaration) =>
        isModuleScopedDeclaration(decl)
      )
    ) {
      return undefined;
    }

    // Skip function declarations
    if (
      declarations.some((decl: ts.Declaration) =>
        isFunctionDeclaration(decl, this.#checker)
      )
    ) {
      return undefined;
    }

    // Check if ANY declaration is outside the callback
    const hasExternalDeclaration = declarations.some((decl: ts.Declaration) => {
      const isWithin = isDeclaredWithinFunction(decl, func);
      return !isWithin;
    });

    if (hasExternalDeclaration) {
      if (this.#options.captureNonModuleExternalPropertyAccesses === false) {
        return undefined;
      }
      // Capture the whole property access expression
      return node;
    }

    return undefined;
  }

  /**
   * Check if an identifier should be captured.
   * Returns the identifier to capture, or undefined if it shouldn't be captured.
   */
  #shouldCaptureIdentifier(
    node: ts.Identifier,
    func: ts.FunctionLikeDeclaration,
  ): ts.Identifier | undefined {
    // Skip synthetic nodes (created by transformers, not from source)
    if (!node.getSourceFile()) {
      return undefined;
    }

    // Skip if this is part of a property access (handled separately)
    if (
      ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
    ) {
      return undefined;
    }

    // Skip if this identifier is the property name in an object literal (e.g., 'label' in '{ label: value }')
    // We only want to capture the VALUE, not the property name itself
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) {
      return undefined;
    }

    // Skip if this identifier is the property name in a destructuring binding
    // (e.g., 'spotNumber' in 'const { spotNumber: sn } = obj')
    // The property name identifies which property to extract, it's not a variable reference
    if (
      ts.isBindingElement(node.parent) && node.parent.propertyName === node
    ) {
      return undefined;
    }

    // For shorthand property assignments (e.g., {id} instead of {id: id}), we need special handling
    // because getSymbolAtLocation returns the property symbol, not the variable being referenced
    if (ts.isShorthandPropertyAssignment(node.parent)) {
      // For shorthand properties, we need to resolve to the actual variable/value being referenced
      // Use the type checker to get the actual symbol of the referenced value
      const propSymbol = this.#checker.getShorthandAssignmentValueSymbol(
        node.parent,
      );
      if (propSymbol) {
        const propDeclarations = propSymbol.getDeclarations() || [];
        const allDeclaredInside = propDeclarations.every((
          decl: ts.Declaration,
        ) => isDeclaredWithinFunction(decl, func));
        if (allDeclaredInside) {
          return undefined;
        }
        return this.#shouldCaptureExternalIdentifier(node, propDeclarations)
          ? node
          : undefined;
      }
      // If we can't resolve the shorthand symbol, fall through to normal handling
    }

    // Skip JSX element tag names (e.g., <li>, <div>)
    if (
      ts.isJsxOpeningElement(node.parent) ||
      ts.isJsxClosingElement(node.parent) ||
      ts.isJsxSelfClosingElement(node.parent)
    ) {
      return undefined;
    }

    const symbol = this.#checker.getSymbolAtLocation(node);
    if (!symbol) {
      return undefined;
    }

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) {
      return undefined;
    }

    // Filter out shorthand property assignments - they're not real declarations,
    // they're just syntactic sugar that references the actual declaration elsewhere
    const realDeclarations = declarations.filter((decl: ts.Declaration) =>
      !ts.isShorthandPropertyAssignment(decl)
    );

    // If all we have are shorthand property assignments, check if this identifier
    // is actually a parameter of the callback itself
    if (realDeclarations.length === 0) {
      // Check if there's a parameter with this name in the callback
      // Use extractBindingNames to handle nested destructuring patterns
      const isCallbackParam = func.parameters.some((
        param: ts.ParameterDeclaration,
      ) => extractBindingNames(param.name).includes(node.text));

      if (isCallbackParam) {
        return undefined; // Don't capture - it's just referencing a callback parameter
      }

      // Not a callback parameter, must be from outer scope
      return node;
    }

    // Check if ALL real declarations are within the callback
    const allDeclaredInside = realDeclarations.every((decl: ts.Declaration) =>
      isDeclaredWithinFunction(decl, func)
    );

    if (allDeclaredInside) {
      return undefined;
    }

    // Check if it's a JSX attribute (should not be captured)
    const isJsxAttr = declarations.some((decl: ts.Declaration) =>
      ts.isJsxAttribute(decl)
    );
    if (isJsxAttr) {
      return undefined;
    }

    // Skip imports - they're module-scoped and don't need to be captured
    const isImport = declarations.some((decl) =>
      ts.isImportSpecifier(decl) ||
      ts.isImportClause(decl) ||
      ts.isNamespaceImport(decl)
    );
    if (isImport) {
      return undefined;
    }

    if (!this.#shouldCaptureExternalIdentifier(node, declarations)) {
      return undefined;
    }

    // If we got here, at least one declaration is outside the callback
    // So it's a captured variable
    return node;
  }

  #shouldCaptureExternalIdentifier(
    node: ts.Identifier,
    declarations: readonly ts.Declaration[],
  ): boolean {
    // Skip function declarations (can't serialize functions)
    const isFunction = declarations.some((decl: ts.Declaration) =>
      isFunctionDeclaration(decl, this.#checker)
    );
    if (isFunction) {
      return false;
    }

    // Skip type parameters (generic type parameters like T, U, etc.)
    // Type parameters are compile-time only and don't exist at runtime.
    // Trying to capture them causes "ReferenceError: T is not defined"
    const isTypeParameter = declarations.some((decl: ts.Declaration) =>
      ts.isTypeParameterDeclaration(decl)
    );
    if (isTypeParameter) {
      return false;
    }

    const isModuleScoped = declarations.some((decl: ts.Declaration) =>
      isModuleScopedDeclaration(decl)
    );
    if (isModuleScoped) {
      const predicate = this.#options.captureModuleScopedIdentifierWhen;
      if (!predicate) {
        return false;
      }
      const type = this.#checker.getTypeAtLocation(node);
      return predicate(node, type, this.#checker);
    }

    return this.#options.captureNonModuleExternalIdentifiers !== false;
  }

  /**
   * Type guard for function-like declarations (excludes signature declarations).
   * Used to identify nested functions that can have their own captures.
   */
  #isFunctionLikeDeclaration(
    node: ts.Node,
  ): node is ts.FunctionLikeDeclaration {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node);
  }

  #isParameterOrLocalVariable(
    identifier: ts.Identifier,
    func: ts.FunctionLikeDeclaration,
    funcParams: Set<string>,
  ): boolean {
    // Check if it's a function parameter
    if (funcParams.has(identifier.text)) {
      return true;
    }

    // Check if it's a local variable declared within the function
    const symbol = this.#checker.getSymbolAtLocation(identifier);
    if (symbol) {
      const declarations = symbol.getDeclarations() || [];
      for (const decl of declarations) {
        if (isDeclaredWithinFunction(decl, func)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Determines if a capture from a nested function should be added to the outer function's captures.
   * Filters out captures that are parameters or local variables of the outer function.
   */
  #shouldAddNestedCapture(
    capture: ts.Expression,
    outerFunc: ts.FunctionLikeDeclaration,
    funcParams: Set<string>,
  ): boolean {
    if (ts.isIdentifier(capture)) {
      return !this.#isParameterOrLocalVariable(
        capture,
        outerFunc,
        funcParams,
      );
    }

    if (ts.isPropertyAccessExpression(capture)) {
      // Property access: check if root identifier is a parameter or local variable
      // Walk down the chain to find the root: a.b.c -> a
      let rootExpr: ts.Expression = capture;
      while (ts.isPropertyAccessExpression(rootExpr)) {
        rootExpr = rootExpr.expression;
      }
      if (ts.isIdentifier(rootExpr)) {
        return !this.#isParameterOrLocalVariable(
          rootExpr,
          outerFunc,
          funcParams,
        );
      }
      // Root is not an identifier (e.g., computed property access) - include it
      return true;
    }

    // Other types of captures (e.g., element access, call expressions) - include them
    return true;
  }
}
