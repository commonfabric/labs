import ts from "typescript";

/**
 * The prefix TypeScript gives a property keyed by a unique symbol declared as
 * `FABRIC_PRIMITIVE_BRAND` (`@commonfabric/api`),
 * `__@FABRIC_PRIMITIVE_BRAND@<id>`; the name of the constant is what
 * identifies it, as with the other symbol-keyed markers.
 */
const FABRIC_PRIMITIVE_BRAND_PREFIX = "__@FABRIC_PRIMITIVE_BRAND@";

/**
 * Whether the type carries the `FabricPrimitive` nominal brand, directly or by
 * inheritance. This is what makes a type named e.g. `FabricBytes` actually BE
 * the `FabricPrimitive` class rather than an unrelated user type that happens
 * to share the name: schema generation classifies by it (the native-type
 * formatter's `supportsType`, and named-type hoisting in `type-utils.ts`).
 *
 * The brand is read by the name of its key, so this says what a type claims
 * to be, not who declared it: a type that declares a member under any symbol
 * named `FABRIC_PRIMITIVE_BRAND` carries it. A caller that acts on the claim
 * establishes the declaring side itself, as the transformer's module-scope
 * data wrap does by requiring the constructor to be one `commonfabric`
 * declares.
 */
export function declaresFabricPrimitiveBrand(type: ts.Type): boolean {
  return type.getProperties().some((property) =>
    (property.escapedName as string).startsWith(FABRIC_PRIMITIVE_BRAND_PREFIX)
  );
}
