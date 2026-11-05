// A user type that shares a `FabricPrimitive` class name but does NOT carry
// the `FabricSpecialObject` brand is not claimed by the `FabricPrimitive`
// schema vocabulary: it keeps its structural schema and its normal
// named-type hoisting.
interface FabricBytes {
  length: number;
  label: string;
}

interface SchemaRoot {
  first: FabricBytes;
  second: FabricBytes;
}
