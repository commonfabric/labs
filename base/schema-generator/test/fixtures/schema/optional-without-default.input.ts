// Tests Option B semantics: T | undefined without Default wrapper
// These properties should NOT be in required array

interface SchemaRoot {
  // Optional flag - should not be in required
  optionalFlag?: string;

  // Union with undefined - should be in required (Option B)
  unionUndefined: string | undefined;

  // Both optional flag AND undefined union - should not be in required
  bothOptional?: number | undefined;

  // Regular required property for contrast
  required: string;
}
