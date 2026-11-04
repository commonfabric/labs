// Test that generic interface instantiations with different type arguments
// are NOT collapsed into a single shared $def.
// This was a bug where PatternToolResult<{ mentionable: X }> and
// PatternToolResult<{ favorites: Y }> were both mapped to the same
// $ref: "#/$defs/PatternToolResult" definition.

interface GenericResult<E> {
  data: string;
  extraParams: E;
}

interface SchemaRoot {
  first: GenericResult<{ alpha: number }>;
  second: GenericResult<{ beta: string }>;
}
