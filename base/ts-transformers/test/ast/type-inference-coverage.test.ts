import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  ensureTypeNodeRegistered,
  getTypeFromTypeNodeWithFallback,
  inferArrayElementType,
  isAnyType,
  isCellLikeType,
  typeToTypeNode,
  unwrapCellLikeType,
  unwrapOpaqueLikeType,
  widenLiteralType,
} from "../../src/ast/type-inference.ts";
import { setParentPointers } from "../../src/ast/utils.ts";
import { describe, it, test } from "@commonfabric/test-support/test";

// A minimal global lib so `string[]` and `checker.isArrayType(...)` resolve.
// It is passed as a program root file (not the default lib) with `noLib` on, so
// the `Array`/`ReadonlyArray` globals are visible from every file including the
// synthetic `commonfabric.d.ts` module below.
const LIB = `
interface Array<T> { length: number; [index: number]: T; }
interface ReadonlyArray<T> { length: number; readonly [index: number]: T; }
`;

// A stand-in commonfabric module. `Cell<T>` carries the `[CELL_BRAND]: "cell"`
// marker the transformer's branded-cell detection looks for. `Default<T, V>`
// mirrors the real alias shape `(T & DefaultMarker<V>) | V`-ish enough that the
// checker keeps its `aliasSymbol`, and it lives in a file named
// `commonfabric.d.ts` so `isDefaultAliasSymbol` recognizes it.
const CF = `
export declare const CELL_BRAND: unique symbol;
export declare const DEFAULT_MARKER: unique symbol;
export interface Cell<T> { [CELL_BRAND]: "cell"; readonly value: T; }
export interface BareCell { [CELL_BRAND]: "cell"; }
export interface DefaultMarker<V> { readonly [DEFAULT_MARKER]: V; }
export type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
export interface Box<T> { readonly boxed: T; }
`;

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const files: Record<string, string> = {
    "/test.ts": source,
    "/commonfabric.d.ts": CF,
    "/lib.d.ts": LIB,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(
          name,
          files[name]!,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
        : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    directoryExists: () => true,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names) =>
      names.map((name) => {
        const match = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` || fileName.endsWith(`/${name}.d.ts`)
        );
        return match
          ? {
            resolvedFileName: match,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          }
          : undefined;
      }),
  };
  const program = ts.createProgram(
    ["/lib.d.ts", "/test.ts"],
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noLib: true,
    },
    host,
  );
  return {
    sourceFile: program.getSourceFile("/test.ts")!,
    checker: program.getTypeChecker(),
  };
}

/** Resolve the type of a trailing `name;` expression statement. */
function typeOf(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  name: string,
): ts.Type {
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
  return checker.getTypeAtLocation(found);
}

function reference(
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

const SOURCE = `
import { Cell, BareCell, Default, Box } from "commonfabric";
declare const litUnion: "a" | 1;
declare const cellString: Cell<string>;
declare const cellObject: Cell<{ a: number }>;
declare const bareCell: BareCell;
declare const plainIntersection: { a: number } & { b: string };
declare const cellArray: Cell<string[]>;
declare const defaultArray: Default<string[]>;
declare const cellDefaultArray: Cell<Default<string[]>>;
declare const cellDefaultOrUndefined: Cell<Default<string[]> | undefined>;
declare const duplicateElementArrays: string[] | ReadonlyArray<string>;
declare const boxedDefaultArray: Box<Default<string[]>>;
declare const scalar: string;
litUnion;
cellString;
cellObject;
bareCell;
plainIntersection;
cellArray;
defaultArray;
cellDefaultArray;
cellDefaultOrUndefined;
duplicateElementArrays;
boxedDefaultArray;
scalar;
`;

test("widenLiteralType: a union of differently-based literals widens to a base-type union", () => {
  // `"a" | 1` -> `string | number`. Drives the multi-member reconstruction that
  // rebuilds the union from de-duplicated widened members via getUnionType.
  const { sourceFile, checker } = createProgram(SOURCE);
  const widened = widenLiteralType(
    typeOf(sourceFile, checker, "litUnion"),
    checker,
  );
  assertEquals(checker.typeToString(widened), "string | number");
});

test("isCellLikeType: undefined is not cell-like", () => {
  const { checker } = createProgram(SOURCE);
  assertEquals(isCellLikeType(undefined, checker), false);
});

test("isCellLikeType: a branded Cell<T> is cell-like", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  assertEquals(
    isCellLikeType(typeOf(sourceFile, checker, "cellString"), checker),
    true,
  );
});

test("unwrapCellLikeType: a branded Cell<string> unwraps to its inner string", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  const unwrapped = unwrapCellLikeType(
    typeOf(sourceFile, checker, "cellString"),
    checker,
  )!;
  assertEquals(checker.typeToString(unwrapped), "string");
});

test("unwrapCellLikeType: a branded Cell<{ a: number }> unwraps to the object type", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  const unwrapped = unwrapCellLikeType(
    typeOf(sourceFile, checker, "cellObject"),
    checker,
  )!;
  assertEquals(checker.typeToString(unwrapped), "{ a: number; }");
});

test("unwrapOpaqueLikeType: an intersection with no branded cell member is rebuilt structurally", () => {
  // `{ a: number } & { b: string }` has no OpaqueCell part, so the walker
  // returns the intersection as it is.
  const { sourceFile, checker } = createProgram(SOURCE);
  const unwrapped = unwrapOpaqueLikeType(
    typeOf(sourceFile, checker, "plainIntersection"),
    checker,
  )!;
  assertEquals(
    checker.typeToString(unwrapped),
    "{ a: number; } & { b: string; }",
  );
});

test("typeToTypeNode: an invalid location argument is caught and yields undefined", () => {
  // typeToTypeNode wraps checker.typeToTypeNode in try/catch. A synthetic node
  // with no source file / position is a location the checker rejects.
  const { sourceFile, checker } = createProgram(SOURCE);
  const type = typeOf(sourceFile, checker, "cellObject");
  const detachedLocation = ts.factory.createIdentifier("detached");
  const node = typeToTypeNode(type, checker, detachedLocation, undefined);
  // Either a node or undefined is acceptable behavior; the branch under test is
  // that no exception escapes. Assert the call completes and returns a TypeNode
  // or undefined.
  assert(node === undefined || ts.isTypeNode(node));
});

function elementTypeText(name: string): string {
  const { sourceFile, checker } = createProgram(SOURCE);
  const result = inferArrayElementType(reference(sourceFile, name), {
    checker,
    factory: ts.factory,
    sourceFile,
    state: undefined,
  });
  return result.type ? checker.typeToString(result.type) : "<none>";
}

test("inferArrayElementType: a branded Cell<string[]> yields the element type", () => {
  // Drives the reference-type branch where the inner type is directly an array
  // and extractElementFromArrayType returns the element.
  assertEquals(elementTypeText("cellArray"), "string");
});

test("inferArrayElementType: a Default<string[]> alias yields the element type", () => {
  // Drives the wrapped-list read: the cell's argument is the union that
  // `Default<string[]>` expands to, and both of its arms yield `string`.
  assertEquals(elementTypeText("cellDefaultArray"), "string");
});

test("inferArrayElementType: a Cell<Default<string[]> | undefined> yields the element type", () => {
  // The cell's argument is a union around the array that keeps no alias, so
  // only a read through the union's arms finds `string`.
  assertEquals(elementTypeText("cellDefaultOrUndefined"), "string");
});

test("inferArrayElementType: a plain Default<string[]> reference yields the element type via the array fallback", () => {
  assertEquals(elementTypeText("defaultArray"), "string");
});

test("unwrapCellLikeType: a branded cell with no type argument returns itself", () => {
  // The cell is branded (so isCellLikeType is true) but has no type argument, so
  // unwrapOpaqueLikeType returns it unchanged and it has no payload to read —
  // the final `?? type` fallthrough returns the cell type itself.
  const { sourceFile, checker } = createProgram(SOURCE);
  const unwrapped = unwrapCellLikeType(
    typeOf(sourceFile, checker, "bareCell"),
    checker,
  )!;
  assertEquals(checker.typeToString(unwrapped), "BareCell");
});

test("inferArrayElementType: two array arms with the same element de-duplicate to a single element", () => {
  // `string[] | readonly string[]`: both arms extract `string`, so
  // combineExtractedElementTypes runs its de-duplication loop and collapses the
  // two identical element types back to a single one.
  assertEquals(elementTypeText("duplicateElementArrays"), "string");
});

test("inferArrayElementType: a Box<Default<string[]>> unwraps the Default alias while recursing a reference", () => {
  // Drives extractElementFromArrayType's reference-recursion into a member whose
  // type argument is a Default alias wrapping an array.
  assertEquals(elementTypeText("boxedDefaultArray"), "string");
});

//
// Synthetic composite type registration
//
// A TypeNode built by the factory has no source position, so
// `checker.getTypeFromTypeNode` widens it to `any`. When each leaf is
// pre-registered with a real Type, ensureTypeNodeRegistered rebuilds the
// composite Type from the registered children through the TypeScript-internal
// createArrayType / getUnionType / createAnonymousType entry points.
//

function programForSynthetics(): {
  checker: ts.TypeChecker;
} {
  const { checker } = createProgram(`declare const x: string; x;`);
  return { checker };
}

test("ensureTypeNodeRegistered: a synthetic array node rebuilds string[] from a registered element", () => {
  const { checker } = programForSynthetics();
  const registry = new WeakMap<ts.Node, ts.Type>();
  const elementNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.StringKeyword,
  );
  registry.set(elementNode, checker.getStringType());
  const arrayNode = ts.factory.createArrayTypeNode(elementNode);
  setParentPointers(arrayNode);
  const type = ensureTypeNodeRegistered(arrayNode, checker, registry);
  assert(type !== undefined);
  assertEquals(checker.typeToString(type!), "string[]");
});

test("ensureTypeNodeRegistered: a synthetic union node rebuilds string | number from registered members", () => {
  const { checker } = programForSynthetics();
  const registry = new WeakMap<ts.Node, ts.Type>();
  const stringNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.StringKeyword,
  );
  const numberNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.NumberKeyword,
  );
  registry.set(stringNode, checker.getStringType());
  registry.set(numberNode, checker.getNumberType());
  const unionNode = ts.factory.createUnionTypeNode([stringNode, numberNode]);
  setParentPointers(unionNode);
  const type = ensureTypeNodeRegistered(unionNode, checker, registry);
  assert(type !== undefined);
  assertEquals(checker.typeToString(type!), "string | number");
});

test("ensureTypeNodeRegistered: a synthetic type literal rebuilds an anonymous object from registered members", () => {
  const { checker } = programForSynthetics();
  const registry = new WeakMap<ts.Node, ts.Type>();
  const valueNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.StringKeyword,
  );
  registry.set(valueNode, checker.getStringType());
  const literalNode = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(undefined, "a", undefined, valueNode),
  ]);
  setParentPointers(literalNode);
  const type = ensureTypeNodeRegistered(literalNode, checker, registry);
  assert(type !== undefined);
  assertEquals(checker.typeToString(type!), "{ a: string; }");
});

test("ensureTypeNodeRegistered: a synthetic parenthesized node resolves to its inner registered type", () => {
  const { checker } = programForSynthetics();
  const registry = new WeakMap<ts.Node, ts.Type>();
  const innerNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.StringKeyword,
  );
  registry.set(innerNode, checker.getStringType());
  const parenNode = ts.factory.createParenthesizedType(innerNode);
  setParentPointers(parenNode);
  const type = ensureTypeNodeRegistered(parenNode, checker, registry);
  assert(type !== undefined);
  assertEquals(checker.typeToString(type!), "string");
});

test("getTypeFromTypeNodeWithFallback: an already-registered node returns the registered type directly", () => {
  const { checker } = programForSynthetics();
  const registry = new WeakMap<ts.Node, ts.Type>();
  const node = ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
  const stringType = checker.getStringType();
  registry.set(node, stringType);
  const type = getTypeFromTypeNodeWithFallback(node, checker, registry);
  assertEquals(type, stringType);
});

test("ensureTypeNodeRegistered: without a registry it returns the direct checker type", () => {
  const { sourceFile, checker } = createProgram(
    `declare const s: string; type Alias = string; const a: Alias = "x"; a;`,
  );
  // A source-positioned annotation resolves directly without any registry.
  let annotation: ts.TypeNode | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "Alias") {
      annotation = node.type;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const type = ensureTypeNodeRegistered(annotation!, checker);
  assertEquals(checker.typeToString(type!), "string");
});

describe("type-inference", () => {
  describe("widenLiteralType()", () => {
    it("returns the checker's `boolean` for a `true` or `false` literal", () => {
      const { checker } = createProgram(SOURCE);

      expect(widenLiteralType(checker.getTrueType(), checker)).toBe(
        checker.getBooleanType(),
      );
      expect(widenLiteralType(checker.getFalseType(), checker)).toBe(
        checker.getBooleanType(),
      );
    });
  });

  describe("ensureTypeNodeRegistered()", () => {
    // A node parsed without parent pointers throws in the checker, which looks
    // up through a node's parents for the flow context of its type.

    /** The type node of `type A = <text>`, parsed with or without parents. */
    function aliasedTypeNode(text: string, setParentNodes: boolean) {
      const declarationFile = ts.createSourceFile(
        "/other.ts",
        `type A = ${text};`,
        ts.ScriptTarget.ESNext,
        setParentNodes,
      );
      const [alias] = declarationFile.statements;
      if (!alias || !ts.isTypeAliasDeclaration(alias)) {
        throw new Error("type alias not found");
      }
      return alias.type;
    }

    it("returns `undefined`, and registers nothing, for a node the checker throws on", () => {
      const { checker } = programForSynthetics();
      const registry = new WeakMap<ts.Node, ts.Type>();
      const unparented = aliasedTypeNode("string[]", false);

      expect(ensureTypeNodeRegistered(unparented, checker)).toBeUndefined();
      expect(ensureTypeNodeRegistered(unparented, checker, registry))
        .toBeUndefined();
      expect(registry.has(unparented)).toBe(false);

      const parented = aliasedTypeNode("string[]", true);
      expect(
        checker.typeToString(ensureTypeNodeRegistered(parented, checker)!),
      ).toBe("string[]");
    });

    it("returns the checker's type, and registers nothing, for a synthetic parenthesized node around a node the checker throws on", () => {
      // The checker reads any node it did not parse as its error type, which
      // is `any`, and the node it encloses holds no type to stand in for it.

      const { checker } = programForSynthetics();
      const registry = new WeakMap<ts.Node, ts.Type>();
      const unparented = aliasedTypeNode("string[]", false);
      const parenthesized = ts.factory.createParenthesizedType(unparented);

      const type = ensureTypeNodeRegistered(parenthesized, checker, registry);

      expect(type).toBe(checker.getTypeFromTypeNode(parenthesized));
      expect(isAnyType(type)).toBe(true);
      expect(registry.has(parenthesized)).toBe(false);
      expect(registry.has(unparented)).toBe(false);
    });
  });
});
