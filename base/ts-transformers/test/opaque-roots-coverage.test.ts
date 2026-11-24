/**
 * Unit coverage for `src/transformers/opaque-roots.ts`.
 *
 * These tests drive the pure AST-shape helpers directly:
 *
 * - `classifyOpaquePathTerminalCall` — classifies the trailing call of an opaque
 *   navigation chain as `.get()` / `.key()`, including the element-access form
 *   (`obj["get"]()`).
 * - `getOpaqueAccessInfo` — walks a member-access chain back to its root,
 *   unwrapping parenthesization/casts/non-null/partially-emitted wrappers and
 *   recording the traversed path segments plus whether any segment was dynamic.
 * - `addBindingTargetSymbols` — collects the declared symbols of a binding name,
 *   descending into array/object binding patterns and skipping holes.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";

import ts from "typescript";

import type { TransformationContext } from "../src/core/mod.ts";
import {
  addBindingTargetSymbols,
  classifyOpaquePathTerminalCall,
  getOpaqueAccessInfo,
} from "../src/transformers/opaque-roots.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TS,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";
  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function testContext(checker: ts.TypeChecker): TransformationContext {
  return {
    checker,
    factory: ts.factory,
  } as unknown as TransformationContext;
}

function findInitializer(
  sourceFile: ts.SourceFile,
  name: string,
): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name && node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Initializer for ${name} not found`);
  return found;
}

function findVariable(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found && ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) && node.name.text === name
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Variable declaration for ${name} not found`);
  return found;
}

//
// classifyOpaquePathTerminalCall
//

Deno.test("classifyOpaquePathTerminalCall recognizes .get() and .key() property-access terminals", () => {
  const { sourceFile } = createProgram(`
    const a = obj.get();
    const b = obj.key();
    const c = obj.other();
  `);
  const get = findInitializer(sourceFile, "a") as ts.CallExpression;
  const key = findInitializer(sourceFile, "b") as ts.CallExpression;
  const other = findInitializer(sourceFile, "c") as ts.CallExpression;

  assertEquals(classifyOpaquePathTerminalCall(get), "get");
  assertEquals(classifyOpaquePathTerminalCall(key), "key");
  assertEquals(classifyOpaquePathTerminalCall(other), undefined);
});

Deno.test("classifyOpaquePathTerminalCall recognizes string-literal element-access terminals", () => {
  // `obj["get"]()` and `obj["key"]()` classify the same as the property-access
  // form via the element-access branch.
  const { sourceFile } = createProgram(`
    const a = obj["get"]();
    const b = obj["key"]();
  `);
  const get = findInitializer(sourceFile, "a") as ts.CallExpression;
  const key = findInitializer(sourceFile, "b") as ts.CallExpression;

  assertEquals(classifyOpaquePathTerminalCall(get), "get");
  assertEquals(classifyOpaquePathTerminalCall(key), "key");
});

Deno.test("classifyOpaquePathTerminalCall recognizes no-substitution-template element-access terminals", () => {
  const { sourceFile } = createProgram(`
    const a = obj[\`get\`]();
  `);
  const get = findInitializer(sourceFile, "a") as ts.CallExpression;
  assertEquals(classifyOpaquePathTerminalCall(get), "get");
});

Deno.test("classifyOpaquePathTerminalCall ignores an unrelated element-access key", () => {
  const { sourceFile } = createProgram(`
    const a = obj["other"]();
  `);
  const call = findInitializer(sourceFile, "a") as ts.CallExpression;
  assertEquals(classifyOpaquePathTerminalCall(call), undefined);
});

Deno.test("classifyOpaquePathTerminalCall ignores a computed (non-literal) element-access key", () => {
  // A dynamic key (identifier) is neither a StringLiteralLike nor a
  // NoSubstitutionTemplate, so the element-access branch falls through to
  // undefined.
  const { sourceFile } = createProgram(`
    const k = "get";
    const a = obj[k]();
  `);
  const call = findInitializer(sourceFile, "a") as ts.CallExpression;
  assertEquals(classifyOpaquePathTerminalCall(call), undefined);
});

Deno.test("classifyOpaquePathTerminalCall returns undefined for a bare identifier callee", () => {
  const { sourceFile } = createProgram(`const a = fn();`);
  const call = findInitializer(sourceFile, "a") as ts.CallExpression;
  assertEquals(classifyOpaquePathTerminalCall(call), undefined);
});

//
// getOpaqueAccessInfo
//

Deno.test("getOpaqueAccessInfo records the root identifier and property path", () => {
  const { sourceFile, checker } = createProgram(`const a = root.foo.bar;`);
  const expr = findInitializer(sourceFile, "a");
  const info = getOpaqueAccessInfo(expr, testContext(checker));
  assertEquals(info.root, "root");
  assert(info.rootIdentifier && ts.isIdentifier(info.rootIdentifier));
  assertEquals(info.path, ["foo", "bar"]);
  assertFalse(info.dynamic);
});

Deno.test("getOpaqueAccessInfo unwraps parenthesized and `as`/`satisfies`/`!`/`<T>` wrappers", () => {
  // Each wrapper type peels off before the chain walk continues, so the root
  // and path are recovered identically to the unwrapped form.
  const { sourceFile, checker } = createProgram(`
    const asExpr = (root as any).foo;
    const satisfiesExpr = (root satisfies unknown).foo;
    const nonNull = root!.foo;
    const oldCast = (<any>root).foo;
    const paren = ((root)).foo;
  `);
  for (
    const name of ["asExpr", "satisfiesExpr", "nonNull", "oldCast", "paren"]
  ) {
    const info = getOpaqueAccessInfo(
      findInitializer(sourceFile, name),
      testContext(checker),
    );
    assertEquals(info.root, "root", `root for ${name}`);
    assertEquals(info.path, ["foo"], `path for ${name}`);
    assertFalse(info.dynamic, `dynamic for ${name}`);
  }
});

Deno.test("getOpaqueAccessInfo records literal element-access segments as path entries", () => {
  const { sourceFile, checker } = createProgram(`
    const a = root["foo"][0];
  `);
  const info = getOpaqueAccessInfo(
    findInitializer(sourceFile, "a"),
    testContext(checker),
  );
  assertEquals(info.root, "root");
  assertEquals(info.path, ["foo", "0"]);
  assertFalse(info.dynamic);
});

Deno.test("getOpaqueAccessInfo marks a computed element-access key as dynamic", () => {
  // A call-expression index cannot be resolved to a static path segment, so the
  // access is flagged dynamic and no segment is recorded.
  const { sourceFile, checker } = createProgram(`
    const a = root[compute()];
  `);
  const info = getOpaqueAccessInfo(
    findInitializer(sourceFile, "a"),
    testContext(checker),
  );
  assertEquals(info.root, "root");
  assertEquals(info.path, []);
  assert(info.dynamic);
});

Deno.test("getOpaqueAccessInfo unwraps a partially-emitted expression wrapper", () => {
  // PartiallyEmittedExpression is a synthetic node kind produced by transforms
  // rather than the parser, so it is built with the factory here. The walker
  // peels it off and recovers the underlying `root.foo` chain.
  const { sourceFile, checker } = createProgram(`const a = root.foo;`);
  const inner = findInitializer(sourceFile, "a");
  const wrapped = ts.factory.createPartiallyEmittedExpression(inner);
  const info = getOpaqueAccessInfo(wrapped, testContext(checker));
  assertEquals(info.root, "root");
  assertEquals(info.path, ["foo"]);
  assertFalse(info.dynamic);
});

Deno.test("getOpaqueAccessInfo marks an unresolvable element-access key as dynamic", () => {
  // `root[]` is a parse error; recovery yields an ElementAccess whose argument
  // is a present-but-empty missing identifier. It is not a literal key and does
  // not resolve to a known computed key, so the access is flagged dynamic with
  // no path segment recorded.
  const { sourceFile, checker } = createProgram(`const a = root[];`);
  const info = getOpaqueAccessInfo(
    findInitializer(sourceFile, "a"),
    testContext(checker),
  );
  assertEquals(info.root, "root");
  assertEquals(info.path, []);
  assert(info.dynamic);
});

Deno.test("getOpaqueAccessInfo returns no root when the chain does not bottom out on an identifier", () => {
  // A chain rooted in a call expression (`fn().foo`) has no identifier root, so
  // `root`/`rootIdentifier` are absent while the path is still recorded.
  const { sourceFile, checker } = createProgram(`
    const a = fn().foo;
  `);
  const info = getOpaqueAccessInfo(
    findInitializer(sourceFile, "a"),
    testContext(checker),
  );
  assertEquals(info.root, undefined);
  assertEquals(info.rootIdentifier, undefined);
  assertEquals(info.path, ["foo"]);
});

//
// addBindingTargetSymbols
//

Deno.test("addBindingTargetSymbols collects a simple identifier binding symbol", () => {
  const { sourceFile, checker } = createProgram(`const single = 1;`);
  const decl = findVariable(sourceFile, "single");
  const bucket = new Set<ts.Symbol>();
  addBindingTargetSymbols(decl.name, bucket, checker);
  assertEquals([...bucket].map((s) => s.getName()), ["single"]);
});

Deno.test("addBindingTargetSymbols descends into nested binding patterns and skips array holes", () => {
  // Array holes are OmittedExpression elements that are skipped; object and
  // nested array patterns recurse into their element names.
  const { sourceFile, checker } = createProgram(`
    const [first, , { nested }] = source;
  `);
  let decl: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (!decl && ts.isVariableDeclaration(node)) decl = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert(decl);

  const bucket = new Set<ts.Symbol>();
  addBindingTargetSymbols(decl.name, bucket, checker);
  const names = [...bucket].map((s) => s.getName()).sort();
  assertEquals(names, ["first", "nested"]);
});
