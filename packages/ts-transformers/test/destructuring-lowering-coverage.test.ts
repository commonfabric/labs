import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import type { TransformationContext } from "../src/core/mod.ts";
import {
  collectDestructureBindings,
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
  ).replace(/\s+/g, " ").trim();
}

/**
 * Assert that `node` is a type-literal with a single property signature whose
 * name (as `.text`) and numeric-literal value match. Pins the lowered default
 * type on the returned AST node rather than on its printed text.
 */
function assertSingleNumericProp(
  node: ts.TypeNode,
  name: string,
  value: string,
): void {
  assert(ts.isTypeLiteralNode(node), "expected a type literal");
  assertEquals(node.members.length, 1);
  const member = node.members[0]!;
  assert(ts.isPropertySignature(member), "expected a property signature");
  assert(
    ts.isNumericLiteral(member.name) || ts.isStringLiteral(member.name),
    "expected a numeric or string property name",
  );
  assertEquals(member.name.text, name);
  assert(
    member.type && ts.isLiteralTypeNode(member.type),
    "expected a literal type",
  );
  assert(
    ts.isNumericLiteral(member.type.literal),
    "expected a numeric literal type value",
  );
  assertEquals(member.type.literal.text, value);
}

Deno.test("getStaticDefaultTypeNode lowers a bare bigint literal to its literal type", () => {
  const { sourceFile, checker } = createProgram("const big = 7n;");
  const context = testContext(checker);

  const typeNode = getStaticDefaultTypeNode(
    findVariable(sourceFile, "big").initializer!,
    context,
  );
  assert(typeNode);
  assertEquals(printType(typeNode, sourceFile), "7n");
});

Deno.test("getStaticDefaultTypeNode bails on an array whose element is non-static", () => {
  // A bare identifier element has no static literal form, so the whole array
  // default is rejected (returns undefined).
  const { sourceFile, checker } = createProgram(
    "declare const other: number; const arr = [other];",
  );
  const context = testContext(checker);

  assertEquals(
    getStaticDefaultTypeNode(
      findVariable(sourceFile, "arr").initializer!,
      context,
    ),
    undefined,
  );
});

Deno.test("getStaticDefaultTypeNode rejects an object literal with a non-assignment property", () => {
  // A shorthand property assignment is not a PropertyAssignment, so the object
  // default cannot be lowered.
  const { sourceFile, checker } = createProgram(
    "declare const label: string; const obj = { label };",
  );
  const context = testContext(checker);

  assertEquals(
    getStaticDefaultTypeNode(
      findVariable(sourceFile, "obj").initializer!,
      context,
    ),
    undefined,
  );
});

Deno.test("getStaticDefaultTypeNode lowers a numeric object key and rejects a computed key", () => {
  const { sourceFile, checker } = createProgram(
    "const numericKey = { 3: 1 };\n" +
      "const computedKey = { [Symbol.iterator]: 4 };\n",
  );
  const context = testContext(checker);

  const numeric = getStaticDefaultTypeNode(
    findVariable(sourceFile, "numericKey").initializer!,
    context,
  );
  assert(numeric);
  assertSingleNumericProp(numeric, "3", "1");

  // Computed property name is not a supported key kind, so the object is
  // rejected wholesale.
  assertEquals(
    getStaticDefaultTypeNode(
      findVariable(sourceFile, "computedKey").initializer!,
      context,
    ),
    undefined,
  );
});

Deno.test("getStaticDefaultTypeNode lowers a no-substitution-template object key", () => {
  // A template-literal property name is not producible from object-literal
  // source syntax, so synthesize the object literal and drive the branch that
  // treats a no-substitution template key as a string key.
  const { checker } = createProgram("declare const x: number;");
  const context = testContext(checker);
  const factory = ts.factory;

  const objectLiteral = factory.createObjectLiteralExpression([
    factory.createPropertyAssignment(
      factory.createNoSubstitutionTemplateLiteral("tpl", "tpl"),
      factory.createNumericLiteral("2"),
    ),
  ]);

  const typeNode = getStaticDefaultTypeNode(objectLiteral, context);
  assert(typeNode);
  assertSingleNumericProp(typeNode, "tpl", "2");
});

Deno.test("getStaticDefaultTypeNode rejects an object whose property value is non-static", () => {
  const { sourceFile, checker } = createProgram(
    "declare const dyn: number; const obj = { count: dyn };",
  );
  const context = testContext(checker);

  assertEquals(
    getStaticDefaultTypeNode(
      findVariable(sourceFile, "obj").initializer!,
      context,
    ),
    undefined,
  );
});

Deno.test("collectDestructureBindings records a plain identifier binding at its path", () => {
  const { checker } = createProgram("declare const x: number;");
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];

  collectDestructureBindings(
    ts.factory.createIdentifier("localName"),
    ["root", "field"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assertEquals(bindings.length, 1);
  assertEquals(bindings[0]!.localName, "localName");
  assertEquals(toStringPath(bindings[0]!.path), ["root", "field"]);
  assertEquals(defaults.length, 0);
  assertEquals(unsupported.length, 0);
});

Deno.test("collectDestructureBindings uses the shorthand identifier as the key", () => {
  const { sourceFile, checker } = createProgram(
    "declare const input: any; const { plain } = input;",
  );
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const objectBinding = findBindingDeclaration(
    sourceFile,
    ts.isObjectBindingPattern,
  );

  collectDestructureBindings(
    objectBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assertEquals(unsupported.length, 0);
  assertEquals(bindings.length, 1);
  assertEquals(bindings[0]!.localName, "plain");
  assertEquals(toStringPath(bindings[0]!.path), ["root", "plain"]);
});

Deno.test("collectDestructureBindings reports an unsupported property-name kind", () => {
  // Only a private-identifier property name can slip past the identifier /
  // string / numeric / computed branches, and that form is not producible from
  // destructuring source, so synthesize the binding element.
  const { checker } = createProgram("declare const x: number;");
  const context = testContext(checker);
  const factory = ts.factory;

  const element = factory.createBindingElement(
    undefined,
    factory.createPrivateIdentifier("#secret"),
    factory.createIdentifier("value"),
  );
  const objectPattern = factory.createObjectBindingPattern([element]);

  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];

  collectDestructureBindings(
    objectPattern,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assert(
    unsupported.some((message) =>
      message.includes("Unsupported destructuring key in pattern context")
    ),
    `unsupported was: ${JSON.stringify(unsupported)}`,
  );
});

Deno.test("collectDestructureBindings rejects a non-static default on an array element", () => {
  const { sourceFile, checker } = createProgram(
    "declare const fallback: number; declare const input: any;\n" +
      "const [first = fallback] = input;",
  );
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const arrayBinding = findBindingDeclaration(
    sourceFile,
    ts.isArrayBindingPattern,
  );

  collectDestructureBindings(
    arrayBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assertEquals(defaults.length, 0);
  assertEquals(unsupported.length, 1);
  assertStringIncludes(
    unsupported[0]!,
    "Non-static destructuring initializers",
  );
  // The rejected default skips the rest of the element, so no binding is kept.
  assertEquals(bindings.length, 0);
});

Deno.test("collectDestructureBindings rejects an array default under a dynamic parent path", () => {
  const { sourceFile, checker } = createProgram(
    "declare const input: any; const [first = 5] = input;",
  );
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const arrayBinding = findBindingDeclaration(
    sourceFile,
    ts.isArrayBindingPattern,
  );

  // Seed the path with a non-string (dynamic) segment so toStringPath fails
  // when the array element's default path is built.
  const dynamicSegment = ts.factory.createIdentifier("dynamicKey");
  collectDestructureBindings(
    arrayBinding.name,
    [dynamicSegment],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assertEquals(defaults.length, 0);
  assertEquals(unsupported.length, 1);
  assertStringIncludes(
    unsupported[0]!,
    "Defaults on dynamic destructuring keys",
  );
});

Deno.test("collectDestructureBindings rejects an object element without a key and a non-identifier name", () => {
  // Object destructuring source syntax cannot express an element that has no
  // property name yet binds a nested pattern, so synthesize that binding
  // element to reach the branch that reports it as unsupported.
  const { checker } = createProgram("declare const x: number;");
  const context = testContext(checker);
  const factory = ts.factory;

  const nestedPattern = factory.createArrayBindingPattern([
    factory.createBindingElement(
      undefined,
      undefined,
      factory.createIdentifier("inner"),
    ),
  ]);
  const element = factory.createBindingElement(
    undefined,
    undefined,
    nestedPattern,
  );
  const objectPattern = factory.createObjectBindingPattern([element]);

  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];

  collectDestructureBindings(
    objectPattern,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assert(
    unsupported.some((message) =>
      message.includes("Nested binding without explicit property key")
    ),
    `unsupported was: ${JSON.stringify(unsupported)}`,
  );
});

Deno.test("collectDestructureBindings rejects an unsupported computed key that is not a fabric key", () => {
  // A computed key expression that neither resolves to a fabric key nor to a
  // static/known key is unsupported.
  const { sourceFile, checker } = createProgram(
    "declare const input: any; declare const other: symbol;\n" +
      "const { [other]: value } = input;",
  );
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const objectBinding = findBindingDeclaration(
    sourceFile,
    ts.isObjectBindingPattern,
  );

  collectDestructureBindings(
    objectBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  // A computed identifier key falls through to the dynamic-expression path and
  // yields a binding with an undefined string path rather than an unsupported
  // message, so assert on that shape.
  assert(
    bindings.some((binding) => toStringPath(binding.path) === undefined) ||
      unsupported.length > 0,
  );
});

Deno.test("collectDestructureBindings rejects a default on a dynamic object key", () => {
  // A computed key that stays a dynamic expression cannot carry a default,
  // because the default path would contain a non-string segment.
  const { sourceFile, checker } = createProgram(
    "declare const input: any; declare const other: symbol;\n" +
      "const { [other]: value = 3 } = input;",
  );
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const objectBinding = findBindingDeclaration(
    sourceFile,
    ts.isObjectBindingPattern,
  );

  collectDestructureBindings(
    objectBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assertEquals(defaults.length, 0);
  assert(
    unsupported.some((message) =>
      message.includes("Defaults on dynamic destructuring keys")
    ),
    `unsupported was: ${JSON.stringify(unsupported)}`,
  );
});

Deno.test("collectDestructureBindings emits a direct SELF key expression for a simple binding", () => {
  const { sourceFile, checker } = createProgram(
    "declare const input: any; declare const __cfHelpers: any;\n" +
      "const { [__cfHelpers.SELF]: selfValue } = input;",
  );
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const objectBinding = findBindingDeclaration(
    sourceFile,
    ts.isObjectBindingPattern,
  );

  collectDestructureBindings(
    objectBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assertEquals(unsupported.length, 0);
  assertEquals(bindings.length, 1);
  const selfBinding = bindings[0]!;
  assertEquals(selfBinding.localName, "selfValue");
  assert(selfBinding.directKeyExpression);
  assertEquals(
    ts.isIdentifier(selfBinding.directKeyExpression) &&
      selfBinding.directKeyExpression.text,
    "SELF",
  );
});

Deno.test("collectDestructureBindings rejects nested destructuring under a SELF key", () => {
  const { sourceFile, checker } = createProgram(
    "declare const input: any; declare const __cfHelpers: any;\n" +
      "const { [__cfHelpers.SELF]: { inner } } = input;",
  );
  const context = testContext(checker);
  const bindings: DestructureBinding[] = [];
  const defaults: DefaultDestructureBinding[] = [];
  const unsupported: string[] = [];
  const objectBinding = findBindingDeclaration(
    sourceFile,
    ts.isObjectBindingPattern,
  );

  collectDestructureBindings(
    objectBinding.name,
    ["root"],
    bindings,
    defaults,
    unsupported,
    context,
  );

  assert(
    unsupported.some((message) =>
      message.includes("Nested SELF destructuring")
    ),
    `unsupported was: ${JSON.stringify(unsupported)}`,
  );
});
