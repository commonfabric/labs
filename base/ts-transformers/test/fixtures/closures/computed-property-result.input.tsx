import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-property-result
// Verifies: computed property access with a dynamic key captures both the object and the key
//   computed(() => expr) → lift(schema, schema)({ value, config, key })
// Context: `config[key]` requires both `config` and `key` to be captured as plain values
export default pattern(() => {
  const value = new Writable(10);
  const config = { multiplier: 2, divisor: 5 };
  const key = "multiplier";

  const result = computed(() => value.get() * config[key]);

  return result;
});
