/**
 * Keeps an argument's authored syntax and the bindings it is written under
 * together while generic declarations are read.
 */

import ts from "typescript";

import type { BoundTypeArgument, BoundTypeParameters } from "./interface.ts";
import {
  holdsFreeTypeParameter,
  holdsTypeParameter,
  typeParameterOfReference,
} from "./typescript/type-node.ts";

/**
 * Returns the argument written by `node`, forwarding a bound parameter as
 * its own argument. An unbound parameter has no readable argument here.
 */
export function bindWrittenArgument(
  node: ts.TypeNode,
  bound: BoundTypeParameters | undefined,
  checker: ts.TypeChecker,
  typeOf: (node: ts.TypeNode) => ts.Type,
): BoundTypeArgument | undefined {
  if (holdsFreeTypeParameter(node, checker, bound?.arguments)) return undefined;
  const parameter = bound && typeParameterOfReference(node, checker);
  const forwarded = parameter && bound?.arguments.get(parameter);
  if (forwarded) return forwarded;
  const type = typeOf(node);
  return bound && holdsTypeParameter(node, checker, bound.arguments)
    ? { type, node, bound }
    : { type, node };
}

/**
 * Whether `node` uses a parameter in an operator the checker must instantiate
 * before its value can be read: indexed access, a conditional, `keyof`, a
 * mapped type, or a template literal.
 */
export function usesParameterUnreachably(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  return ((ts.isIndexedAccessTypeNode(node) || ts.isConditionalTypeNode(node) ||
    ts.isMappedTypeNode(node) || ts.isTemplateLiteralTypeNode(node) ||
    (ts.isTypeOperatorNode(node) &&
      node.operator === ts.SyntaxKind.KeyOfKeyword)) &&
    holdsFreeTypeParameter(node, checker)) ||
    (ts.forEachChild(
      node,
      (child) => usesParameterUnreachably(child, checker) || undefined,
    ) ?? false);
}
