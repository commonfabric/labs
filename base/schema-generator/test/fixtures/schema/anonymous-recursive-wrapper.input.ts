// Test case: Anonymous recursive type inside a wrapper
// This should create a synthetic name for the anonymous type and properly
// store it in $defs, not create a dangling reference

type Default<T, V extends T = T> = T;

interface SchemaRoot {
  // Anonymous object type wrapped in Default, containing self-reference to SchemaRoot
  // deno-lint-ignore ban-types
  field: Default<{ self?: SchemaRoot }, {}>;
}
