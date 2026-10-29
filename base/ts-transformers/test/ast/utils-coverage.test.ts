import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import {
  getMemberSymbol,
  getNodeText,
  getTypeAtLocationWithFallback,
  getVariableInitializer,
  isFunctionParameter,
  isOptionalMemberSymbol,
  setParentPointers,
} from "../../src/ast/utils.ts";

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
    ts.ScriptKind.TS,
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

function findFirst<T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T,
  predicate: (node: T) => boolean = () => true,
): T {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && guard(node) && predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error("node not found");
  return found;
}

Deno.test("getMemberSymbol resolves a property access through the base type", () => {
  const { sourceFile, checker } = createProgram(
    `interface Config { title: string }
     declare const config: Config;
     const value = config.title;`,
  );
  const access = findFirst(sourceFile, ts.isPropertyAccessExpression);
  const symbol = getMemberSymbol(access, checker);
  assert(symbol);
  assertEquals(symbol.getName(), "title");
});

Deno.test(
  "getMemberSymbol resolves a string-literal element access through the base type",
  () => {
    const { sourceFile, checker } = createProgram(
      `interface Config { title: string }
       declare const config: Config;
       const value = config["title"];`,
    );
    const access = findFirst(sourceFile, ts.isElementAccessExpression);
    const symbol = getMemberSymbol(access, checker);
    assert(symbol);
    assertEquals(symbol.getName(), "title");
  },
);

Deno.test(
  "getMemberSymbol returns undefined for an unknown element-access key",
  () => {
    const { sourceFile, checker } = createProgram(
      `interface Config { title: string }
       declare const config: Config;
       const value = config["missing"];`,
    );
    const access = findFirst(sourceFile, ts.isElementAccessExpression);
    // No such property on the base type, so no member symbol is resolved.
    assertEquals(getMemberSymbol(access, checker), undefined);
  },
);

Deno.test("isOptionalMemberSymbol reflects the optional property flag", () => {
  const { sourceFile, checker } = createProgram(
    `interface Config { maybe?: string; required: string }
     declare const config: Config;
     const a = config.maybe;
     const b = config.required;`,
  );
  const accesses: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) accesses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const maybe = accesses.find((a) => a.name.text === "maybe")!;
  const required = accesses.find((a) => a.name.text === "required")!;
  assertEquals(isOptionalMemberSymbol(maybe, checker), true);
  assertEquals(isOptionalMemberSymbol(required, checker), false);
});

Deno.test("isFunctionParameter recognizes a plain function parameter", () => {
  const { sourceFile, checker } = createProgram(
    `function f(param: number) { return param + 1; }`,
  );
  const usage = findFirst(
    sourceFile,
    ts.isIdentifier,
    (n) => n.text === "param" && !ts.isParameter(n.parent),
  );
  assertEquals(isFunctionParameter(usage, checker), true);
});

Deno.test(
  "isFunctionParameter treats a builder-owned callback parameter as opaque",
  () => {
    // The arrow is the argument of a `pattern(...)` call, so its parameter is
    // builder-owned and must not be reported as an ordinary function parameter.
    const { sourceFile, checker } = createProgram(
      `declare function pattern<T>(fn: (state: T) => unknown): unknown;
       const p = pattern((state: { x: number }) => state.x);`,
    );
    const usage = findFirst(
      sourceFile,
      ts.isIdentifier,
      (n) => n.text === "state" && ts.isPropertyAccessExpression(n.parent),
    );
    assertEquals(isFunctionParameter(usage, checker), false);
  },
);

Deno.test(
  "isFunctionParameter recognizes the declaring parameter name identifier",
  () => {
    const { sourceFile, checker } = createProgram(
      `function f(only: number) { return 0; }`,
    );
    const name = findFirst(
      sourceFile,
      ts.isIdentifier,
      (n) =>
        n.text === "only" && ts.isParameter(n.parent) && n.parent.name === n,
    );
    assertEquals(isFunctionParameter(name, checker), true);
  },
);

Deno.test("isFunctionParameter rejects a non-parameter identifier", () => {
  const { sourceFile, checker } = createProgram(
    `const local = 1; const other = local + 1;`,
  );
  const usage = findFirst(
    sourceFile,
    ts.isIdentifier,
    (n) => n.text === "local" && ts.isBinaryExpression(n.parent),
  );
  assertEquals(isFunctionParameter(usage, checker), false);
});

Deno.test(
  "isFunctionParameter returns false for a synthetic identifier with no source file",
  () => {
    const { checker } = createProgram(`const x = 1;`);
    const synthetic = ts.factory.createIdentifier("element");
    // A freshly created identifier has no source file, so the parent chain
    // cannot be traversed and it is treated as opaque.
    assertEquals(isFunctionParameter(synthetic, checker), false);
  },
);

Deno.test("getVariableInitializer returns the initializer of a const binding", () => {
  const { sourceFile, checker } = createProgram(
    `const seed = 41 + 1; const used = seed;`,
  );
  const usage = findFirst(
    sourceFile,
    ts.isIdentifier,
    (n) =>
      n.text === "seed" && ts.isVariableDeclaration(n.parent) &&
      n.parent.name !== n,
  );
  const initializer = getVariableInitializer(usage, checker);
  assert(initializer);
  assert(ts.isBinaryExpression(initializer));
});

Deno.test(
  "getVariableInitializer returns undefined for a non-identifier expression",
  () => {
    const { sourceFile, checker } = createProgram(`const value = 1 + 2;`);
    const binary = findFirst(sourceFile, ts.isBinaryExpression);
    assertEquals(getVariableInitializer(binary, checker), undefined);
  },
);

Deno.test(
  "getTypeAtLocationWithFallback prefers a registered synthetic type",
  () => {
    const { sourceFile, checker } = createProgram(`declare const x: unknown;`);
    const identifier = findFirst(sourceFile, ts.isIdentifier);
    const registry = new WeakMap<ts.Node, ts.Type>();
    const stringType = checker.getStringType();
    registry.set(identifier, stringType);
    const resolved = getTypeAtLocationWithFallback(
      identifier,
      checker,
      registry,
    );
    assertEquals(resolved, stringType);
  },
);

Deno.test(
  "getTypeAtLocationWithFallback falls back to a better-typed initializer for an any binding",
  () => {
    // `raw` has no annotation and an `any`-typed initializer at the checker
    // level, but the registry supplies a concrete initializer type that the
    // fallback should surface instead of the widened any.
    const { sourceFile, checker } = createProgram(
      `declare function makeAny(): any; const raw = makeAny(); const used = raw;`,
    );
    const usage = findFirst(
      sourceFile,
      ts.isIdentifier,
      (n) =>
        n.text === "raw" && ts.isVariableDeclaration(n.parent) &&
        n.parent.name !== n,
    );
    const declaration = findFirst(
      sourceFile,
      ts.isVariableDeclaration,
      (d) => ts.isIdentifier(d.name) && d.name.text === "raw",
    );
    const registry = new WeakMap<ts.Node, ts.Type>();
    registry.set(declaration.initializer!, checker.getNumberType());
    const resolved = getTypeAtLocationWithFallback(usage, checker, registry);
    assertEquals(resolved, checker.getNumberType());
  },
);

Deno.test("setParentPointers wires parent links on a synthetic subtree", () => {
  const inner = ts.factory.createIdentifier("inner");
  const call = ts.factory.createCallExpression(inner, undefined, []);
  const statement = ts.factory.createExpressionStatement(call);
  setParentPointers(statement);
  assertEquals(call.parent, statement);
  assertEquals(inner.parent, call);
});

Deno.test("getNodeText prints a synthetic node that has no source file", () => {
  const identifier = ts.factory.createIdentifier("synthetic");
  assertEquals(getNodeText(identifier), "synthetic");
});
