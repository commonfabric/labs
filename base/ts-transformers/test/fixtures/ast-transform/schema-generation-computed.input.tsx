import { computed } from "commonfabric";

type DeriveInput = {
  count: number;
};

type DeriveResult = {
  doubled: number;
};

declare const source: DeriveInput;

// FIXTURE: schema-generation-computed
// Verifies: computed() closure-extracts a captured value into a lift() with input
// (capture) and output schemas generated from type info
//   computed(() => ({ doubled: source.count * 2 })) → lift(captureSchema, outputSchema, { source }, fn)
export const doubledValue = computed((): DeriveResult => ({
  doubled: source.count * 2,
}));
