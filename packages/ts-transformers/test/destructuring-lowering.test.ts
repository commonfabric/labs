import { assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import type { TransformationContext } from "../src/core/mod.ts";
import {
  collectDestructureBindings,
  createKeyCall,
  type DefaultDestructureBinding,
  type DestructureBinding,
  getStaticDefaultTypeNode,
  toStringPath,
} from "../src/transformers/destructuring-lowering.ts";

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
    options: {},
    state: {
      typeRegistry: new WeakMap<ts.Node, ts.Type>(),
    },
    cfHelpers: {
      getHelperExpr: (name: string) => ts.factory.createIdentifier(name),
    },
  } as unknown as TransformationContext;
}

function findVariable(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing variable ${name}`);
  return found;
}

function findBindingDeclaration(
  sourceFile: ts.SourceFile,
  predicate: (name: ts.BindingName) => boolean,
): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isVariableDeclaration(node) && predicate(node.name)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("Missing binding declaration");
  return found;
}

function printType(node: ts.TypeNode, sourceFile: ts.SourceFile): string {
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(
    ts.EmitHint.Unspecified,
    node,
    sourceFile,
  );
}

Deno.test("destructuring lowering converts static defaults to type nodes", () => {
  const { sourceFile, checker } = createProgram(`
    const text = "hello";
    const template = \`world\`;
    const numberValue = -1;
    const bigintValue = +2n;
    const flag = false;
    const empty = null;
    const missing = undefined;
    const tuple = ["x", 1, true];
    const objectValue = { label: "Ada", "display-name": "A", 0: null };
    const spreadArray = [...tuple];
  `);
  const context = testContext(checker);

  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "text").initializer!,
        context,
      )!,
      sourceFile,
    ),
    '"hello"',
  );
  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "template").initializer!,
        context,
      )!,
      sourceFile,
    ),
    '"world"',
  );
  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "numberValue").initializer!,
        context,
      )!,
      sourceFile,
    ),
    "-1",
  );
  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "bigintValue").initializer!,
        context,
      )!,
      sourceFile,
    ),
    "+2n",
  );
  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "flag").initializer!,
        context,
      )!,
      sourceFile,
    ),
    "false",
  );
  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "empty").initializer!,
        context,
      )!,
      sourceFile,
    ),
    "null",
  );
  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "missing").initializer!,
        context,
      )!,
      sourceFile,
    ),
    "undefined",
  );
  assertEquals(
    printType(
      getStaticDefaultTypeNode(
        findVariable(sourceFile, "tuple").initializer!,
        context,
      )!,
      sourceFile,
    ).replace(/\s+/g, " "),
    '[ "x", 1, true ]',
  );
  const objectType = printType(
    getStaticDefaultTypeNode(
      findVariable(sourceFile, "objectValue").initializer!,
      context,
    )!,
    sourceFile,
  );
  assertStringIncludes(objectType, 'label: "Ada";');
  assertStringIncludes(objectType, '"display-name": "A";');
  assertStringIncludes(objectType, "0: null;");
  assertEquals(
    getStaticDefaultTypeNode(
      findVariable(sourceFile, "spreadArray").initializer!,
      context,
    ),
    undefined,
  );
});

Deno.test("destructuring lowering collects array and object bindings", () => {
  const { sourceFile, checker } = createProgram(`
    declare const input: unknown;
    declare const dynamic: string;
    const [first = "x", , { name }, ...rest] = input as any;
    const { "title": title = 1, 0: zero, nested: { value }, [dynamic]: dyn } = input as any;
  `);
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const arrayBinding = findBindingDeclaration(
    sourceFile,
    ts.isArrayBindingPattern,
  );
  const objectBinding = findBindingDeclaration(
    sourceFile,
    ts.isObjectBindingPattern,
  );

  collectDestructureBindings(
    arrayBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );
  collectDestructureBindings(
    objectBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assertEquals(bindings.map((binding) => binding.localName), [
    "first",
    "name",
    "title",
    "zero",
    "value",
    "dyn",
  ]);
  assertEquals(bindings.map((binding) => toStringPath(binding.path)), [
    ["root", "0"],
    ["root", "2", "name"],
    ["root", "title"],
    ["root", "0"],
    ["root", "nested", "value"],
    undefined,
  ]);
  assertEquals(defaults.map((entry) => entry.path), [
    ["root", "0"],
    ["root", "title"],
  ]);
  assertEquals(unsupported.length, 1);
  assertStringIncludes(unsupported[0]!, "Rest destructuring");
});

Deno.test("destructuring lowering creates key calls for static and dynamic paths", () => {
  const { sourceFile } = createProgram("const dynamic = keyName;");
  const dynamic = findVariable(sourceFile, "dynamic").initializer!;
  const call = createKeyCall(
    ts.factory.createIdentifier("input"),
    ["profile", dynamic],
    ts.factory,
  );

  assertEquals(toStringPath(["profile", dynamic]), undefined);
  assertEquals(
    printType(ts.factory.createTypeReferenceNode("T"), sourceFile),
    "T",
  );
  assertEquals(
    ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(
      ts.EmitHint.Expression,
      call,
      sourceFile,
    ),
    'input.key("profile", keyName)',
  );
});
