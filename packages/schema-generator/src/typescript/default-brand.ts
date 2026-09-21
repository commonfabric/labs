/**
 * Recognizes the brand `Default<T, V>` leaves on the types it expands to. The
 * checker resolves the alias away on most paths, into a union whose branded
 * members intersect a value type with `{ readonly [DEFAULT_MARKER]: V }`, and
 * the marker's payload is then the only place `V` survives at the type level
 * (see `Default` in `packages/api/index.ts`).
 */

import ts from "typescript";

/**
 * Recognizes an actual `DEFAULT_MARKER` property on a member of an expanded
 * `Default`. Ordinary empty objects and unrelated symbol brands do not promise
 * a default.
 */
export function hasDefaultMarker(
  member: ts.Type,
  typeChecker: ts.TypeChecker,
): boolean {
  return getDefaultMarkerProperty(member, typeChecker) !== undefined;
}

/**
 * Returns the type of the `DEFAULT_MARKER` payload on a member of an expanded
 * `Default` — its `V` — or `undefined` for a member that carries no marker.
 */
export function getDefaultMarkerPayload(
  member: ts.Type,
  typeChecker: ts.TypeChecker,
): ts.Type | undefined {
  const marker = getDefaultMarkerProperty(member, typeChecker);
  return marker && typeChecker.getTypeOfSymbol(marker);
}

/** Finds the marker on a brand-only constituent of an expanded `Default`. */
function getDefaultMarkerProperty(
  member: ts.Type,
  typeChecker: ts.TypeChecker,
): ts.Symbol | undefined {
  const brandParts = (member.flags & ts.TypeFlags.Intersection) !== 0
    ? ((member as ts.IntersectionType).types ?? []).filter((part) =>
      isBrandOnlyMarkerType(part, typeChecker)
    )
    : isBrandOnlyMarkerType(member, typeChecker)
    ? [member]
    : [];
  return brandParts
    .flatMap((part) => typeChecker.getPropertiesOfType(part))
    .find((prop) =>
      String(prop.escapedName as string).startsWith("__@DEFAULT_MARKER")
    );
}

/**
 * True for a "brand-only" object type that carries only symbol-keyed markers
 * (e.g. `{ readonly [DEFAULT_MARKER]: V }`) — no string-keyed data
 * properties. TypeScript encodes unique-symbol property names as "__@..."
 * internally; a type with only such properties is a brand, not data.
 */
function isBrandOnlyMarkerType(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const props = typeChecker.getPropertiesOfType(type);
  if (props.length === 0) return true;
  return props.every((prop) =>
    String(prop.escapedName as string).startsWith("__@")
  );
}
