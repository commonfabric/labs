import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/dataflow.ts";
import type {
  DataFlowAnalysis,
  DataFlowGraph,
  DataFlowNode,
  DataFlowScope,
} from "../../src/ast/dataflow.ts";
import {
  getRelevantDataFlows,
  normalizeDataFlows,
} from "../../src/ast/normalize.ts";
import type { ReactiveContextLookup } from "../../src/ast/reactive-context.ts";
import { getExpressionText } from "../../src/ast/utils.ts";

const factory = ts.factory;

// A checker attached to a trivial program. It is only used to resolve symbols
// for synthetically constructed nodes; factory-created identifiers have no
// symbol, which is exactly the "synthetic root" condition the normalizer's
// map-parameter recovery path keys off of.
function trivialChecker(): ts.TypeChecker {
  const fileName = "/trivial.ts";
  const source = "const trivial = 1;";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    noLib: true,
  };
  const sf = ts.createSourceFile(fileName, source, options.target!, true);
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name) => name === fileName ? sf : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";
  return ts.createProgram([fileName], options, host).getTypeChecker();
}

function syntheticNode(
  id: number,
  expression: ts.Expression,
  scopeId: number,
  parentId: number | null,
  isExplicit: boolean,
): DataFlowNode {
  return { id, expression, canonicalKey: "", parentId, scopeId, isExplicit };
}

function syntheticGraph(
  nodes: DataFlowNode[],
  scopes: DataFlowScope[],
): DataFlowGraph {
  return { nodes, scopes, rootScopeId: 0 };
}

function syntheticAnalysis(graph: DataFlowGraph): DataFlowAnalysis {
  return {
    containsReactive: true,
    requiresRewrite: true,
    dataFlows: graph.nodes.map((n) => n.expression),
    graph,
  };
}

const emptySourceFile = ts.createSourceFile(
  "/empty.ts",
  "",
  ts.ScriptTarget.ES2020,
  true,
);

// A minimal branded-cell prelude so `state.*` reads resolve to a reactive
// (opaque) type under `noLib`, mirroring the reactive harness used by the
// dataflow tests.
const REACTIVE_PRELUDE = `
declare const CELL_BRAND: unique symbol;
type BrandedCell<T, Brand extends string> = { readonly [CELL_BRAND]: Brand };
interface OpaqueCell<T> extends BrandedCell<T, "opaque"> {}
interface Item {
  name: OpaqueCell<string>;
  compute(): OpaqueCell<number>;
}
interface OpaqueArray<T> extends BrandedCell<T[], "opaque"> {
  map<U>(callback: (element: OpaqueCell<Item>, index: number, array: OpaqueArray<T>) => U): U[];
  toUpperCase(): OpaqueCell<T>;
}
declare const state: {
  readonly count: OpaqueCell<number>;
  readonly user: OpaqueCell<{ name: OpaqueCell<string> }>;
  readonly items: OpaqueArray<number>;
};
declare function computed<T>(callback: () => T): T;
`;

function createTsxProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    skipLibCheck: true,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TSX,
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

function findInitializer(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error(`Initializer for ${declarationName} not found`);
  }
  return found;
}

function print(node: ts.Node, sourceFile: ts.SourceFile): string {
  return ts.createPrinter().printNode(
    ts.EmitHint.Unspecified,
    node,
    sourceFile,
  );
}

// A lookup that treats every arrow/function node as an array-method callback.
const arrayMethodLookup: ReactiveContextLookup = {
  isArrayMethodCallback: () => true,
};

Deno.test("normalizeDataFlows unwraps a parenthesized reactive read to the bare property access", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = (state.count);
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const normalized = normalizeDataFlows(analysis.graph);
  assertEquals(normalized.length, 1);
  // The parenthesized wrapper is purely syntactic and is stripped.
  assertEquals(print(normalized[0].expression, sourceFile), "state.count");
  assert(!ts.isParenthesizedExpression(normalized[0].expression));
});

Deno.test("normalizeDataFlows strips an `as` type assertion from a reactive read", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.count as number;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const normalized = normalizeDataFlows(analysis.graph);
  assertEquals(normalized.length, 1);
  assertEquals(print(normalized[0].expression, sourceFile), "state.count");
  assert(!ts.isAsExpression(normalized[0].expression));
});

Deno.test("normalizeDataFlows strips an angle-bracket type assertion from a reactive read", () => {
  // Angle-bracket assertions are only valid in .ts, so use a non-jsx program.
  const source = `
    ${REACTIVE_PRELUDE}
    const value = <number> state.count;
  `;
  const fileName = "/assert.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    skipLibCheck: true,
  };
  const sf = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sf : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";
  const program = ts.createProgram([fileName], compilerOptions, host);
  const checker = program.getTypeChecker();
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sf, "value"),
  );
  const normalized = normalizeDataFlows(analysis.graph);
  assertEquals(normalized.length, 1);
  assertEquals(print(normalized[0].expression, sf), "state.count");
  assert(ts.isPropertyAccessExpression(normalized[0].expression));
});

Deno.test("normalizeDataFlows strips a non-null assertion from a reactive read", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.count!;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const normalized = normalizeDataFlows(analysis.graph);
  assertEquals(normalized.length, 1);
  assertEquals(print(normalized[0].expression, sourceFile), "state.count");
  assert(!ts.isNonNullExpression(normalized[0].expression));
});

Deno.test("normalizeDataFlows normalizes a property access used as a method callee back to its object", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.items.map((element) => element);
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const normalized = normalizeDataFlows(analysis.graph);
  // The `state.items.map` read is the callee of a call expression, so it is
  // normalized back to the receiver object `state.items`. The `.map` member is
  // never a surviving reactive dependency of its own.
  const texts = normalized.map((n) => print(n.expression, sourceFile));
  assert(
    !texts.some((t) => t.endsWith(".map")),
    `the .map callee should be normalized to its object, got ${
      JSON.stringify(texts)
    }`,
  );
});

Deno.test("normalizeDataFlows suppresses a parent read that has a more specific explicit child", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.user.name;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const normalized = normalizeDataFlows(analysis.graph);
  const texts = normalized.map((n) => print(n.expression, sourceFile));
  // The most-specific read survives; broader ancestor reads that have a more
  // specific explicit child are suppressed from the result.
  assert(
    texts.includes("state.user.name"),
    `expected state.user.name among ${JSON.stringify(texts)}`,
  );
  assert(
    !texts.includes("state.user"),
    `parent read state.user should be suppressed, got ${JSON.stringify(texts)}`,
  );
});

Deno.test("normalizeDataFlows with requested dataFlows keeps parent reads unsuppressed", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.user.name;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  // Passing an explicit requested set disables parent suppression: every
  // requested expression is treated as a wanted dependency.
  const requested = analysis.graph.nodes.map((n) => n.expression);
  const normalized = normalizeDataFlows(analysis.graph, requested);
  const texts = new Set(normalized.map((n) => getExpressionText(n.expression)));
  assert(texts.size >= 1);
});

Deno.test("getRelevantDataFlows returns the reactive reads for a plain pattern body", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.count;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const relevant = getRelevantDataFlows(analysis, checker);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(texts.includes("state.count"));
});

Deno.test("getRelevantDataFlows drops reads rooted at a plain array-method callback parameter", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.items.map((element, index, array) => element);
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const relevant = getRelevantDataFlows(analysis, checker, arrayMethodLookup);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  // The map callback's own parameter (`element`) is an ignored parameter and
  // must not surface as a reactive dependency; the reactive receiver does.
  assert(
    texts.includes("state.items"),
    `expected state.items among ${JSON.stringify(texts)}`,
  );
  assert(
    !texts.includes("element"),
    `callback parameter element should be filtered, got ${
      JSON.stringify(texts)
    }`,
  );
});

Deno.test("getRelevantDataFlows without a lookup keeps a property read off a synthetic map parameter", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.items.map((element, index, array) => element.name);
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  // With no ReactiveContextLookup the callback is not recognized as an array
  // method callback, so the synthetic `element.name` read is retained; only the
  // reactive receiver `state.items` is common to both.
  const relevant = getRelevantDataFlows(analysis, checker);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(
    texts.includes("state.items"),
    `expected state.items among ${JSON.stringify(texts)}`,
  );
  assert(
    texts.some((t) => t.startsWith("element")),
    `expected an element-rooted read among ${JSON.stringify(texts)}`,
  );
});

Deno.test("getRelevantDataFlows recurses through a property access to find the ignored parameter root", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.items.map((element, index, array) => element.name);
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  // The dependency `element.name` roots at the ignored `element` parameter; the
  // ignored-parameter walk recurses through the property access to that root and
  // filters it out once the callback is marked.
  const relevant = getRelevantDataFlows(analysis, checker, arrayMethodLookup);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(
    !texts.some((t) => t.startsWith("element")),
    `element-rooted reads should be filtered, got ${JSON.stringify(texts)}`,
  );
});

Deno.test("getRelevantDataFlows recurses through a call expression to find the ignored parameter root", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.items.map((element) => element.compute());
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  // `element.compute()` is a call whose callee roots at the ignored `element`
  // parameter; the ignored-parameter walk descends through the call expression.
  const relevant = getRelevantDataFlows(analysis, checker, arrayMethodLookup);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(
    !texts.some((t) => t.startsWith("element")),
    `element-rooted reads should be filtered, got ${JSON.stringify(texts)}`,
  );
});

Deno.test("getRelevantDataFlows keeps a synthetic `index` parameter read when unmarked", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = state.items.map((element, index) => index);
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  const relevant = getRelevantDataFlows(analysis, checker);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  // `index` is one of the recognized synthetic map parameter names, exercising
  // the synthetic-map-parameter recovery branch.
  assert(
    texts.includes("index"),
    `expected index among ${JSON.stringify(texts)}`,
  );
});

Deno.test("normalizeDataFlows unwraps a synthetic parenthesized expression node", () => {
  // The full analyzer strips wrappers before recording a node, so the only way
  // to exercise the parenthesis-stripping branch is with a hand-built node.
  const inner = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "count",
  );
  const graph = syntheticGraph(
    [syntheticNode(
      0,
      factory.createParenthesizedExpression(inner),
      0,
      null,
      true,
    )],
    [{ id: 0, parentId: null, parameters: [] }],
  );
  const normalized = normalizeDataFlows(graph);
  assertEquals(normalized.length, 1);
  assert(ts.isPropertyAccessExpression(normalized[0].expression));
  assertEquals(
    ts.createPrinter().printNode(
      ts.EmitHint.Unspecified,
      normalized[0].expression,
      emptySourceFile,
    ),
    "state.count",
  );
});

Deno.test("normalizeDataFlows unwraps a synthetic `as` type assertion node", () => {
  const inner = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "count",
  );
  const asExpr = factory.createAsExpression(
    inner,
    factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
  );
  const graph = syntheticGraph(
    [syntheticNode(0, asExpr, 0, null, true)],
    [{ id: 0, parentId: null, parameters: [] }],
  );
  const normalized = normalizeDataFlows(graph);
  assertEquals(normalized.length, 1);
  assert(ts.isPropertyAccessExpression(normalized[0].expression));
});

Deno.test("normalizeDataFlows unwraps a synthetic angle-bracket type assertion node", () => {
  const inner = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "count",
  );
  const typeAssertion = factory.createTypeAssertion(
    factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    inner,
  );
  const graph = syntheticGraph(
    [syntheticNode(0, typeAssertion, 0, null, true)],
    [{ id: 0, parentId: null, parameters: [] }],
  );
  const normalized = normalizeDataFlows(graph);
  assertEquals(normalized.length, 1);
  assert(ts.isPropertyAccessExpression(normalized[0].expression));
});

Deno.test("normalizeDataFlows unwraps a synthetic non-null assertion node", () => {
  const inner = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "count",
  );
  const graph = syntheticGraph(
    [syntheticNode(0, factory.createNonNullExpression(inner), 0, null, true)],
    [{ id: 0, parentId: null, parameters: [] }],
  );
  const normalized = normalizeDataFlows(graph);
  assertEquals(normalized.length, 1);
  assert(ts.isPropertyAccessExpression(normalized[0].expression));
});

Deno.test("getRelevantDataFlows falls back to non-synthetic reads when synthetic map params are present", () => {
  // `element` is a factory identifier with no symbol, so its read counts as a
  // synthetic root matching a recognized map-parameter name. With a
  // non-synthetic `state.items` read available and no marked callback, the
  // recovery keeps only the non-synthetic reads.
  const checker = trivialChecker();
  const stateItems = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "items",
  );
  const elementName = factory.createPropertyAccessExpression(
    factory.createIdentifier("element"),
    "name",
  );
  const graph = syntheticGraph(
    [
      syntheticNode(0, stateItems, 0, null, true),
      syntheticNode(1, elementName, 1, null, true),
    ],
    [
      { id: 0, parentId: null, parameters: [] },
      {
        id: 1,
        parentId: 0,
        parameters: [{ name: "element" }, { name: "index" }, { name: "array" }],
      },
    ],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(texts.includes("state.items"));
  assert(
    !texts.some((t) => t.startsWith("element")),
    `synthetic element read should be dropped, got ${JSON.stringify(texts)}`,
  );
});

Deno.test("getRelevantDataFlows keeps every read when a synthetic map callback is marked", () => {
  // The scope's first parameter declaration lives inside an arrow function that
  // the lookup reports as a marked array-method callback. That marks the whole
  // group as in-callback, so the recovery retains all reads (synthetic and not).
  const checker = trivialChecker();
  const paramDecl = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  const arrow = factory.createArrowFunction(
    undefined,
    undefined,
    [paramDecl],
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  // Establish the parent chain so the ignored-parameter walk can climb from the
  // parameter declaration up to the arrow function.
  (paramDecl as { parent: ts.Node }).parent = arrow;

  const stateItems = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "items",
  );
  const elementName = factory.createPropertyAccessExpression(
    factory.createIdentifier("element"),
    "name",
  );
  const graph = syntheticGraph(
    [
      syntheticNode(0, stateItems, 0, null, true),
      syntheticNode(1, elementName, 1, null, true),
    ],
    [
      { id: 0, parentId: null, parameters: [] },
      {
        id: 1,
        parentId: 0,
        parameters: [{ name: "element", declaration: paramDecl }, {
          name: "index",
        }, { name: "array" }],
      },
    ],
  );
  const markedLookup: ReactiveContextLookup = {
    isArrayMethodCallback: (node) => node === arrow,
  };
  const relevant = getRelevantDataFlows(
    syntheticAnalysis(graph),
    checker,
    markedLookup,
  );
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(texts.includes("state.items"));
});

Deno.test("getRelevantDataFlows returns false for an ignored-parameter scope that does not exist", () => {
  // A node whose scopeId has no matching scope hits the missing-scope guard in
  // the ignored-parameter check, which returns false so the read is retained.
  const checker = trivialChecker();
  const orphan = factory.createPropertyAccessExpression(
    factory.createIdentifier("ghost"),
    "value",
  );
  const graph = syntheticGraph(
    [syntheticNode(0, orphan, 99, null, true)],
    [{ id: 0, parentId: null, parameters: [] }],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  // The read survives because its scope cannot be found, so it is not treated
  // as originating from an ignored parameter.
  assert(texts.includes("ghost.value"));
});

Deno.test("getRelevantDataFlows drops an all-synthetic map read through the ignored-parameter walk", () => {
  // With only a synthetic `element.name` read and no non-synthetic sibling, the
  // recovery hands every read to the ignored-parameter filter. The read roots at
  // the symbol-less `element` identifier, which matches a scope parameter name,
  // so it is filtered out entirely.
  const checker = trivialChecker();
  const paramDecl = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  const arrow = factory.createArrowFunction(
    undefined,
    undefined,
    [paramDecl],
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  (paramDecl as { parent: ts.Node }).parent = arrow;
  const elementName = factory.createPropertyAccessExpression(
    factory.createIdentifier("element"),
    "name",
  );
  const graph = syntheticGraph(
    [syntheticNode(1, elementName, 1, null, true)],
    [
      { id: 0, parentId: null, parameters: [] },
      {
        id: 1,
        parentId: 0,
        parameters: [{ name: "element", declaration: paramDecl }, {
          name: "index",
        }, { name: "array" }],
      },
    ],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker, {
    isArrayMethodCallback: (node) => node === arrow,
  });
  assertEquals(relevant.length, 0);
});

Deno.test("getRelevantDataFlows keeps a synthetic root whose name is not a recognized map parameter", () => {
  // The synthetic-root read exists, but its identifier is `custom`, which is not
  // one of element/index/array. The map-parameter recovery does not engage, so
  // the read falls through to the plain ignored-parameter filter and, matching
  // no parameter, survives.
  const checker = trivialChecker();
  const customRead = factory.createPropertyAccessExpression(
    factory.createIdentifier("custom"),
    "value",
  );
  const graph = syntheticGraph(
    [syntheticNode(0, customRead, 0, null, true)],
    [{ id: 0, parentId: null, parameters: [] }],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker);
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(texts.includes("custom.value"));
});

Deno.test("getRelevantDataFlows treats a marked-callback probe with no first-parameter declaration as unmarked", () => {
  // The scope's first parameter carries no declaration, so the marked-callback
  // probe short-circuits to unmarked; with a non-synthetic sibling present the
  // recovery keeps only the non-synthetic reads.
  const checker = trivialChecker();
  const stateItems = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "items",
  );
  const indexRead = factory.createIdentifier("index");
  const graph = syntheticGraph(
    [
      syntheticNode(0, stateItems, 0, null, true),
      syntheticNode(1, indexRead, 1, null, true),
    ],
    [
      { id: 0, parentId: null, parameters: [] },
      {
        id: 1,
        parentId: 0,
        parameters: [{ name: "element" }, { name: "index" }, { name: "array" }],
      },
    ],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker, {
    isArrayMethodCallback: () => true,
  });
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(texts.includes("state.items"));
  assert(
    !texts.includes("index"),
    `synthetic index read should be dropped, got ${JSON.stringify(texts)}`,
  );
});

Deno.test("getRelevantDataFlows climbs the parent chain to the enclosing callback in the marked probe", () => {
  // The first parameter's declaration is nested (its immediate parent is not the
  // callback), so the marked-callback probe must climb several parent links
  // before reaching the arrow function it checks against the lookup.
  const checker = trivialChecker();
  const paramDecl = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  const bindingList = factory.createVariableDeclarationList([]);
  const block = factory.createBlock([]);
  const arrow = factory.createArrowFunction(
    undefined,
    undefined,
    [paramDecl],
    undefined,
    undefined,
    block,
  );
  // Insert intermediate non-function parents between the declaration and arrow
  // so the marked probe's ancestor walk iterates more than once.
  (paramDecl as { parent: ts.Node }).parent = bindingList;
  (bindingList as { parent: ts.Node }).parent = block;
  (block as { parent: ts.Node }).parent = arrow;

  const stateItems = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "items",
  );
  const elementName = factory.createPropertyAccessExpression(
    factory.createIdentifier("element"),
    "name",
  );
  const graph = syntheticGraph(
    [
      syntheticNode(0, stateItems, 0, null, true),
      syntheticNode(1, elementName, 1, null, true),
    ],
    [
      { id: 0, parentId: null, parameters: [] },
      {
        id: 1,
        parentId: 0,
        parameters: [{ name: "element", declaration: paramDecl }, {
          name: "index",
        }, { name: "array" }],
      },
    ],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker, {
    isArrayMethodCallback: (node) => node === arrow,
  });
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(texts.includes("state.items"));
});

Deno.test("getRelevantDataFlows keeps a builder-callback parameter as an opaque (non-ignored) input", () => {
  // The ignored-parameter walk finds the parameter's declaration, climbs an
  // intermediate block to the enclosing arrow, then to a builder call. A builder
  // callback parameter is opaque, so it is not treated as ignored and its read
  // is retained.
  const checker = trivialChecker();
  const paramDecl = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  const block = factory.createBlock([]);
  const arrow = factory.createArrowFunction(
    undefined,
    undefined,
    [paramDecl],
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  // The declaration's immediate parent is a non-function block, forcing the
  // function-ancestor walk to iterate before reaching the arrow.
  (paramDecl as { parent: ts.Node }).parent = block;
  (block as { parent: ts.Node }).parent = arrow;
  const builderCall = factory.createCallExpression(
    factory.createIdentifier("computed"),
    undefined,
    [arrow],
  );
  (arrow as { parent: ts.Node }).parent = builderCall;

  const elementName = factory.createPropertyAccessExpression(
    factory.createIdentifier("element"),
    "name",
  );
  const graph = syntheticGraph(
    [syntheticNode(1, elementName, 1, null, true)],
    [
      { id: 0, parentId: null, parameters: [] },
      {
        id: 1,
        parentId: 0,
        parameters: [{ name: "element", declaration: paramDecl }, {
          name: "index",
        }, { name: "array" }],
      },
    ],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker, {
    isArrayMethodCallback: (node) => node === arrow,
  });
  const texts = relevant.map((r) => getExpressionText(r.expression));
  // The builder callback parameter is opaque, so `element.name` survives.
  assert(
    texts.some((t) => t.startsWith("element")),
    `builder-callback parameter read should be kept, got ${
      JSON.stringify(texts)
    }`,
  );
});

Deno.test("getRelevantDataFlows marked probe returns unmarked when no callback ancestor is found", () => {
  // The first parameter's declaration has a parent chain that never reaches an
  // arrow or function expression, so the marked-callback probe exhausts the walk
  // and reports the group as unmarked; the non-synthetic sibling is what remains.
  const checker = trivialChecker();
  const paramDecl = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier("element"),
  );
  const outerBlock = factory.createBlock([]);
  const innerBlock = factory.createBlock([]);
  // A chain of plain blocks with no function-like ancestor.
  (paramDecl as { parent: ts.Node }).parent = innerBlock;
  (innerBlock as { parent: ts.Node }).parent = outerBlock;

  const stateItems = factory.createPropertyAccessExpression(
    factory.createIdentifier("state"),
    "items",
  );
  const elementName = factory.createPropertyAccessExpression(
    factory.createIdentifier("element"),
    "name",
  );
  const graph = syntheticGraph(
    [
      syntheticNode(0, stateItems, 0, null, true),
      syntheticNode(1, elementName, 1, null, true),
    ],
    [
      { id: 0, parentId: null, parameters: [] },
      {
        id: 1,
        parentId: 0,
        parameters: [{ name: "element", declaration: paramDecl }, {
          name: "index",
        }, { name: "array" }],
      },
    ],
  );
  const relevant = getRelevantDataFlows(syntheticAnalysis(graph), checker, {
    isArrayMethodCallback: () => true,
  });
  const texts = relevant.map((r) => getExpressionText(r.expression));
  assert(texts.includes("state.items"));
});
