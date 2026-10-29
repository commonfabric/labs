import { computed } from "commonfabric";

declare const total: number;

// FIXTURE: schema-generation-computed-untyped
// Verifies: a reactive builder with no generic type args infers schemas from captured values
//   computed(() => total * 2) → captures `total` ({ type: "number" }) and infers output from the body
// Context: Input type comes from `declare const total: number`; output inferred from arrow body
export const doubled = computed(() => total * 2);
