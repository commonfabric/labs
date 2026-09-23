import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import type {
  CapabilityParamSummary,
  TransformationContext,
} from "../src/core/mod.ts";
import {
  applyCapabilityDefaultsToTypeNode,
  applyShrinkAndWrap,
  printTypeNode,
} from "../src/transformers/type-shrinking.ts";
import { collect, parseModule } from "./transformed-ast.ts";

//
// Structural inspection of printed type nodes
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

//
// Harness (mirrors test/type-shrinking.test.ts so cases stay comparable)
//

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

function findTypeAlias(
  sourceFile: ts.SourceFile,
  aliasName: string,
): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === aliasName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Type alias ${aliasName} not found`);
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

interface CollectedDiagnostic {
  severity: string;
  type: string;
  message: string;
}

function createContext(sourceFile: ts.SourceFile): {
  context: TransformationContext;
  diagnostics: CollectedDiagnostic[];
} {
  const diagnostics: CollectedDiagnostic[] = [];
  const context = {
    sourceFile,
    factory: ts.factory,
    options: {},
    state: {
      typeRegistry: new WeakMap<ts.Node, ts.Type>(),
    },
    reportDiagnostic: (d: CollectedDiagnostic) => {
      diagnostics.push({
        severity: d.severity,
        type: d.type,
        message: d.message,
      });
    },
  } as unknown as TransformationContext;
  return { context, diagnostics };
}

//
// Shrinking and wrapping: the paths that resolve, and the ones that do not
//
// The arms where a path resolves — array items and their unions, nested
// leaves, identity paths across members, and the cell capabilities carried
// through them — beside the diagnostics and the untouched nodes that a path
// failing to resolve produces.
//

Deno.test("applyShrinkAndWrap shrinks Array<T> reference items to accessed fields", () => {
  // Array element node building via type-driven shrinking (Array<T> reference).
  // Lines ~1185-1202, 1194-1199: TypeReference to `Array` resolved through the
  // checker, element shrunk, array node rebuilt.

  const { sourceFile, checker } = createProgram(`
    type Item = { id: string; title: string; unused: number };
    type Input = Array<Item>;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "title"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("title")?.type, "string");
  // The `Array<Item>` reference is rebuilt with the shrunk element, staying an
  // Array<...> reference around a type literal rather than collapsing to a
  // numeric-key object.
  assert(ts.isTypeReferenceNode(node));
  assertEquals((node.typeName as ts.Identifier).text, "Array");
  assert(ts.isTypeLiteralNode(node.typeArguments![0]!));
  assertEquals(members.has("unused"), false);
  assertEquals(members.has("id"), false);
});

Deno.test("applyShrinkAndWrap collapses length-only Array<T> reads to unknown[]", () => {
  // length-only access on an Array<T> reference emits unknown[] (array-root
  // only path). Exercises the `allNonItem` array branch in the node-driven
  // path.

  const { sourceFile, checker } = createProgram(`
    type Item = { id: string; title: string };
    type Input = Array<Item>;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown[]");
});

Deno.test("applyShrinkAndWrap shrinks each member of a source-authored union", () => {
  // Union of object shapes: shrink each non-nullish member; nullish member
  // preserved. Exercises the union branch in buildShrunkTypeNodeFromTypeNode
  // (lines ~1278-1301) via a source-authored union node.

  const { sourceFile, checker } = createProgram(`
    type Input =
      | { shared: string; onlyA: number }
      | { shared: string; onlyB: boolean };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["shared"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("shared")?.type, "string");
  assertEquals(members.has("onlyA"), false);
  assertEquals(members.has("onlyB"), false);
});

Deno.test("applyShrinkAndWrap collapses a shrunk union to its single non-nullish member", () => {
  // Union `T | undefined` where only one member holds the accessed property.
  // After shrinking the non-nullish member, a single member remains and the
  // union collapses to that member (line ~1299-1301 `all.length === 1`).

  const { sourceFile, checker } = createProgram(`
    type Input = { keep: string; drop: number };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  // Author a union node whose only non-nullish member is the object literal.
  const unionNode = ts.factory.createUnionTypeNode([
    alias.type,
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["keep"]],
    }),
    unionNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "string");
  assertEquals(members.has("drop"), false);
  // Single non-nullish member survived; undefined was dropped after collapse,
  // so the root is the bare object literal rather than a union.
  assert(ts.isTypeLiteralNode(node));
});

Deno.test("applyShrinkAndWrap re-appends undefined when type-driven shrinking a nullable object", () => {
  // Type-driven union nullish re-wrapping (buildShrunkTypeNodeFromType,
  // ~856-895) and line 888 (`nullishMembers.length === 0` short-circuit not
  // taken). Drive with a synthetic base node to force the type-driven path.

  const { sourceFile, checker } = createProgram(`
    type Payload = { keep: string; drop: number };
    type Input = Payload | undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["keep"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "string");
  assertEquals(members.has("drop"), false);
  // The nullable object is rebuilt as a union that re-appends `undefined`.
  assert(ts.isUnionTypeNode(node));
  assert(
    node.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword),
  );
});

Deno.test("applyShrinkAndWrap keeps nested primitive leaves intact under type-driven shrinking", () => {
  // Nested primitive leaf on a type-driven shrink: `text.length` keeps the
  // string leaf intact instead of shrinking `text` to `{ length }` (lines
  // ~934-962 primitive-scalar branch through the type-driven path).

  const { sourceFile, checker } = createProgram(`
    type Input = { text: string; other: number };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["text", "length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  // `text` keeps its string leaf rather than shrinking to `{ length }`.
  assertEquals(members.get("text")?.type, "string");
  assertEquals(members.has("length"), false);
  assertEquals(members.has("other"), false);
});

Deno.test("applyShrinkAndWrap represents index-signature access as an optional member", () => {
  // Index-signature access via type-driven shrinking: a numeric/string key that
  // is not a named property resolves through the index signature and the
  // emitted member is optional (lines ~913-936: `isOptional = true`,
  // `984-989`).

  const { sourceFile, checker } = createProgram(`
    type Input = { [key: string]: { name: string; unused: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["anyKey", "name"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("anyKey")?.optional, true);
  assertEquals(members.get("name")?.type, "string");
  assertEquals(members.has("unused"), false);
});

Deno.test("applyShrinkAndWrap resolves an interface reference and drops unaccessed members", () => {
  // isUnchangedShrink: a TypeReference whose members are all accessed with no
  // nested change is kept as the original reference to preserve $ref/$defs
  // (lines ~1453-1474 return `node`).

  const { sourceFile, checker } = createProgram(`
    interface Point { x: number; y: number; z: number; }
    type Input = Point;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["x"], ["y"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  // The reference resolves to its declared members and the unaccessed `z` is
  // dropped, so the shrink differs from the original (isUnchangedShrink false).
  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("x")?.type, "number");
  assertEquals(members.get("y")?.type, "number");
  assertEquals(members.has("z"), false);
});

Deno.test("applyShrinkAndWrap merges inherited interface members and honors overrides", () => {
  // Interface heritage merge: an interface extending a base contributes
  // inherited members that are merged and de-duplicated (mergeResolvedMembers,
  // ~1416-1442; resolveMembersFromDeclaration heritage branch ~1388-1414). An
  // overriding property in the derived interface wins.

  const { sourceFile, checker } = createProgram(`
    interface Base { shared: string; baseOnly: number; }
    interface Derived extends Base { shared: string; derivedOnly: boolean; }
    type Input = Derived;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["baseOnly"], ["derivedOnly"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("baseOnly")?.type, "number");
  assertEquals(members.get("derivedOnly")?.type, "boolean");
  assertEquals(members.has("shared"), false);
});

Deno.test("applyShrinkAndWrap reports unknown-type-access for unknown base with reads", () => {
  // Diagnostics: unknown base type with property access reports
  // schema:unknown-type-access (lines ~1876-1893). Driven through
  // applyShrinkAndWrap with a context + fnNode so validateShrinkCoverage runs.

  const { sourceFile, checker } = createProgram(`
    type Input = unknown;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);
  const fnNode = alias;

  applyShrinkAndWrap(
    createParamSummary({
      name: "payload",
      readPaths: [["missing"]],
    }),
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "full",
    "opaque",
    context,
    fnNode,
  );

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "schema:unknown-type-access");
  assertStringIncludes(diagnostics[0]!.message, "payload");
  assertStringIncludes(diagnostics[0]!.message, "'.missing'");
});

Deno.test("applyShrinkAndWrap reports path-not-in-type for a missing property", () => {
  // Diagnostics: concrete type but an accessed path is absent reports
  // schema:path-not-in-type (lines ~1938-1954, and the missing filter
  // 1939-1941).

  const { sourceFile, checker } = createProgram(`
    type Input = { present: string };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);

  applyShrinkAndWrap(
    createParamSummary({
      name: "row",
      readPaths: [["present"], ["absent"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "full",
    "opaque",
    context,
    alias,
  );

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "schema:path-not-in-type");
  assertStringIncludes(diagnostics[0]!.message, "'.absent'");
  assertEquals(diagnostics[0]!.message.includes("'.present'"), false);
});

Deno.test("applyShrinkAndWrap reports unknown-typed property access", () => {
  // Diagnostics: concrete type with a property typed `unknown` reports
  // schema:unknown-type-access (case 2, lines ~1900-1935).

  const { sourceFile, checker } = createProgram(`
    type Input = { amounts: unknown };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);

  applyShrinkAndWrap(
    createParamSummary({
      name: "input",
      readPaths: [["amounts"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "full",
    "opaque",
    context,
    alias,
  );

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "schema:unknown-type-access");
  assertStringIncludes(diagnostics[0]!.message, "'.amounts'");
  assertStringIncludes(diagnostics[0]!.message, "typed as 'unknown'");
});

Deno.test("applyShrinkAndWrap skips validation for a never base type", () => {
  // Diagnostics: `never` base type skips validation entirely (lines
  // ~1857-1862). A `never`-typed parameter with reads must produce no
  // diagnostics.

  const { sourceFile, checker } = createProgram(`
    type Input = never;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);

  applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["anything"]],
    }),
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "full",
    "opaque",
    context,
    alias,
  );

  assertEquals(diagnostics.length, 0);
});

Deno.test("applyShrinkAndWrap reports unknown-type-access for an unknown wildcard param", () => {
  // Diagnostics: wildcard param typed `unknown` passed to an opaque function
  // reports the wildcard-specific unknown-type-access branch (lines
  // ~1733-1750).

  const { sourceFile, checker } = createProgram(`
    type Input = unknown;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);

  applyShrinkAndWrap(
    createParamSummary({
      name: "logged",
      wildcard: true,
    }),
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "full",
    "opaque",
    context,
    alias,
  );

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "schema:unknown-type-access");
  assertStringIncludes(diagnostics[0]!.message, "logged");
});

Deno.test("applyShrinkAndWrap validates array item paths against the element type", () => {
  // Validation over an array base: item-level paths validate against the
  // element type. A missing item property reports through the array-element
  // recursion (lines ~1795-1833, getArrayElementTypeNode paths ~1656-1709).

  const { sourceFile, checker } = createProgram(`
    interface Row { id: string; }
    type Input = Row[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);

  applyShrinkAndWrap(
    createParamSummary({
      name: "rows",
      readPaths: [["0", "id"], ["0", "missing"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "full",
    "opaque",
    context,
    alias,
  );

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "schema:path-not-in-type");
  assertStringIncludes(diagnostics[0]!.message, "'.missing'");
});

Deno.test("applyShrinkAndWrap applies defaults-only fallback across the base type shape", () => {
  // defaults_only mode: a default nested under a path present in the base type
  // gets applied to the fallback shape when the direct node application misses.
  // Also exercises applyCapabilityDefaultsToTypeNode fallback (~2919-2945) and
  // buildDefaultsOnlyFallbackPaths leaf expansion (~2954-2956, 3001-3026).

  const { sourceFile, checker } = createProgram(`
    type Input = { title: string; count: number };
    type TitleDefault = "Untitled";
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const titleDefault = findTypeAlias(sourceFile, "TitleDefault");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      defaults: [{ path: ["title"], defaultType: titleDefault.type }],
    }),
    // A synthetic node that has no `title` member forces the fallback shape.
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "defaults_only",
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(
    members.get("title")?.type,
    '__cfHelpers.Default<string, "Untitled">',
  );
  assertEquals(members.get("count")?.type, "number");
});

Deno.test("applyCapabilityDefaultsToTypeNode applies a default through a tuple index", () => {
  // applyCapabilityDefaultsToTypeNode: default applied directly through a tuple
  // index (applySingleDefaultToTypeNode tuple branch ~2825-2850).

  const { sourceFile, checker } = createProgram(`
    type Input = [{ name?: string }, number];
    type NameDefault = "Anon";
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const nameDefault = findTypeAlias(sourceFile, "NameDefault");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyCapabilityDefaultsToTypeNode(
    alias.type,
    [{ path: ["0", "name"], defaultType: nameDefault.type }],
    baseType,
    [["0", "name"]],
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("name")?.optional, true);
  assertEquals(
    members.get("name")?.type,
    '__cfHelpers.Default<string, "Anon">',
  );
});

Deno.test("applyCapabilityDefaultsToTypeNode ignores an out-of-range tuple index", () => {
  // applyCapabilityDefaultsToTypeNode: out-of-range tuple index leaves the node
  // unchanged (tuple guard ~2827-2831). No __cfHelpers.Default wrapper appears.

  const { sourceFile, checker } = createProgram(`
    type Input = [{ name?: string }];
    type NameDefault = "Anon";
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const nameDefault = findTypeAlias(sourceFile, "NameDefault");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyCapabilityDefaultsToTypeNode(
    alias.type,
    [{ path: ["5", "name"], defaultType: nameDefault.type }],
    baseType,
    [["5", "name"]],
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const node = parseType(printTypeNode(result, sourceFile));
  assertEquals(hasQualifiedRef(node, "__cfHelpers", "Default"), false);
});

Deno.test("applyShrinkAndWrap replaces identity-only union roots per member", () => {
  // Identity-only root on a union base: each union member is replaced with the
  // identity-only shape; nullish members are rebuilt as-is
  // (createIdentityOnlyRootTypeNode union branch ~2367-2400).

  const { sourceFile, checker } = createProgram(`
    type Input = { a: string } | { b: number } | undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
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

  const node = parseType(printTypeNode(result, sourceFile));
  // Each non-nullish member collapses to `unknown`; undefined is preserved.
  assert(ts.isUnionTypeNode(node));
  assert(
    node.types.some((member) => member.kind === ts.SyntaxKind.UnknownKeyword),
  );
  assert(
    node.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword),
  );
  const members = props(node);
  assertEquals(members.has("a"), false);
  assertEquals(members.has("b"), false);
});

Deno.test("applyShrinkAndWrap rebuilds an identity-only nullish root as undefined", () => {
  // Identity-only root that is nullish (`undefined`): rebuilt via
  // createIdentityOnlyNullishTypeNode (lines ~2357-2365, 2311-2331).

  const { sourceFile, checker } = createProgram(`
    type Input = undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "undefined");
});

Deno.test("applyShrinkAndWrap descends identity item paths through Array<T> references", () => {
  // Identity paths descending through an array item interface reference
  // resolved via the checker (applyIdentityOnlyPathsToTypeNode Array<T> ref
  // branch ~2557-2583) using an Array<T> reference (not `T[]`).

  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    interface Item { keep: string; drop: number; }
    type Input = Array<Item>;
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

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
});

Deno.test("applyShrinkAndWrap applies identity paths across union members", () => {
  // Identity paths through a union base node (applyIdentityOnlyPathsToTypeNode
  // union branch ~2728-2752): each union member is visited and changed members
  // force a rebuilt union.

  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input =
      | { item: { keep: string; drop: number } }
      | { item: { keep: string; other: boolean } };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const unionNode = alias.type;
  assert(ts.isUnionTypeNode(unionNode));

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["item", "keep"]],
      identityCellPaths: [["item", "keep"]],
    }),
    unionNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
  assertEquals(members.get("other")?.type, "boolean");
});

Deno.test("applyShrinkAndWrap keeps an interface reference when no identity path matches", () => {
  // Identity paths through a named interface reference that resolves to
  // declared members, where a nested member is left unchanged (no matching
  // child path) so the `!changed` early return keeps the reference
  // (applyIdentityOnlyPathsToTypeNode reference branch ~2669-2725, unchanged
  // return ~2721-2723).

  const { sourceFile, checker } = createProgram(`
    interface Outer { inner: { keep: string }; other: string; }
    type Input = Outer;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      // Names a head that does not exist on Outer, so nothing changes.
      identityPaths: [["nonexistent"]],
      identityCellPaths: [["nonexistent"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  // No member matched, so the reference is returned unchanged.
  assertEquals(printTypeNode(result, sourceFile), "Outer");
});

Deno.test("applyShrinkAndWrap applies cell capabilities through parenthesized literals", () => {
  // applyCellCapabilityPathsToTypeNode through a parenthesized type node
  // (~2181-2193) plus per-property cell capability selection where read+write
  // paths on the same leaf select `writable`.

  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type ReadonlyCell<T> = { readonly readonly?: T };
    }
    type Inner = { value: __cfHelpers.Writable<number> };
    type Input = (Inner);
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
});

//
// Node shapes taken one at a time
//
// Each shape the walk can meet — arrays and their aliases, parenthesized and
// wrapper references, unions, and the defaults applied through them —
// whether or not a path matches inside it.
//

Deno.test("applyShrinkAndWrap keeps Array<T> unchanged for an unresolved identity item path", () => {
  // Identity item path on an Array<T> reference that names no member leaves the
  // whole array reference unchanged (Array<T> ref `updated === inner`
  // ~2574-2576).

  const { sourceFile, checker } = createProgram(`
    interface Item { keep: string; }
    type Input = Array<Item>;
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

  assertEquals(printTypeNode(result, sourceFile), "Array<Item>");
});

Deno.test("applyShrinkAndWrap keeps a readonly array unchanged for an unresolved identity item path", () => {
  // Identity item path on a readonly array that names no member leaves the
  // readonly-array node unchanged (readonly-array `updated === elementType`
  // ~2546-2548).

  const { sourceFile, checker } = createProgram(`
    interface Item { keep: string; }
    type Input = readonly Item[];
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

  const node = parseType(printTypeNode(result, sourceFile));
  // The readonly-array node is returned unchanged: a `readonly` type operator
  // over an `Item[]` array.
  assert(ts.isTypeOperatorNode(node));
  assertEquals(node.operator, ts.SyntaxKind.ReadonlyKeyword);
  assert(ts.isArrayTypeNode(node.type));
  assertEquals(node.type.elementType.getText(node.getSourceFile()), "Item");
});

Deno.test("applyShrinkAndWrap rebuilds a parenthesized identity root when a leaf changes", () => {
  // Identity path through a parenthesized literal that DOES change a leaf: the
  // parenthesized wrapper is rebuilt around the updated inner
  // (createIdentityOnly paren branch ~2485-2498, change arm).

  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = ({ item: { keep: string; drop: number } });
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  assert(ts.isParenthesizedTypeNode(alias.type));

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["item", "keep"]],
      identityCellPaths: [["item", "keep"]],
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
});

Deno.test("applyShrinkAndWrap descends identity paths through a Cell-like wrapper reference", () => {
  // Identity path through a Cell-like wrapper reference descends into the inner
  // type argument (applyIdentityOnlyPathsToTypeNode cell-ref branch
  // ~2642-2667).

  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Cell<T> = { readonly cell?: T };
    type Input = Cell<{ keep: string; drop: number }>;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["keep"]],
      identityCellPaths: [["keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // The Cell wrapper is retained; its inner `keep` leaf is wrapped in place.
  assert(ts.isTypeReferenceNode(node));
  assertEquals((node.typeName as ts.Identifier).text, "Cell");
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
});

Deno.test("applyShrinkAndWrap recognizes an array type-alias reference as array-shaped", () => {
  // Node-driven array shrink where the base node is a type alias resolving to
  // an array (not `T[]`/`Array<T>` syntactically) exercises the checker-based
  // array detection (buildShrunkTypeNodeFromTypeNode ~1086-1096, 1185-1202).
  // The alias reference is recognized as array-shaped and preserved as a
  // reference so schema generation keeps its $ref.

  const { sourceFile, checker } = createProgram(`
    interface Row { id: string; title: string; unused: number; }
    type Rows = Row[];
    type Input = Rows;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "title"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  // The alias resolves to an array via the checker; the reference is kept.
  assertEquals(printTypeNode(result, sourceFile), "Rows");
});

Deno.test("applyShrinkAndWrap shrinks array-like type literals with numeric index and length", () => {
  // Array-like TypeLiteral (numeric index + length) drives the
  // getArrayLikeTypeLiteralElementType path (~557-577) and element shrinking of
  // a literal element node (~565-567). Item field access shrinks the element.

  const { sourceFile, checker } = createProgram(`
    type Input = {
      length: number;
      [n: number]: { id: string; title: string; unused: number };
    };
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

  const { node, props: members } = shrunkProps(result, sourceFile);
  // The array-like literal shrinks into an array of the shrunk element.
  assert(ts.isArrayTypeNode(node));
  assertEquals(members.get("title")?.type, "string");
  assertEquals(members.has("unused"), false);
});

Deno.test("applyShrinkAndWrap resolves a union-only property during type-driven shrinking", () => {
  // findPropertySymbol resolves a property that lives only on one union
  // constituent (findPropertySymbol union recursion ~684-689) during
  // type-driven shrinking of a union base node.

  const { sourceFile, checker } = createProgram(`
    type Input = { common: string } & ({ onlyHere: number } | { alt: boolean });
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["common"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("common")?.type, "string");
});

Deno.test("applyShrinkAndWrap drops an unresolved deep child during type-driven shrinking", () => {
  // Type-driven shrink where a deeper path fails to materialize on a nested
  // property: the child is dropped rather than widened
  // (buildShrunkTypeNodeFromType `!shrunkChild && !hasDirectAccess` continue,
  // ~978-989 region). Access a valid head plus an invalid deep path on the same
  // property.

  const { sourceFile, checker } = createProgram(`
    type Input = { data: { present: string }; other: number };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["data", "present"], ["other"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("present")?.type, "string");
  assertEquals(members.get("other")?.type, "number");
});

Deno.test("applyCapabilityDefaultsToTypeNode applies a default through a union member", () => {
  // applyCapabilityDefaultsToTypeNode applies a default through a union member
  // (applySingleDefaultToTypeNode union branch ~2852-2870).

  const { sourceFile, checker } = createProgram(`
    type Input = { a?: string } | { b?: number };
    type ADefault = "x";
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const aDefault = findTypeAlias(sourceFile, "ADefault");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyCapabilityDefaultsToTypeNode(
    alias.type,
    [{ path: ["a"], defaultType: aDefault.type }],
    baseType,
    [["a"]],
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("a")?.optional, true);
  assertEquals(members.get("a")?.type, '__cfHelpers.Default<string, "x">');
});

Deno.test("applyShrinkAndWrap expands nested defaults-only fallback leaves", () => {
  // defaults-only fallback where a default is nested under a property: the
  // fallback path builder expands the child's leaves so the default lands
  // (buildDefaultsOnlyFallbackPaths nested-head expansion ~2954-2956,
  // 3009-3026).

  const { sourceFile, checker } = createProgram(`
    type Input = { group: { title: string; note: string }; count: number };
    type TitleDefault = "Untitled";
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const titleDefault = findTypeAlias(sourceFile, "TitleDefault");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      defaults: [{ path: ["group", "title"], defaultType: titleDefault.type }],
    }),
    // Synthetic base with no `group` member forces the fallback shape.
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "defaults_only",
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(
    members.get("title")?.type,
    '__cfHelpers.Default<string, "Untitled">',
  );
  // Sibling leaf under the same parent is retained in the expanded fallback.
  assertEquals(members.get("note")?.type, "string");
  assertEquals(members.get("count")?.type, "number");
});

Deno.test("applyShrinkAndWrap replaces an identity-only root that has no resolvable type", () => {
  // Identity-only root whose resolved semantic type is undefined falls back to
  // the replacement type node (createIdentityOnlyRootTypeNode `!resolvedType`
  // branch ~2345-2354) — driven by a synthetic node with no base type.

  const { sourceFile, checker } = createProgram(`type Marker = string;`);
  // A synthetic reference to a name that resolves to nothing under noLib.
  const syntheticNode = ts.factory.createTypeReferenceNode("Unresolvable");

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    syntheticNode,
    undefined,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  // No base type and an unresolvable node → identity-only root collapses to
  // `unknown`.
  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

Deno.test("applyShrinkAndWrap selects writable capability for read-and-write cell leaves", () => {
  // Cell-capability application over a plain object literal member whose value
  // is a cell wrapper (applyCellCapabilityPathsToTypeNode literal member branch
  // ~2199-2264): a read+write access selects the `writable` capability.

  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
    }
    type Input = { field: __cfHelpers.Writable<number>; untouched: string };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "writable",
      readPaths: [["field"]],
      writePaths: [["field"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("field")?.type, "__cfHelpers.Writable<number>");
  assertEquals(members.has("untouched"), false);
});

//
// Array-union validation, and the defensive arms
//
// Validation over array unions, what remains of union collapse, and the
// branches that exist to fail safely.
//

Deno.test("applyShrinkAndWrap accepts item paths present on a nullable array union element", () => {
  // Validation over a `Row[] | undefined` base with a valid item field reports
  // no diagnostic, exercising getArrayElementTypeNode's union branch
  // (~1643-1657): the nullish member is skipped and the array member yields the
  // element type.

  const { sourceFile, checker } = createProgram(`
    interface Row { id: string; }
    type Input = Row[] | undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);

  applyShrinkAndWrap(
    createParamSummary({
      name: "rows",
      readPaths: [["0", "id"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "full",
    "opaque",
    context,
    alias,
  );

  // `id` resolves on the array element, so no path-not-in-type is reported.
  assertEquals(diagnostics.length, 0);
});

Deno.test("applyShrinkAndWrap collapses a one-member union node to the shrunk member", () => {
  // A union node whose single non-nullish member shrinks collapses to that
  // member (buildShrunkTypeNodeFromTypeNode union `all.length === 1`
  // ~1298-1301). A one-element union node with one accessed property drives the
  // collapse.

  const { sourceFile, checker } = createProgram(`
    type Input = { keep: string; drop: number };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  // A union node with a single (object literal) member, no nullish members.
  const unionNode = ts.factory.createUnionTypeNode([alias.type]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["keep"]],
    }),
    unionNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "string");
  assertEquals(members.has("drop"), false);
  // Collapsed to the single shrunk member, so the root is a bare object literal
  // rather than a union.
  assert(ts.isTypeLiteralNode(node));
});

Deno.test("applyShrinkAndWrap leaves an all-nullish union node unchanged", () => {
  // A union node with only nullish members is returned unchanged
  // (buildShrunkTypeNodeFromTypeNode `nonNullish.length === 0` ~1278).

  const { sourceFile, checker } = createProgram(`type Input = string;`);
  const nullOnly = ts.factory.createUnionTypeNode([
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
    ts.factory.createLiteralTypeNode(ts.factory.createNull()),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["anything"]],
    }),
    nullOnly,
    undefined,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const node = parseType(printTypeNode(result, sourceFile));
  // The all-nullish union is returned unchanged: both the `undefined` keyword
  // and the `null` literal member survive.
  assert(ts.isUnionTypeNode(node));
  assert(
    node.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword),
  );
  assert(
    node.types.some((member) =>
      ts.isLiteralTypeNode(member) &&
      member.literal.kind === ts.SyntaxKind.NullKeyword
    ),
  );
});

Deno.test("applyCapabilityDefaultsToTypeNode ignores a tuple default whose nested path is absent", () => {
  // A valid tuple index whose nested default path does not resolve leaves the
  // tuple unchanged (applySingleDefaultToTypeNode tuple `!updatedChild.applied`
  // arm ~2841-2843).

  const { sourceFile, checker } = createProgram(`
    type Input = [{ present?: string }];
    type D = "x";
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const dDefault = findTypeAlias(sourceFile, "D");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyCapabilityDefaultsToTypeNode(
    alias.type,
    [{ path: ["0", "absent"], defaultType: dDefault.type }],
    baseType,
    [["0", "absent"]],
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  // The nested path names no member, so no default wrapper is applied.
  const node = parseType(printTypeNode(result, sourceFile));
  assertEquals(hasQualifiedRef(node, "__cfHelpers", "Default"), false);
});
