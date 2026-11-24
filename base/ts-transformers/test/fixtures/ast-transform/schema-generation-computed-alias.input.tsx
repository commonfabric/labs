import { computed as computedAlias } from "commonfabric";

type AliasInput = {
  text: string;
};

type AliasResult = {
  length: number;
};

declare const state: AliasInput;

// FIXTURE: schema-generation-computed-alias
// Verifies: a reactive builder imported under an alias still gets schema injection
//   computedAlias((): AliasResult => ...) → captures `state` and lowers to lift(inputSchema, outputSchema, ...)
// Context: Uses `import { computed as computedAlias }` to test aliased import tracking
export const textLength = computedAlias((): AliasResult => ({
  length: state.text.length,
}));
