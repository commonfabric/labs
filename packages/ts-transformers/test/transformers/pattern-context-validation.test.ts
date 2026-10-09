import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { validateSource } from "../utils.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

/**
 * The type and severity of each `module-scope:` diagnostic reported for a
 * module holding `declarations` above a trivial pattern.
 */
async function moduleScopeDiagnostics(
  declarations: string,
  options: { storedSource?: boolean } = {},
) {
  const { diagnostics } = await validateSource(
    `import { pattern } from "commonfabric";
${declarations}
export default pattern(() => ({ v: 1 }));`,
    { types: COMMONFABRIC_TYPES, ...options },
  );
  return diagnostics
    .filter((diagnostic) => diagnostic.type.startsWith("module-scope:"))
    .map(({ type, severity }) => ({ type, severity }));
}

describe("pattern-context-validation", () => {
  describe("`let` and `var` at module scope", () => {
    it("reports `module-scope:let-declaration` for a `let` statement", async () => {
      expect(await moduleScopeDiagnostics("let counter = 0;")).toEqual([
        { type: "module-scope:let-declaration", severity: "error" },
      ]);
    });

    it("reports `module-scope:var-declaration` for a `var` statement", async () => {
      expect(await moduleScopeDiagnostics("var counter = 0;")).toEqual([
        { type: "module-scope:var-declaration", severity: "error" },
      ]);
    });

    it("reports an exported `let` and an exported `var`", async () => {
      // The module verifier lets these through at load, since they compile to
      // assignments to `exports`, so the compiler is the only refusal.

      expect(
        await moduleScopeDiagnostics(
          "export let counter = 0;\nexport var total = 0;",
        ),
      ).toEqual([
        { type: "module-scope:let-declaration", severity: "error" },
        { type: "module-scope:var-declaration", severity: "error" },
      ]);
    });

    it("reports a `let` statement once however many bindings it declares", async () => {
      expect(await moduleScopeDiagnostics("let first = 1, second = 2;"))
        .toEqual([
          { type: "module-scope:let-declaration", severity: "error" },
        ]);
    });

    it("reports a `let` statement without an initializer", async () => {
      expect(await moduleScopeDiagnostics("let counter: number;")).toEqual([
        { type: "module-scope:let-declaration", severity: "error" },
      ]);
    });

    it("reports nothing for `const` and for ambient `declare let` and `declare var`", async () => {
      expect(
        await moduleScopeDiagnostics(
          "const counter = 0;\ndeclare let seen: number;\ndeclare var total: number;",
        ),
      ).toEqual([]);
    });

    it("reports nothing for `let` and `var` inside a function at module scope", async () => {
      expect(
        await moduleScopeDiagnostics(
          `function tally(values: number[]): number {
  let total = 0;
  for (var index = 0; index < values.length; index++) total += values[index];
  return total;
}`,
        ),
      ).toEqual([]);
    });

    it("reports a warning rather than an error when recompiling stored source", async () => {
      // Stored source was admitted when it was deployed, and an
      // identity-pinned reload admits nothing new.

      expect(
        await moduleScopeDiagnostics("export let counter = 0;", {
          storedSource: true,
        }),
      ).toEqual([
        { type: "module-scope:let-declaration", severity: "warning" },
      ]);
    });
  });
});
