import ts from "typescript";

/**
 * Compiler options for the emit test. ES modules and an ESNext target keep the
 * output close to the source, and `jsx` matches the workspace setting so markup
 * in a `.tsx` file compiles to calls. `alwaysStrict` is off to match Deno,
 * which loads every file as an ES module and so emits no `"use strict"` line
 * for a file that has no import or export.
 */
const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  alwaysStrict: false,
};

/**
 * Returns whether `content`, taken as the source of `filePath`, compiles to
 * code that can run. A file holding only interfaces, type aliases, and other
 * declarations compiles to an empty module, so it has no statement any test
 * could execute, and Deno's coverage reports no line for it that a test could
 * leave uncovered.
 *
 * The answer comes from compiling the file and reading what comes out. Which
 * constructs reach the output is the compiler's rule. An enum, a namespace
 * holding a value, and an import kept for its side effects all emit code. A
 * type-only import, a namespace holding only types, and a comment do not.
 *
 * An export declaration in the output, such as `export * from "./a.ts"`,
 * `export { b } from "./b.ts"`, or the `export {}` the compiler emits to keep
 * an otherwise empty file a module, only binds names. A module's evaluation
 * runs no step for it, so a file of nothing else has no statement a test could
 * execute. Pattern coverage instrumentation skips export declarations for the
 * same reason.
 *
 * The answer is what the TypeScript compiler emits. What runs is what Deno
 * emits, which is swc's work, so the two agreeing is a property held by test
 * rather than one this function can enforce.
 *
 * `docs/development/COVERAGE.md` describes what the coverage gate does with the
 * answer.
 */
export function hasExecutableCode(content: string, filePath: string): boolean {
  const emitted = ts.transpileModule(content, {
    fileName: filePath,
    compilerOptions: TRANSPILE_OPTIONS,
  }).outputText;

  const parsed = ts.createSourceFile(
    "emitted.js",
    emitted,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  );
  return parsed.statements.some((statement) =>
    !ts.isExportDeclaration(statement)
  );
}
