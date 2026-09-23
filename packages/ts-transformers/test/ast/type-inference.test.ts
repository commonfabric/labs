import { assertEquals } from "@std/assert";
import ts from "typescript";

import { isCollectionType } from "../../src/ast/mod.ts";
import {
  inferArrayElementType,
  unwrapOpaqueLikeType,
} from "../../src/ast/type-inference.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
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

/** Resolve the declared type of a top-level `declare const <name>: T`. */
function declaredType(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  name: string,
): ts.Type {
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = checker.getTypeAtLocation(node.name);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error(`Declaration for ${name} not found`);
  }
  return found;
}

// `noLib` is on, so the array forms are recognized only because we declare the
// global Array/ReadonlyArray interfaces here — mirroring call-kind.test.ts.
const SOURCE = `
  interface Array<T> { length: number; }
  interface ReadonlyArray<T> { length: number; }

  declare const arr: string[];
  declare const readonlyArr: readonly string[];
  declare const tuple: [string, number];
  declare const unionOfArrays: string[] | number[];
  declare const unionWithScalar: string | string[];
  declare const scalar: string;
  declare const obj: { a: number };
`;

Deno.test("isCollectionType: array and tuple result types are collections", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "arr"), checker),
    true,
  );
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "readonlyArr"), checker),
    true,
  );
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "tuple"), checker),
    true,
  );
});

Deno.test("isCollectionType: a union whose every member is an array/tuple is a collection", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  // The union arm — `a ?? b` over differently-typed arrays resolves to
  // `string[] | number[]`, which `checker.isArrayType` returns false for.
  assertEquals(
    isCollectionType(
      declaredType(sourceFile, checker, "unionOfArrays"),
      checker,
    ),
    true,
  );
});

Deno.test("isCollectionType: scalars, objects, and mixed unions are not collections", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "scalar"), checker),
    false,
  );
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "obj"), checker),
    false,
  );
  // A union with even one non-array member is not a collection.
  assertEquals(
    isCollectionType(
      declaredType(sourceFile, checker, "unionWithScalar"),
      checker,
    ),
    false,
  );
});

Deno.test("isCollectionType: an undefined type is not a collection", () => {
  const { checker } = createProgram(SOURCE);
  assertEquals(isCollectionType(undefined, checker), false);
});

// `inferArrayElementType` operates on the resolved Type, not the syntax, so the
// declared Array/ReadonlyArray interfaces need a numeric index signature for
// `getIndexTypeOfType` to return the element type.
const ARRAY_ELEMENT_SOURCE = `
  interface Array<T> { length: number; [index: number]: T; }
  interface ReadonlyArray<T> { length: number; [index: number]: T; }
  interface Box<T> { value: T; }

  declare const plainArray: string[];
  declare const unionOfArrays: string[] | number[];
  declare const optionalArray: string[] | undefined;
  declare const refIntersection: { tag: number } & string[];
  declare const plainIntersection: { a: number } & { b: string };
  declare const boxedArrays: Box<string[]> | number[];
  declare const boxedScalarMix: Box<string> | number[];
  declare const scalar: string;

  plainArray;
  unionOfArrays;
  optionalArray;
  refIntersection;
  plainIntersection;
  boxedArrays;
  boxedScalarMix;
  scalar;
`;

/** Find the trailing `name;` expression-statement reference by identifier. */
function findReference(
  sourceFile: ts.SourceFile,
  name: string,
): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = node.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Reference ${name} not found`);
  return found;
}

function elementTypeText(name: string): string {
  const { sourceFile, checker } = createProgram(ARRAY_ELEMENT_SOURCE);
  const result = inferArrayElementType(findReference(sourceFile, name), {
    checker,
    factory: ts.factory,
    sourceFile,
  });
  return result.type ? checker.typeToString(result.type) : "<none>";
}

Deno.test("inferArrayElementType: plain array yields the element type", () => {
  assertEquals(elementTypeText("plainArray"), "string");
});

Deno.test("inferArrayElementType: union of distinct arrays yields a union element", () => {
  // Drives the union fallback (`extractElementFromArrayType` over the union),
  // de-duplication, and the internal `getUnionType` reconstruction.
  assertEquals(elementTypeText("unionOfArrays"), "string | number");
});

Deno.test("inferArrayElementType: array-or-undefined drops the undefined arm", () => {
  // Drives the single-survivor branch of `combineExtractedElementTypes`.
  assertEquals(elementTypeText("optionalArray"), "string");
});

Deno.test("inferArrayElementType: intersection with an array reference unwraps the array", () => {
  // Drives `findReferenceTypeInIntersection` returning the array member.
  assertEquals(elementTypeText("refIntersection"), "string");
});

Deno.test("inferArrayElementType: intersection without an array member is not array-like", () => {
  // Drives `findReferenceTypeInIntersection` returning undefined and the
  // empty-result branch of `combineExtractedElementTypes`.
  assertEquals(elementTypeText("plainIntersection"), "<none>");
});

Deno.test("inferArrayElementType: union of a wrapped array and a plain array", () => {
  // Drives the Object/Reference branch of `extractElementFromArrayType` that
  // recurses into a reference's type argument.
  assertEquals(elementTypeText("boxedArrays"), "string | number");
});

Deno.test("inferArrayElementType: a non-array reference member contributes nothing", () => {
  // `Box<string>` is a reference whose argument is not array-like, so only the
  // `number[]` arm contributes an element type.
  assertEquals(elementTypeText("boxedScalarMix"), "number");
});

Deno.test("inferArrayElementType: a scalar has no element type", () => {
  assertEquals(elementTypeText("scalar"), "<none>");
});

Deno.test("unwrapOpaqueLikeType: a plain type is returned unchanged", () => {
  const { sourceFile, checker } = createProgram(ARRAY_ELEMENT_SOURCE);
  const scalar = checker.getTypeAtLocation(findReference(sourceFile, "scalar"));
  assertEquals(
    checker.typeToString(unwrapOpaqueLikeType(scalar, checker)!),
    "string",
  );
});

Deno.test("unwrapOpaqueLikeType: undefined input returns undefined", () => {
  const { checker } = createProgram(ARRAY_ELEMENT_SOURCE);
  assertEquals(unwrapOpaqueLikeType(undefined, checker), undefined);
});
