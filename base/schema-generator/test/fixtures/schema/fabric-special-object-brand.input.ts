// Mirrors the api's special-object classes. Their brand keys exist only in
// the type system -- no runtime value carries any of them -- so the generator
// must not surface one as a schema property or requirement.
//
// `FabricPrimitive` carries a brand keyed by an interned symbol, and
// `FabricInstance` the one that types a `FabricInstancePlus`, at `never`. A
// structural schema of either skips every such key, as it skips every
// symbol-keyed member.
//
// A concrete `FabricPrimitive` class (`FabricBytes`) emits its
// `FabricPrimitive` schema type (`{ type: "FabricBytes" }`, matched by
// prototype at validation time). A branded type OUTSIDE that vocabulary
// (the `FabricPrimitive` base here) still emits a structural object schema,
// with the brand skipped.
const FABRIC_PRIMITIVE_BRAND = Symbol.for("@commonfabric/FabricPrimitive");

interface FabricPrimitive {
  readonly [FABRIC_PRIMITIVE_BRAND]: true;
}

const FABRIC_INSTANCE_PLUS_BRAND = Symbol.for(
  "@commonfabric/FabricInstancePlus",
);

interface FabricInstance {
  readonly [FABRIC_INSTANCE_PLUS_BRAND]: never;
  deepClone(frozen: boolean): FabricInstance;
}

interface FabricBytes extends FabricPrimitive {
  readonly length: number;
  slice(start?: number, end?: number): Uint8Array;
  copyInto(target: Uint8Array, offset?: number, length?: number): number;
}

interface SchemaRoot {
  blob: FabricBytes;
  opaque: FabricPrimitive;
  instance: FabricInstance;
}
