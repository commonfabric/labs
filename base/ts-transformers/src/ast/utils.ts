import * as ts from "typescript";

import { getEnclosingFunctionLikeDeclaration } from "./function-predicates.ts";

const nodeTextCache = new WeakMap<ts.Node, string>();
const syntheticNodePrinter = ts.createPrinter();
const syntheticNodeSourceFile = ts.createSourceFile(
  "",
  "",
  ts.ScriptTarget.Latest,
);

/**
 * Safely get the source text of any node, handling both regular and synthetic
 * nodes. Synthetic nodes (created by transformers) have no valid source
 * positions, so `node.getText()` throws on them; this prints them instead.
 * Prefer this (or {@link getExpressionText}) over `getText()` in the
 * transformer — a lint rule enforces it.
 */
export function getNodeText(node: ts.Node): string {
  const cached = nodeTextCache.get(node);
  if (cached !== undefined) {
    return cached;
  }

  let text: string;
  const sourceFile = node.getSourceFile();
  // Check both: no source file OR synthetic node (pos=-1)
  if (!sourceFile || node.pos === -1) {
    // Synthetic node - use printer
    try {
      text = syntheticNodePrinter.printNode(
        ts.EmitHint.Unspecified,
        node,
        syntheticNodeSourceFile,
      );
    } catch {
      text = `<error printing ${ts.SyntaxKind[node.kind]}>`;
    }
  } else {
    // The sanctioned getText() call: guarded by the synthetic check above, and
    // passes the source file (the form the no-node-get-text lint rule allows).
    text = node.getText(sourceFile);
  }
  nodeTextCache.set(node, text);
  return text;
}

/** Safe source text for an expression. See {@link getNodeText}. */
export function getExpressionText(expr: ts.Expression): string {
  return getNodeText(expr);
}

/**
 * PROVENANCE: true when the node — or, if it was cloned/replaced during
 * transformation, its original — carries a real source range: i.e. an author
 * wrote this code and can act on a diagnostic anchored to it. Consulted where
 * a lowering disagreement must be routed either to an author-facing diagnostic
 * (authored node) or a pipeline-invariant throw (synthetic node).
 *
 * This is one of two deliberately OPPOSITE questions about a node's origin —
 * pick by what the answer is used for:
 *
 * - `hasAuthoredSourceSite` (this) looks THROUGH `getOriginalNode`: a
 *   transformer-created clone of authored code still counts as authored,
 *   because the author's text exists and a diagnostic can point at it.
 * - {@link isSyntheticNode} deliberately does NOT look through originals: a
 *   clone is synthetic no matter what it was cloned from, because the passes
 *   asking that question care about who CREATED the node (idempotency /
 *   ownership — "don't reprocess helper calls a pass emitted"), not whose
 *   text it descends from.
 *
 * Using this predicate where {@link isSyntheticNode} is meant misclassifies
 * synthetic clones as authored and re-enters subtrees a pass already owns;
 * the reverse silently drops diagnostics for authored code that was cloned.
 */
export function hasAuthoredSourceSite(node: ts.Node): boolean {
  if (node.getSourceFile() && node.pos >= 0) {
    return true;
  }

  const original = ts.getOriginalNode(node);
  return original !== node &&
    !!original.getSourceFile() &&
    original.pos >= 0;
}

/**
 * IDENTITY: true when this node object was created by a transformer factory
 * rather than the parser — it carries no real source range of its own.
 * Deliberately ignores `getOriginalNode`: see the contrast table on
 * {@link hasAuthoredSourceSite} before choosing between the two.
 *
 * This is the package's one spelling of the pos-based synthetic check
 * (`pos < 0 || end < 0`). Factory nodes are created with `(-1, -1)`;
 * `setTextRange`/lineage helpers set both ends together, so a half-set range
 * is treated as synthetic rather than trusted.
 */
export function isSyntheticNode(node: ts.Node): boolean {
  return node.pos < 0 || node.end < 0;
}

/**
 * Gets the type of a node, checking typeRegistry first (for synthetic nodes),
 * then falling back to the type checker.
 *
 * This is useful when working with nodes that may have been created during
 * transformation (synthetic nodes) which can lose their type information.
 *
 * @param node - The node to get the type for
 * @param checker - The TypeScript type checker
 * @param typeRegistry - Optional registry of types for synthetic nodes
 * @returns The type, or undefined if it couldn't be determined
 */
export function getTypeAtLocationWithFallback(
  node: ts.Node,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  // Check current node first
  if (typeRegistry?.has(node)) {
    return typeRegistry.get(node)!;
  }

  // Check original node (in case this node was cloned during transformation)
  const original = ts.getOriginalNode(node);
  if (original !== node && typeRegistry?.has(original)) {
    return typeRegistry.get(original)!;
  }

  try {
    const type = checker.getTypeAtLocation(node);
    if (shouldUseInitializerTypeFallback(type, node)) {
      const initializerType = getInitializerTypeFallback(
        node,
        checker,
        typeRegistry,
      );
      if (initializerType) {
        return initializerType;
      }
    }
    return type;
  } catch {
    return undefined;
  }
}

function shouldUseInitializerTypeFallback(
  type: ts.Type | undefined,
  node: ts.Node,
): node is ts.Identifier {
  if (!type || !ts.isIdentifier(node)) {
    return false;
  }
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function getIdentifierValueDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  let declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
    const shorthandValueSymbol = checker.getShorthandAssignmentValueSymbol(
      declaration,
    );
    declaration = shorthandValueSymbol?.valueDeclaration ??
      shorthandValueSymbol?.declarations?.[0];
  }
  return declaration;
}

export function getVariableInitializer(
  node: ts.Expression,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  if (!ts.isIdentifier(node)) {
    return undefined;
  }

  const declaration = getIdentifierValueDeclaration(node, checker);
  if (declaration && ts.isVariableDeclaration(declaration)) {
    return declaration.initializer;
  }
  return undefined;
}

function getInitializerTypeFallback(
  node: ts.Identifier,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  const declaration = getIdentifierValueDeclaration(node, checker);

  if (!declaration || !ts.isVariableDeclaration(declaration)) {
    return undefined;
  }

  // Respect explicit annotations, even if they widen to any/unknown.
  if (declaration.type || !declaration.initializer) {
    return undefined;
  }

  const initializer = declaration.initializer;
  const originalInitializer = ts.getOriginalNode(initializer);
  const registryType = typeRegistry?.get(initializer) ??
    (originalInitializer !== initializer
      ? typeRegistry?.get(originalInitializer)
      : undefined);
  if (
    registryType &&
    (registryType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0
  ) {
    return registryType;
  }

  try {
    const initializerType = checker.getTypeAtLocation(initializer);
    if (
      (initializerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0
    ) {
      return initializerType;
    }
  } catch {
    // Fall through to undefined
  }

  return undefined;
}

/**
 * Helper to resolve the base type of an expression
 */
function resolveBaseType(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  let baseType = checker.getTypeAtLocation(expression);
  if (baseType.flags & ts.TypeFlags.Any) {
    const baseSymbol = checker.getSymbolAtLocation(expression);
    if (baseSymbol) {
      const resolved = checker.getTypeOfSymbolAtLocation(
        baseSymbol,
        expression,
      );
      if (resolved) {
        baseType = resolved;
      }
    }
  }
  return baseType;
}

/**
 * Gets the symbol for a property or element access expression
 */
export function getMemberSymbol(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    const direct = checker.getSymbolAtLocation(expression.name);
    if (direct) return direct;
    const baseType = resolveBaseType(expression.expression, checker);
    if (!baseType) return undefined;
    return baseType.getProperty(expression.name.text);
  }

  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    const baseType = resolveBaseType(expression.expression, checker);
    if (!baseType) return undefined;
    return baseType.getProperty(expression.argumentExpression.text);
  }

  return checker.getSymbolAtLocation(expression) ?? undefined;
}

/**
 * Set parent pointers for synthetic nodes created by transformers.
 * Synthetic nodes don't have parent pointers set, which breaks logic
 * that relies on .parent (like method call detection).
 *
 * This is a common utility used when creating synthetic AST nodes that need
 * to participate in parent-based navigation.
 */
export function setParentPointers(node: ts.Node, parent?: ts.Node): void {
  if (parent && !(node as any).parent) {
    (node as any).parent = parent;
  }
  ts.forEachChild(node, (child) => setParentPointers(child, node));
}

/**
 * Carry full lineage from `origin` onto a synthesized REPLACEMENT of it:
 * textRange (pos/end), sourceMapRange, and the original-node chain. Apply it at
 * sites that `factory.create*` a call standing in for the same semantic unit at
 * the same site (the closure strategies' rebuilt builder calls) so
 * `BuilderCallHoistingTransformer` (and the debug source resolution downstream)
 * can still recover where each builder call was authored. `factory.update*`
 * copies textRange + original automatically; this is the `create*` counterpart.
 *
 * Use it ONLY where the full gate proves textRange/original inert (see
 * {@link preserveSourceMapRange} for why they are observable channels); when
 * in doubt, carry position via {@link preserveSourceMapRange} alone — that is
 * the channel the recovery walk and A′ read, and it is sufficient everywhere.
 *
 * `origin` is the node this one REPLACES in the emitted tree — same semantic
 * unit, same site. `origin` may itself be synthetic mid-chain — the channels
 * compose: original chains extend, getSourceMapRange propagates, and a pos=-1
 * textRange copies as a harmless no-op while recovery still works through the
 * chain.
 *
 * Origin-semantics constraint: the anchor MUST be the true semantic
 * predecessor — full lineage claims the origin's IDENTITY, not just its
 * position, and identity flows into more than sourcemaps: setTextRange feeds
 * diagnostics / getText spans, and setOriginalNode feeds every
 * getOriginalNode-fallback lookup (builder-kind resolution,
 * getTypeAtLocationWithFallback, the cross-stage marker registries). Two
 * corollaries, both enforced by the emit-invariance gate and the full suite
 * (CT-1868):
 *   - A node that WRAPS authored content (a wrapper arrow or applied wrapper
 *     call whose body/argument IS the authored expression) is NOT that
 *     content's semantic predecessor. Claiming its identity poisons
 *     identity-sensitive classifiers — e.g. a compute wrapper whose original
 *     points into the subtree `markSyntheticComputeOwnedSubtree` just marked
 *     reads as compute-owned itself. Use {@link preserveSourceMapRange} there.
 *   - Where a node needs source-map position and checker identity but must not
 *     acquire a text range, use `CFHelpers.preserveNodeSourceMap` instead. Its
 *     range and identity nodes may differ or coincide.
 */
export function preserveLineage<T extends ts.Node>(
  node: T,
  origin: ts.Node,
): T {
  return ts.setOriginalNode(
    ts.setSourceMapRange(
      ts.setTextRange(node, origin),
      ts.getSourceMapRange(origin),
    ),
    origin,
  );
}

/**
 * Carry ONLY the sourceMapRange from `origin` onto `node`. Use this instead of
 * {@link preserveLineage} for synthesized CALLBACK arrows/functions: on a
 * callback the other two lineage channels are NOT emit-safe, while
 * sourceMapRange — the channel A′ debug resolution reads — is:
 *
 *   - `setTextRange` gives the arrow a real `pos`; when a later pass rebuilds it
 *     via `factory.update*` (e.g. PatternCallbackTransform rewriting the first
 *     parameter to `__cf_pattern_input`), the arrow ends up with a real `pos`
 *     while its synthesized parameter keeps `pos:-1`, so the printer's
 *     `canEmitSimpleArrowHead` `param.pos === arrow.pos` check flips and a bare
 *     `x => …` head gets parenthesized to `(x) => …`.
 *   - `setOriginalNode` feeds `getTypeAtLocationWithFallback`'s `getOriginalNode`
 *     fallback, which SchemaInjection consults to derive a builder's argument /
 *     result schema from its callback — a real original changes emitted schemas.
 *
 * The same reasoning applies beyond callbacks, making this the DEFAULT carrier
 * for CT-1868 lineage:
 *
 *   - WRAPPER nodes (arrows or applied calls synthesized AROUND an authored
 *     expression) are not the expression's semantic predecessor; claiming its
 *     identity via setOriginalNode corrupts identity-sensitive classifiers
 *     (e.g. a compute wrapper whose original points into the subtree
 *     `markSyntheticComputeOwnedSubtree` just marked reads as compute-owned
 *     itself and trips the array-method context invariant).
 *   - SchemaInjection's rebuilt builder calls sit at their original JSX/module
 *     sites when printed: a real textRange there changes the printer's
 *     line-break layout (JSX ternaries/containers reflow), and an original
 *     chain resurfaces typeRegistry entries through
 *     `getTypeAtLocationWithFallback` (observed: module-scope-cf-data wrapping
 *     a hoisted lift application it previously left bare).
 *
 * sourceMapRange rides `factory.update*` rebuilds (setOriginalNode merges
 * emitNode data) and is read by neither the printer's text output nor
 * schema/type resolution nor the marker registries, so it recovers the
 * authored position with byte-identical emit and unchanged semantics (CT-1868;
 * the emit-invariance gate and the fixture suite caught every perturbation
 * above). Calls that genuinely replace a call at its own site AND are gate-
 * proven inert take full {@link preserveLineage} instead.
 */
export function preserveSourceMapRange<T extends ts.Node>(
  node: T,
  origin: ts.Node,
): T {
  return ts.setSourceMapRange(node, ts.getSourceMapRange(origin));
}

/**
 * Returns the best available authored text range for a node which may be
 * synthetic. The explicit source-map range is the principal lineage channel
 * once intermediate transformers rebuild a node.
 */
export function recoverAuthoredPosition(
  node: ts.Node,
): ts.TextRange | undefined {
  if (node.pos >= 0) return { pos: node.pos, end: node.end };

  const sourceMapRange = ts.getSourceMapRange(node);
  if (
    (sourceMapRange as unknown) !== (node as unknown) && sourceMapRange.pos >= 0
  ) {
    return { pos: sourceMapRange.pos, end: sourceMapRange.end };
  }

  const original = ts.getOriginalNode(node);
  if (original !== node && original.pos >= 0) {
    return { pos: original.pos, end: original.end };
  }
  return undefined;
}

// Import and re-export shared checks from schema-generator
import {
  isDefaultAliasSymbol,
  isOptionalSymbol,
} from "@commonfabric/schema-generator/property-optionality";
export { isDefaultAliasSymbol, isOptionalSymbol };

/**
 * Check if a property access expression refers to an optional property.
 * Returns true if the property has the `?` optional flag
 *
 * @example
 * ```typescript
 * interface Config {
 *   a?: number;                 // => true (has ? flag)
 *   b: number | undefined;      // => false (union with undefined)
 *   c: number;                  // => false (required)
 *   d?: number | undefined;     // => true (has ? flag)
 * }
 * ```
 */
export function isOptionalMemberSymbol(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): boolean {
  const symbol = getMemberSymbol(expression, checker);
  return symbol !== undefined && isOptionalSymbol(symbol);
}

export function isFunctionParameter(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  // Handle synthetic nodes: if the node doesn't have a source file, we can't traverse parent chain safely
  // Synthetic identifiers from map closure transformation (like `discount`, `element`) are treated as
  // opaque parameters, not regular function parameters
  if (!node.getSourceFile()) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(node);
  if (symbol) {
    const declarations = symbol.getDeclarations();
    if (declarations && declarations.some((decl) => ts.isParameter(decl))) {
      for (const decl of declarations) {
        if (!ts.isParameter(decl)) continue;
        const parent = decl.parent;
        if (
          ts.isFunctionExpression(parent) ||
          ts.isArrowFunction(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isMethodDeclaration(parent)
        ) {
          if (isBuilderOwnedFunctionLike(parent)) {
            return false;
          }
        }
        return true;
      }
    }
  }

  const parent = node.parent;
  if (parent && ts.isParameter(parent) && parent.name === node) {
    return true;
  }

  const containingFunction = getEnclosingFunctionLikeDeclaration(node);

  if (containingFunction && containingFunction.parameters) {
    for (const param of containingFunction.parameters) {
      if (
        param.name && ts.isIdentifier(param.name) &&
        param.name.text === node.text
      ) {
        if (isBuilderOwnedFunctionLike(containingFunction)) {
          return false;
        }
        return true;
      }
    }
  }

  return false;
}

function isBuilderOwnedFunctionLike(func: ts.FunctionLikeDeclaration): boolean {
  let callExpr: ts.Node = func;
  while (callExpr.parent && !ts.isCallExpression(callExpr.parent)) {
    callExpr = callExpr.parent;
  }

  if (!callExpr.parent || !ts.isCallExpression(callExpr.parent)) {
    return false;
  }

  const funcName = getNodeText(callExpr.parent.expression);
  return funcName.includes("pattern") ||
    funcName.includes("handler") ||
    funcName.includes("lift");
}

/**
 * Visit a node's children, handling JSX expressions properly.
 * TypeScript's visitEachChild doesn't traverse into JsxExpression.expression,
 * so we need to handle those manually.
 *
 * This is the transformation/visitor version. For read-only analysis,
 * see the special JSX handling in dataflow.ts.
 */
export function visitEachChildWithJsx(
  node: ts.Node,
  visitor: ts.Visitor,
  context: ts.TransformationContext | undefined,
): ts.Node {
  // Handle JSX elements - need to traverse JSX expression children manually
  if (ts.isJsxElement(node)) {
    const openingElement = ts.visitNode(node.openingElement, visitor);
    const children = ts.visitNodes(
      node.children,
      (child) => {
        // Visit the JsxExpression node itself, not just its inner expression
        // This allows transformers to process JsxExpression nodes
        return ts.visitNode(child, visitor);
      },
      ts.isJsxChild,
    );
    const closingElement = ts.visitNode(node.closingElement, visitor);
    return ts.factory.updateJsxElement(
      node,
      openingElement as ts.JsxOpeningElement,
      children,
      closingElement as ts.JsxClosingElement,
    );
  }

  // Handle JSX self-closing elements
  if (ts.isJsxSelfClosingElement(node)) {
    return ts.visitEachChild(node, visitor, context);
  }

  // Handle JSX fragments
  if (ts.isJsxFragment(node)) {
    const openingFragment = ts.visitNode(node.openingFragment, visitor);
    const children = ts.visitNodes(
      node.children,
      (child) => {
        // Visit the child node itself (including JsxExpression nodes)
        return ts.visitNode(child, visitor);
      },
      ts.isJsxChild,
    );
    const closingFragment = ts.visitNode(node.closingFragment, visitor);
    return ts.factory.updateJsxFragment(
      node,
      openingFragment as ts.JsxOpeningFragment,
      children,
      closingFragment as ts.JsxClosingFragment,
    );
  }

  // For all other nodes, use the default behavior
  return ts.visitEachChild(node, visitor, context);
}

/**
 * Check if a property access expression is being invoked as a method call.
 *
 * @example
 * ```typescript
 * // Returns true:
 * obj.method()  // node is obj.method
 *
 * // Returns false:
 * const x = obj.method  // node is obj.method (not being called)
 * ```
 */
export function isMethodCall(node: ts.PropertyAccessExpression): boolean {
  return !!(
    node.parent &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node
  );
}

/**
 * When a property access is a method call, get the object being called on.
 * This is useful for closures that should capture the object, not the method.
 *
 * @example
 * ```typescript
 * state.counter.set()  // Returns PropertyAccessExpression for state.counter
 * obj.method()         // Returns undefined (obj is not a PropertyAccessExpression)
 * obj.prop             // Returns undefined (not a method call)
 * ```
 *
 * @returns The object PropertyAccessExpression if this is a method call on a property chain,
 *          undefined otherwise
 */
export function getMethodCallTarget(
  node: ts.PropertyAccessExpression,
): ts.PropertyAccessExpression | undefined {
  if (!isMethodCall(node)) return undefined;

  const obj = node.expression;
  return ts.isPropertyAccessExpression(obj) ? obj : undefined;
}
