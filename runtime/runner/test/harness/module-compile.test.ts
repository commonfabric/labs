import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ensureCompilerStack } from "../../src/harness/deferred-compiler-stack.ts";
import { builderSourceSiteOptionsForCompile } from "../../src/harness/module-compile.ts";

// Mapping a site measures the helper injection, which parses.
await ensureCompilerStack();

describe("module-compile", () => {
  describe("builderSourceSiteOptionsForCompile()", () => {
    // `/main.tsx` holds three authored lines, which the helper import moves
    // down by one in the compiler's input.

    const { mapSite } = builderSourceSiteOptionsForCompile({
      id: "program",
      mounts: [],
      sourceFiles: [{
        name: "/program/main.tsx",
        contents: "const a = 1;\nconst b = 2;\nexport { a, b };",
      }],
    });

    it("returns a site moved onto the authored line it was compiled from", () => {
      expect(mapSite("/program/main.tsx", { line: 2, col: 6 })).toEqual({
        line: 1,
        col: 6,
      });
      expect(
        mapSite("/program/main.tsx", { line: 4, col: 0, bindingName: "b" }),
      ).toEqual({ line: 3, col: 0, bindingName: "b" });
    });

    it("returns `undefined` for a site in a file with no authored source", () => {
      expect(mapSite("/program/other.tsx", { line: 2, col: 0 }))
        .toBeUndefined();
    });

    it("returns `undefined` for a site on a line the author did not write", () => {
      expect(mapSite("/program/main.tsx", { line: 1, col: 0 })).toBeUndefined();
      expect(mapSite("/program/main.tsx", { line: 5, col: 0 })).toBeUndefined();
    });
  });
});
