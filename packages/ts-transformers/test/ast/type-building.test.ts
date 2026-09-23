import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import ts from "typescript";

import { parseModule } from "../transformed-ast.ts";

import {
  buildCaptureTypeElements,
  cloneTypeNodeDeepForEmission,
} from "../../src/ast/type-building.ts";
import { TransformationContext } from "../../src/core/mod.ts";
import {
  type CaptureTreeNode,
  createCaptureTreeNode,
} from "../../src/utils/capture-tree.ts";

//
// Emitting a type node into another file
//
// The printer extracts literal text by source position from the file it is
// printing. A declaration member's type node reused in ANOTHER file therefore
// emits garbage tokens for literal types (e.g. the `"n/a"` in
// `Default<string, "n/a">` printed as whatever sits at those offsets in the
// emit file). cloneTypeNodeDeepForEmission strips positions throughout so
// literals print from their own `.text`.
//

Deno.test("cloneTypeNodeDeepForEmission prints cross-file literal types from their own text", () => {
  const declarationFile = ts.createSourceFile(
    "declaration.ts",
    `interface I { label: Default<string, "default-text">; }`,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const iface = declarationFile.statements[0] as ts.InterfaceDeclaration;
  const member = iface.members[0] as ts.PropertySignature;
  const typeNode = member.type!;

  // A different, shorter emit file: position-based extraction cannot
  // reproduce the literal from here.
  const emitFile = ts.createSourceFile(
    "emit.ts",
    "export {};",
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const printer = ts.createPrinter({ removeComments: true });

  const cloned = cloneTypeNodeDeepForEmission(typeNode);
  const printed = printer.printNode(ts.EmitHint.Unspecified, cloned, emitFile);

  assertEquals(printed, `Default<string, "default-text">`);
});

Deno.test("cloneTypeNodeDeepForEmission carries typeRegistry entries onto clones", () => {
  const declarationFile = ts.createSourceFile(
    "declaration.ts",
    `interface I { label: Default<string, "x">; }`,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const iface = declarationFile.statements[0] as ts.InterfaceDeclaration;
  const member = iface.members[0] as ts.PropertySignature;
  const typeNode = member.type!;

  const fakeType = { flags: ts.TypeFlags.String } as ts.Type;
  const typeRegistry = new WeakMap<ts.Node, ts.Type>();
  typeRegistry.set(typeNode, fakeType);

  const cloned = cloneTypeNodeDeepForEmission(typeNode, typeRegistry);

  assertStrictEquals(typeRegistry.get(cloned), fakeType);
});

//
// Building capture type elements
//

Deno.test("buildCaptureTypeElements handles destructured keys and renames identifier captures", () => {
  const sourceText = `
    interface Input {
      0?: string;
      "named-key"?: number;
      keep: boolean;
    }

    function collect({ 0: zero, "named-key": namedKey, keep }: Input) {
      return [zero, namedKey, keep];
    }
  `;
  const fileName = "capture-keys.ts";
  const { program, sourceFile } = createProgram(fileName, sourceText);
  const returnArray = findFirstNode(
    sourceFile,
    ts.isArrayLiteralExpression,
  );
  const [zeroExpr, namedKeyExpr, keepExpr] = returnArray.elements;
  if (
    !ts.isIdentifier(zeroExpr) ||
    !ts.isIdentifier(namedKeyExpr) ||
    !ts.isIdentifier(keepExpr)
  ) {
    throw new Error("Expected return array to contain identifier captures");
  }

  let tsContext!: ts.TransformationContext;
  const transformed = ts.transform(sourceFile, [
    (context) => {
      tsContext = context;
      return (node) => node;
    },
  ]);
  try {
    const context = new TransformationContext({
      program,
      sourceFile,
      tsContext,
    });
    const keepLiteral = captureNode(keepExpr);
    const elements = buildCaptureTypeElements(
      new Map<string, CaptureTreeNode>([
        ["zero", captureNode(zeroExpr)],
        ["namedKey", captureNode(namedKeyExpr)],
        ["keep", keepLiteral],
        ["not-safe", keepLiteral],
      ]),
      context,
      new Map([
        ["keep", "kept"],
        ["not-safe", "ignored"],
      ]),
    );

    const printed = ts.createPrinter().printNode(
      ts.EmitHint.Unspecified,
      ts.factory.createTypeLiteralNode(elements),
      sourceFile,
    );

    // Reparse the printed type literal and inspect its members: the optional
    // destructured keys widen to `T | undefined`, the plain key keeps its
    // type, and the identifier-unsafe key `not-safe` is emitted as a quoted
    // string-literal property name.
    const members = typeLiteralMembers(printed);
    assertEquals(members.get("zero"), {
      optional: true,
      type: "string | undefined",
    });
    assertEquals(members.get("namedKey"), {
      optional: true,
      type: "number | undefined",
    });
    assertEquals(members.get("kept"), { optional: false, type: "boolean" });
    assertEquals(members.get("not-safe"), { optional: false, type: "boolean" });
  } finally {
    transformed.dispose();
  }
});

// Reparse a printed type-literal into a map from member name to its optionality
// and printed type keyword. Wrapping it in `type __T = …;` lets the parser
// recover the members from text, so assertions read real nodes rather than
// matching substrings of the print.
function typeLiteralMembers(
  printed: string,
): Map<string, { optional: boolean; type: string }> {
  const root = parseModule(`type __T = ${printed};`);
  const alias = root.statements[0];
  assert(ts.isTypeAliasDeclaration(alias) && ts.isTypeLiteralNode(alias.type));
  const out = new Map<string, { optional: boolean; type: string }>();
  for (const member of alias.type.members) {
    assert(ts.isPropertySignature(member) && member.type);
    const name = member.name;
    const key = ts.isStringLiteralLike(name) || ts.isIdentifier(name)
      ? name.text
      : undefined;
    assert(key !== undefined, "unexpected member name");
    out.set(key, {
      optional: member.questionToken !== undefined,
      type: member.type.getText(root),
    });
  }
  return out;
}

function createProgram(fileName: string, sourceText: string) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => name === fileName,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (name) => name === fileName ? sourceFile : undefined,
    readFile: (name) => name === fileName ? sourceText : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };

  return {
    program: ts.createProgram([fileName], compilerOptions, host),
    sourceFile,
  };
}

function captureNode(expression: ts.Expression): CaptureTreeNode {
  const node = createCaptureTreeNode([]);
  node.expression = expression;
  return node;
}

function findFirstNode<T extends ts.Node>(
  node: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T {
  const found = findFirstNodeInner(node, predicate);
  if (!found) throw new Error("Expected to find matching node");
  return found;
}

function findFirstNodeInner<T extends ts.Node>(
  node: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T | undefined {
  if (predicate(node)) return node;
  let found: T | undefined;
  node.forEachChild((child) => {
    if (!found) found = findFirstNodeInner(child, predicate);
  });
  return found;
}
