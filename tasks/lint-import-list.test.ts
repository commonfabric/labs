/// <reference lib="deno.unstable" />

/**
 * Runs the `cf-import-list` rules over short files, and checks which statement
 * `one-statement-per-kind` reports and which of its five messages it gives.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import plugin from "./lint-import-list.ts";

const RULE = "cf-import-list/one-statement-per-kind";

/** The five shapes the rule reports, told apart by a phrase of each message. */
const MERGE = "merge";
const BARE_BESIDE_VALUE = "bare-beside-value";
const REPEATED_BARE = "repeated-bare";
const TYPES_BESIDE_BARE = "types-beside-bare";
const MERGE_THROUGH_NAMESPACE = "merge-through-namespace";

const PHRASES: readonly (readonly [string, string])[] = [
  ["merge the two lists of names", MERGE],
  ["reach through the namespace", MERGE_THROUGH_NAMESPACE],
  ["This bare statement adds nothing beside it", BARE_BESIDE_VALUE],
  ["A module is evaluated once however many times", REPEATED_BARE],
  ["This statement names nothing but types", TYPES_BESIDE_BARE],
];

/** Which shape each diagnostic reports, in the order reported. */
function diagnose(source: string): string[] {
  return run(source).map((diagnostic) => {
    expect(diagnostic.id).toEqual(RULE);
    const match = PHRASES.find(([phrase]) =>
      diagnostic.message.includes(phrase)
    );
    if (match === undefined) {
      throw new Error(`Unrecognized message: ${diagnostic.message}`);
    }
    return match[1];
  });
}

/** The statement each diagnostic is reported against, in the order reported. */
function statements(source: string): string[] {
  return run(source).map(({ range }) => source.slice(range[0], range[1]));
}

/** What the rule reports over one file, in the order it reports it. */
function run(source: string): Deno.lint.Diagnostic[] {
  return Deno.lint.runPlugin(plugin, "sample.ts", source).filter(({ id }) =>
    id === RULE
  );
}

describe("lint-import-list", () => {
  describe("one-statement-per-kind", () => {
    it("passes one statement marking its type-only names inline", () => {
      const source = `
        import { type Thing, make } from "./mod.ts";
        export const thing: Thing = make();
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes an `import type` above a value import of one module", () => {
      const source = `
        import type { Thing } from "./mod.ts";
        import { make } from "./mod.ts";
        export const thing: Thing = make();
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes one statement each from two modules", () => {
      const source = `
        import { a } from "./a.ts";
        import { b } from "./b.ts";
        export const both = [a, b];
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes two spellings of one module, which it reads as two", () => {
      const source = `
        import { a } from "@/mod.ts";
        import { b } from "../src/mod.ts";
        export const both = [a, b];
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes a re-export beside an import of the same module", () => {
      const source = `
        import { a } from "./mod.ts";
        export { b } from "./mod.ts";
        export const one = a;
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("reports a second value import of one module", () => {
      const source = `
        import { a } from "./mod.ts";
        import { b } from "./mod.ts";
        export const both = [a, b];
      `;
      expect(diagnose(source)).toEqual([MERGE]);
      expect(statements(source)).toEqual([`import { b } from "./mod.ts";`]);
    });

    it("reports a second `import type` of one module", () => {
      const source = `
        import type { A } from "./mod.ts";
        import type { B } from "./mod.ts";
        export type Both = [A, B];
      `;
      expect(diagnose(source)).toEqual([MERGE]);
      expect(statements(source)).toEqual([
        `import type { B } from "./mod.ts";`,
      ]);
    });

    it("reports a value import beside a default import of one module", () => {
      const source = `
        import mod from "./mod.ts";
        import { a } from "./mod.ts";
        export const both = [mod, a];
      `;
      expect(diagnose(source)).toEqual([MERGE]);
    });

    it("reports a namespace import beside a named import of one module", () => {
      const source = `
        import * as mod from "./mod.ts";
        import { a } from "./mod.ts";
        export const both = [mod, a];
      `;
      expect(diagnose(source)).toEqual([MERGE_THROUGH_NAMESPACE]);
      expect(statements(source)).toEqual([`import { a } from "./mod.ts";`]);
    });

    it("reports two `import type`s the same way when one is a namespace", () => {
      const source = `
        import type { A } from "./mod.ts";
        import type * as mod from "./mod.ts";
        export type Both = [A, typeof mod];
      `;
      expect(diagnose(source)).toEqual([MERGE_THROUGH_NAMESPACE]);
    });

    it("reports merging through the namespace only where one of the pair takes it", () => {
      // Each statement merges into the first of its kind, so the namespace
      // written third blocks its own merge and not the one above it.
      const source = `
        import { a } from "./mod.ts";
        import { b } from "./mod.ts";
        import * as mod from "./mod.ts";
        export const all = [a, b, mod];
      `;
      expect(diagnose(source)).toEqual([MERGE, MERGE_THROUGH_NAMESPACE]);
      expect(statements(source)).toEqual([
        `import { b } from "./mod.ts";`,
        `import * as mod from "./mod.ts";`,
      ]);
    });

    it("reports a second `import type` of one module with an empty clause", () => {
      const source = `
        import type {} from "./mod.ts";
        import type {} from "./mod.ts";
      `;
      expect(diagnose(source)).toEqual([MERGE]);
      expect(statements(source)).toEqual([`import type {} from "./mod.ts";`]);
    });

    it("counts an empty `import type` clause against a named one", () => {
      const source = `
        import type {} from "./mod.ts";
        import type { A } from "./mod.ts";
        export type Alias = A;
      `;
      expect(diagnose(source)).toEqual([MERGE]);
      expect(statements(source)).toEqual([
        `import type { A } from "./mod.ts";`,
      ]);
    });

    it("passes an empty `import type` clause beside a bare import", () => {
      // The bare statement is what evaluates the module, and the `import type`
      // is a statement of the other kind, so the pair is one of each.
      const source = `
        import "./mod.ts";
        import type {} from "./mod.ts";
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("reports each statement after the first, one report each", () => {
      const source = `
        import { a } from "./mod.ts";
        import { b } from "./mod.ts";
        import { c } from "./mod.ts";
        export const all = [a, b, c];
      `;
      expect(diagnose(source)).toEqual([MERGE, MERGE]);
      expect(statements(source)).toEqual([
        `import { b } from "./mod.ts";`,
        `import { c } from "./mod.ts";`,
      ]);
    });

    it("passes a bare import of a module nothing else imports", () => {
      const source = `
        import "./polyfill.ts";
        export const ready = true;
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("passes a bare import beside nothing but an `import type`", () => {
      const source = `
        import "./mod.ts";
        import type { Thing } from "./mod.ts";
        export type Alias = Thing;
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("reports the bare import when a value import also names the module", () => {
      const source = `
        import "./mod.ts";
        import { a } from "./mod.ts";
        export const one = a;
      `;
      expect(diagnose(source)).toEqual([BARE_BESIDE_VALUE]);
      expect(statements(source)).toEqual([`import "./mod.ts";`]);
    });

    it("reports the bare import written below the value import as well", () => {
      const source = `
        import { a } from "./mod.ts";
        import "./mod.ts";
        export const one = a;
      `;
      expect(diagnose(source)).toEqual([BARE_BESIDE_VALUE]);
      expect(statements(source)).toEqual([`import "./mod.ts";`]);
    });

    it("passes a statement naming nothing but types on its own", () => {
      const source = `
        import { type Thing } from "./mod.ts";
        export type Alias = Thing;
      `;
      expect(diagnose(source)).toEqual([]);
    });

    it("reports the statement naming nothing but types, not the bare import", () => {
      const source = `
        import "./mod.ts";
        import { type Thing } from "./mod.ts";
        export type Alias = Thing;
      `;
      expect(diagnose(source)).toEqual([TYPES_BESIDE_BARE]);
      expect(statements(source)).toEqual([
        `import { type Thing } from "./mod.ts";`,
      ]);
    });

    it("reports it the same way with the bare import written below", () => {
      const source = `
        import { type Thing } from "./mod.ts";
        import "./mod.ts";
        export type Alias = Thing;
      `;
      expect(diagnose(source)).toEqual([TYPES_BESIDE_BARE]);
      expect(statements(source)).toEqual([
        `import { type Thing } from "./mod.ts";`,
      ]);
    });

    it("reports the bare import beside a namespace import of one module", () => {
      const source = `
        import "./mod.ts";
        import * as mod from "./mod.ts";
        export const one = mod;
      `;
      expect(diagnose(source)).toEqual([BARE_BESIDE_VALUE]);
      expect(statements(source)).toEqual([`import "./mod.ts";`]);
    });

    it("reports a bare import repeated with nothing else naming the module", () => {
      const source = `
        import "./polyfill.ts";
        import "./polyfill.ts";
        export const ready = true;
      `;
      expect(diagnose(source)).toEqual([REPEATED_BARE]);
    });

    it("reports the value pair and the bare statement of one module apart", () => {
      const source = `
        import "./mod.ts";
        import { a } from "./mod.ts";
        import { b } from "./mod.ts";
        export const both = [a, b];
      `;
      expect(diagnose(source)).toEqual([MERGE, BARE_BESIDE_VALUE]);
      expect(statements(source)).toEqual([
        `import { b } from "./mod.ts";`,
        `import "./mod.ts";`,
      ]);
    });

    it("reports the same module under each kind separately", () => {
      const source = `
        import type { A } from "./mod.ts";
        import type { B } from "./mod.ts";
        import { c } from "./mod.ts";
        import { d } from "./mod.ts";
        export const both: [A, B] = [c, d];
      `;
      expect(diagnose(source)).toEqual([MERGE, MERGE]);
      expect(statements(source)).toEqual([
        `import type { B } from "./mod.ts";`,
        `import { d } from "./mod.ts";`,
      ]);
    });
  });
});

describe("cf-import-list/types-are-import-type", () => {
  const RULE_ID = "cf-import-list/types-are-import-type";
  const reports = (source: string, file = "sample.ts") =>
    Deno.lint.runPlugin(plugin, file, source).filter(({ id }) => id === RULE_ID)
      .length;

  it("reports a value statement naming nothing but types", () => {
    expect(reports(`import { type A, type B } from "x";\n`)).toBe(1);
  });

  it("accepts a statement that also binds a value", () => {
    expect(reports(`import { type A, b } from "x";\n`)).toBe(0);
  });

  it("accepts `import type` and a bare import", () => {
    expect(reports(`import type { A } from "x";\nimport "y";\n`)).toBe(0);
  });

  it("leaves a pattern's source as written", () => {
    expect(
      reports(
        `import { type A } from "x";\n`,
        "/labs/patterns/apps/sample/main.tsx",
      ),
    ).toBe(0);
  });
});
