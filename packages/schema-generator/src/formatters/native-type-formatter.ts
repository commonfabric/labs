import ts from "typescript";
import type { MutableJSONSchema } from "@commonfabric/api";
import { fabricPrimitiveClassesByName } from "@commonfabric/data-model/fabric-primitives";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import { isDefaultLibrarySourceFile } from "../typescript/default-library.ts";

const NATIVE_TYPE_SCHEMAS: Record<string, MutableJSONSchema> = {
  // This schema is embedded in the code, so we can have simpler links.
  VNode: { $ref: "https://commonfabric.org/schemas/vnode.json" },
  // A `Date` is stored as a `FabricEpochNsec` and a `Uint8Array` as a
  // `FabricBytes`, so both are objects at the fabric boundary, and a value
  // stored as one reads back intact through `"object"`. (`{ type: "string" }`
  // does not: the read projects to `undefined`, which is what the `Date`
  // mapping used to do to every value read through the schema its own TS type
  // generates.) These deliberately stay `"object"` rather than adopting the
  // `FabricPrimitive` type names below: a field authored against a NATIVE TS
  // type can hold a raw native value on the way into the fabric boundary, and
  // the `FabricPrimitive` types validate by prototype only.
  Date: { type: "object" },
  RegExp: { type: "object" },
  Uint8Array: { type: "object" },
  // Fields authored against the `FabricPrimitive` classes themselves emit
  // the `FabricPrimitive` schema vocabulary: a value matches by prototype, not
  // by structure. Each class is keyed by the name a pattern declares it under,
  // and maps to the `.schemaType` its instances report. Guarded in
  // `supportsType` by the `FabricPrimitive` brand so an unrelated user type
  // sharing a name keeps its structural schema.
  ...Object.fromEntries(
    Object.entries(fabricPrimitiveClassesByName()).map((
      [name, cls],
    ) => [name, { type: cls.prototype.schemaType }]),
  ),
  // A `URL` converts to a plain string, so this one is accurate as written.
  URL: { type: "string", format: "uri" },
  ArrayBuffer: true,
  ArrayBufferLike: true,
  SharedArrayBuffer: true,
  ArrayBufferView: true,
  Uint8ClampedArray: true,
  Int8Array: true,
  Uint16Array: true,
  Int16Array: true,
  Uint32Array: true,
  Int32Array: true,
  Float32Array: true,
  Float64Array: true,
  BigInt64Array: true,
  BigUint64Array: true,
  // These types are complex, and aren't a meaningful filter
  JSONSchemaObj: true,
  JSONSchema: true,
};

/**
 * The readable value of a `SqliteDb` handle: the descriptor
 * `{ id, tables, rev }` (`docs/specs/sqlite-builtin/01-api.md`). The handle
 * type is a nominal brand — a single `unique symbol` member — so the shape its
 * members describe is empty, and a schema derived from them shapes every read
 * of the handle down to `{}`.
 *
 * `tables` holds the author-declared table schemas, arbitrary JSON Schema
 * whose per-column `ifc` labels are what a pattern reads to write a query
 * against the database, so it passes through unfiltered. The handle also
 * carries fields outside the descriptor the runtime resolves for itself
 * (`scope`, `owner`); `additionalProperties: true` is what keeps a read
 * through this schema from dropping them.
 */
const SQLITE_DATABASE_SCHEMA: MutableJSONSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    tables: { type: "object", additionalProperties: true },
    rev: { type: "number" },
  },
  additionalProperties: true,
};

/**
 * Escaped-name prefix TypeScript gives a property keyed by the exported
 * `SQLITE_DB_BRAND` unique symbol (`packages/api/index.ts`). Claiming the
 * handle by its brand rather than by the name `SqliteDatabase` keeps an
 * unrelated user type of that name on its structural schema — and, unlike the
 * name-keyed entries above, leaves the branded type its ordinary `$defs`
 * hoisting, so every `SqliteDb` position keeps referring to one descriptor.
 */
const SQLITE_DB_BRAND_PREFIX = "__@SQLITE_DB_BRAND@";

const NATIVE_TYPE_NAMES = new Set(Object.keys(NATIVE_TYPE_SCHEMAS));
const FABRIC_PRIMITIVE_TYPE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(fabricPrimitiveClassesByName()),
);
const LIB_DECLARED_NATIVE_TYPES = new Set([
  "Date",
  "RegExp",
  "URL",
  "ArrayBuffer",
  "ArrayBufferLike",
  "SharedArrayBuffer",
  "ArrayBufferView",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * Formatter that replaces specific types with a manually specified schema
 *
 * This mostly exists to support native types, but it's also used to replace
 * complex types with simpler schemas than what would be generatted, and allow
 * for referencing embedded schema definitions.
 */
export class NativeTypeFormatter implements TypeFormatter {
  supportsType(type: ts.Type, context: GenerationContext): boolean {
    if (NativeTypeFormatter.declaresSqliteDbBrand(type)) {
      return true;
    }
    const typeName = NativeTypeFormatter.#getTypeName(type);
    if (!NativeTypeFormatter.isNativeType(typeName)) {
      return false;
    }
    if (
      typeName !== undefined && LIB_DECLARED_NATIVE_TYPES.has(typeName)
    ) {
      return NativeTypeFormatter.#hasLibraryDeclaration(type, context);
    }
    if (NativeTypeFormatter.isFabricPrimitiveTypeName(typeName)) {
      return NativeTypeFormatter.declaresFabricPrimitiveBrand(type);
    }
    return true;
  }

  formatType(
    type: ts.Type,
    _context: GenerationContext,
  ): MutableJSONSchema {
    const typeName = NativeTypeFormatter.#getTypeName(type);
    const schema = NativeTypeFormatter.declaresSqliteDbBrand(type)
      ? SQLITE_DATABASE_SCHEMA
      : NATIVE_TYPE_SCHEMAS[typeName!];
    // TODO(danfuzz): `structuredClone()` mangles non-JSON `FabricValue`s —
    // harmless while `NATIVE_TYPE_SCHEMAS` are plain JSON, but a problem once
    // schema-generator covers the full `FabricValue` spectrum. See the matching
    // note on `cloneSchemaDefinition()` re: a FabricValue-aware clone and
    // whether mutability is even needed.
    return (typeof schema === "boolean" ? schema : structuredClone(schema!));
  }

  static #getTypeName(type: ts.Type): string | undefined {
    // Prefer direct symbol name; fall back to target symbol for TypeReference
    const symbol = type.symbol;
    let name = symbol?.name;
    const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
    if (!name && (objectFlags & ts.ObjectFlags.Reference)) {
      const ref = type as unknown as ts.TypeReference;
      name = ref.target?.symbol?.name ?? name;
    }
    // Known compiler-internal anonymous type names
    // Using a minimal whitelist - only block the most common cases we know are problematic.
    // Fail open: if uncertain, let it through rather than break user code (like GraphQL __Schema types).
    const compilerInternalNames = new Set([
      "__type", // Anonymous object literals
      "__object", // Anonymous object types
    ]);

    // Helper to check if a name is compiler-internal/anonymous
    // vs. user-defined types that happen to start with __ (e.g., GraphQL introspection types like __Schema)
    const isAnonymousName = (n: string | undefined) => {
      if (!n) return true; // No name = anonymous
      return compilerInternalNames.has(n); // Check against whitelist
    };

    const aliasName = type.aliasSymbol?.name;

    // Fall back to alias symbol when present (type aliases) if we haven't used it yet
    // This includes the case where symbol.name is "__type" (anonymous object literal)
    // but the type has an explicit alias name
    if (isAnonymousName(name) && aliasName) {
      name = aliasName;
    }

    if (isAnonymousName(name)) {
      return undefined;
    }

    return name;
  }

  static #getTypeSymbol(type: ts.Type): ts.Symbol | undefined {
    if (type.symbol) return type.symbol;

    const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
    if (objectFlags & ts.ObjectFlags.Reference) {
      const ref = type as unknown as ts.TypeReference;
      return ref.target?.symbol;
    }

    return type.aliasSymbol;
  }

  /**
   * Whether the name is one a concrete `FabricPrimitive` class is declared
   * under, which is the name a TypeScript type referring to the class has.
   */
  public static isFabricPrimitiveTypeName(
    typeName: string | undefined,
  ): boolean {
    return typeName !== undefined && FABRIC_PRIMITIVE_TYPE_NAMES.has(typeName);
  }

  /**
   * Whether the type carries the `FabricPrimitive` nominal brand (directly or
   * by inheritance). This is what makes a type named e.g. `FabricBytes`
   * actually BE the `FabricPrimitive` class rather than an unrelated user type
   * that happens to share the name. Both this formatter's `supportsType` and
   * named-type hoisting (`getNamedTypeKey`, `type-utils.ts`) classify by it,
   * so an unbranded name-sharer keeps its structural schema AND its normal
   * `$defs` hoisting.
   *
   * The brand is keyed by the `FABRIC_PRIMITIVE_BRAND` symbol, whose property
   * TypeScript names `__@FABRIC_PRIMITIVE_BRAND@<id>`; the name of the
   * constant is what identifies it, as with the other symbol-keyed markers.
   */
  public static declaresFabricPrimitiveBrand(type: ts.Type): boolean {
    return type.getProperties().some((prop) =>
      String(prop.escapedName as string).startsWith(
        "__@FABRIC_PRIMITIVE_BRAND@",
      )
    );
  }

  /**
   * Whether the type carries the `SqliteDb` handle's nominal brand, and so IS
   * the database handle whose readable value is the `{ id, tables, rev }`
   * descriptor rather than a type that happens to be named for it.
   */
  public static declaresSqliteDbBrand(type: ts.Type): boolean {
    // Members are only resolved for object types, so no other type reaching
    // this formatter pays for the check.
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    return type.getProperties().some((property) =>
      (property.escapedName as string).startsWith(SQLITE_DB_BRAND_PREFIX)
    );
  }

  static #hasLibraryDeclaration(
    type: ts.Type,
    context: GenerationContext,
  ): boolean {
    const symbol = NativeTypeFormatter.#getTypeSymbol(type);
    return symbol?.declarations?.some((declaration) =>
      isDefaultLibrarySourceFile(declaration.getSourceFile(), context)
    ) ?? false;
  }

  /** Returns whether `typeName` names a native type, which gets no `$defs`. */
  public static isNativeType(typeName: string | undefined): boolean {
    return typeName !== undefined && NATIVE_TYPE_NAMES.has(typeName);
  }
}
