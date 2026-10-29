import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import { StaticCache } from "@commonfabric/static";

import { TransformationContext } from "../src/core/context.ts";
import { transformCfDirective } from "../src/mod.ts";
import { emitCallExpression } from "../src/transformers/expression-rewrite/emitters/call-expression.ts";
import type { EmitterContext } from "../src/transformers/expression-rewrite/types.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// The call-expression emitter's early "no reactive data flows" guard and its
// zero-arg-IIFE receiver scan run only while a pattern compiles cold through the
// transformer in CI. When the pattern jobs' compile cache is warm the
// compilation is skipped, so these lines alternate between covered and uncovered
// across runs of identical code and destabilize the coverage-debt gate. These
// tests drive the emitter directly with a real TransformationContext and assert
// on the node it returns.

const cache = StaticCache.fromFileSystem();
const es2023 = await cache.getText("types/es2023.d.ts");
const dom = await cache.getText("types/dom.d.ts");
const jsx = await cache.getText("types/jsx.d.ts");

function buildProgram(
  source: string,
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const fileName = "/test.tsx";
  const files: Record<string, string> = {
    [fileName]: transformCfDirective(source),
    "commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"],
    "cfc.ts": COMMONFABRIC_TYPES["cfc.ts"],
    "es2023.d.ts": es2023,
    "dom.d.ts": dom,
    "jsx.d.ts": jsx,
  };
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "__cfHelpers.h",
    jsxFragmentFactory: "__cfHelpers.h.fragment",
    strict: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name) =>
      files[name]
        ? ts.createSourceFile(name, files[name], compilerOptions.target!, true)
        : undefined,
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => !!files[name],
    readFile: (name) => files[name],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "es2023.d.ts",
    resolveModuleNames: (names) =>
      names.map((name) =>
        name === "commonfabric"
          ? {
            resolvedFileName: "commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          }
          : undefined
      ),
  };
  const program = ts.createProgram(Object.keys(files), compilerOptions, host);
  return { program, sourceFile: program.getSourceFile(fileName)! };
}

function withContext<T>(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  body: (context: TransformationContext) => T,
): T {
  let out!: T;
  ts.transform(sourceFile, [
    (tsContext) => (root) => {
      out = body(new TransformationContext({ program, sourceFile, tsContext }));
      return root;
    },
  ]);
  return out;
}

function find<T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T,
  predicate: (node: T) => boolean = () => true,
): T {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && guard(node) && predicate(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error("no matching node");
  return found;
}

// Build the emitter context for `expression` using the real data-flow analyzer,
// so `dataFlows` reflects the expression's actual reactive dependencies.
function emitterContextFor(
  expression: ts.Expression,
  context: TransformationContext,
): { emit: EmitterContext; dataFlowCount: number } {
  const analyze = context.getDataFlowAnalyzer();
  const analysis = analyze(expression);
  const dataFlows = context.getRelevantDataFlowsFromAnalysis(analysis);
  const emit = {
    expression,
    analysis,
    context,
    analyze,
    dataFlows,
    inSafeContext: false,
    reactiveContextKind: "pattern",
    preferInputBoundWrappers: false,
    rewriteChildren: (node: ts.Expression) => node,
    rewriteSubexpression: (node: ts.Expression) => node,
  } as unknown as EmitterContext;
  return { emit, dataFlowCount: dataFlows.length };
}

const HEAD = `/// <cts-enable />
import { Cell, pattern, UI, VNode } from "commonfabric";
interface Input { base: Cell<number>; }
interface Output { [UI]: VNode; }
`;

Deno.test("emitCallExpression declines a call with no reactive data flows", () => {
  // A plain call to a non-reactive local function has no reactive dependencies,
  // so the emitter's `dataFlows.length === 0` guard fires and it emits nothing.
  const { program, sourceFile } = buildProgram(`${HEAD}
const plus = (a: number, b: number) => a + b;
export default pattern<Input, Output>(() => ({
  [UI]: <div>{plus(1, 2)}</div>,
}));`);
  const call = find(
    sourceFile,
    ts.isCallExpression,
    (node) =>
      ts.isIdentifier(node.expression) && node.expression.text === "plus",
  );

  const { result, dataFlowCount } = withContext(
    program,
    sourceFile,
    (context) => {
      const { emit, dataFlowCount } = emitterContextFor(call, context);
      return { result: emitCallExpression(emit), dataFlowCount };
    },
  );

  assertEquals(dataFlowCount, 0);
  assertEquals(result, undefined);
});

Deno.test("emitCallExpression scans a zero-arg IIFE for captured cell reads and wraps it", () => {
  // A zero-arg inline IIFE reading a captured pattern-input cell via a bare
  // identifier (`base.get()`) reaches the IIFE receiver scan. That scan walks the
  // IIFE body, finds the `.get()` on the identifier `base`, and asks whether
  // `base` is declared inside the IIFE — it is not (it is a pattern input), so
  // the receiver is treated as an outer reactive dependency and the emitter
  // rewrites the IIFE into a reactive wrapper call rather than leaving it as an
  // immediately-invoked function.
  const { program, sourceFile } = buildProgram(`${HEAD}
export default pattern<Input, Output>(({ base }) => ({
  [UI]: <div>{(() => base.get() + 1)()}</div>,
}));`);
  const iife = find(
    sourceFile,
    ts.isCallExpression,
    (node) =>
      ts.isParenthesizedExpression(node.expression) &&
      ts.isArrowFunction(node.expression.expression) &&
      node.arguments.length === 0,
  );

  const { result, dataFlowCount } = withContext(
    program,
    sourceFile,
    (context) => {
      const { emit, dataFlowCount } = emitterContextFor(iife, context);
      return { result: emitCallExpression(emit), dataFlowCount };
    },
  );

  // The captured `base` read is a reactive dependency, so the emitter did not
  // decline.
  assertEquals(dataFlowCount, 1);
  assert(result !== undefined, "expected the IIFE to be rewritten");
  // The authored IIFE was replaced by a call (the reactive wrapper), not left as
  // the original immediately-invoked function.
  assert(ts.isCallExpression(result!), "expected a wrapper call expression");
  assert(result !== iife, "expected a new node, not the original IIFE");
});
