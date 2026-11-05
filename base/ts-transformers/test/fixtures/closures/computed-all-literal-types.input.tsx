import { Writable, computed, pattern } from "commonfabric";

// Test that all literal types are widened in closure captures
// FIXTURE: computed-all-literal-types
// Verifies: literal values (number, string, boolean, float) are captured and their types widened in schemas
//   computed(() => expr) → lift(schema, schema)({ value, numLiteral, floatLiteral, boolLiteral, strLiteral }) with widened types
// Context: each literal type maps to its widened JSON schema type (e.g., 42 → "number", "hello" → "string")
export default pattern(() => {
  const value = new Writable(10);

  // All literal types that should be widened
  const numLiteral = 42;
  const strLiteral = "hello";
  const boolLiteral = true;
  const floatLiteral = 3.14;

  const result = computed(() => {
    // Use all captured literals to ensure they're all widened
    const combined = value.get() + numLiteral + floatLiteral;
    return boolLiteral ? strLiteral + combined : "";
  });

  return result;
});
