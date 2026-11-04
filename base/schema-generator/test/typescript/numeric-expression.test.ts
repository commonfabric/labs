/**
 * These cases drive `numberFromExpression` against a real compiled program
 * rather than a hand-built node, because one distinction it has to make can
 * come from nowhere else: whether an identifier naming a non-finite global is
 * the global or a local rebinding of it, which is a question about the file's
 * own scope and so is answered by the checker.
 *
 * The wrapper cases need no such thing. Seeing through parentheses, `as`, and
 * `satisfies` is pure syntax, and they are here because unwrapping must not
 * widen what counts as a number, not because a program is required to test
 * them.
 *
 * The declining cases carry as much weight as the recognizing ones. Folding a
 * non-numeric expression, or a prefix operator that is not a sign, would put
 * a fabricated value into a generated schema, which is a worse outcome than
 * declining to read one at all.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import ts from "typescript";

import { numberFromExpression } from "../../src/typescript/numeric-expression.ts";

/**
 * Build a checker over a single synthetic file. No default library is
 * supplied, so an unshadowed `NaN`/`Infinity` resolves to no symbol at all —
 * which is what the helper treats as "the global".
 */
function createProgram(source: string): {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.fileExists = (name) => name === fileName;
  host.getDirectories = () => [];
  host.getCurrentDirectory = () => "/";
  host.writeFile = () => {};

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { checker: program.getTypeChecker(), sourceFile };
}

/** Evaluate the initializer of `const <name> = ...` in `source`. */
function evaluate(source: string, name: string): number | undefined {
  const { checker, sourceFile } = createProgram(source);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) throw new Error(`no initializer for ${name}`);
  return numberFromExpression(initializer, checker);
}

/** Evaluate `const v = <expr>;` — the common single-expression case. */
function evaluateExpr(expr: string): number | undefined {
  return evaluate(`const v = ${expr};`, "v");
}

Deno.test("numberFromExpression: unsigned literals", () => {
  assertStrictEquals(evaluateExpr("5"), 5);
  assertStrictEquals(evaluateExpr("0"), 0);
  assertStrictEquals(evaluateExpr("1.5"), 1.5);
  assertStrictEquals(evaluateExpr("0x10"), 16);
  assertStrictEquals(evaluateExpr("1e3"), 1000);
});

Deno.test("numberFromExpression: signed literals", () => {
  assertStrictEquals(evaluateExpr("-5"), -5);
  assertStrictEquals(evaluateExpr("-1"), -1);
  assertStrictEquals(evaluateExpr("-0.5"), -0.5);
  assertStrictEquals(evaluateExpr("+5"), 5);
  // Nested signs fold rather than bailing.
  assertStrictEquals(evaluateExpr("- -5"), 5);
  assertStrictEquals(evaluateExpr("-+-5"), 5);
});

Deno.test("numberFromExpression: signed zero keeps its sign", () => {
  // The whole point of the value model: -0 and 0 are distinct stored values.
  assertEquals(Object.is(evaluateExpr("-0"), -0), true);
  assertEquals(Object.is(evaluateExpr("0"), 0), true);
  assertEquals(Object.is(evaluateExpr("-0"), 0), false);
  assertEquals(Object.is(evaluateExpr("- -0"), 0), true);
});

Deno.test("numberFromExpression: non-finite globals", () => {
  assertEquals(Number.isNaN(evaluateExpr("NaN")), true);
  assertStrictEquals(evaluateExpr("Infinity"), Infinity);
  assertStrictEquals(evaluateExpr("-Infinity"), -Infinity);
  assertStrictEquals(evaluateExpr("+Infinity"), Infinity);
  assertEquals(Number.isNaN(evaluateExpr("-NaN")), true);
});

Deno.test("numberFromExpression: shadowed non-finite globals do not fold", () => {
  // A local binding named `NaN` denotes 111 here, not the global. Folding it
  // to the global would be silently wrong, so the helper declines instead.
  assertStrictEquals(
    evaluate("const NaN = 111; const v = NaN;", "v"),
    undefined,
  );
  assertStrictEquals(
    evaluate("const Infinity = 222; const v = Infinity;", "v"),
    undefined,
  );
  assertStrictEquals(
    evaluate("const Infinity = 222; const v = -Infinity;", "v"),
    undefined,
  );
});

Deno.test("numberFromExpression: sees through parentheses", () => {
  // Parentheses can wrap the whole expression or sit inside it; `-(1)` is the
  // case no unwrapping by the caller could reach.
  assertStrictEquals(evaluateExpr("(1)"), 1);
  assertStrictEquals(evaluateExpr("(-1)"), -1);
  assertStrictEquals(evaluateExpr("((1))"), 1);
  assertStrictEquals(evaluateExpr("-(1)"), -1);
  assertStrictEquals(evaluateExpr("-(-1)"), 1);
  assertEquals(Object.is(evaluateExpr("(-0)"), -0), true);
  assertEquals(Object.is(evaluateExpr("-(0)"), -0), true);
  assertEquals(Number.isNaN(evaluateExpr("(NaN)")), true);
  assertStrictEquals(evaluateExpr("-(Infinity)"), -Infinity);
  // Unwrapping must not widen what counts as a number. A parenthesized
  // non-number is still a non-number.
  assertStrictEquals(evaluateExpr(`("5")`), undefined);
  assertStrictEquals(evaluateExpr(`-("5")`), undefined);
  assertStrictEquals(evaluateExpr("(true)"), undefined);
  assertStrictEquals(evaluateExpr("(someName)"), undefined);
  assertStrictEquals(evaluateExpr("(1 + 1)"), undefined);
  // A shadowed global stays unresolvable through parentheses too.
  assertStrictEquals(
    evaluate("const NaN = 111; const v = (NaN);", "v"),
    undefined,
  );
});

Deno.test("numberFromExpression: sees through type-only wrappers", () => {
  // `as`, `satisfies` and the angle-bracket assertion change no value. They are
  // transparent at the caller's outermost level already; these are the nested
  // positions only this function can reach.
  assertStrictEquals(evaluateExpr("1 as number"), 1);
  assertStrictEquals(evaluateExpr("-(1 as number)"), -1);
  assertStrictEquals(evaluateExpr("-(1 as const)"), -1);
  assertStrictEquals(evaluateExpr("(-1) as number"), -1);
  assertStrictEquals(evaluateExpr("1 satisfies number"), 1);
  assertStrictEquals(evaluateExpr("-(1 satisfies number)"), -1);
  assertEquals(Object.is(evaluateExpr("-(0 as number)"), -0), true);
  assertStrictEquals(evaluateExpr("-(Infinity as number)"), -Infinity);
});

Deno.test("numberFromExpression: declines non-numeric expressions", () => {
  assertStrictEquals(evaluateExpr(`"5"`), undefined);
  assertStrictEquals(evaluateExpr("true"), undefined);
  assertStrictEquals(evaluateExpr("null"), undefined);
  assertStrictEquals(evaluateExpr("someName"), undefined);
  assertStrictEquals(evaluateExpr("2 + 3"), undefined);
  assertStrictEquals(evaluateExpr("f()"), undefined);
});

Deno.test("numberFromExpression: declines non-sign prefix operators", () => {
  assertStrictEquals(evaluateExpr("~5"), undefined);
  assertStrictEquals(evaluateExpr("!5"), undefined);
  assertStrictEquals(evaluateExpr(`-"5"`), undefined);
});
