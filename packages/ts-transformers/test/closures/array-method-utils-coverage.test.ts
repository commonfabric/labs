import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { collect } from "../transformed-ast.ts";
import type { TransformationContext } from "../../src/core/mod.ts";
import type { CaptureTreeNode } from "../../src/utils/capture-tree.ts";
import {
  analyzeElementBinding,
  type ElementBindingAnalysis,
  rewriteCallbackBody,
} from "../../src/closures/strategies/array-method-utils.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    skipLibCheck: true,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);

  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? sourceFile
      : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.readFile = (name) => name === fileName ? source : baseReadFile(name);
  host.fileExists = (name) => name === fileName || baseFileExists(name);

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function testContext(checker: ts.TypeChecker): TransformationContext {
  return {
    checker,
    factory: ts.factory,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: {},
    state: {
      typeRegistry: new WeakMap<ts.Node, ts.Type>(),
    },
    markAsSyntheticComputeCallback: () => {},
    cfHelpers: {
      getHelperExpr: (name: string) => ts.factory.createIdentifier(name),
      createHelperCall: (
        name: string,
        _node: ts.Node,
        typeArgs: readonly ts.TypeNode[] | undefined,
        args: readonly ts.Expression[],
      ) =>
        ts.factory.createCallExpression(
          ts.factory.createIdentifier(`__cf_${name}`),
          typeArgs ? [...typeArgs] : undefined,
          [...args],
        ),
    },
  } as unknown as TransformationContext;
}

/** Finds the first arrow function parameter in the source. */
function firstArrowParam(
  sourceFile: ts.SourceFile,
): ts.ParameterDeclaration {
  let found: ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isArrowFunction(node) && node.parameters.length > 0) {
      found = node.parameters[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("no arrow parameter found");
  return found;
}

const passthroughBindingId = (candidate: string): ts.Identifier =>
  ts.factory.createIdentifier(candidate);

/**
 * The bound leaf identifier names of a binding pattern (or any node containing
 * binding elements), recursing through nested object and array patterns. This
 * captures the identifiers a destructuring introduces regardless of how the
 * printer lays the pattern out.
 */
function boundNames(node: ts.Node): string[] {
  return collect(node, ts.isBindingElement).flatMap((element) =>
    ts.isIdentifier(element.name) ? [element.name.text] : []
  );
}

/** True when `node` contains a rest binding element (`...name`). */
function hasRestElement(node: ts.Node): boolean {
  return collect(node, ts.isBindingElement).some((element) =>
    element.dotDotDotToken !== undefined
  );
}

/** The identifiers a printed block reads or returns, by their source text. */
function identifierTexts(node: ts.Node): Set<string> {
  return new Set(collect(node, ts.isIdentifier).map((id) => id.text));
}

/**
 * True when `node` declares `name` — as a plain `const name = ...` variable or
 * as a leaf of a destructuring binding.
 */
function declaresName(node: ts.Node, name: string): boolean {
  const asVariable = collect(node, ts.isVariableDeclaration).some((decl) =>
    ts.isIdentifier(decl.name) && decl.name.text === name
  );
  return asVariable || boundNames(node).includes(name);
}

/** True when `node` contains `return <identifier>;` for the given name. */
function returnsIdentifier(node: ts.Node, name: string): boolean {
  return collect(node, ts.isReturnStatement).some((statement) =>
    statement.expression !== undefined &&
    ts.isIdentifier(statement.expression) &&
    statement.expression.text === name
  );
}

Deno.test("analyzeElementBinding synthesizes `element` when the callback takes no parameter", () => {
  const { checker } = createProgram("const x = 1;");
  const captureTree = new Map<string, CaptureTreeNode>();
  const analysis = analyzeElementBinding(
    undefined,
    captureTree,
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assert(ts.isIdentifier(analysis.bindingName));
  assertEquals(analysis.bindingName.text, "element");
  assertEquals(analysis.elementIdentifier.text, "element");
  assertEquals(analysis.computedAliases.length, 0);
});

Deno.test("analyzeElementBinding avoids the `element` name when the capture tree already uses it", () => {
  const { checker } = createProgram("const x = 1;");
  const captureTree = new Map<string, CaptureTreeNode>([
    ["element", { properties: new Map(), path: [] }],
  ]);
  const analysis = analyzeElementBinding(
    undefined,
    captureTree,
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assertEquals(analysis.elementIdentifier.text, "__cf_element");
});

Deno.test("analyzeElementBinding reuses a bare identifier parameter directly", () => {
  const { sourceFile, checker } = createProgram(
    "const f = (item) => item.name;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assert(ts.isIdentifier(analysis.bindingName));
  assertEquals(analysis.bindingName.text, "item");
  assertEquals(analysis.computedAliases.length, 0);
  assertEquals(analysis.destructureStatement, undefined);
});

Deno.test("analyzeElementBinding normalizes a plain object destructuring parameter without aliases", () => {
  const { sourceFile, checker } = createProgram(
    "const f = ({ name, value }) => name;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  // No computed keys means no aliases; the destructuring survives as the
  // binding name and its identifier falls back to "element".
  assertEquals(analysis.computedAliases.length, 0);
  assert(ts.isObjectBindingPattern(analysis.bindingName));
  assertEquals(analysis.elementIdentifier.text, "element");
  assertEquals(boundNames(analysis.bindingName), ["name", "value"]);
});

Deno.test("analyzeElementBinding walks nested object and array binding patterns", () => {
  const { sourceFile, checker } = createProgram(
    "const f = ({ outer: { inner }, tuple: [first] }) => first;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assertEquals(analysis.computedAliases.length, 0);
  assert(ts.isObjectBindingPattern(analysis.bindingName));
  // Nested object and array patterns are rebuilt with their leaf names intact.
  const names = new Set(boundNames(analysis.bindingName));
  assert(names.has("inner"));
  assert(names.has("first"));
});

Deno.test("analyzeElementBinding handles renamed and string-keyed object properties", () => {
  const { sourceFile, checker } = createProgram(
    'const f = ({ label: renamed, "weird-key": ok }) => renamed;',
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assertEquals(analysis.computedAliases.length, 0);
  // The renamed property (`label: renamed`) and the string-keyed property
  // (`"weird-key": ok`) bind their target identifiers, not their source keys.
  const names = new Set(boundNames(analysis.bindingName));
  assert(names.has("renamed"));
  assert(names.has("ok"));
});

Deno.test("analyzeElementBinding preserves array holes and rest elements", () => {
  const { sourceFile, checker } = createProgram(
    "const f = ([, second, ...rest]) => second;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assertEquals(analysis.computedAliases.length, 0);
  assert(ts.isArrayBindingPattern(analysis.bindingName));
  // The leading hole and the rest element are carried through the rebuild.
  const names = new Set(boundNames(analysis.bindingName));
  assert(names.has("second"));
  assert(names.has("rest"));
  assert(hasRestElement(analysis.bindingName));
});

Deno.test("analyzeElementBinding recurses into array elements that are themselves binding patterns", () => {
  const { sourceFile, checker } = createProgram(
    "const f = ([[a, b], { c }]) => a;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assertEquals(analysis.computedAliases.length, 0);
  assert(ts.isArrayBindingPattern(analysis.bindingName));
  // Both the nested array pattern and the nested object pattern are rebuilt.
  const names = new Set(boundNames(analysis.bindingName));
  assert(names.has("a"));
  assert(names.has("b"));
  assert(names.has("c"));
});

Deno.test("analyzeElementBinding drops nested object patterns that hold only a computed key inside an array", () => {
  // The inner `{ [k]: chosen }` produces no residual binding element, so the
  // nested walk returns undefined and the surrounding array element is left as
  // its original node while the computed key is lifted into an alias.
  const { sourceFile, checker } = createProgram(
    "declare const k: string;\n" +
      "const f = ([{ [k]: chosen }, kept]) => chosen;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assertEquals(analysis.computedAliases.length, 1);
  assertEquals(analysis.computedAliases[0].aliasName, "chosen");
  assert(analysis.destructureStatement);
  assert(boundNames(analysis.destructureStatement).includes("kept"));
});

Deno.test("analyzeElementBinding drops nested object patterns that hold only a computed key inside an object", () => {
  // The inner `{ [k]: chosen }` yields no residual, so its walk returns
  // undefined and the enclosing object property is skipped entirely.
  const { sourceFile, checker } = createProgram(
    "declare const k: string;\n" +
      "const f = ({ nested: { [k]: chosen }, kept }) => chosen;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  assertEquals(analysis.computedAliases.length, 1);
  assert(analysis.destructureStatement);
  // The nested-only-computed property is dropped; the sibling plain key stays.
  assert(boundNames(analysis.destructureStatement).includes("kept"));
  assertEquals(
    identifierTexts(analysis.destructureStatement).has("nested"),
    false,
  );
});

Deno.test("analyzeElementBinding lifts a computed key into an alias with a residual destructure", () => {
  const { sourceFile, checker } = createProgram(
    "declare const k: string;\n" +
      "const f = ({ [k]: chosen, other }) => chosen;",
  );
  const param = firstArrowParam(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  // The computed key becomes a lifted alias; the remaining plain property
  // stays as a residual destructuring statement bound to the element.
  assertEquals(analysis.computedAliases.length, 1);
  assertEquals(analysis.computedAliases[0].aliasName, "chosen");
  assertEquals(analysis.elementIdentifier.text, "element");
  assert(analysis.destructureStatement);
  // The residual destructure binds the plain `other` property from the
  // synthesized `element` receiver.
  assert(boundNames(analysis.destructureStatement).includes("other"));
  assert(identifierTexts(analysis.destructureStatement).has("element"));
});

Deno.test("rewriteCallbackBody returns the body unchanged when there are no computed aliases", () => {
  const { sourceFile, checker } = createProgram(
    "const f = (item) => item.name;",
  );
  const body = firstArrowBody(sourceFile);
  const analysis: ElementBindingAnalysis = {
    bindingName: ts.factory.createIdentifier("item"),
    elementIdentifier: ts.factory.createIdentifier("item"),
    computedAliases: [],
  };
  const result = rewriteCallbackBody(body, analysis, testContext(checker));
  assertEquals(result, body);
});

Deno.test("rewriteCallbackBody injects alias and key prologues around an expression body", () => {
  const { sourceFile, checker } = createProgram(
    "declare const k: string;\n" +
      "const f = ({ [k]: chosen }) => chosen;",
  );
  const param = firstArrowParam(sourceFile);
  const body = firstArrowBody(sourceFile);
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  const result = rewriteCallbackBody(body, analysis, testContext(checker));
  // A concise expression body becomes a block; the key binding and the alias
  // binding are prepended, and the original expression returns from the block.
  assert(ts.isBlock(result));
  // The lifted alias `chosen` is bound in the prologue and the original
  // expression body becomes a `return chosen;`.
  assert(declaresName(result, "chosen"));
  assert(returnsIdentifier(result, "chosen"));
});

Deno.test("rewriteCallbackBody reuses an existing block body when injecting alias prologues", () => {
  const { sourceFile, checker } = createProgram(
    "declare const k: string;\n" +
      "const f = ({ [k]: chosen }) => { return chosen; };",
  );
  const param = firstArrowParam(sourceFile);
  const body = firstArrowBody(sourceFile);
  assert(ts.isBlock(body));
  const analysis = analyzeElementBinding(
    param,
    new Map(),
    testContext(checker),
    new Set<string>(),
    passthroughBindingId,
  );
  const result = rewriteCallbackBody(body, analysis, testContext(checker));
  assert(ts.isBlock(result));
  // The original block's statements are retained after the injected prologue.
  assert(declaresName(result, "chosen"));
  assert(returnsIdentifier(result, "chosen"));
});

/** Finds the body of the first arrow function in the source. */
function firstArrowBody(sourceFile: ts.SourceFile): ts.ConciseBody {
  let found: ts.ConciseBody | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isArrowFunction(node)) {
      found = node.body;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("no arrow function found");
  return found;
}
