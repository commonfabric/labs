import ts from "typescript";
import { detectTrustedFactoryType } from "@commonfabric/schema-generator";

import { isCommonFabricSymbol } from "@commonfabric/schema-generator/common-fabric-symbols";

const FRAMEWORK_PROVIDED_ALIAS = "FrameworkProvided";
const FRAMEWORK_PROVIDED_MARKER_PREFIX = "__@FRAMEWORK_PROVIDED_MARKER";

/** A trusted FrameworkProvided leaf, expressed relative to the inspected type. */
export type FrameworkProvidedPath = readonly string[];

/**
 * Find every FrameworkProvided leaf in a data type.
 *
 * Detection is semantic and provenance checked. The public alias is accepted
 * only when it resolves to Common Fabric, and the expanded branded arm is
 * accepted only when its unique-symbol property was declared by Common
 * Fabric. A user alias or copied marker spelling therefore grants no trust.
 */
export function findFrameworkProvidedPaths(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly FrameworkProvidedPath[] {
  const paths: string[][] = [];
  walkDataType(type, checker, [], new Set(), paths);
  return dedupePaths(paths);
}

/** Find FrameworkProvided paths in every factory input arm of `type`. */
export function findFactoryInputFrameworkProvidedPaths(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly FrameworkProvidedPath[] {
  const paths: string[][] = [];
  const visit = (
    current: ts.Type,
    prefix: readonly string[],
    active: Set<ts.Type>,
  ): void => {
    if (active.has(current)) return;
    active.add(current);
    try {
      // Factory aliases are commonly branded intersections. Detect the full
      // callable before decomposing compound types or the public factory
      // contract would be split away from its brand.
      const factory = detectTrustedFactoryType(current, checker);
      if (factory) {
        for (
          const path of findFrameworkProvidedPaths(factory.inputType, checker)
        ) {
          paths.push([...prefix, ...path]);
        }
        return;
      }

      if (
        current.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)
      ) {
        for (const member of (current as ts.UnionOrIntersectionType).types) {
          visit(member, prefix, active);
        }
        return;
      }

      if (current.getCallSignatures().length > 0) return;
      if ((current.flags & ts.TypeFlags.Object) === 0) return;

      if (checker.isTupleType(current)) {
        for (
          const element of checker.getTypeArguments(current as ts.TypeReference)
        ) {
          visit(element, [...prefix, "[]"], active);
        }
        return;
      }
      if (checker.isArrayType(current)) {
        const element = checker.getTypeArguments(
          current as ts.TypeReference,
        )[0];
        if (element) visit(element, [...prefix, "[]"], active);
        return;
      }

      for (const property of checker.getPropertiesOfType(current)) {
        const name = property.getName();
        if (name.startsWith("__@")) continue;
        const declaration = property.valueDeclaration ??
          property.declarations?.[0];
        if (!declaration) continue;
        visit(
          checker.getTypeOfSymbolAtLocation(property, declaration),
          [...prefix, name],
          active,
        );
      }

      const stringIndex = checker.getIndexTypeOfType(
        current,
        ts.IndexKind.String,
      );
      if (stringIndex) visit(stringIndex, [...prefix, "*"], active);
      const numberIndex = checker.getIndexTypeOfType(
        current,
        ts.IndexKind.Number,
      );
      if (numberIndex) visit(numberIndex, [...prefix, "[]"], active);
    } finally {
      active.delete(current);
    }
  };

  visit(type, [], new Set());
  return dedupePaths(paths);
}

function walkDataType(
  type: ts.Type,
  checker: ts.TypeChecker,
  path: readonly string[],
  active: Set<ts.Type>,
  paths: string[][],
): void {
  if (active.has(type)) return;
  active.add(type);
  try {
    if (isTrustedFrameworkProvided(type, checker)) {
      paths.push([...path]);
      return;
    }

    if (type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) {
      for (const member of (type as ts.UnionOrIntersectionType).types) {
        walkDataType(member, checker, path, active, paths);
      }
      return;
    }

    if (
      type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never |
        ts.TypeFlags.Null | ts.TypeFlags.Undefined)
    ) {
      return;
    }

    // Factory callable structure is implementation surface, not authored
    // data. Callers inspect its public input contract explicitly via
    // findFactoryInputFrameworkProvidedPaths().
    if (type.getCallSignatures().length > 0) return;

    if ((type.flags & ts.TypeFlags.Object) === 0) return;

    if (checker.isTupleType(type)) {
      const tuple = type as ts.TypeReference;
      for (const element of checker.getTypeArguments(tuple)) {
        walkDataType(element, checker, [...path, "[]"], active, paths);
      }
      return;
    }
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      if (element) {
        walkDataType(element, checker, [...path, "[]"], active, paths);
      }
      return;
    }

    for (const property of checker.getPropertiesOfType(type)) {
      const name = property.getName();
      if (name.startsWith("__@")) continue;
      const declaration = property.valueDeclaration ??
        property.declarations?.[0];
      if (!declaration) continue;
      const propertyType = checker.getTypeOfSymbolAtLocation(
        property,
        declaration,
      );
      walkDataType(
        propertyType,
        checker,
        [...path, name],
        active,
        paths,
      );
    }

    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      walkDataType(
        stringIndex,
        checker,
        [...path, "*"],
        active,
        paths,
      );
    }
    const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (numberIndex) {
      walkDataType(
        numberIndex,
        checker,
        [...path, "[]"],
        active,
        paths,
      );
    }
  } finally {
    active.delete(type);
  }
}

function isTrustedFrameworkProvided(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const alias = type.aliasSymbol;
  if (
    alias?.name === FRAMEWORK_PROVIDED_ALIAS &&
    isCommonFabricSymbol(alias, checker)
  ) {
    return true;
  }

  return checker.getPropertiesOfType(type).some((property) =>
    property.getName().startsWith(FRAMEWORK_PROVIDED_MARKER_PREFIX) &&
    isCommonFabricSymbol(property, checker)
  );
}

function dedupePaths(paths: readonly (readonly string[])[]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const path of paths) {
    const key = JSON.stringify(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([...path]);
  }
  return result;
}
