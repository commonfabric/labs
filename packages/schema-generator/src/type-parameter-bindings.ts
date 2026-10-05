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
 * compound type is matched to a checker-created instantiation in the context
 * or `candidates`. Its authored node stays available
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
  const roots = context.instantiatedAs
    ? [context.instantiatedAs, ...candidates]
    : candidates;
  for (const candidate of instantiationsOf(roots, context.typeChecker)) {
    if (matchesInstantiation(argument, candidate, context.typeChecker)) {
      return candidate;
    }
  }
  return argument.type;
}

/**
 * Checker-created types reachable through union members and type arguments.
 * A default's instantiated value may live in its marker's argument after the
 * checker has flattened the enclosing union.
 */
function* instantiationsOf(
  roots: readonly ts.Type[],
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): Generator<ts.Type> {
  for (const type of roots) {
    if (seen.has(type)) continue;
    seen.add(type);
    yield type;
    const children = [
      ...type.aliasTypeArguments ?? [],
      ...isReference(type) ? checker.getTypeArguments(type) : [],
      ...type.isUnionOrIntersection() ? type.types : [],
    ];
    yield* instantiationsOf(children, checker, seen);
  }
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
  active: {
    type: ts.Type;
    candidate: ts.Type;
    bound: BoundTypeParameters | undefined;
  }[] = [],
): boolean {
  const resolved = resolvedArgumentOf(declared.type, declared.bound);
  if (resolved.type === candidate) return true;
  if (
    active.some((pair) =>
      pair.type === resolved.type && pair.candidate === candidate &&
      pair.bound === resolved.bound
    )
  ) return true;
  active.push({ type: resolved.type, candidate, bound: resolved.bound });
  const underBindings = (type: ts.Type): BoundTypeArgument =>
    resolved.bound ? { type, bound: resolved.bound } : { type };
  const argumentsMatch = (
    declaredArguments: readonly ts.Type[],
    candidateArguments: readonly ts.Type[],
  ): boolean =>
    declaredArguments.length === candidateArguments.length &&
    declaredArguments.every((type, index) =>
      matchesInstantiation(
        underBindings(type),
        candidateArguments[index]!,
        checker,
        active,
      )
    );
  try {
    if (resolved.type.aliasSymbol) {
      return resolved.type.aliasSymbol === candidate.aliasSymbol &&
        argumentsMatch(
          resolved.type.aliasTypeArguments ?? [],
          candidate.aliasTypeArguments ?? [],
        );
    }
    if (isReference(resolved.type) && isReference(candidate)) {
      return resolved.type.target === candidate.target && argumentsMatch(
        checker.getTypeArguments(resolved.type),
        checker.getTypeArguments(candidate),
      );
    }
    if (resolved.type.isUnion()) {
      const flatten = (argument: BoundTypeArgument): BoundTypeArgument[] => {
        const current = resolvedArgumentOf(argument.type, argument.bound);
        return current.type.isUnion()
          ? current.type.types.flatMap((type) =>
            flatten(current.bound ? { type, bound: current.bound } : { type })
          )
          : (current.type.flags & ts.TypeFlags.Never) !== 0
          ? []
          : [current];
      };
      const flattened = flatten(resolved);
      const dominant = flattened.find(({ type }) =>
        (type.flags & ts.TypeFlags.Any) !== 0
      ) ?? flattened.find(({ type }) =>
        (type.flags & ts.TypeFlags.Unknown) !== 0
      );
      const declaredMembers = dominant ? [dominant] : flattened;
      const candidateMembers = candidate.isUnion()
        ? candidate.types
        : [candidate];
      const matches = (member: BoundTypeArgument, candidate: ts.Type) =>
        matchesInstantiation(member, candidate, checker, active);
      // The checker can absorb a bound literal into a primitive union arm,
      // as `0 | number` becomes `number`. Assignability compares these
      // already-resolved primitive leaves without interpreting generic types.
      const primitive = (type: ts.Type) =>
        (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral |
          ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral |
          ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral |
          ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral |
          ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol |
          ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !==
          0;
      const covered = (member: BoundTypeArgument, candidate: ts.Type) =>
        matches(member, candidate) ||
        (primitive(member.type) && primitive(candidate) &&
          checker.isTypeAssignableTo(member.type, candidate));
      return declaredMembers.every((member) =>
        candidateMembers.some((candidate) => covered(member, candidate))
      ) && candidateMembers.every((candidate) =>
        declaredMembers.some((member) =>
          matches(member, candidate) ||
          (primitive(member.type) && primitive(candidate) &&
            checker.isTypeAssignableTo(candidate, member.type))
        )
      );
    }
    if (
      isAnonymousObject(resolved.type) && isAnonymousObject(candidate) &&
      resolved.type.getSymbol() &&
      resolved.type.getSymbol() === candidate.getSymbol() &&
      checker.getSignaturesOfType(resolved.type, ts.SignatureKind.Call)
          .length === 0 &&
      checker.getSignaturesOfType(resolved.type, ts.SignatureKind.Construct)
          .length === 0
    ) {
      const properties = checker.getPropertiesOfType(resolved.type);
      const candidateProperties = checker.getPropertiesOfType(candidate);
      const indexes = checker.getIndexInfosOfType(resolved.type);
      const candidateIndexes = checker.getIndexInfosOfType(candidate);
      return properties.length === candidateProperties.length &&
        properties.every((property) => {
          const candidateProperty = candidate.getProperty(property.getName());
          return candidateProperty !== undefined && matchesInstantiation(
            underBindings(checker.getTypeOfSymbol(property)),
            checker.getTypeOfSymbol(candidateProperty),
            checker,
            active,
          );
        }) && indexes.length === candidateIndexes.length &&
        indexes.every((index, position) =>
          index.keyType === candidateIndexes[position]!.keyType &&
          matchesInstantiation(
            underBindings(index.type),
            candidateIndexes[position]!.type,
            checker,
            active,
          )
        );
    }
    return false;
  } finally {
    active.pop();
  }
}

/** Whether `type` is a checker-created reference with readable arguments. */
function isReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
}

/** Whether `type` is an anonymous object whose member types can be compared. */
function isAnonymousObject(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) !== 0;
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
