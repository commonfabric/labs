import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import type {
  CapabilityParamSummary,
  TransformationContext,
} from "../src/core/mod.ts";
import {
  applyShrinkAndWrap,
  printTypeNode,
  validateShrinkCoverage,
} from "../src/transformers/type-shrinking.ts";
import { collect, parseModule } from "./transformed-ast.ts";

// These branches in type-shrinking run only when a pattern compiles cold through
// the transformer. When the pattern compile-cache is warm they are skipped, so
// they flap between covered and uncovered across CI runs of identical code. The
// tests below drive them directly through the exported shrinking entry points so
// they are recorded every run.

//
// Structural inspection of printed type nodes (mirrors
// type-shrinking-coverage.test.ts).
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

/** Every property signature reachable under `node`, keyed by name. */
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

//
// Harness (mirrors type-shrinking-coverage.test.ts so cases stay comparable).
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
// The flapping branches, driven directly
//
// Each case constructs the smallest source that reaches its branch, so the
// branch is covered whether or not a pattern happens to compile cold.
//

Deno.test("applyShrinkAndWrap drops a deep read into an unknown-typed property under type-driven shrinking", () => {
  // Type-driven shrink descending into an `unknown`/`any` property drops that
  // property rather than widening it (buildShrunkTypeNodeFromType
  // `!hasDirectAccess && isAnyOrUnknownType(propType)` continue, lines
  // 964-967). A synthetic base node forces the type-driven path; a deep path
  // into an `unknown`-typed member reaches the guard.
  const { sourceFile, checker } = createProgram(`
    type Input = { blob: unknown; kept: string };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      // Deep path into `blob` (unknown): the child cannot be materialized, so
      // `blob` is dropped instead of widened to the full unknown shape.
      readPaths: [["blob", "inner"], ["kept"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  // The unknown-typed `blob` is absent; only the resolvable `kept` leaf remains.
  assertEquals(members.has("blob"), false);
  assertEquals(members.get("kept")?.type, "string");
});

Deno.test("validateShrinkCoverage resolves array element node from an array type-alias reference", () => {
  // getArrayElementTypeNode fallback: a base node that is a plain type-alias
  // reference (not `T[]`, `Array<T>`, readonly array, union, or type literal)
  // resolves to an array only through the checker, so the element node is built
  // from the resolved element type (lines 1685-1688, 1694, 1699-1709).
  // Validating an item path on such a base runs the fallback and finds the item
  // field.
  const { sourceFile, checker } = createProgram(`
    interface Array<T> { length: number; [n: number]: T; }
    interface Row { id: string; title: string; }
    type Rows = Row[];
    type Input = Rows;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);
  // The base node is the bare `Rows` reference — not syntactically an array.
  const baseTypeNode = alias.type;
  assert(ts.isTypeReferenceNode(baseTypeNode));

  validateShrinkCoverage(
    createParamSummary({
      name: "rows",
      readPaths: [["0", "id"], ["0", "missing"]],
    }),
    baseTypeNode,
    baseType,
    [["0", "id"], ["0", "missing"]],
    // shrunk is undefined so validation resolves the element via the base node's
    // checker-driven fallback rather than a prebuilt array shape.
    undefined,
    context,
    alias,
    checker,
  );

  // `id` resolves on the element type via the fallback; `missing` does not.
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "schema:path-not-in-type");
  assertStringIncludes(diagnostics[0]!.message, "'.missing'");
  assertEquals(diagnostics[0]!.message.includes("'.id'"), false);
});

Deno.test("validateShrinkCoverage validates array-root paths against the array base when the shrunk node is not array-shaped", () => {
  // validateShrinkCoverage over an array base where the shrunk node is NOT
  // array-shaped: array-root paths (`length`) survive and re-drive validation
  // against the array base (line 1832-1833 `paths = arrayRootPaths`), and the
  // array-root head is checked via typeNodeHasHead's array-shape arm (line
  // 1545). A bogus non-array head keeps the top-1763 fast path from firing.
  const { sourceFile, checker } = createProgram(`
    interface Array<T> { length: number; [n: number]: T; }
    interface Row { id: string; }
    type Input = Row[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const { context, diagnostics } = createContext(sourceFile);
  const baseTypeNode = alias.type;
  assert(ts.isArrayTypeNode(baseTypeNode));

  // A non-array shrunk node so the array-compatible fast path (all heads
  // array-compatible + shrunk array-shaped) does not fire.
  const nonArrayShrunk = ts.factory.createTypeLiteralNode([]);

  validateShrinkCoverage(
    createParamSummary({
      name: "rows",
      // `length` is an array-root-only path; `bogus` is a non-array head that
      // both blocks the fast path and is absent from the array element.
      readPaths: [["length"], ["bogus"]],
    }),
    baseTypeNode,
    baseType,
    [["length"], ["bogus"]],
    nonArrayShrunk,
    context,
    alias,
    checker,
  );

  // `length` validates against the array base (typeNodeHasHead array arm), so
  // the only diagnostic is for the item path `bogus`, which is absent from Row.
  const rootDiagnostics = diagnostics.filter((d) =>
    d.message.includes("'.length'")
  );
  assertEquals(rootDiagnostics.length, 0);
  assert(
    diagnostics.some((d) => d.message.includes("'.bogus'")),
    "expected a diagnostic for the missing item field",
  );
});
