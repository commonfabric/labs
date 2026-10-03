/**
 * Recognizes a writer policy from a type alone: a CFC metadata carrier whose
 * metadata holds a `writeAuthorizedBy` or a `writePolicyAnyOf`. Only a
 * `typeof` node names a writer, so a type says that a value carries one but
 * never which.
 */

import ts from "typescript";

import { cfcCarrierProperty } from "./cfc-carrier.ts";

/**
 * The writer policy `metadata`, a CFC carrier's metadata type, holds, by the
 * alias that writes it: a `writeAuthorizedBy` or a `writePolicyAnyOf`, whose
 * writers only `typeof` nodes name, so no reading of the type alone mints
 * them. `undefined` for metadata holding neither.
 */
export const writerPolicyHeldBy = (
  metadata: ts.Type,
  checker: ts.TypeChecker,
): "WriteAuthorizedBy" | "WritePolicyAnyOf" | undefined => {
  const value = checker.getNonNullableType(metadata);
  return value.getProperty("writePolicyAnyOf")
    ? "WritePolicyAnyOf"
    : value.getProperty("writeAuthorizedBy")
    ? "WriteAuthorizedBy"
    : undefined;
};

/**
 * Whether `type` itself carries a writer policy: a member of an intersection
 * that is a CFC carrier holding one, read through unions and intersections
 * but not into the values the type holds.
 */
export const carriesWriterPolicy = (
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean =>
  type.isUnionOrIntersection() &&
  type.types.some((member) => {
    const carrier = cfcCarrierProperty(member);
    return carrier
      ? writerPolicyHeldBy(checker.getTypeOfSymbol(carrier), checker) !==
        undefined
      : carriesWriterPolicy(member, checker);
  });

/**
 * Whether `type`, or a value it holds, carries a writer policy: a member of an
 * intersection that is a CFC carrier holding one, read through unions,
 * intersections, object properties and index signatures, and array and tuple
 * elements. Each type is read once, which is what ends the reading of a
 * recursive type; no depth bound cuts it short, since one would answer that a
 * policy past it is absent. A function's signature, a cell's methods among
 * them, holds no value, and is not read.
 */
export const holdsWriterPolicy = (
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean => {
  if (seen.has(type)) return false;
  seen.add(type);
  const within = (inner: ts.Type) => holdsWriterPolicy(inner, checker, seen);
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => {
      const carrier = cfcCarrierProperty(member);
      return carrier
        ? writerPolicyHeldBy(checker.getTypeOfSymbol(carrier), checker) !==
          undefined
        : within(member);
    });
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker.getTypeArguments(type as ts.TypeReference).some(within);
  }
  if (type.getCallSignatures().length > 0) return false;
  return type.getProperties().some((property) =>
    within(checker.getTypeOfSymbol(property))
  ) ||
    checker.getIndexInfosOfType(type).some((info) => within(info.type));
};
