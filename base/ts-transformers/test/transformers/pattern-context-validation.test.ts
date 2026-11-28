import { expect } from "@std/expect";
import { validateSource, withSourceText } from "../utils.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { describe, it } from "@commonfabric/test-support/test";

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

/**
 * The type of each error reported for `source` whose type starts with
 * `typePrefix`, with the source text of the node it is reported on. Positions are in the text the compiler reads, which
 * the helper import the harness adds in front of `source` shifts.
 */
async function errorSites(source: string, typePrefix = "") {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return withSourceText(
    source,
    diagnostics.filter((diagnostic) =>
      diagnostic.severity === "error" && diagnostic.type.startsWith(typePrefix)
    ),
  ).map(({ type, text }) => ({ type, text }));
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

  describe("`SELF` reads", () => {
    it("reports nothing for `SELF` read off an object literal", async () => {
      expect(
        await errorSites(
          `import { pattern, SELF } from "commonfabric";
export default pattern<{ a: number }>((input) => ({
  own: ({ [SELF]: 1 })[SELF],
  read: (input as any).items[SELF],
}));`,
          "pattern-context:",
        ),
      ).toEqual([
        {
          type: "pattern-context:self-access",
          text: "(input as any).items[SELF]",
        },
      ]);
    });

    it("reports `SELF` read off a pattern callback's second parameter", async () => {
      expect(
        await errorSites(`import { pattern, SELF } from "commonfabric";
export default pattern<{ a: number }>((input, second: any) => ({
  self: input[SELF],
  other: second[SELF],
}));`),
      ).toEqual([
        { type: "pattern-context:self-access", text: "second[SELF]" },
      ]);
    });

    it("reports `SELF` read off a standalone function's parameter inside a nested pattern", async () => {
      // The nested pattern's own input is the only receiver `SELF` names a
      // result on, whether the enclosing function is an arrow held in a
      // `const` or a function declaration.

      expect(
        await errorSites(
          `import { pattern, SELF } from "commonfabric";
export const make = (outer: any) =>
  pattern<{ a: number }>((input) => ({ self: input[SELF], other: outer[SELF] }));
export function build(outer: any) {
  return pattern<{ a: number }>((input) => ({ other: outer[SELF] }));
}
export default pattern(() => ({ v: 1 }));`,
          "pattern-context:",
        ),
      ).toEqual([
        { type: "pattern-context:self-access", text: "outer[SELF]" },
        { type: "pattern-context:self-access", text: "outer[SELF]" },
      ]);
    });
  });

  describe("standalone functions", () => {
    it("reports an applied `lift()` as a reactive computation", async () => {
      const sites = await errorSites(
        `import { lift, pattern } from "commonfabric";
export function doubled(value: number) {
  return lift((x: number) => x * 2)(value);
}
export default pattern(() => ({ v: 1 }));`,
      );
      expect(sites).toEqual([
        {
          type: "standalone-function:reactive-operation",
          text: "lift((x: number) => x * 2)(value)",
        },
      ]);
    });

    it("reports a callback held in a `const` and passed to `patternTool()` by name", async () => {
      expect(
        await errorSites(
          `import { computed, pattern, patternTool } from "commonfabric";
const measure = ({ q }: { q: string }) => computed(() => q.length);
export const tool = patternTool(measure);
export default pattern(() => ({ v: 1 }));`,
        ),
      ).toContainEqual({
        type: "standalone-function:reactive-operation",
        text: "computed(() => q.length)",
      });
    });
  });

  describe("callable captures in SES callbacks", () => {
    it("reports a callable from an enclosing function but not one destructured at module scope", async () => {
      expect(
        await errorSites(
          `import { handler, pattern, Writable } from "commonfabric";
const helpers = { twice: (n: number) => n * 2 };
const { twice } = helpers;
export default pattern<{ count: Writable<number> }>(({ count }) => {
  const once = (n: number) => n;
  return {
    bump: handler<unknown, { count: Writable<number> }>((_, state) => {
      state.count.set(twice(once(state.count.get())));
    })({ count }),
  };
});`,
          "ses-callback:",
        ),
      ).toEqual([{ type: "ses-callback:callable-capture", text: "once" }]);
    });
  });
});
