import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

describe("mod", () => {
  it("throws on import, since the package holds patterns rather than a module API", async () => {
    // deno-lint-ignore cf-imports/no-inline-module-import -- the module throws as it loads, which is what this asserts
    await expect(import("./mod.ts")).rejects.toThrow(
      "Package contains static patterns and cannot be imported",
    );
  });
});
