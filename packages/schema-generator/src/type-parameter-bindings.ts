/**
 * Keeps an argument's authored syntax and the bindings it is written under
 * together while generic declarations are read.
 */

import ts from "typescript";

import type {
  BoundTypeArgument,
  BoundTypeParameters,
  GenerationContext,
} from "./interface.ts";
import {
  holdsFreeTypeParameter,
  holdsTypeParameter,
  typeParameterOfReference,
  typeParameterOfType,
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
 * Reads `node`'s semantic type under its authored parameter bindings. A
 * compound reference is matched to its instantiation among `candidates`, where
 * the checker has already instantiated it. Its authored node stays available
 * to the formatter for defaults, scopes, and writer identities.
 */
export function readBoundTypeNode(
  node: ts.TypeNode,
  context: GenerationContext,
  candidates: readonly ts.Type[] = [],
): ts.Type {
  // The registry can hold a capture's narrowed observation of a declared
  // object. Default coverage is checked against the authored target; omitted
  // fields in an observation do not make its full default invalid.
  const declared = context.typeChecker.getTypeFromTypeNode(node);
  const argument = resolvedArgumentOf(declared, context.boundTypeParameters);
  return candidates.find((candidate) =>
    matchesInstantiation(argument, candidate, context.typeChecker)
  ) ?? argument.type;
}

/**
 * Helper for {@link readBoundTypeNode}, which follows a parameter through the
 * bindings of each argument's own declaration scope.
 */
function resolvedArgumentOf(
  type: ts.Type,
  bound: BoundTypeParameters | undefined,
): BoundTypeArgument {
  let current: BoundTypeArgument = bound ? { type, bound } : { type };
  const seen = new Set<BoundTypeArgument>();
  while (current.bound) {
    const parameter = typeParameterOfType(current.type);
    const argument = parameter && current.bound.arguments.get(parameter);
    if (!argument || seen.has(argument)) break;
    seen.add(argument);
    current = argument;
  }
  return current;
}

/**
 * Helper for {@link readBoundTypeNode}, which compares the declaration and
 * arguments of a generic reading to a checker-created instantiation.
 */
function matchesInstantiation(
  declared: BoundTypeArgument,
  candidate: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const resolved = resolvedArgumentOf(declared.type, declared.bound);
  if (resolved.type === candidate) return true;
  const argumentsMatch = (
    declaredArguments: readonly ts.Type[],
    candidateArguments: readonly ts.Type[],
  ): boolean =>
    declaredArguments.length === candidateArguments.length &&
    declaredArguments.every((type, index) =>
      matchesInstantiation(
        resolved.bound ? { type, bound: resolved.bound } : { type },
        candidateArguments[index]!,
        checker,
      )
    );
  if (resolved.type.aliasSymbol) {
    return resolved.type.aliasSymbol === candidate.aliasSymbol &&
      argumentsMatch(
        resolved.type.aliasTypeArguments ?? [],
        candidate.aliasTypeArguments ?? [],
      );
  }
  const isReference = (type: ts.Type): type is ts.TypeReference =>
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
  return isReference(resolved.type) && isReference(candidate) &&
    resolved.type.target === candidate.target &&
    argumentsMatch(
      checker.getTypeArguments(resolved.type),
      checker.getTypeArguments(candidate),
    );
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
