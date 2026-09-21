import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import type { CapabilityParamSummary } from "../src/core/mod.ts";
import {
  applyCapabilityDefaultsToTypeNode,
  applyShrinkAndWrap,
  containsAnyOrUnknownTypeNode,
  isCellLikeTypeNode,
  isSqliteTypeNode,
  isStreamTypeNode,
  overlayContractCapabilities,
  preservedWrapperFor,
  printTypeNode,
  wrapTypeNodeWithCapability,
} from "../src/transformers/type-shrinking.ts";
import { collect, parseModule } from "./transformed-ast.ts";

//
// Structural inspection of printed type nodes.
//
// `printTypeNode` renders a `ts.TypeNode` to text. Asserting on that text with
// `assertStringIncludes` is weak: it matches on formatting and cannot tell a
// property named `title` apart from the word `title` appearing anywhere. These
// helpers reparse the printed type node and expose its members as real AST
// nodes so tests can assert on property names, optional flags, exact member
// types, and the shape of the root node.
//

/** Reparse a printed type node into a `ts.TypeNode`. */
function parseType(printed: string): ts.TypeNode {
  const decl = collect(
    parseModule(`type __T = ${printed};`),
    ts.isTypeAliasDeclaration,
  )[0];
  if (!decl) throw new Error(`Could not parse type node: ${printed}`);
  return decl.type;
}

interface PropInfo {
  optional: boolean;
  type: string;
}

/**
 * Every property signature reachable under `node`, keyed by name, carrying its
 * optional flag and the printed text of its declared type. Nested literals
 * contribute their own members, so `unused` being absent from the map means it
 * appears nowhere in the shape.
 */
function props(node: ts.Node): Map<string, PropInfo> {
  const sf = node.getSourceFile();
  const out = new Map<string, PropInfo>();
  for (const signature of collect(node, ts.isPropertySignature)) {
    const name = ts.isIdentifier(signature.name)
      ? signature.name.text
      : signature.name.getText(sf);
    out.set(name, {
      optional: !!signature.questionToken,
      type: signature.type ? signature.type.getText(sf) : "",
    });
  }
  return out;
}

/** Reparse the printed shrink result and return its member map. */
function shrunkProps(result: ts.TypeNode, sourceFile: ts.SourceFile): {
  node: ts.TypeNode;
  props: Map<string, PropInfo>;
} {
  const node = parseType(printTypeNode(result, sourceFile));
  return { node, props: props(node) };
}

/** True when `node` contains a reference to the qualified name `left.right`. */
function hasQualifiedRef(node: ts.Node, left: string, right: string): boolean {
  return collect(node, ts.isTypeReferenceNode).some((ref) => {
    const name = ref.typeName;
    return ts.isQualifiedName(name) &&
      ts.isIdentifier(name.left) && name.left.text === left &&
      name.right.text === right;
  });
}

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

function createProgramWithFiles(
  files: Record<string, string>,
  entryFileName = "/test.ts",
): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(
          name,
          files[name]!,
          languageVersion,
          true,
          name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) => {
        const directMatch = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` ||
          fileName.endsWith(`/${name}.d.ts`)
        );
        if (!directMatch) {
          return undefined;
        }
        return {
          resolvedFileName: directMatch,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }),
  };

  const program = ts.createProgram([entryFileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(entryFileName);
  if (!sourceFile) {
    throw new Error("Expected source file in program.");
  }

  return { sourceFile, checker: program.getTypeChecker() };
}

function findTypeAlias(
  sourceFile: ts.SourceFile,
  aliasName: string,
): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === aliasName
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Type alias ${aliasName} not found`);
  }

  return found;
}

function createParamSummary(
  summary: Partial<CapabilityParamSummary>,
): CapabilityParamSummary {
  return {
    name: "input",
    capability: "opaque",
    readPaths: [],
    writePaths: [],
    opaquePaths: [],
    passthrough: false,
    wildcard: false,
    identityOnly: false,
    ...summary,
  };
}

describe("overlayContractCapabilities()", () => {
  it("returns a reference to an alias whose type holds no cell as written", () => {
    const { sourceFile, checker } = createProgram(`
      type Profile = { name: string };
      type Event = { x: Profile };
    `);
    const alias = findTypeAlias(sourceFile, "Event");

    const result = overlayContractCapabilities(
      alias.type,
      checker.getTypeAtLocation(alias.type),
      createParamSummary({
        capability: "readonly",
        readPaths: [["x", "name"]],
      }),
      checker,
      ts.factory,
      sourceFile,
    );

    expect(result).toBe(alias.type);
  });
});

Deno.test("applyShrinkAndWrap preserves tuple roots for length-only synthetic shrinking", () => {
  const { sourceFile, checker } = createProgram(`
    type Pair = [number, string];
  `);
  const alias = findTypeAlias(sourceFile, "Pair");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "Pair");
});

Deno.test("applyShrinkAndWrap does not treat numeric index signatures as arrays", () => {
  const { sourceFile, checker } = createProgram(`
    type Indexed = { [index: number]: string };
  `);
  const alias = findTypeAlias(sourceFile, "Indexed");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

Deno.test("applyShrinkAndWrap treats numeric index plus length as array-like", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = {
      length: number;
      [index: number]: Option;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap preserves full array item shapes for direct array reads", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      people: {
        active: boolean;
        name: string;
        priorityRank: number;
      }[];
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["people"], ["people", "0", "active"]],
      fullShapePaths: [["people"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assert(members.has("people"));
  assertEquals(members.get("active")?.type, "boolean");
  assertEquals(members.get("name")?.type, "string");
  assertEquals(members.get("priorityRank")?.type, "number");
  assertEquals(members.has("other"), false);
});

Deno.test("applyShrinkAndWrap keeps numeric array access array-shaped", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = Option[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap prefers array-shaped semantic shrink over synthetic numeric object", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = Option[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      ts.factory.createNumericLiteral("0"),
      undefined,
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          "title",
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
      ]),
    ),
    ts.factory.createPropertySignature(
      undefined,
      "length",
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    ),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap materializes item paths for synthetic unknown arrays", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = unknown[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      ts.factory.createNumericLiteral("0"),
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
    ts.factory.createPropertySignature(
      undefined,
      "length",
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    ),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: unknown;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap defaults-only fallback expands repeated child leaves independently", () => {
  const { sourceFile, checker } = createProgram(`
    type Shared = { a: string; b: string };
    type Input = { group: { left: Shared; right: Shared } };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      defaults: [{
        path: ["group", "left", "a"],
        defaultType: ts.factory.createKeywordTypeNode(
          ts.SyntaxKind.StringKeyword,
        ),
      }],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "defaults_only",
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // Both `left` and `right` are expanded into inline literals with `a` and `b`
  // leaves rather than left as `Shared` references.
  assertEquals(members.get("a")?.type, "string");
  assertEquals(members.get("b")?.type, "string");
  const right = collect(node, ts.isPropertySignature).find((signature) =>
    ts.isIdentifier(signature.name) && signature.name.text === "right"
  );
  assert(right && right.type && ts.isTypeLiteralNode(right.type));
});

Deno.test("applyShrinkAndWrap preserves nested primitive leaves for property-only access", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = { text: string };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["text", "length"]],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("text")?.type, "string");
  assertEquals(members.has("length"), false);
});

Deno.test("applyShrinkAndWrap turns identity-only wrapped inputs into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    ts.factory.createTypeReferenceNode("Input"),
    baseType,
    true,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    "__cfHelpers.OpaqueCell<unknown>",
  );
});

Deno.test("applyShrinkAndWrap turns comparable wrapped inputs into ComparableCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "comparable",
      identityOnly: true,
      passthrough: true,
    }),
    ts.factory.createTypeReferenceNode("Input"),
    baseType,
    true,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    "__cfHelpers.ComparableCell<unknown>",
  );
});

Deno.test("applyShrinkAndWrap turns identity-only unwrapped inputs into unknown", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

Deno.test("applyShrinkAndWrap turns identity-only cell leaves into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      left: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
      right: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["left"], ["right"]],
      identityCellPaths: [["left"], ["right"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("left")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("right")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.has("name"), false);
  assertEquals(members.has("nested"), false);
});

Deno.test("applyShrinkAndWrap turns read-only cell leaves into ReadonlyCell", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type ReadonlyCell<T> = { readonly readonly?: T };
    }
    type Input = {
      value: __cfHelpers.Writable<number>;
      untouched: __cfHelpers.Writable<string>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "readonly",
      readPaths: [["value"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("value")?.type, "__cfHelpers.ReadonlyCell<number>");
  assertEquals(members.has("untouched"), false);
});

Deno.test("applyShrinkAndWrap turns opaque derivation cell leaves into OpaqueCell", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      items: __cfHelpers.Writable<{ name: string }[]>;
      untouched: __cfHelpers.Writable<string>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      opaquePaths: [["items"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  const items = members.get("items");
  assert(items && hasQualifiedRef(node, "__cfHelpers", "OpaqueCell"));
  assert(items.type.startsWith("__cfHelpers.OpaqueCell<"));
  assertEquals(members.get("name")?.type, "string");
  assertEquals(members.has("untouched"), false);
});

Deno.test("applyShrinkAndWrap turns comparable cell leaves into ComparableCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type ComparableCell<T> = { readonly comparable?: T };
    }
    type Input = {
      left: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
      right: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "comparable",
      identityPaths: [["left"], ["right"]],
      identityCellPaths: [["left"], ["right"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(
    members.get("left")?.type,
    "__cfHelpers.ComparableCell<unknown>",
  );
  assertEquals(
    members.get("right")?.type,
    "__cfHelpers.ComparableCell<unknown>",
  );
  assertEquals(members.has("name"), false);
  assertEquals(members.has("nested"), false);
});

Deno.test("applyShrinkAndWrap lets identity containers cover retained child paths", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      item: { active: boolean; name: string };
      untouched: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["item", "active"]],
      identityPaths: [["item"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("item")?.type, "unknown");
  assertEquals(members.has("active"), false);
  assertEquals(members.has("name"), false);
});

Deno.test("applyShrinkAndWrap shrinks direct array parameters to used item fields", () => {
  const { sourceFile, checker } = createProgram(`
    type AssetRecord = {
      id: string;
      stage: string;
      owner: string;
      unused: { nested: string };
    };
    type Input = AssetRecord[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["id"], ["stage"], ["owner"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.get("stage")?.type, "string");
  assertEquals(members.get("owner")?.type, "string");
  assertEquals(members.has("unused"), false);
  assertEquals(members.has("nested"), false);
});

Deno.test("applyShrinkAndWrap preserves inherited interface fields in array unions", () => {
  const { sourceFile, checker } = createProgram(`
    interface LeadState {
      id: string;
      name: string;
    }

    interface LeadScoreSummary extends LeadState {
      score: number;
      unused: string;
    }

    type Input = LeadScoreSummary[] | undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "id"], ["0", "score"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.get("score")?.type, "number");
  assertEquals(members.has("name"), false);
  assertEquals(members.has("unused"), false);
});

Deno.test("applyShrinkAndWrap preserves aliased fixed-symbol keys in node-driven shrinking", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/test.ts": `
      import { SELF as CF_SELF } from "commonfabric";

      type Input = {
        [CF_SELF]?: { id: string; title: string };
        value: string;
      };
    `,
    "/commonfabric.d.ts": `
      export declare const SELF: unique symbol;
    `,
  });
  const alias = findTypeAlias(sourceFile, "Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["$SELF", "id"]],
    }),
    alias.type,
    undefined,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("[CF_SELF]")?.optional, true);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.has("title"), false);
  assertEquals(members.has("value"), false);
});

Deno.test("applyCapabilityDefaultsToTypeNode applies defaults through tuples and unions", () => {
  const { sourceFile, checker } = createProgram(`
    type Input =
      | [{ name?: string; unused?: string }]
      | { fallback?: string; unused?: string };
    type NameDefault = "Anonymous";
    type FallbackDefault = "Fallback";
  `);
  const input = findTypeAlias(sourceFile, "Input");
  const nameDefault = findTypeAlias(sourceFile, "NameDefault");
  const fallbackDefault = findTypeAlias(sourceFile, "FallbackDefault");
  const baseType = checker.getTypeAtLocation(input.type);

  const result = applyCapabilityDefaultsToTypeNode(
    input.type,
    [
      { path: ["0", "name"], defaultType: nameDefault.type },
      { path: ["fallback"], defaultType: fallbackDefault.type },
    ],
    baseType,
    [["0", "name"], ["fallback"]],
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("name")?.optional, true);
  assertEquals(
    members.get("name")?.type,
    '__cfHelpers.Default<string, "Anonymous">',
  );
  assertEquals(members.get("fallback")?.optional, true);
  assertEquals(
    members.get("fallback")?.type,
    '__cfHelpers.Default<string, "Fallback">',
  );
});

Deno.test("type shrinking helper predicates detect wrapper type nodes", () => {
  const { sourceFile, checker } = createProgram(`
    type CellValue = Cell<string>;
    type StreamValue = Stream<string>;
    type SqliteValue = SqliteDb<{ id: string }>;
    type PlainValue = string;
    type AnyUnion = { value: any } | { fallback: unknown };
  `);
  const cellNode = findTypeAlias(sourceFile, "CellValue").type;
  const streamNode = findTypeAlias(sourceFile, "StreamValue").type;
  const sqliteNode = findTypeAlias(sourceFile, "SqliteValue").type;
  const plainNode = findTypeAlias(sourceFile, "PlainValue").type;
  const anyUnionNode = findTypeAlias(sourceFile, "AnyUnion").type;

  assertEquals(containsAnyOrUnknownTypeNode(anyUnionNode), true);
  assertEquals(containsAnyOrUnknownTypeNode(plainNode), false);
  assertEquals(isCellLikeTypeNode(cellNode), true);
  assertEquals(isCellLikeTypeNode(sqliteNode), false);
  assertEquals(isStreamTypeNode(streamNode), true);
  assertEquals(isStreamTypeNode(cellNode), false);
  assertEquals(isSqliteTypeNode(sqliteNode), true);
  assertEquals(isSqliteTypeNode(cellNode), false);
  assertEquals(preservedWrapperFor(streamNode, undefined, checker), "Stream");
  assertEquals(preservedWrapperFor(sqliteNode, undefined, checker), "SqliteDb");
  assertEquals(preservedWrapperFor(plainNode, undefined, checker), undefined);
});

Deno.test("applyShrinkAndWrap descends identity paths through named interface references", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    interface Inner { keep: string; drop: number; }
    interface Outer { inner: Inner; other: string; }
    type Input = Outer;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  // The reference resolves to declared members, recurses into `inner`, and
  // wraps the `keep` leaf. Identity-path application transforms the targeted
  // leaf in place and leaves the surrounding structure intact.
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
  assertEquals(members.get("other")?.type, "string");
});

Deno.test("applyShrinkAndWrap rebuilds inline literals when a nested identity leaf changes", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      inner: { keep: string; drop: number };
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
  assertEquals(members.get("other")?.type, "string");
});

Deno.test("applyShrinkAndWrap returns an inline literal unchanged when a nested identity path does not resolve", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      a: { x: string };
      b: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["a", "missing"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // No member changes, so the literal (and its `a` member) is returned as-is.
  assertEquals(members.get("x")?.type, "string");
  assertEquals(members.get("b")?.type, "string");
  assertEquals(hasQualifiedRef(node, "__cfHelpers", "OpaqueCell"), false);
});

Deno.test("applyShrinkAndWrap leaves array elements untouched when an identity item path does not resolve", () => {
  const { sourceFile, checker } = createProgram(`
    interface Item { keep: string; drop: number; }
    type Input = Item[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["0", "missing"]],
      identityCellPaths: [["0", "missing"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  // The item path names no real member, so the element type (and the whole
  // array node) is returned unchanged.
  assertEquals(printed, "Item[]");
});

Deno.test("applyShrinkAndWrap descends identity item paths through readonly arrays", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    interface Item { keep: string; drop: number; }
    type Input = readonly Item[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["0", "keep"]],
      identityCellPaths: [["0", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // The readonly-array node recurses into its element type, resolves the item
  // interface's members, and wraps the requested leaf in place.
  assert(ts.isTypeOperatorNode(node));
  assertEquals(node.operator, ts.SyntaxKind.ReadonlyKeyword);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
});

Deno.test("wrapTypeNodeWithCapability emits the expected cell wrappers", () => {
  const { sourceFile } = createProgram(`type Value = string;`);
  const valueNode = findTypeAlias(sourceFile, "Value").type;

  const wrappers = [
    ["readonly", "ReadonlyCell"],
    ["comparable", "ComparableCell"],
    ["writeonly", "WriteonlyCell"],
    ["writable", "Writable"],
    ["opaque", "OpaqueCell"],
  ] as const;

  for (const [capability, wrapperName] of wrappers) {
    const node = parseType(printTypeNode(
      wrapTypeNodeWithCapability(valueNode, capability, ts.factory),
      sourceFile,
    ));
    assert(ts.isTypeReferenceNode(node));
    assert(hasQualifiedRef(node, "__cfHelpers", wrapperName));
    assert(node.typeArguments && node.typeArguments.length === 1);
    assertEquals(
      node.typeArguments[0]!.getText(node.getSourceFile()),
      "string",
    );
  }
});

Deno.test("applyShrinkAndWrap preserves a parenthesized capture while narrowing cell capability", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/commonfabric.d.ts": "export interface Cell<T> { get(): T; }",
    "/test.ts": `
      import type { Cell } from "commonfabric";
      type Input = ({ value: Cell<{ count: number }>; other: string });
    `,
  });
  const alias = findTypeAlias(sourceFile, "Input");
  const result = applyShrinkAndWrap(
    createParamSummary({ wildcard: true, readPaths: [["value"]] }),
    alias.type,
    checker.getTypeAtLocation(alias.type),
    false,
    checker,
    sourceFile,
    ts.factory,
  );
  const { node } = shrunkProps(result, sourceFile);
  expect(ts.isParenthesizedTypeNode(node)).toBe(true);
  if (!ts.isParenthesizedTypeNode(node) || !ts.isTypeLiteralNode(node.type)) {
    throw new Error("Expected a parenthesized object capture");
  }
  const outer = node.type.members.filter(ts.isPropertySignature);
  expect(
    outer.map((member) =>
      ts.isIdentifier(member.name) ? member.name.text : undefined
    ),
  )
    .toEqual(["value", "other"]);
  const value = outer[0]!;
  const other = outer[1]!;
  expect(other.type?.kind).toBe(ts.SyntaxKind.StringKeyword);
  if (!value.type || !ts.isTypeReferenceNode(value.type)) {
    throw new Error("Expected the value property to carry the Cell wrapper");
  }
  if (
    !ts.isQualifiedName(value.type.typeName) ||
    !ts.isIdentifier(value.type.typeName.left)
  ) {
    throw new Error("Expected a qualified Cell wrapper");
  }
  expect(value.type.typeName.left.text).toBe("__cfHelpers");
  expect(value.type.typeName.right.text).toBe("ReadonlyCell");
  expect(value.type.typeArguments).toHaveLength(1);
  const payload = value.type.typeArguments![0]!;
  if (!ts.isTypeLiteralNode(payload)) {
    throw new Error("Expected a Cell payload object");
  }
  expect(payload.members).toHaveLength(1);
  const count = payload.members[0]!;
  if (!ts.isPropertySignature(count) || !ts.isIdentifier(count.name)) {
    throw new Error("Expected the Cell payload's count property");
  }
  expect(count.name.text).toBe("count");
  expect(count.type?.kind).toBe(ts.SyntaxKind.NumberKeyword);
});
