import ts from "typescript";

export interface TypeTraversalOptions<T> {
  /** TypeScript type checker */
  readonly checker: ts.TypeChecker;

  /** Function to check each type and potentially return a result */
  readonly checkType: (type: ts.Type) => T | undefined;

  /** Whether to check apparent type (default: false) */
  readonly visitApparentType?: boolean;

  /** Whether to traverse base types for interfaces (default: false) */
  readonly visitBaseTypes?: boolean;

  /** Whether to traverse type reference targets (default: false) */
  readonly visitTypeReferenceTarget?: boolean;
}

/**
 * Traverses a TypeScript type hierarchy with configurable behavior.
 * Handles unions, intersections, type references, and base types.
 * Uses a seen set to avoid infinite recursion on circular types.
 *
 * @param type - The type to traverse
 * @param options - Configuration for traversal behavior
 * @param seen - Set of already-visited types (for cycle detection)
 * @returns Result from checkType function, or undefined if no match found
 */
export function traverseTypeHierarchy<T>(
  type: ts.Type,
  options: TypeTraversalOptions<T>,
  seen = new Set<ts.Type>(),
): T | undefined {
  // Prevent infinite recursion on circular types
  if (seen.has(type)) return undefined;
  seen.add(type);

  // Check the type directly first
  const direct = options.checkType(type);
  if (direct !== undefined) return direct;

  // Check apparent type if requested
  if (options.visitApparentType) {
    const apparent = options.checker.getApparentType(type);
    if (apparent !== type) {
      const fromApparent = traverseTypeHierarchy(apparent, options, seen);
      if (fromApparent !== undefined) return fromApparent;
    }
  }

  // A union or an intersection matches as its first matching member does.
  if (type.isUnionOrIntersection()) {
    for (const child of type.types) {
      const result = traverseTypeHierarchy(child, options, seen);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  // Handle object types
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;

    // Check type reference targets if requested
    if (
      options.visitTypeReferenceTarget &&
      objectType.objectFlags & ts.ObjectFlags.Reference
    ) {
      const typeRef = objectType as ts.TypeReference;
      if (typeRef.target) {
        const fromTarget = traverseTypeHierarchy(typeRef.target, options, seen);
        if (fromTarget !== undefined) return fromTarget;
      }
    }

    // Check base types if requested
    if (
      options.visitBaseTypes &&
      objectType.objectFlags & ts.ObjectFlags.ClassOrInterface
    ) {
      const baseTypes = options.checker.getBaseTypes(
        objectType as ts.InterfaceType,
      ) ?? [];
      for (const base of baseTypes) {
        const fromBase = traverseTypeHierarchy(base, options, seen);
        if (fromBase !== undefined) return fromBase;
      }
    }
  }

  return undefined;
}
