/**
 * Recognizes the brand a scope wrapper leaves on the type it resolves to.
 * `PerUser<T>` is `T & { readonly [SCOPE_BRAND]?: "user" }` (`Scoped` in
 * `packages/api/index.ts`), so a resolved type carries its scope in that
 * member however the wrapper was reached: written in place, or through any
 * chain of aliases, whose outermost alias is all the checker reports.
 */

import type { SchemaScope } from "@commonfabric/api";
import ts from "typescript";

import { isCommonFabricSymbol } from "./common-fabric-symbols.ts";

/** The wrapper `commonfabric` declares for each scope. */
export const SCOPE_WRAPPER_FOR_SCOPE: Readonly<Record<SchemaScope, string>> = {
  space: "PerSpace",
  user: "PerUser",
  session: "PerSession",
  any: "PerAny",
};

/** A resolved scope wrapper: its scope, and the types it wraps. */
export interface ScopeBrand {
  readonly scope: SchemaScope;
  /**
   * The members of the intersection other than the brand, which intersect to
   * the wrapper's payload.
   */
  readonly payload: readonly ts.Type[];
}

/**
 * The scope wrapper `type` resolves to, or `undefined` for a type that carries
 * no `commonfabric` `SCOPE_BRAND`. A wrapper around a union resolves to a union
 * of branded members rather than to one intersection, and is not read here.
 */
export function getScopeBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): ScopeBrand | undefined {
  if ((type.flags & ts.TypeFlags.Intersection) === 0) return undefined;
  const payload: ts.Type[] = [];
  let scope: SchemaScope | undefined;
  for (const member of (type as ts.IntersectionType).types) {
    const memberScope = scopeOfBrandMember(member, checker);
    if (memberScope === undefined) {
      payload.push(member);
    } else if (scope === undefined || scope === memberScope) {
      scope = memberScope;
    } else {
      return undefined;
    }
  }
  return scope === undefined ? undefined : { scope, payload };
}

/**
 * The scope that `member` declares when it is the brand member
 * `{ readonly [SCOPE_BRAND]?: S }`, and `undefined` for any other type.
 */
function scopeOfBrandMember(
  member: ts.Type,
  checker: ts.TypeChecker,
): SchemaScope | undefined {
  if ((member.flags & ts.TypeFlags.Object) === 0) return undefined;
  const properties = checker.getPropertiesOfType(member);
  if (properties.length !== 1) return undefined;
  const brand = properties[0]!;
  if (!isScopeBrandProperty(brand, checker)) return undefined;
  const brandType = checker.getNonNullableType(checker.getTypeOfSymbol(brand));
  if (!brandType.isStringLiteral()) return undefined;
  const scope = brandType.value;
  return Object.hasOwn(SCOPE_WRAPPER_FOR_SCOPE, scope)
    ? scope as SchemaScope
    : undefined;
}

/** Whether `property` is keyed by `commonfabric`'s own `SCOPE_BRAND`. */
function isScopeBrandProperty(
  property: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  return (property.declarations ?? []).some((declaration) => {
    const name = ts.getNameOfDeclaration(declaration);
    if (!name || !ts.isComputedPropertyName(name)) return false;
    const key = checker.getSymbolAtLocation(name.expression);
    return key !== undefined && key.getName() === "SCOPE_BRAND" &&
      isCommonFabricSymbol(key);
  });
}
