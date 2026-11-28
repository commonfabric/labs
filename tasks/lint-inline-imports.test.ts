/// <reference lib="deno.unstable" />

/**
 * Runs the two `cf-imports` rules over short files and checks which of them,
 * if either, reports.
 */

import { expect } from "@std/expect";
import plugin from "./lint-inline-imports.ts";
import { describe, it } from "@commonfabric/test-support/test";

function diagnose(source: string, fileName = "sample.ts"): string[] {
  return Deno.lint.runPlugin(plugin, fileName, source).map((d) => d.id);
}

const TYPE = "cf-imports/no-inline-type-import";
const MODULE = "cf-imports/no-inline-module-import";

describe("lint-inline-imports", () => {
  describe("no-inline-type-import", () => {
    it("reports a named type reached through import()", () => {
      expect(diagnose(`type A = import("./mod.ts").Thing;`)).toEqual([TYPE]);
    });

    it("reports a type query on a whole module", () => {
      expect(diagnose(`type M = typeof import("./mod.ts");`)).toEqual([TYPE]);
    });

    it("reports one inside a function signature", () => {
      const source = `
        function f(op: import("./ops.ts").Op): void {
          void op;
        }
      `;
      expect(diagnose(source)).toEqual([TYPE]);
    });

    it("reports each use separately", () => {
      const source = `
        interface Api {
          a: import("./mod.ts").A;
          b: import("./mod.ts").B;
        }
      `;
      expect(diagnose(source)).toEqual([TYPE, TYPE]);
    });

    it("passes a type imported at the top", () => {
      const source = `
        import type { Thing } from "./mod.ts";
        type A = Thing;
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes a namespace type imported at the top", () => {
      const source = `
        import type * as mod from "./mod.ts";
        type M = typeof mod;
      `;
      expect(diagnose(source)).toEqual([]);
    });
  });

  describe("no-inline-module-import", () => {
    it("reports a module named by a plain string", () => {
      const source = `
        async function load() {
          return await import("./mod.ts");
        }
      `;
      expect(diagnose(source)).toEqual([MODULE]);
    });

    it("reports one written at the top level of a module", () => {
      expect(diagnose(`const m = await import("./mod.ts");`)).toEqual([MODULE]);
    });

    it("reports a string that carries a query", () => {
      const source = `const m = await import("./mod.ts?fresh");`;
      expect(diagnose(source)).toEqual([MODULE]);
    });

    it("reports one that passes import attributes", () => {
      const source = `
        const p = await import("./ports.json", { with: { type: "json" } });
      `;
      expect(diagnose(source)).toEqual([MODULE]);
    });

    it("passes a specifier built from a template literal", () => {
      const source = "const m = await import(`./mod.ts?run=${id}`);";
      expect(diagnose(source)).toEqual([]);
    });

    it("passes a literal that is not a string", () => {
      // A number, a regular expression and `null` all parse as literals, and
      // none of them is something an import declaration could carry.
      expect(diagnose(`const m = await import(42);`)).toEqual([]);
      expect(diagnose(`const m = await import(/re/);`)).toEqual([]);
      expect(diagnose(`const m = await import(null);`)).toEqual([]);
    });

    it("passes a specifier held in a variable", () => {
      const source = `
        async function load(path: string) {
          return await import(path);
        }
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes a static import declaration", () => {
      const source = `
        import { thing } from "./mod.ts";
        export const t = thing;
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes import.meta, which is not an import expression", () => {
      expect(diagnose(`const url = import.meta.url;`)).toEqual([]);
    });
  });

  it("reports both kinds in one file, each under its own rule", () => {
    const source = `
      type A = import("./mod.ts").Thing;
      const m = await import("./mod.ts");
    `;
    expect(diagnose(source).sort()).toEqual([MODULE, TYPE].sort());
  });
});
