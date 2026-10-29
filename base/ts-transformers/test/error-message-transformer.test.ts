import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createReactiveErrorTransformer } from "../src/diagnostics/mod.ts";

describe("createReactiveErrorTransformer", () => {
  it("transforms .get() on OpaqueCell error to clear message", () => {
    const transform = createReactiveErrorTransformer();
    const originalMessage =
      "Property 'get' does not exist on type 'OpaqueCell<number> & number'.";

    const result = transform(originalMessage);

    expect(result).not.toBeNull();
    expect(result).toContain("Unnecessary .get() call");
    expect(result).toContain("remove .get()");
    expect(result).not.toContain("OpaqueCell"); // Original error suppressed
  });

  it("includes original error in verbose mode", () => {
    const transform = createReactiveErrorTransformer(true);
    const originalMessage =
      "Property 'get' does not exist on type 'OpaqueCell<number> & number'.";

    const result = transform(originalMessage);

    expect(result).not.toBeNull();
    expect(result).toContain("Unnecessary .get() call");
    expect(result).toContain("Original TypeScript error:");
    expect(result).toContain("OpaqueCell<number>"); // Original included
  });

  it("returns null for unrelated errors", () => {
    const transform = createReactiveErrorTransformer();
    const unrelatedMessage =
      "Type 'string' is not assignable to type 'number'.";

    const result = transform(unrelatedMessage);

    expect(result).toBeNull();
  });

  it("handles complex OpaqueCell types", () => {
    const transform = createReactiveErrorTransformer();
    const complexMessage =
      "Property 'get' does not exist on type 'OpaqueCell<{ items: string[]; count: number }> & { items: string[]; count: number }'.";

    const result = transform(complexMessage);

    expect(result).not.toBeNull();
    expect(result).toContain("Unnecessary .get() call");
  });
});
