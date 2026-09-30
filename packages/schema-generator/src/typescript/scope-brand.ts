/**
 * Recognizes the brand a scope wrapper leaves on the type it resolves to.
 * `PerUser<T>` is `T & { readonly [SCOPE_BRAND]?: "user" }` for a `T` that is
 * not `null` or `undefined`, and `T` itself for one that is (`Scoped` in
 * `packages/api/index.ts`). So a resolved type carries its scope in that
 * member however the wrapper was reached: written in place, or through any
 * chain of aliases. `Scoped` is a conditional type, and the checker reports no
 * alias for the type it resolves to, so the brand is what names the wrapper.
 *
 * The transformer reads a wrapper this way where it holds only a resolved type,
 * and schema generation where no node or alias names the wrapper
 * (`ts_to_json_schema_mapping.md` §10).
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
   * the brand is intersected with, which intersect to that alternative, except
   * a `null` or `undefined` alternative, which `Scoped` keeps outside the brand
   * and which lists itself alone.
   */
  readonly payload: readonly (readonly ts.Type[])[];
}

/**
 * The scope wrapper `type` resolves to, or `undefined` for a type that carries
 * no `commonfabric` `SCOPE_BRAND`. A wrapper around a union resolves to a union
 * of branded members, beside any `null` or `undefined` it holds, which carry no
 * brand. It is read as one wrapper when every other member carries the same
 * scope. A wrapper whose payload holds a type parameter is `Scoped<T, S>` the
 * checker defers, which is read by its arguments.
 */
export function getScopeBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): ScopeBrand | undefined {
  if (!type.isUnion()) {
    const brand = brandOfIntersection(type, checker) ??
      brandOfDeferredScoped(type);
    return brand && { scope: brand.scope, payload: [brand.members] };
  }
  const payload: (readonly ts.Type[])[] = [];
  let scope: SchemaScope | undefined;
  for (const member of type.types) {
    if ((member.flags & NULLISH) !== 0) {
      payload.push([member]);
      continue;
    }
    const brand = brandOfIntersection(member, checker) ??
      brandOfDeferredScoped(member);
    if (!brand || (scope !== undefined && brand.scope !== scope)) {
      return undefined;
    }
    scope = brand.scope;
    payload.push(brand.members);
  }
  return scope === undefined ? undefined : { scope, payload };
}

/**
 * The type `type`, which the scope wrapper `brand` resolves to, holds: each
 * alternative of its payload, the one member it has where it has one, and
 * otherwise the branded member itself, whose other members the checker cannot
 * intersect again without the brand. A reader takes a brand still held there
 * as no part of the value (`GenerationContext.scopeBrandRead`).
 */
export function scopePayloadType(
  type: ts.Type,
  brand: ScopeBrand,
  checker: ts.TypeChecker,
): ts.Type {
  const branded = type.isUnion() ? type.types : [type];
  const alternatives = brand.payload.map((members, index) =>
    members.length === 1 ? members[0]! : branded[index]!
  );
  if (alternatives.length === 1) return alternatives[0]!;
  const getUnionType = (checker as ts.TypeChecker & {
    getUnionType?: (types: readonly ts.Type[]) => ts.Type;
  }).getUnionType;
  return getUnionType?.(alternatives) ?? type;
}

/**
 * Whether `member`, a member of an intersection, is a scope wrapper's brand
 * `{ readonly [SCOPE_BRAND]?: S }`, which holds no part of the value.
 */
export function isScopeBrandMember(
  member: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return scopeOfBrandMember(member, checker) !== undefined;
}

/** The flags of a member `Scoped` keeps outside the brand. */
const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined;

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
 * Helper for `getScopeBrand()`, which returns the scope and payload of `type`
 * where it is `Scoped<T, S>` the checker defers, as it does while `T` holds a
 * type parameter, or `undefined` for any other type. Such a type is the
 * conditional `Scoped` declares, with `Scoped` for its alias and the payload
 * and the scope for its arguments.
 */
function brandOfDeferredScoped(
  type: ts.Type,
): { scope: SchemaScope; members: readonly ts.Type[] } | undefined {
  if ((type.flags & ts.TypeFlags.Conditional) === 0) return undefined;
  const alias = type.aliasSymbol;
  const [payload, scope] = type.aliasTypeArguments ?? [];
  if (
    alias?.getName() !== "Scoped" || !isCommonFabricSymbol(alias) ||
    !payload || !scope?.isStringLiteral() ||
    !Object.hasOwn(SCOPE_WRAPPER_FOR_SCOPE, scope.value)
  ) {
    return undefined;
  }
  return { scope: scope.value as SchemaScope, members: [payload] };
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
