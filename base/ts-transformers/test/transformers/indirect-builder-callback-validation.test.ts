/**
 * The module verifier admits a trusted builder's callback in two spellings —
 * written at the call, or a name bound to a function the same module emits —
 * and refuses to load a module that uses any other
 * (`verifyTrustedBuilderCall`, spec §17.6). This stage refuses the same
 * spellings at compile time, so the author is pointed at the argument instead
 * of meeting a verifier message at load.
 *
 * These sources compile against the REAL commonfabric surface
 * (`COMMONFABRIC_TYPES` loads `types/commonfabric.d.ts`), so what the checker
 * says about callback-ness here is what it says about a real pattern.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { validateFiles, validateSource } from "../utils.ts";
import type { TransformationDiagnostic } from "../../src/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

function indirectCallbackErrors(
  diagnostics: readonly TransformationDiagnostic[],
) {
  return diagnostics.filter(
    (d) =>
      d.type === "builder-callback:indirect-reference" &&
      d.severity === "error",
  );
}

async function errorsIn(moduleBody: string) {
  const source = `
    import { Cell, handler, lift, pattern } from "commonfabric";
    ${moduleBody}
    export default pattern(() => ({}));
  `;
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return indirectCallbackErrors(diagnostics);
}

describe("indirect-builder-callback-validation", () => {
  describe("callbacks the verifier cannot follow", () => {
    it("reports a callback reached through a property access", async () => {
      const errors = await errorsIn(`
        const callbacks = {
          save(_event: unknown, _state: { count: Cell<number> }) {},
        };
        const saveVerb = handler<unknown, { count: Cell<number> }>(
          callbacks.save,
        );
      `);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("through a property access");
      expect(errors[0].message).toContain("refused");
    });

    it("reports a callback imported from another module", async () => {
      const { diagnostics } = await validateFiles({
        "/helpers.ts": `
          export const save = (_event: unknown, _state: { count: number }) => {};
        `,
        "/test.tsx": `
          import { handler, pattern } from "commonfabric";
          import { save } from "./helpers.ts";
          const saveVerb = handler(save);
          export default pattern(() => ({}));
        `,
      }, { types: COMMONFABRIC_TYPES });

      const errors = indirectCallbackErrors(diagnostics);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(
        "a binding this module does not declare",
      );
    });

    it("reports a name whose only declaration is erased before emit", async () => {
      // An ambient declaration leaves the compiled module with a name bound to
      // nothing, which the verifier reports as an indirect reference.
      const errors = await errorsIn(`
        declare function bump(n: number): number;
        const inc = lift(bump);
      `);
      expect(errors).toHaveLength(1);
    });

    it("reports a callback this module exports", async () => {
      // CommonJS emit reads an exported binding as `exports.f`, and the
      // verifier's grammar admits only a bare identifier.
      const errors = await errorsIn(`
        export const bump = (n: number) => n + 1;
        const inc = lift(bump);
      `);
      expect(errors).toHaveLength(1);
    });

    it("reports a lift callback that is not in the leading position", async () => {
      // The callback belongs at position 0, but the verifier scans the leading
      // positions and takes the first that resolves — so one placed later and
      // unresolvable is refused at load rather than ignored.
      const errors = await errorsIn(`
        const callbacks = { bump: (n: number) => n + 1 };
        const inc = lift(
          { type: "object" } as never,
          undefined as never,
          callbacks.bump as never,
        );
      `);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("through a property access");
    });

    it("reports a generator written at the call", async () => {
      // `tryParseDirectFunction` accepts `async`, never `function*`.
      const errors = await errorsIn(`
        const inc = lift(function* (n: number) {
          yield n + 1;
        } as never);
      `);
      expect(errors).toHaveLength(1);
    });
  });

  describe("callbacks the verifier admits", () => {
    it("accepts a function written at the call", async () => {
      expect(await errorsIn(`const inc = lift((n: number) => n + 1);`))
        .toHaveLength(0);
    });

    it("accepts a same-module const bound to a function", async () => {
      expect(
        await errorsIn(`
          const bump = (n: number) => n + 1;
          const inc = lift(bump);
        `),
      ).toHaveLength(0);
    });

    it("accepts a same-module function declaration", async () => {
      // Declarations hoist, so the declaration may follow its use.
      expect(
        await errorsIn(`
          const inc = lift(bump);
          function bump(n: number) {
            return n + 1;
          }
        `),
      ).toHaveLength(0);
    });

    it("accepts an alias of a same-module function", async () => {
      // The verifier propagates the function classification through the alias,
      // so rejecting this would refuse a module it loads.
      expect(
        await errorsIn(`
          function bump(n: number) {
            return n + 1;
          }
          const alias = bump;
          const inc = lift(alias);
        `),
      ).toHaveLength(0);
    });

    it("accepts a callback re-exported by a trailing clause", async () => {
      // A trailing clause emits `exports.bump = bump` and leaves local
      // references alone, so the compiled callback is still a bare identifier.
      expect(
        await errorsIn(`
          const bump = (n: number) => n + 1;
          const inc = lift(bump);
          export { bump };
        `),
      ).toHaveLength(0);
    });

    it("accepts an exported function declaration", async () => {
      // A function declaration keeps its local binding even when exported.
      expect(
        await errorsIn(`
          export function bump(n: number) {
            return n + 1;
          }
          const inc = lift(bump);
        `),
      ).toHaveLength(0);
    });

    it("accepts an overloaded function by its implementation", async () => {
      expect(
        await errorsIn(`
          function bump(n: number): number;
          function bump(n: string): string;
          function bump(n: never) {
            return n;
          }
          const inc = lift(bump);
        `),
      ).toHaveLength(0);
    });
  });

  it("leaves an argument that is not function-bearing alone", async () => {
    // A different mistake, already described by whatever rejects it; naming it
    // a callback here would misreport the problem.
    expect(
      await errorsIn(`const inc = lift({ type: "object" } as never);`),
    ).toHaveLength(0);
  });
});
