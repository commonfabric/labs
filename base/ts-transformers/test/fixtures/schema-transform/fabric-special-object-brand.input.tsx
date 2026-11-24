import { type FabricBytes, pattern, UI } from "commonfabric";

// FIXTURE: fabric-special-object-brand
// Verifies: a field authored against a `FabricPrimitive` class emits its
// `FabricPrimitive` schema type (`{ type: "FabricBytes" }`, matched by
// prototype at validation time), and the `FabricSpecialObject` nominal brand
// -- a type-system-only key -- never reaches a generated schema.
export default pattern((state: { blob: FabricBytes }) => {
  return {
    [UI]: <div>{state.blob}</div>,
  };
});
