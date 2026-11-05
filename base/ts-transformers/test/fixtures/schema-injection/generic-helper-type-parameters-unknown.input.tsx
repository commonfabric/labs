import { Cell, generateObject, wish } from "commonfabric";

// FIXTURE: generic-helper-type-parameters-unknown
// Verifies: generic definition-site helper wrappers degrade injected schemas to unknown
//   wish<T>({ query }) → wish<T>({ query }, { type: "unknown" })
//   generateObject<T>({ ... }) → generateObject<T>({ schema: { type: "unknown" }, ... })
//   new Cell<T>(value) → new Cell<T>(value, { type: "unknown" })
export function buildWishExplicit<T>(path: string) {
  return wish<T>({ query: path });
}

export function buildObjectExplicit<T>(prompt: string) {
  return generateObject<T>({
    model: "gpt-4o-mini",
    prompt,
  });
}

export function buildCellExplicit<T>(value: T) {
  return new Cell<T>(value);
}
