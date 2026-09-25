/**
 * Recognizes the brand a scope wrapper leaves on the type it resolves to.
 * `PerUser<T>` is `T & { readonly [SCOPE_BRAND]?: "user" }` (`Scoped` in
 * `packages/api/index.ts`), so a resolved type carries its scope in that
 * member however the wrapper was reached: written in place, or through any
 * chain of aliases, whose outermost alias is all the checker reports.
 *
 * The transformer reads a wrapper this way where it holds only a resolved type.
 * Schema generation recognizes a wrapper by name instead
 * (`ts_to_json_schema_mapping.md` §10), so `Scoped<T, S>` written directly is
 * read as a scope wrapper by neither.
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

/**
 * The scope the wrapper named `name` declares, or `undefined` for a name that
 * is not a scope wrapper's.
 */
export function scopeForWrapperName(
  name: string | undefined,
): SchemaScope | undefined {
  return (Object.keys(SCOPE_WRAPPER_FOR_SCOPE) as SchemaScope[]).find(
    (scope) => SCOPE_WRAPPER_FOR_SCOPE[scope] === name,
  );
}

/** A resolved scope wrapper: its scope, and the types it wraps. */
export interface ScopeBrand {
  /** The scope the brand declares. */
  readonly scope: SchemaScope;

  /**
   * The payload's alternatives, one per member of a union the brand was
   * distributed over, and one for any other payload. Each lists the members
   * the brand is intersected with, which intersect to that alternative.
   */
  readonly payload: readonly (readonly ts.Type[])[];
}

/**
 * The scope wrapper `type` resolves to, or `undefined` for a type that carries
 * no `commonfabric` `SCOPE_BRAND`. A wrapper around a union resolves to a union
 * of branded members, which is read as one wrapper when every member carries
 * the same scope.
 */
export function getScopeBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): ScopeBrand | undefined {
  if (!type.isUnion()) {
    const brand = brandOfIntersection(type, checker);
    return brand && { scope: brand.scope, payload: [brand.members] };
  }
  const payload: (readonly ts.Type[])[] = [];
  let scope: SchemaScope | undefined;
  for (const member of type.types) {
    const brand = brandOfIntersection(member, checker);
    if (!brand || (scope !== undefined && brand.scope !== scope)) {
      return undefined;
    }
    scope = brand.scope;
    payload.push(brand.members);
  }
  return scope === undefined ? undefined : { scope, payload };
}

/**
 * Helper for `getScopeBrand()`, which returns the scope an intersection's
 * brand member declares and the members intersected with it, or `undefined`
 * for a type that is not such an intersection.
 */
function brandOfIntersection(
  type: ts.Type,
  checker: ts.TypeChecker,
): { scope: SchemaScope; members: readonly ts.Type[] } | undefined {
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
  return scope === undefined ? undefined : { scope, members: payload };
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
    const declared = key && key.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(key)
      : key;
    return declared !== undefined && declared.getName() === "SCOPE_BRAND" &&
      isCommonFabricSymbol(declared);
  });
}
