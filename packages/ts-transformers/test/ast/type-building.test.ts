import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import ts from "typescript";

import { parseModule } from "../transformed-ast.ts";

import {
  buildCaptureTypeElements,
  cloneTypeNodeDeepForEmission,
  qualifyCommonFabricTypeRefs,
} from "../../src/ast/type-building.ts";
import { CrossStageState, TransformationContext } from "../../src/core/mod.ts";
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

  const cloned = cloneTypeNodeDeepForEmission(typeNode, undefined, undefined);
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

  const cloned = cloneTypeNodeDeepForEmission(
    typeNode,
    typeRegistry,
    undefined,
  );

  assertStrictEquals(typeRegistry.get(cloned), fakeType);
});

Deno.test("cloneTypeNodeDeepForEmission records the clone of a print as printed from its type", () => {
  const state = new CrossStageState();
  const printedType = { flags: ts.TypeFlags.String } as ts.Type;
  const printed = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.StringKeyword,
  );
  state.recordPrintedFrom(printed, printedType);

  const cloned = cloneTypeNodeDeepForEmission(
    ts.factory.createArrayTypeNode(printed),
    undefined,
    state,
  );

  // The clone is a new node, so the record on it was carried there.
  assertNotStrictEquals(cloned.elementType, printed);
  assertStrictEquals(state.printedFrom(cloned.elementType), printedType);
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

//
// Qualifying commonfabric type references
//
// The js-compiler loads the commonfabric declarations as a root file, under
// `noResolve`, so the printer names a commonfabric type it cannot reach in
// scope by a path relative to the file it prints for
// (`import("../../commonfabric").Cell<T>`), a spelling a module of the
// program's own can share. The paired Type, not the spelling, decides whether
// such an import type is rewritten to `__cfHelpers.X`.
//

const COMMONFABRIC_DECLARATIONS = [
  "export interface Cell<T> { get(): T; }",
  "export declare function cell<T>(value: T): Cell<T>;",
].join("\n");

const MINIMAL_LIB = [
  "interface Array<T> {}",
  "interface Boolean {}",
  "interface CallableFunction {}",
  "interface Function {}",
  "interface IArguments {}",
  "interface NewableFunction {}",
  "interface Number {}",
  "interface Object {}",
  "interface RegExp {}",
  "interface String {}",
].join("\n");

/**
 * The type of `probe`, exported by `source` compiled at `/app/main/main.ts`
 * beside `files`, in a program shaped as the js-compiler shapes one: the
 * commonfabric declarations at `commonfabric.d.ts` as a root, under
 * `noResolve`. Returns that type, the node the checker prints for it, the
 * checker, a function printing a node from the source's file, and that file.
 */
function printProbeType(
  source: string,
  files: Record<string, string> = {},
) {
  const contents: Record<string, string> = {
    "lib.d.ts": MINIMAL_LIB,
    "commonfabric.d.ts": COMMONFABRIC_DECLARATIONS,
    "/app/main/main.ts": source,
    ...files,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) =>
      contents[name] === undefined
        ? undefined
        : ts.createSourceFile(name, contents[name], languageVersion, true),
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => contents[name] !== undefined,
    readFile: (name) => contents[name],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => {
        if (literal.text === "commonfabric") {
          return {
            resolvedModule: {
              resolvedFileName: "commonfabric.d.ts",
              extension: ts.Extension.Dts,
              isExternalLibraryImport: true,
            },
          };
        }
        const resolvedFileName = `${
          new URL(literal.text, `file://${containingFile}`).pathname
        }.ts`;
        return contents[resolvedFileName] !== undefined
          ? {
            resolvedModule: { resolvedFileName, extension: ts.Extension.Ts },
          }
          : { resolvedModule: undefined };
      }),
  };
  const program = ts.createProgram(
    Object.keys(contents).filter((name) => name !== "lib.d.ts"),
    { noResolve: true, strict: true },
    host,
  );
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile("/app/main/main.ts")!;
  const probe = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "probe"
    )!;
  const type = checker.getTypeAtLocation(probe.name);
  const node = checker.typeToTypeNode(
    type,
    sourceFile,
    ts.NodeBuilderFlags.NoTruncation,
  )!;
  const printer = ts.createPrinter({ removeComments: true });
  const print = (printed: ts.TypeNode) =>
    printer.printNode(ts.EmitHint.Unspecified, printed, sourceFile);
  return { type, node, checker, print, sourceFile };
}

Deno.test("qualifyCommonFabricTypeRefs rewrites an import type a relative path names when its type is the commonfabric export", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    'import { cell } from "commonfabric";\nexport const probe = cell({ a: 1 });',
  );
  assertEquals(
    print(node),
    'import("../../commonfabric").Cell<{ a: number; }>',
  );

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(print(qualified), "__cfHelpers.Cell<{ a: number; }>");
});

Deno.test("qualifyCommonFabricTypeRefs rewrites an import-type member of a union by the constituent it names", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      "declare const flag: boolean;",
      "export const probe = flag ? cell({ a: 1 }) : undefined;",
    ].join("\n"),
  );
  assertEquals(
    print(node),
    'import("../../commonfabric").Cell<{ a: number; }> | undefined',
  );

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    "__cfHelpers.Cell<{ a: number; }> | undefined",
  );
});

Deno.test("qualifyCommonFabricTypeRefs leaves an import type naming a module of the program's own called commonfabric", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    'import { cell } from "../commonfabric";\nexport const probe = cell({ a: 1 });',
    { "/app/commonfabric.ts": COMMONFABRIC_DECLARATIONS },
  );
  assertEquals(print(node), 'import("../commonfabric").Cell<{ a: number; }>');

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertStrictEquals(qualified, node);
});

Deno.test("qualifyCommonFabricTypeRefs leaves an import type of the commonfabric module itself, which names no export", () => {
  const { type, checker, print, sourceFile } = printProbeType(
    'import { cell } from "commonfabric";\nexport const probe = cell({ a: 1 });',
  );
  const node = ts.factory.createImportTypeNode(
    ts.factory.createLiteralTypeNode(
      ts.factory.createStringLiteral("commonfabric"),
    ),
  );
  assertEquals(print(node), 'import("commonfabric")');

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertStrictEquals(qualified, node);
});

Deno.test("qualifyCommonFabricTypeRefs leaves a union member a module of the program's own exports under a commonfabric export's name", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      'import { mine } from "./mine";',
      "declare const flag: boolean;",
      "export const probe = flag ? mine({ a: 1 }) : cell({ b: 2 });",
    ].join("\n"),
    {
      "/app/main/mine.ts": [
        "export interface Cell<T> { mine: T; }",
        "export declare function mine<T>(value: T): Cell<T>;",
      ].join("\n"),
    },
  );
  assertEquals(
    print(node),
    'import("./mine").Cell<{ a: number; }> | import("../../commonfabric").Cell<{ b: number; }>',
  );

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    'import("./mine").Cell<{ a: number; }> | __cfHelpers.Cell<{ b: number; }>',
  );
});

Deno.test("qualifyCommonFabricTypeRefs leaves a union member the program's own type in scope names under a commonfabric export's name", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      'import { type Cell, mine } from "./mine";',
      "declare const flag: boolean;",
      "export const probe = flag ? mine({ a: 1 }) : cell({ b: 2 });",
    ].join("\n"),
    {
      "/app/main/mine.ts": [
        "export interface Cell<T> { mine: T; }",
        "export declare function mine<T>(value: T): Cell<T>;",
      ].join("\n"),
    },
  );
  assertEquals(
    print(node),
    'Cell<{ a: number; }> | import("../../commonfabric").Cell<{ b: number; }>',
  );

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    "Cell<{ a: number; }> | __cfHelpers.Cell<{ b: number; }>",
  );
});

Deno.test("qualifyCommonFabricTypeRefs leaves a union member a module of the program's own re-exports under a commonfabric export's name", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      'import { mine } from "./mine";',
      "declare const flag: boolean;",
      "export const probe = flag ? mine({ a: 1 }) : cell({ b: 2 });",
    ].join("\n"),
    {
      "/app/main/mine.ts": [
        "interface Other<T> { mine: T; }",
        "export { Other as Cell };",
        "export declare function mine<T>(value: T): Other<T>;",
      ].join("\n"),
    },
  );
  assertEquals(
    print(node),
    'import("./mine").Cell<{ a: number; }> | import("../../commonfabric").Cell<{ b: number; }>',
  );

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    'import("./mine").Cell<{ a: number; }> | __cfHelpers.Cell<{ b: number; }>',
  );
});

Deno.test("qualifyCommonFabricTypeRefs leaves a union member the program's own re-export in scope names under a commonfabric export's name", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      'import { type Cell, mine } from "./mine";',
      "declare const flag: boolean;",
      "export const probe = flag ? mine({ a: 1 }) : cell({ b: 2 });",
    ].join("\n"),
    {
      "/app/main/mine.ts": [
        "interface Other<T> { mine: T; }",
        "export { Other as Cell };",
        "export declare function mine<T>(value: T): Other<T>;",
      ].join("\n"),
    },
  );
  assertEquals(
    print(node),
    'Cell<{ a: number; }> | import("../../commonfabric").Cell<{ b: number; }>',
  );

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    "Cell<{ a: number; }> | __cfHelpers.Cell<{ b: number; }>",
  );
});

Deno.test("qualifyCommonFabricTypeRefs leaves both members of a union whose import types name the commonfabric declarations' path and a module of the program's own at it", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      'import { mine } from "../../commonfabric";',
      "declare const flag: boolean;",
      "export const probe = flag ? mine({ a: 1 }) : cell({ b: 2 });",
    ].join("\n"),
    {
      "/commonfabric.ts": [
        "interface Other<T> { mine: T; }",
        "export { Other as Cell };",
        "export declare function mine<T>(value: T): Other<T>;",
      ].join("\n"),
    },
  );
  assertEquals(
    print(node),
    'import("../../commonfabric").Cell<{ a: number; }> | import("../../commonfabric").Cell<{ b: number; }>',
  );

  const qualified = qualifyCommonFabricTypeRefs(node, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    'import("../../commonfabric").Cell<{ a: number; }> | import("../../commonfabric").Cell<{ b: number; }>',
  );
});

Deno.test('qualifyCommonFabricTypeRefs qualifies a union member an import type of "commonfabric" names by its spelling', () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      "declare const flag: boolean;",
      "export const probe = flag ? cell({ a: 1 }) : undefined;",
    ].join("\n"),
  );
  assert(ts.isUnionTypeNode(node));
  const [member, rest] = node.types;
  assert(ts.isImportTypeNode(member));
  const spelled = ts.factory.createUnionTypeNode([
    ts.factory.updateImportTypeNode(
      member,
      ts.factory.createLiteralTypeNode(
        ts.factory.createStringLiteral("commonfabric"),
      ),
      member.attributes,
      member.qualifier,
      member.typeArguments,
      member.isTypeOf,
    ),
    rest,
  ]);
  assertEquals(
    print(spelled),
    'import("commonfabric").Cell<{ a: number; }> | undefined',
  );

  const qualified = qualifyCommonFabricTypeRefs(spelled, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    "__cfHelpers.Cell<{ a: number; }> | undefined",
  );
});

Deno.test("qualifyCommonFabricTypeRefs qualifies a union member an import type names with the declarations' extension", () => {
  const { type, node, checker, print, sourceFile } = printProbeType(
    [
      'import { cell } from "commonfabric";',
      "declare const flag: boolean;",
      "export const probe = flag ? cell({ a: 1 }) : undefined;",
    ].join("\n"),
  );
  assert(ts.isUnionTypeNode(node));
  const [member, rest] = node.types;
  assert(ts.isImportTypeNode(member));
  const withExtension = ts.factory.createUnionTypeNode([
    ts.factory.updateImportTypeNode(
      member,
      ts.factory.createLiteralTypeNode(
        ts.factory.createStringLiteral("../../commonfabric.js"),
      ),
      member.attributes,
      member.qualifier,
      member.typeArguments,
      member.isTypeOf,
    ),
    rest,
  ]);
  assertEquals(
    print(withExtension),
    'import("../../commonfabric.js").Cell<{ a: number; }> | undefined',
  );

  const qualified = qualifyCommonFabricTypeRefs(withExtension, type, {
    checker,
    factory: ts.factory,
    sourceFile,
  });

  assertEquals(
    print(qualified),
    "__cfHelpers.Cell<{ a: number; }> | undefined",
  );
});
