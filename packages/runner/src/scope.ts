import { isObjectNotArray } from "@commonfabric/utils/types";
import type {
  AsCellEntry,
  CellKind,
  CellScope,
  LinkScope,
  SchemaScope,
} from "./builder/types.ts";

export const DEFAULT_CELL_SCOPE: CellScope = "space";

export const CELL_SCOPES = ["space", "user", "session"] as const;

export const CELL_KINDS = [
  "cell",
  "opaque",
  "stream",
  "comparable",
  "readonly",
  "writeonly",
  "sqlite",
] as const satisfies readonly CellKind[];

// Keep the runtime registry exhaustive when the public CellKind union grows.
const _allCellKindsAreRegistered: Exclude<
  CellKind,
  (typeof CELL_KINDS)[number]
> extends never ? true : never = true;
void _allCellKindsAreRegistered;

const cellKinds = new Set<string>(CELL_KINDS);

export function hasOwnEnumerableDataProperty(
  value: object,
  key: PropertyKey,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable === true &&
    "value" in descriptor;
}

export function isCellKind(value: unknown): value is CellKind {
  return typeof value === "string" && cellKinds.has(value);
}

export function isAsCellEntry(value: unknown): value is AsCellEntry {
  if (isCellKind(value)) return true;
  if (!isObjectNotArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (
    !hasOwnEnumerableDataProperty(entry, "kind") || !isCellKind(entry.kind)
  ) {
    return false;
  }
  if ("scope" in entry) {
    if (!hasOwnEnumerableDataProperty(entry, "scope")) return false;
    return entry.scope === undefined || isSchemaScope(entry.scope);
  }
  return true;
}

export function isAsCellEntryArray(
  value: unknown,
): value is readonly AsCellEntry[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    if (
      !hasOwnEnumerableDataProperty(value, index) ||
      !isAsCellEntry(value[index])
    ) {
      return false;
    }
  }
  return true;
}

const scopeRankByValue: Record<CellScope, number> = {
  space: 0,
  user: 1,
  session: 2,
};

export function isCellScope(value: unknown): value is CellScope {
  return value === "space" || value === "user" || value === "session";
}

export function isSchemaScope(value: unknown): value is SchemaScope {
  return isCellScope(value) || value === "any";
}

export function isLinkScope(value: unknown): value is LinkScope {
  return value === "inherit" || isCellScope(value);
}

export function normalizeCellScope(scope: CellScope | undefined): CellScope {
  return scope ?? DEFAULT_CELL_SCOPE;
}

export function resolveLinkScope(
  scope: LinkScope | undefined,
  containingScope: CellScope | undefined,
): CellScope {
  if (scope === undefined || scope === "inherit") {
    return normalizeCellScope(containingScope);
  }
  return scope;
}

export function scopeRank(scope: CellScope): number {
  return scopeRankByValue[scope];
}

/**
 * The narrower (more restrictive) of two schema follow caps. `undefined` and
 * `"any"` mean "no cap", so they lose to any real one.
 */
export function narrowerScopeCap(
  a: SchemaScope | undefined,
  b: SchemaScope | undefined,
): SchemaScope | undefined {
  if (a === undefined || a === "any") return b;
  if (b === undefined || b === "any") return a;
  return scopeRank(a) <= scopeRank(b) ? a : b;
}

export function narrowestScope(
  scopes: Iterable<CellScope | undefined>,
): CellScope {
  let narrowest: CellScope = DEFAULT_CELL_SCOPE;
  for (const scope of scopes) {
    if (scope !== undefined && scopeRank(scope) > scopeRank(narrowest)) {
      narrowest = scope;
    }
  }
  return narrowest;
}

/**
 * A scoped schema may follow links at the same or broader scope only. For
 * example, a user-scoped schema can read space/user links but not session links.
 * Omitted schema scope and `scope: "any"` are permissive and can follow every
 * concrete link scope.
 */
export function canFollowScopedLink(
  schemaScope: SchemaScope | undefined,
  linkScope: CellScope,
): boolean {
  if (schemaScope === undefined || schemaScope === "any") {
    return true;
  }
  return scopeRank(linkScope) <= scopeRank(schemaScope);
}
