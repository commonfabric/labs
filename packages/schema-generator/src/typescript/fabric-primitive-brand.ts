import ts from "typescript";

/**
 * The prefix TypeScript gives the property keyed by the `FABRIC_PRIMITIVE_BRAND`
 * symbol (`@commonfabric/api`), `__@FABRIC_PRIMITIVE_BRAND@<id>`; the name of
 * the constant is what identifies it, as with the other symbol-keyed markers.
 */
const FABRIC_PRIMITIVE_BRAND_PREFIX = "__@FABRIC_PRIMITIVE_BRAND@";

/**
 * Whether the type carries the `FabricPrimitive` nominal brand, directly or by
 * inheritance. This is what makes a type named e.g. `FabricBytes` actually BE
 * the `FabricPrimitive` class rather than an unrelated user type that happens
 * to share the name: schema generation classifies by it (the native-type
 * formatter's `supportsType`, and named-type hoisting in `type-utils.ts`), and
 * the transformer's module-scope data wrap admits a construction by it.
 */
export function declaresFabricPrimitiveBrand(type: ts.Type): boolean {
  return type.getProperties().some((property) =>
    (property.escapedName as string).startsWith(FABRIC_PRIMITIVE_BRAND_PREFIX)
  );
}
