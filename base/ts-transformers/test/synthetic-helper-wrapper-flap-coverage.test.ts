import { assertEquals } from "@std/assert";
import ts from "typescript";
import { StaticCache } from "@commonfabric/static";

import { TransformationContext } from "../src/core/context.ts";
import { transformCfDirective } from "../src/mod.ts";
import { isSyntheticHelperWrapperInArrayMethodCallback } from "../src/transformers/expression-site-lowering.ts";
import { CF_HELPERS_IDENTIFIER } from "../src/core/cf-helpers.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// `isSyntheticHelperWrapperInArrayMethodCallback` classifies a synthetic
// reactive-helper wrapper (a `__cfHelpers.ifElse/when/unless`/lift-applied call
// produced by an earlier lowering pass) by walking up from it to decide whether
// it sits inside an array-method callback. Its no-enclosing-function fallback
// runs only when such a synthetic wrapper is reached with a parent chain that
// holds no function at all — a transient state the transformer produces while
// compiling patterns cold, but which a compile-cache-warm CI run skips, so the
// line alternates between covered and uncovered across runs of identical code.
//
// This drives that fallback directly: a freshly built synthetic `ifElse` wrapper
// has a negative text position (marking it synthetic) and no parent, so the
// upward walk finds no function and the classifier returns false — the wrapper
// is not treated as living inside an array-method callback.

const cache = StaticCache.fromFileSystem();
const es2023 = await cache.getText("types/es2023.d.ts");
const dom = await cache.getText("types/dom.d.ts");
const jsx = await cache.getText("types/jsx.d.ts");

function buildContext<T>(body: (context: TransformationContext) => T): T {
  const fileName = "/test.tsx";
  const files: Record<string, string> = {
    [fileName]: transformCfDirective(`/// <cts-enable />
import { pattern, UI, VNode } from "commonfabric";
interface Input {}
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(() => ({ [UI]: <div /> }));`),
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
  const sourceFile = program.getSourceFile(fileName)!;
  let out!: T;
  ts.transform(sourceFile, [
    (tsContext) => (root) => {
      out = body(new TransformationContext({ program, sourceFile, tsContext }));
      return root;
    },
  ]);
  return out;
}

/** A synthetic `__cfHelpers.<name>(...)` call, as a lowering pass emits. */
function syntheticHelperCall(name: string): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier(CF_HELPERS_IDENTIFIER),
      name,
    ),
    undefined,
    [
      ts.factory.createTrue(),
      ts.factory.createNumericLiteral("1"),
      ts.factory.createNumericLiteral("2"),
    ],
  );
}

Deno.test("a detached synthetic helper wrapper is not classified as inside an array-method callback", () => {
  // A factory-built node carries a negative position (synthetic) and no parent.
  const wrapper = syntheticHelperCall("ifElse");
  assertEquals(wrapper.pos < 0, true);
  assertEquals(wrapper.parent, undefined);

  const result = buildContext((context) =>
    isSyntheticHelperWrapperInArrayMethodCallback(wrapper, context)
  );

  // Recognized as a synthetic reactive-helper wrapper, but with no enclosing
  // function in its (empty) parent chain, so it is not inside an array-method
  // callback.
  assertEquals(result, false);
});

Deno.test("a non-helper synthetic call is rejected before the ancestor walk", () => {
  // A `__cfHelpers.notAHelper(...)` call is not a recognized reactive-helper
  // wrapper, so the classifier declines up front rather than walking ancestors.
  const notAWrapper = syntheticHelperCall("notAHelper");

  const result = buildContext((context) =>
    isSyntheticHelperWrapperInArrayMethodCallback(notAWrapper, context)
  );

  assertEquals(result, false);
});
