import ts from "typescript";
import { getNodeText } from "./utils.ts";

export function isSafeEventHandlerCall(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text.startsWith("on");
  }
  if (ts.isIdentifier(expression)) {
    return expression.text.startsWith("on");
  }
  return false;
}

/**
 * Check if a type is a function type that looks like an event handler.
 *
 * In Common Fabric JSX, any function passed to an element is treated as an
 * action/handler.
 * We check that handlers have 0 or 1 parameters to distinguish them from data-transformer
 * functions (which typically take multiple parameters).
 */
export function isEventHandlerType(
  type: ts.Type,
  _checker: ts.TypeChecker,
): boolean {
  const signatures = type.getCallSignatures();
  if (signatures.length === 0) {
    return false;
  }
  // Check that all signatures have 0 or 1 parameters
  return signatures.every((sig) => sig.parameters.length <= 1);
}

/**
 * Check if a node is inside a JSX attribute that should be treated as an event handler.
 * Detection uses two strategies:
 * 1. Name-based: attribute name starts with "on" (e.g., onClick, onSubmit)
 * 2. Type-based: the expected type is a function (requires checker)
 *
 * @param node - The node to check (typically an identifier or the JsxAttribute itself)
 * @param checker - Optional TypeChecker for type-based detection
 */
export function isEventHandlerJsxAttribute(
  node: ts.Node,
  checker?: ts.TypeChecker,
): boolean {
  if (!node || !node.parent) return false;

  // Find the JsxAttribute - node could be the attribute itself or a child of it
  let jsxAttribute: ts.JsxAttribute | undefined;

  if (ts.isJsxAttribute(node)) {
    jsxAttribute = node;
  } else if (ts.isJsxAttribute(node.parent)) {
    jsxAttribute = node.parent;
  } else {
    return false;
  }

  const attrName = getNodeText(jsxAttribute.name);

  // Fast path: conventional "on*" naming
  if (attrName.startsWith("on")) {
    return true;
  }

  // Type-based detection (requires checker)
  if (
    checker &&
    jsxAttribute.initializer &&
    ts.isJsxExpression(jsxAttribute.initializer)
  ) {
    const expr = jsxAttribute.initializer.expression;
    if (expr) {
      // Get the contextual type (what the component expects for this prop)
      const contextualType = checker.getContextualType(expr);
      if (contextualType && isEventHandlerType(contextualType, checker)) {
        return true;
      }
    }
  }

  return false;
}
