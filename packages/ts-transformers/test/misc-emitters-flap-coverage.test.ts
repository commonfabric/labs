import { assert, assertEquals } from "@std/assert";

import { StaticCache } from "@commonfabric/static";
import ts from "typescript";

import { unwrapOpaqueLikeType } from "../src/ast/type-inference.ts";
import { shouldTransformArrayMethod } from "../src/closures/strategies/array-method-policy.ts";
import { TransformationContext } from "../src/core/context.ts";
import { transformCfDirective } from "../src/mod.ts";
import { emitElementAccessExpression } from "../src/transformers/expression-rewrite/emitters/element-access-expression.ts";
import type { EmitterContext } from "../src/transformers/expression-rewrite/types.ts";
import { findPreferredNestedLowerableExpressionSite } from "../src/transformers/expression-site-policy.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// Each branch exercised here otherwise runs only while a pattern compiles cold
// through the transformer in CI's pattern-integration jobs. When that pipeline's
// compile-cache is warm the branch is skipped, so it flips between covered and
// uncovered across CI runs of identical code and destabilizes the coverage-debt
// gate. These tests drive each branch directly through the exported entry point
// that reaches it, so it is recorded every run. Each test asserts on the real
// value the branch produces (a decision, a returned node/undefined, a resolved
// type, or a diagnostic-free classification), not merely that the line ran.

const cache = StaticCache.fromFileSystem();
const es2023 = await cache.getText("types/es2023.d.ts");
const dom = await cache.getText("types/dom.d.ts");
const jsx = await cache.getText("types/jsx.d.ts");

/** A TypeScript program that resolves the real `commonfabric` type surface. */
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

/**
 * Run `body` with a real TransformationContext for `sourceFile`. The context is
 * only valid inside a `ts.transform` factory, so the body runs there and its
 * return value is forwarded out.
 */
function withContext<T>(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  body: (context: TransformationContext) => T,
): T {
  let out!: T;
  ts.transform(sourceFile, [
    (tsContext) => (root) => {
      out = body(
        new TransformationContext({ program, sourceFile, tsContext }),
      );
      return root;
    },
  ]);
  return out;
}

/** First descendant matching a type guard. */
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

function unwrapParens(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

//
// closures/strategies/array-method-policy.ts:54-56
//
// `isReactiveFallbackLeft` recognizes a `(<reactive> ?? []).map(...)` receiver
// whose left operand is directly a reactive value. In a compute context the
// collection-provenance guards above it are evaluated with the type-based root
// and implicit-parameter roots disabled, so a captured pattern-scope `Cell`
// slips past them and reaches this recognizer, which returns true from the
// `isReactiveValueExpression(left)` branch. The array method still does not
// transform (a compute-context receiver is auto-unwrapped), so the decision is
// false — but the receiver has been classified as a reactive fallback.
//

function fallbackMapDecision(source: string): {
  kind: string;
  decision: boolean;
} {
  const { program, sourceFile } = buildProgram(source);
  const mapCall = find(
    sourceFile,
    ts.isCallExpression,
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "map" &&
      ts.isBinaryExpression(unwrapParens(call.expression.expression)),
  );
  return withContext(program, sourceFile, (context) => ({
    kind: context.getReactiveContext(mapCall).kind,
    decision: shouldTransformArrayMethod(mapCall, context),
  }));
}

Deno.test("array-method-policy: (cell ?? []).map in a compute context is recognized as a reactive fallback receiver but not transformed", () => {
  const result = fallbackMapDecision(`/// <cts-enable />
import { Cell, computed, pattern, UI, VNode } from "commonfabric";
interface Input { tags: Cell<string[]>; }
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(({ tags }) => {
  const out = computed(() => (tags ?? []).map((x) => x.length));
  return { [UI]: <div>{out}</div> };
});`);
  // Reaching the fallback branch requires the compute-context path, and that
  // path returns false (the receiver is auto-unwrapped inside a compute).
  assertEquals(result.kind, "compute");
  assertEquals(result.decision, false);
});

Deno.test("array-method-policy: the same reactive-cell fallback receiver in a pattern context does transform", () => {
  const result = fallbackMapDecision(`/// <cts-enable />
import { Cell, pattern, UI, VNode } from "commonfabric";
interface Input { tags: Cell<string[]>; }
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(({ tags }) => ({
  [UI]: <div>{(tags ?? []).map((x) => <em>{x}</em>)}</div>,
}));`);
  // A pattern-context reactive fallback receiver is lowered to its WithPattern
  // form, confirming the left operand is genuinely reactive.
  assertEquals(result.kind, "pattern");
  assertEquals(result.decision, true);
});

//
// transformers/expression-site-policy.ts:1341-1343
//
// `findPreferredNestedLowerableExpressionSite` scans the descendants of an
// expression for a nested lowerable site. When it reaches a function-like node
// that is not the root expression it returns without descending, so candidate
// sites inside a nested closure are never chosen. An expression whose only
// lowerable content sits inside an array-method callback therefore yields no
// nested site.
//

Deno.test("expression-site-policy: the nested-site search does not descend into a nested function, so a site behind a closure boundary is not chosen", () => {
  const { program, sourceFile } = buildProgram(`/// <cts-enable />
import { Cell, pattern, UI, VNode } from "commonfabric";
interface Input { flag: Cell<boolean>; items: Cell<number[]>; }
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(({ flag, items }) => ({
  [UI]: <div><span>{flag ? items.map((x) => x + 1) : []}</span></div>,
}));`);
  // The conditional's consequent is `items.map((x) => x + 1)` — its only inner
  // content lives inside the arrow-function callback.
  const conditional = find(sourceFile, ts.isConditionalExpression);
  const arrow = find(conditional, ts.isArrowFunction);

  const site = withContext(
    program,
    sourceFile,
    (context) =>
      findPreferredNestedLowerableExpressionSite(
        conditional,
        context,
        context.getDataFlowAnalyzer(),
      ),
  );

  // No nested site is returned: the arrow-function boundary is skipped, so the
  // map-callback body is never offered as a candidate.
  assertEquals(site, undefined);
  // Guard against the test silently passing because the arrow was absent.
  assert(ts.isArrowFunction(arrow));
});

//
// ast/type-inference.ts:313
//
// `unwrapOpaqueLikeType` guards against cyclic types with a `seen` set: when a
// type it is already unwrapping reappears (a self-referential branded cell such
// as `type R = OpaqueCell<R>`), it returns that type unchanged instead of
// recursing forever.
//

Deno.test("type-inference: unwrapping a self-referential branded cell terminates via the seen-set guard", () => {
  const { program, sourceFile } = buildProgram(`
declare const CELL_BRAND: unique symbol;
interface OpaqueCell<T> { [CELL_BRAND]: "opaque"; value: T; }
type R = OpaqueCell<R>;
declare const r: R;
export const x = r;
`);
  const checker = program.getTypeChecker();
  const decl = find(
    sourceFile,
    ts.isVariableDeclaration,
    (d) => ts.isIdentifier(d.name) && d.name.text === "x",
  );
  const recursiveType = checker.getTypeAtLocation(decl.name);

  // Without the cycle guard this would recurse until the stack overflows.
  const result = unwrapOpaqueLikeType(recursiveType, checker);

  // Unwrapping `OpaqueCell<R>` reaches `R` again; the guard returns the same
  // type object rather than descending a second time, so unwrapping resolves to
  // the recursive type itself.
  assert(result !== undefined);
  assertEquals(result, recursiveType);
});

//
// transformers/expression-rewrite/emitters/element-access-expression.ts:19
//
// `emitElementAccessExpression` declines (returns undefined) when the element
// access carries no relevant reactive data flows. An index read on a plain,
// non-reactive local array produces an empty data-flow set, so the emitter emits
// nothing and leaves the access untouched.
//

Deno.test("element-access-expression: an index read with no reactive data flows is left untouched by the emitter", () => {
  const { program, sourceFile } = buildProgram(`/// <cts-enable />
import { pattern, UI, VNode } from "commonfabric";
interface Input {}
interface Output { [UI]: VNode; }
const local: number[] = [1, 2, 3];
export default pattern<Input, Output>(() => ({
  [UI]: <div>{local[0]}</div>,
}));`);
  const elementAccess = find(sourceFile, ts.isElementAccessExpression);

  const { dataFlowCount, result } = withContext(
    program,
    sourceFile,
    (context) => {
      const analyze = context.getDataFlowAnalyzer();
      const analysis = analyze(elementAccess);
      const dataFlows = context.getRelevantDataFlowsFromAnalysis(analysis);
      const emitterContext = {
        expression: elementAccess,
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
      return {
        dataFlowCount: dataFlows.length,
        result: emitElementAccessExpression(emitterContext),
      };
    },
  );

  // The non-reactive `local[0]` read has no reactive dependencies, so the guard
  // fires and the emitter produces nothing.
  assertEquals(dataFlowCount, 0);
  assertEquals(result, undefined);
});
