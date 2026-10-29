import { assert, assertEquals, assertThrows } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { ModuleScopeCfDataTransformer } from "../src/transformers/module-scope-cf-data.ts";
import { TransformationContext } from "../src/core/mod.ts";
import {
  calleeName,
  callsNamed,
  collect,
  parseModule,
} from "./transformed-ast.ts";

/**
 * The argument text of the sole `__cfHelpers.__cf_data(...)` wrap call, or
 * undefined if there is no such call. Asserts there is at most one.
 */
function cfDataArgText(root: ts.SourceFile): string | undefined {
  const calls = callsNamed(root, "__cf_data");
  assert(
    calls.length <= 1,
    `expected at most one wrap call, got ${calls.length}`,
  );
  const call = calls[0];
  return call?.arguments[0]?.getText(root);
}

/** The expression of `export default <expr>`, or undefined if there is none. */
function defaultExportExpression(
  root: ts.SourceFile,
): ts.Expression | undefined {
  const assignment = collect(root, ts.isExportAssignment).find((node) =>
    !node.isExportEquals
  );
  return assignment?.expression;
}

// The module-scope cf-data transformer wraps top-level data expressions with a
// `__cf_data` helper call. The existing `module-scope-cf-data.test.ts` drives
// the full pipeline; these tests drive the transformer directly through
// `ts.transform` with a bare single-file program so the checker-dependent
// classification arms (`isPrimitiveSnapshotCall`'s union / intersection
// analysis) and the callable-classification walks can be pinned against
// minimal sources. The callees are `declare const` bindings on purpose: a
// top-level function declaration or const arrow/function-expression would
// match `isTopLevelLocalHelperCall` first and short-circuit past the
// primitive-snapshot arm. Driving directly also bypasses the
// `HelpersOnlyTransformer` filter, which lets the final test pin the loud
// invariant: wrap emission on a helpers-less source throws rather than
// silently emitting a form the sandbox verifier does not recognize.

function createProgram(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
  const files: Record<string, string> = { "/test.ts": source };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
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
  };
  const program = ts.createProgram(["/test.ts"], options, host);
  return { program, sourceFile: program.getSourceFile("/test.ts")! };
}

// Runs the cf-data transformer directly, bypassing the pipeline (and with it
// the `sourceHasHelpers()` filter — sources here carry their own helpers
// import, except where the filter invariant itself is under test).
function transformDirect(source: string): string {
  const { program, sourceFile } = createProgram(source);
  const transformer = new ModuleScopeCfDataTransformer({});
  const result = ts.transform(sourceFile, [
    (tsContext) => (sf) =>
      transformer.transform(
        new TransformationContext({ program, sourceFile: sf, tsContext }),
      ),
  ]);
  const output = ts
    .createPrinter({ newLine: ts.NewLineKind.LineFeed })
    .printFile(result.transformed[0]);
  result.dispose?.();
  return output;
}

Deno.test(
  "cf-data wraps a bare-identifier call whose result type is primitive",
  () => {
    const output = transformDirect(
      `import { __cfHelpers } from "commonfabric";\n` +
        `declare const n: () => number;\n` +
        `const z = n();\n`,
    );
    // `n` is neither a local callable binding nor a member call, so only the
    // checker-resolved primitive result type qualifies the call as a snapshot.
    assertEquals(cfDataArgText(parseModule(output)), "n()");
  },
);

Deno.test(
  "cf-data wraps a call whose type is a union of primitives",
  () => {
    const output = transformDirect(
      `import { __cfHelpers } from "commonfabric";\n` +
        `declare const u: () => string | number;\n` +
        `const z = u();\n`,
    );
    // A union return type is classified as primitive-like when every member is
    // primitive-like, so the snapshot call is wrapped.
    assertEquals(cfDataArgText(parseModule(output)), "u()");
  },
);

Deno.test(
  "cf-data wraps a call whose type is an intersection of primitives",
  () => {
    const output = transformDirect(
      `import { __cfHelpers } from "commonfabric";\n` +
        `type A = string;\ntype B = string;\n` +
        `declare const u: () => A & B;\n` +
        `const z = u();\n`,
    );
    // An intersection is primitive-like when every member is primitive-like.
    assertEquals(cfDataArgText(parseModule(output)), "u()");
  },
);

Deno.test(
  "cf-data leaves a call whose intersection has a non-primitive member unwrapped",
  () => {
    const output = transformDirect(
      `import { __cfHelpers } from "commonfabric";\n` +
        `declare const u: () => string & { b: string };\n` +
        `const z = u();\n`,
    );
    // The object member is not primitive-like, so the intersection fails the
    // `every` check and the call is not treated as a snapshot.
    assertEquals(
      callsNamed(parseModule(output), "__cf_data").length,
      0,
      "expected the non-primitive intersection to be left unwrapped",
    );
  },
);

Deno.test(
  "cf-data leaves a declared callable with no body unwrapped on default export",
  () => {
    const output = transformDirect(
      `import { __cfHelpers } from "commonfabric";\n` +
        `declare function helper(): number;\nexport default helper;\n`,
    );
    // `callableMayReturnCallResult` returns false for a declaration without a
    // body, so the ambient callable is not classified as a default-exported
    // data callable.
    const root = parseModule(output);
    assertEquals(
      callsNamed(root, "__cf_data").length,
      0,
      "expected the body-less declared callable to be left unwrapped",
    );
    // The default export stays the bare identifier, not a wrap call.
    const exported = defaultExportExpression(root);
    assert(exported && ts.isIdentifier(exported) && exported.text === "helper");
  },
);

Deno.test(
  "cf-data wraps a callable that returns a call-on-call result past a nested class boundary and trailing members",
  () => {
    const output = transformDirect(
      `import { __cfHelpers } from "commonfabric";\n` +
        `declare function factory(): () => number;\n` +
        `const nested = () => ({ make: class {}, a: factory()(), b: 1 });\n` +
        `export default nested;\n`,
    );
    // The nested-expression walk skips the leading class boundary, finds the
    // `factory()()` call-on-call, then short-circuits over the trailing member,
    // classifying `nested` as a default-exported data callable.
    const root = parseModule(output);
    const exported = defaultExportExpression(root);
    assert(exported && ts.isCallExpression(exported), "expected a wrap call");
    assertEquals(calleeName(exported), "__cf_data");
    assertEquals(exported.arguments[0]?.getText(root), "nested");
  },
);

Deno.test(
  "cf-data wrap emission on a helpers-less source throws (filter invariant)",
  () => {
    // The HelpersOnlyTransformer filter guarantees every source reaching
    // transform() carries the helpers import. Bypassing it with a wrappable
    // statement must fail loudly via getHelperExpr, not fall back to an
    // alternate emission the sandbox verifier does not recognize.
    assertThrows(
      () => transformDirect(`const z = { a: 1 };\n`),
      Error,
      "does not contain helpers",
    );
  },
);

Deno.test(
  "cf-data wraps a block-body callable whose call-on-call return precedes later statements",
  async () => {
    const output = await transformSource(
      `import { pattern } from "commonfabric";\n` +
        `declare function factory(): () => number;\n` +
        `const helper = () => {\n` +
        `  if (true) { return factory()(); }\n` +
        `  const after = 1;\n` +
        `  return after;\n` +
        `};\n` +
        `export default helper;`,
      { types: COMMONFABRIC_TYPES },
    );
    // The block traversal finds the call-on-call return inside the branch, then
    // short-circuits the visit over the remaining statements.
    const root = parseModule(output);
    const exported = defaultExportExpression(root);
    assert(exported && ts.isCallExpression(exported), "expected a wrap call");
    const callee = exported.expression;
    assert(
      ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "__cfHelpers" &&
        callee.name.text === "__cf_data",
      "expected __cfHelpers.__cf_data callee",
    );
    assertEquals(exported.arguments[0]?.getText(root), "helper");
  },
);
