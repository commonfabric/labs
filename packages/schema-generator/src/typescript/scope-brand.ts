/**
 * Reads the scope a type declares through its `SCOPE_BRAND` property, which is
 * what `PerSpace`, `PerUser`, `PerSession`, and `PerAny` intersect onto the type
 * they wrap. The brand is part of the type, so it is present whatever name the
 * type was reached by; a wrapper's name is visible only where it is written.
 */

import ts from "typescript";

import type { SchemaScope } from "@commonfabric/api";

/**
 * Every scope a brand may declare. Keyed by `SchemaScope` so that a scope added
 * to the api is a compile error here until it is listed.
 */
const SCHEMA_SCOPES: Readonly<Record<SchemaScope, true>> = {
  space: true,
  user: true,
  session: true,
  any: true,
};

/**
 * Helper for the brand readers, which recognizes the `SCOPE_BRAND` property by
 * the internal name the checker gives a unique-symbol key.
 */
function isScopeBrandProperty(prop: ts.Symbol): boolean {
  return String(prop.escapedName).startsWith("__@SCOPE_BRAND");
}

// A type's properties are fixed within the checker that owns it, and the
// formatter chain asks about every type it visits. A type object belongs to
// one checker, so the type alone is the key.
const brandPropertyCache = new WeakMap<ts.Type, ts.Symbol | null>();

/**
 * Helper for the brand readers, which finds the `SCOPE_BRAND` property among
 * the properties of `type`. A union reports only the properties every member
 * has, so one branded member among unbranded ones yields nothing.
 */
function scopeBrandProperty(type: ts.Type): ts.Symbol | undefined {
  const structured = ts.TypeFlags.Object | ts.TypeFlags.Intersection |
    ts.TypeFlags.Union;
  if ((type.flags & structured) === 0) return undefined;

  let brand = brandPropertyCache.get(type);
  if (brand === undefined) {
    brand = type.getProperties().find(isScopeBrandProperty) ?? null;
    brandPropertyCache.set(type, brand);
  }
  return brand ?? undefined;
}

/**
 * Returns `true` when `type` carries a `SCOPE_BRAND` property, whether or not
 * that brand names a single scope. A union carries one only when every member
 * does, which is how the checker represents a wrapper around a union
 * (`PerUser<boolean>` is `(true & Brand) | (false & Brand)`).
 */
export function hasScopeBrand(type: ts.Type): boolean {
  return scopeBrandProperty(type) !== undefined;
}

/**
 * Returns the scope `type` declares through its `SCOPE_BRAND` property, or
 * `undefined` when it carries no brand or the brand names no single scope. The
 * second case is what nesting two different wrappers without a cell between
 * them leaves behind: the two literals intersect to `never`.
 */
export function getScopeBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): SchemaScope | undefined {
  const brand = scopeBrandProperty(type);
  if (!brand) return undefined;

  // The property is optional, so its type arrives as a union with `undefined`.
  const brandType = checker.getTypeOfSymbol(brand);
  const members = brandType.isUnion() ? brandType.types : [brandType];
  let scope: SchemaScope | undefined;
  for (const member of members) {
    if ((member.flags & ts.TypeFlags.Undefined) !== 0) continue;
    if (
      !member.isStringLiteral() || !Object.hasOwn(SCHEMA_SCOPES, member.value)
    ) {
      return undefined;
    }
    if (scope !== undefined && scope !== member.value) return undefined;
    scope = member.value as SchemaScope;
  }
  return scope;
}

/**
 * Returns `true` for an object type whose only members are scope brands: the
 * constituent a scope wrapper adds, as opposed to the type it wraps.
 */
export function isScopeBrandConstituent(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const props = type.getProperties();
  return props.length > 0 && props.every(isScopeBrandProperty);
}
