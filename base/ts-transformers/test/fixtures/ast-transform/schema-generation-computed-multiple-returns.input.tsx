import { computed } from "commonfabric";

declare const flag: boolean;

// FIXTURE: schema-generation-computed-multiple-returns
// Verifies: a reactive builder with multiple return paths infers a union output schema
//   computed(() => { ... }) → output schema is an enum union of the returned literals
// Context: Callback has two return statements (string and number); output schema is an enum union
// Function with multiple return statements - should infer string | number
export const multiReturn = computed(() => {
  if (flag) {
    return "hello";
  }
  return 42;
});
