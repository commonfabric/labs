/**
 * Recognizes the brand a scope wrapper leaves on the type it resolves to.
 * `PerUser<T>` is `T & { readonly [SCOPE_BRAND]?: "user" }` for a `T` that is
 * not `null` or `undefined`, and holds the `null` and `undefined` of a `T`
 * that has them beside it (`Scoped` in `packages/api/index.ts`). So a resolved
 * type carries its scope in that member however the wrapper was reached:
 * written in place, or through any chain of aliases.
 *
 * The transformer reads a wrapper this way where it holds only a resolved type,
 * and schema generation where no node or alias names the wrapper as a whole,
 * as for `PerUser<T> | null` (`ts_to_json_schema_mapping.md` §10).
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
 * scope. A member a scope wrapper's alias names, as `PerUser<A>` in
 * `PerUser<A> | null`, is read by the alias: its scope from the wrapper's
 * name, and its payload as the argument written for it, whose own alias, as
 * `Confidential<A, …>`, the brand's other members do not keep.
 */
export function getScopeBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): ScopeBrand | undefined {
  if (!type.isUnion()) {
    const brand = brandOfWrapperAlias(type, checker) ??
      brandOfIntersection(type, checker);
    return brand && { scope: brand.scope, payload: [brand.members] };
  }
  const payload: (readonly ts.Type[])[] = [];
  let scope: SchemaScope | undefined;
  for (const member of type.types) {
    if ((member.flags & NULLISH) !== 0) {
      payload.push([member]);
      continue;
    }
    const brand = brandOfWrapperAlias(member, checker) ??
      brandOfIntersection(member, checker);
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
 * Whether `type` carries the brands of two different scopes on one value, as
 * the checker resolves `PerUser<PerSession<T>>` to: a scope wrapper nested in
 * another with no cell between them, which `getScopeBrand()` reads as no
 * wrapper at all. The checker folds two brands of one scope into one, so a
 * wrapper nested in one of its own scope is the wrapper alone.
 */
export function hasNestedScopeBrands(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return (type.isUnion() ? type.types : [type]).some((member) =>
    member.isIntersection() &&
    new Set(
        member.types.map((part) => scopeOfBrandMember(part, checker)).filter(
          (scope) => scope !== undefined,
        ),
      ).size > 1
  );
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
 * where its alias is one of `commonfabric`'s scope wrappers, `PerUser<A>` or
 * `Scoped<A, "user">`, or `undefined` for any other type. While `A` holds a
 * type parameter the brand member is deferred, so the alias is all that names
 * the wrapper.
 */
function brandOfWrapperAlias(
  type: ts.Type,
  checker: ts.TypeChecker,
): { scope: SchemaScope; members: readonly ts.Type[] } | undefined {
  const alias = type.aliasSymbol;
  const [payload, scope] = type.aliasTypeArguments ?? [];
  if (!alias || !payload || !isCommonFabricSymbol(alias)) return undefined;
  const wrapperScope = scopeForWrapperName(alias.getName());
  if (wrapperScope !== undefined) {
    return { scope: wrapperScope, members: [payload] };
  }
  const literal = scope && checker.getNonNullableType(scope);
  return alias.getName() === "Scoped" && literal?.isStringLiteral() &&
      Object.hasOwn(SCOPE_WRAPPER_FOR_SCOPE, literal.value)
    ? { scope: literal.value as SchemaScope, members: [payload] }
    : undefined;
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
