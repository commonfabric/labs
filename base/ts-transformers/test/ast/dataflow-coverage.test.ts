import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/dataflow.ts";

// Branded-cell prelude so `state.*` reads resolve to a reactive (opaque) type
// under `noLib`, mirroring the reactive harness prelude in dataflow.test.ts.
const REACTIVE_PRELUDE = `
declare const CELL_BRAND: unique symbol;
type BrandedCell<T, Brand extends string> = { readonly [CELL_BRAND]: Brand };
interface OpaqueCell<T> extends BrandedCell<T, "opaque"> {}
declare function pattern<I, O>(cb: (x: I) => O): O;
declare const state: {
  readonly count: OpaqueCell<number>;
  readonly nested: { readonly inner: OpaqueCell<number> };
  readonly items: OpaqueCell<number[]>;
};
declare const pair: readonly [OpaqueCell<number>, number];
declare const props: OpaqueCell<{ title: string }>;
declare const idx: number;
`;

// A second source file named commonfabric.d.ts lets `symbolDeclaresCommon
// FabricDefault` recognize `Default<>` (its declarations live in a file whose
// basename is commonfabric.d.ts).
const COMMONFABRIC_DTS = `
export type Default<T, V> = T;
`;

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

function createProgramWithCommonFabric(main: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const files: Record<string, string> = {
    "/commonfabric.d.ts": COMMONFABRIC_DTS,
    "/main.ts": main,
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host: ts.CompilerHost = {
    fileExists: (n) => files[n] !== undefined,
    readFile: (n) => files[n],
    getSourceFile: (n, lv) =>
      files[n] !== undefined
        ? ts.createSourceFile(n, files[n]!, lv, true, ts.ScriptKind.TS)
        : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: () => true,
    resolveModuleNames: (names) =>
      names.map((name) =>
        name === "commonfabric"
          ? {
            resolvedFileName: "/commonfabric.d.ts",
            extension: ts.Extension.Dts,
          }
          : undefined
      ),
  };
  const program = ts.createProgram(
    ["/main.ts", "/commonfabric.d.ts"],
    options,
    host,
  );
  return {
    sourceFile: program.getSourceFile("/main.ts")!,
    checker: program.getTypeChecker(),
  };
}

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

function findFirst<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  pred: (n: ts.Node) => n is T,
  text?: string,
): T {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      pred(node) && (text === undefined || node.getText(sourceFile) === text)
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Node not found: ${text ?? "<pred>"}`);
  return found;
}

function analyze(source: string, name: string) {
  const { sourceFile, checker } = createProgram(
    `${REACTIVE_PRELUDE}\n${source}`,
  );
  return createDataFlowAnalyzer(checker)(findInitializer(sourceFile, name));
}

function analyzeTsx(source: string, name: string) {
  const { sourceFile, checker } = createTsxProgram(
    `${REACTIVE_PRELUDE}\n${source}`,
  );
  return createDataFlowAnalyzer(checker)(findInitializer(sourceFile, name));
}

//
// Structural wrappers around a reactive read (1084-1098)
//

Deno.test("parenthesized reactive read stays reactive", () => {
  const analysis = analyze(`const value = (state.count);`, "value");
  assert(analysis.containsReactive);
});

Deno.test("as-expression around a reactive read stays reactive", () => {
  const analysis = analyze(
    `const value = state.count as OpaqueCell<number>;`,
    "value",
  );
  assert(analysis.containsReactive);
});

Deno.test("angle-bracket type assertion around a reactive read stays reactive", () => {
  // Type assertions (<T>expr) only parse in .ts; pins the TypeAssertionExpression
  // handler (lines 1092-1094).
  const analysis = analyze(
    `const value = <OpaqueCell<number>> state.count;`,
    "value",
  );
  assert(analysis.containsReactive, "type-assertion-wrapped read is reactive");
});

Deno.test("non-null assertion around a reactive read stays reactive", () => {
  const analysis = analyze(`const value = state.count!;`, "value");
  assert(analysis.containsReactive);
});

//
// Common Fabric Default types (790-797, 924-935)
//

Deno.test("identifier typed as a Common Fabric Default is a reactive dataflow", () => {
  // The identifier's symbol declares Default<>, so it records as an explicit
  // reactive dependency (lines 790-797).
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Default } from "commonfabric";
    declare const withDefault: Default<number, 0>;
    const value = withDefault;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assert(analysis.containsReactive, "Default-typed identifier is reactive");
  assertEquals(analysis.requiresRewrite, false);
  assertEquals(analysis.dataFlows.length, 1);
});

Deno.test("property access whose member is a Common Fabric Default requires rewrite", () => {
  // The property member symbol declares Default<>, so the property access is a
  // reactive dependency flagged for rewrite (lines 924-935).
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Default } from "commonfabric";
    declare const holder: { readonly value: Default<number, 0> };
    const value = holder.value;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assert(analysis.containsReactive, "Default-typed member is reactive");
  assertEquals(analysis.requiresRewrite, true);
});

//
// Const-binding aliases resolved through a static access path
// (224-304)
//
// These destructure a field off an implicit reactive parameter (`p`), giving
// the alias a PLAIN field type (e.g. `number`). A plain type skips the
// branded-cell short-circuit in the identifier handler and forces resolution
// through getStableConstAliasInitializer -> getBindingElementStaticAccessPath,
// which rebuilds the read as `p.<field>` and re-analyzes it as reactive.
//

function analyzePatternArrow(callbackSource: string) {
  const { sourceFile, checker } = createProgram(
    `${REACTIVE_PRELUDE}\nconst r = pattern(${callbackSource});`,
  );
  const arrow = findFirst(sourceFile, ts.isArrowFunction);
  return createDataFlowAnalyzer(checker)(arrow);
}

Deno.test("destructured alias with a renamed key resolves reactive", () => {
  // `{ count: renamed }` builds a "property" segment from the propertyName
  // identifier (lines 234-236) and resolves back to the reactive parameter.
  const analysis = analyzePatternArrow(
    `(p: { count: number }) => { const { count: renamed } = p; return renamed; }`,
  );
  assert(analysis.containsReactive, "renamed binding alias is reactive");
});

Deno.test("destructured alias with a string-literal key resolves reactive", () => {
  // A quoted property name is not an identifier, so getObjectBindingAccessSegment
  // falls to getStaticPropertyNameText's string-literal branch (238-241, 253-259).
  const analysis = analyzePatternArrow(
    `(p: { count: number }) => { const { "count": renamed } = p; return renamed; }`,
  );
  assert(analysis.containsReactive, "string-key binding alias is reactive");
});

Deno.test("destructured alias with a numeric-literal key resolves reactive", () => {
  // A numeric property name exercises getStaticPropertyNameText's numeric-literal
  // branch (255-256) inside the propertyName path.
  const analysis = analyzePatternArrow(
    `(p: { 0: number }) => { const { 0: renamed } = p; return renamed; }`,
  );
  assert(analysis.containsReactive, "numeric-key binding alias is reactive");
});

Deno.test("shorthand destructured alias resolves reactive", () => {
  // Shorthand binding (no propertyName) builds a "property" segment from the
  // element name (lines 227-230).
  const analysis = analyzePatternArrow(
    `(p: { count: number }) => { const { count } = p; return count; }`,
  );
  assert(analysis.containsReactive, "shorthand binding alias is reactive");
});

Deno.test("array-destructured alias resolves reactive through an index segment", () => {
  // Array binding element contributes an index segment (284-290) and the built
  // element-access resolves back to the reactive parameter.
  const analysis = analyzePatternArrow(
    `(p: number[]) => { const [first] = p; return first; }`,
  );
  assert(analysis.containsReactive, "array-destructured alias is reactive");
});

Deno.test("nested destructuring resolves reactive through the whole path", () => {
  // Nested binding elements take the owner-is-BindingElement continue branch
  // (296-299) building a multi-segment static path (`p.nested.inner`).
  const analysis = analyzePatternArrow(
    `(p: { nested: { inner: number } }) => { const { nested: { inner } } = p; return inner; }`,
  );
  assert(analysis.containsReactive, "nested binding alias is reactive");
});

//
// Element access (1044-1082)
//

Deno.test("static string-index element access on a reactive cell is reactive", () => {
  // Static literal index merges target+argument (lines 1052-1057) and stays
  // reactive because the receiver `state.items` is a reactive cell.
  const analysis = analyze(`const value = state.items["0"];`, "value");
  assert(analysis.containsReactive, "static index on reactive stays reactive");
});

Deno.test("dynamic element access on a reactive property requires rewrite", () => {
  // Dynamic index falls to the general element-access return (1076-1081):
  // requiresRewrite is forced true and the receiver's dataflows propagate.
  const analysis = analyze(`const value = state.items[idx];`, "value");
  assert(analysis.containsReactive, "reactive dynamic index is reactive");
  assertEquals(analysis.requiresRewrite, true);
  assert(analysis.dataFlows.length > 0);
});

Deno.test("dynamic element access on an ignored branded parameter is inert", () => {
  // `env[idx]` where `env` is a branded but ignored parameter: the receiver is
  // reactive by type yet analyzes to no dataflows, so the reactive-element-
  // access branch fires and its originatesFromIgnored guard returns empty
  // (lines 1059-1064).
  const analysis = analyzeArrow(
    `const f = (env: OpaqueCell<number[]>) => env[idx];`,
  );
  assertEquals(
    analysis.containsReactive,
    false,
    "element access through an ignored branded parameter is inert",
  );
  assertEquals(analysis.dataFlows.length, 0);
});

//
// Array-literal reactive elements (1258-1265)
//

Deno.test("array literal with a reactive element carries reactive dataflow", () => {
  const analysis = analyze(`const value = [state.count];`, "value");
  assert(analysis.containsReactive, "reactive array element flows");
});

//
// Synthetic property access whose root is not an identifier (696-697)
//

Deno.test("synthetic property access rooted in an object literal is inert", () => {
  // `({}).bar` built synthetically: findRootIdentifier bottoms out on a
  // non-identifier (the object literal) and returns undefined (lines 696-697),
  // so nothing is recorded.
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const synthetic = ts.factory.createPropertyAccessExpression(
    ts.factory.createObjectLiteralExpression([]),
    "bar",
  );
  const analysis = createDataFlowAnalyzer(checker)(synthetic);
  assertEquals(analysis.containsReactive, false);
  assertEquals(analysis.dataFlows.length, 0);
});

//
// Reads whose root originates from an ignored (aggregated) scope
// parameter (876-878, 973-975)
//
// A parameter of a plain (non-builder, non-array-method) callback is an
// aggregated scope symbol that is NOT a reactive value, so `isSymbolIgnored`
// treats reads through it as inert. When the read still looks reactive by
// type/shape, the `originatesFromIgnored` guard short-circuits it to empty.
//

function analyzeArrow(source: string) {
  const { sourceFile, checker } = createProgram(
    `${REACTIVE_PRELUDE}\n${source}`,
  );
  const arrow = findFirst(sourceFile, ts.isArrowFunction);
  return createDataFlowAnalyzer(checker)(arrow);
}

Deno.test("branded property off an ignored parameter is not a reactive dependency", () => {
  // `env.cell` is branded, but `env` is an ignored aggregated parameter, so the
  // branded-property branch's originatesFromIgnored guard returns empty
  // (lines 876-878).
  const analysis = analyzeArrow(
    `const f = (env: { cell: OpaqueCell<number> }) => env.cell;`,
  );
  assertEquals(
    analysis.containsReactive,
    false,
    "branded read through an ignored parameter is inert",
  );
  assertEquals(analysis.dataFlows.length, 0);
});

Deno.test("Common Fabric Default member off an ignored parameter is inert", () => {
  // `env.value` member declares Default<>, but `env` is an ignored parameter,
  // so the common-fabric-default branch's originatesFromIgnored guard returns
  // empty (lines 925-927).
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Default } from "commonfabric";
    const f = (env: { value: Default<number, 0> }) => env.value;
  `);
  const arrow = findFirst(sourceFile, ts.isArrowFunction);
  const analysis = createDataFlowAnalyzer(checker)(arrow);
  assertEquals(
    analysis.containsReactive,
    false,
    "Default member through an ignored parameter is inert",
  );
});

Deno.test("structurally-opaque read off an ignored Default parameter is inert", () => {
  // `d.foo` where `d` is typed as a Common Fabric Default is structurally
  // opaque (isStructuralOpaqueTargetExpression true via the Default root), but
  // `d` is an ignored parameter, so the structural-opaque branch's
  // originatesFromIgnored guard returns empty (lines 973-975).
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Default } from "commonfabric";
    const f = (d: Default<{ foo: number }, {}>) => d.foo;
  `);
  const arrow = findFirst(sourceFile, ts.isArrowFunction);
  const analysis = createDataFlowAnalyzer(checker)(arrow);
  assertEquals(
    analysis.containsReactive,
    false,
    "structural-opaque read through an ignored parameter is inert",
  );
});

//
// JSX attributes, spreads, children (1263-1264, 1292-1295)
//

Deno.test("JSX attribute expression carries reactive dataflow", () => {
  const analysis = analyzeTsx(
    `const value = <div title={state.count} />;`,
    "value",
  );
  assert(analysis.containsReactive, "attribute expr dataflow is reactive");
});

Deno.test("JSX spread attribute carries reactive dataflow", () => {
  const analysis = analyzeTsx(`const value = <div {...props} />;`, "value");
  assert(analysis.containsReactive, "spread attribute dataflow is reactive");
});

Deno.test("JSX element children with a nested element carry reactive dataflow", () => {
  const analysis = analyzeTsx(
    `const value = <div><span>{state.count}</span></div>;`,
    "value",
  );
  assert(analysis.containsReactive, "nested child dataflow is reactive");
});

//
// Function-argument callback with a block body (1180-1189, 1231-1240)
//

Deno.test("call-argument callback block return propagates reactive dataflow", () => {
  // A callback argument with a block body has its return-statement expressions
  // analyzed in a child scope (lines 1180-1189).
  const analysis = analyze(
    `declare function run<T>(cb: () => T): T;
     const value = run(() => { return state.count; });`,
    "value",
  );
  assert(analysis.containsReactive, "block-return dataflow is reactive");
});

Deno.test("standalone arrow with a block body propagates reactive dataflow", () => {
  // A function-like expression (not a call argument) with a block body walks
  // its return statements in a child scope (lines 1231-1240).
  const { sourceFile, checker } = createProgram(
    `${REACTIVE_PRELUDE}\nconst value = () => { return state.count; };`,
  );
  const arrow = findFirst(sourceFile, ts.isArrowFunction);
  const analysis = createDataFlowAnalyzer(checker)(arrow);
  assert(analysis.containsReactive, "arrow block-return dataflow is reactive");
});

//
// Synthetic (transformer-created) node handling (683-697, 749-751,
// 1004-1032)
//

Deno.test("synthetic bare identifier is treated as an opaque reactive parameter", () => {
  // A fully-synthetic identifier with no resolvable symbol is recorded as an
  // opaque parameter dataflow (lines 745, 753-758).
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const synthetic = ts.factory.createIdentifier("discount");
  const analysis = createDataFlowAnalyzer(checker)(synthetic);
  assert(analysis.containsReactive, "synthetic opaque parameter is reactive");
  assertEquals(analysis.requiresRewrite, false);
  assertEquals(analysis.dataFlows.length, 1);
});

Deno.test("synthetic identifier matching a synthetic local parameter is inert", () => {
  // A synthetic arrow whose parameter has no resolvable symbol makes reads of
  // that name a scope-local reference, not a reactive dependency (lines
  // 746-751).
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const f = ts.factory;
  const param = f.createParameterDeclaration(
    undefined,
    undefined,
    f.createIdentifier("element"),
  );
  const arrow = f.createArrowFunction(
    undefined,
    undefined,
    [param],
    undefined,
    undefined,
    f.createIdentifier("element"),
  );
  const analysis = createDataFlowAnalyzer(checker)(arrow);
  assertEquals(
    analysis.containsReactive,
    false,
    "synthetic local parameter read is inert",
  );
  assertEquals(analysis.dataFlows.length, 0);
});

Deno.test("synthetic __cfHelpers property access passes through without a new dataflow", () => {
  // A synthetic `__cfHelpers.toSchema` access whose root is undefined is
  // treated as a helper: it passes the target's analysis through instead of
  // recording the access itself as an opaque read (lines 1007-1013). The only
  // recorded dataflow is the synthetic `__cfHelpers` root, not the access.
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const root = ts.factory.createIdentifier("__cfHelpers");
  const synthetic = ts.factory.createPropertyAccessExpression(root, "toSchema");
  const analysis = createDataFlowAnalyzer(checker)(synthetic);
  assertEquals(
    analysis.dataFlows.some((d) => d === synthetic),
    false,
    "the __cfHelpers access is not recorded as its own dataflow",
  );
});

Deno.test("synthetic method call on an opaque root is skipped, not recorded", () => {
  // `element.trim()` where `element` is synthetic and unresolved: the property
  // access is a method call, so it is skipped rather than recorded (1016-1022).
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const f = ts.factory;
  const access = f.createPropertyAccessExpression(
    f.createIdentifier("element"),
    "trim",
  );
  const call = f.createCallExpression(access, undefined, []);
  const analysis = createDataFlowAnalyzer(checker)(call);
  // The inner method-access is skipped: no dataflow is recorded for it.
  assertEquals(
    analysis.dataFlows.some((d) => d === access),
    false,
    "method-access is not recorded as a dataflow",
  );
});

Deno.test("synthetic property access on an opaque root is recorded as reactive", () => {
  // `element.price` where `element` is synthetic and unresolved is treated as
  // an opaque property read (lines 1024-1032).
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const synthetic = ts.factory.createPropertyAccessExpression(
    ts.factory.createIdentifier("element"),
    "price",
  );
  const analysis = createDataFlowAnalyzer(checker)(synthetic);
  assert(analysis.containsReactive, "opaque property read is reactive");
  assertEquals(analysis.requiresRewrite, true);
  assertEquals(analysis.dataFlows.length, 1);
});

Deno.test("synthetic wrapped property access unwraps to its opaque root", () => {
  // `(element)!.price` built synthetically: findRootIdentifier unwraps the
  // parenthesized/non-null wrappers to reach `element` (lines 683-691), then
  // the read is recorded as opaque.
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const f = ts.factory;
  const wrapped = f.createNonNullExpression(
    f.createParenthesizedExpression(f.createIdentifier("element")),
  );
  const synthetic = f.createPropertyAccessExpression(wrapped, "price");
  const analysis = createDataFlowAnalyzer(checker)(synthetic);
  assert(analysis.containsReactive, "wrapped opaque property read is reactive");
  assertEquals(analysis.requiresRewrite, true);
});

Deno.test("synthetic element access unwraps through findRootIdentifier", () => {
  // `element[0].price` built synthetically: findRootIdentifier descends the
  // element-access receiver (lines 679-682) to reach the opaque `element` root.
  const { checker } = createProgram(REACTIVE_PRELUDE);
  const f = ts.factory;
  const elem = f.createElementAccessExpression(
    f.createIdentifier("element"),
    f.createNumericLiteral("0"),
  );
  const synthetic = f.createPropertyAccessExpression(elem, "price");
  const analysis = createDataFlowAnalyzer(checker)(synthetic);
  assert(analysis.containsReactive, "element-access-rooted read is reactive");
});
