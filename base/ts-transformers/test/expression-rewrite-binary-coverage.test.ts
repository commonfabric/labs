import { assert, assertEquals, assertThrows } from "@std/assert";
import ts from "typescript";

import { callsNamed, parseModule } from "./transformed-ast.ts";

import { createDataFlowAnalyzer } from "../src/ast/mod.ts";
import { CrossStageState, TransformationContext } from "../src/core/mod.ts";
import { rewriteExpression } from "../src/transformers/expression-rewrite/mod.ts";
import type { ReactiveContextKind } from "../src/ast/mod.ts";
import type { ExpressionContainerKind } from "../src/transformers/expression-site-types.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { registerTrustedCommonFabricTestSources } from "./trusted-commonfabric-sources.ts";

// These tests drive the shared expression-rewrite entry point
// (`rewriteExpression`) directly against reactive binary expressions found in
// `pattern`/`cell` sources. Driving the entry point rather than the whole
// pipeline lets each case pin the exact reactive-context kind, container kind
// and safe-context flag that a binary reaches the emitter with, so we can
// assert the specific rewrite shape each branch of `emitBinaryExpression`
// produces (a `when`/`unless` lowering, a lift wrapper, or a decision to leave
// the node untouched).

const HEADER =
  `import { __cfHelpers, pattern, cell, lift, UI } from "commonfabric";\n`;

function createContext(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  context: TransformationContext;
} {
  const fileName = "/test.tsx";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    skipLibCheck: true,
  };
  const files: Record<string, string> = {
    [fileName]: source,
    "commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
  };
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion) =>
    files[name] !== undefined
      ? ts.createSourceFile(
        name,
        files[name]!,
        languageVersion,
        true,
        name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
      : originalGetSourceFile(name, languageVersion);
  host.fileExists = (name) => files[name] !== undefined;
  host.readFile = (name) => files[name];
  host.resolveModuleNames = (names) =>
    names.map((name) =>
      name === "commonfabric"
        ? {
          resolvedFileName: "commonfabric.d.ts",
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        }
        : undefined
    );
  const program = ts.createProgram(
    [fileName, "commonfabric.d.ts"],
    options,
    host,
  );
  registerTrustedCommonFabricTestSources(program, ["commonfabric.d.ts"]);
  const sourceFile = program.getSourceFile(fileName)!;
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: { state: new CrossStageState() },
  });
  return { sourceFile, checker: program.getTypeChecker(), context };
}

function findBinary(
  sourceFile: ts.SourceFile,
  operator: ts.SyntaxKind,
  nth = 0,
): ts.BinaryExpression {
  const matches: ts.BinaryExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === operator
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const found = matches[nth];
  if (!found) throw new Error("Expected binary expression not found");
  return found;
}

function printNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return ts.createPrinter().printNode(
    ts.EmitHint.Unspecified,
    node,
    sourceFile,
  );
}

interface RewriteOptions {
  reactiveContextKind: ReactiveContextKind;
  containerKind: ExpressionContainerKind;
  inSafeContext: boolean;
  markSyntheticOwned?: boolean;
}

function rewriteBinary(
  source: string,
  operator: ts.SyntaxKind,
  options: RewriteOptions,
  nth = 0,
): { result: ts.Expression | undefined; printed: string | undefined } {
  const { sourceFile, checker, context } = createContext(HEADER + source);
  const analyze = createDataFlowAnalyzer(checker);
  const binary = findBinary(sourceFile, operator, nth);
  if (options.markSyntheticOwned) {
    context.markSyntheticComputeOwnedSubtree(binary);
  }
  const analysis = analyze(binary);
  const result = rewriteExpression({
    expression: binary,
    analysis,
    context,
    analyze,
    reactiveContextKind: options.reactiveContextKind,
    containerKind: options.containerKind,
    inSafeContext: options.inSafeContext,
  });
  return {
    result,
    printed: result ? printNode(result, sourceFile) : undefined,
  };
}

const AND = ts.SyntaxKind.AmpersandAmpersandToken;
const OR = ts.SyntaxKind.BarBarToken;
const NULLISH = ts.SyntaxKind.QuestionQuestionToken;
const PLUS = ts.SyntaxKind.PlusToken;

Deno.test(
  "emitBinaryExpression lowers a pattern-owned && with a simple reactive left to a when() call",
  () => {
    const { printed } = rewriteBinary(
      `export default pattern((_s) => {
        const showPanel = cell(true);
        return { [UI]: <div>{showPanel.get() && <span>P</span>}</div> };
      });`,
      AND,
      {
        reactiveContextKind: "pattern",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    assert(printed, "expected the && to be lowered");
    const root = parseModule(printed);
    assertEquals(callsNamed(root, "when").length, 1);
  },
);

Deno.test(
  "emitBinaryExpression lowers a pattern-owned || with a simple reactive left to an unless() call",
  () => {
    const { printed } = rewriteBinary(
      `export default pattern((_s) => {
        const value = cell("");
        return { [UI]: <div>{value.get() || <span>F</span>}</div> };
      });`,
      OR,
      {
        reactiveContextKind: "pattern",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    assert(printed, "expected the || to be lowered");
    const root = parseModule(printed);
    assertEquals(callsNamed(root, "unless").length, 1);
  },
);

Deno.test(
  "emitBinaryExpression wraps a non-simple && condition in a lift before the when() call",
  () => {
    const { printed } = rewriteBinary(
      `export default pattern((_s) => {
        const user = cell<{ name: string }>({ name: "" });
        return { [UI]: <div>{(user.get().name.length > 0) && <span>H</span>}</div> };
      });`,
      AND,
      {
        reactiveContextKind: "pattern",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    assert(printed, "expected the && to be lowered");
    const root = parseModule(printed);
    assertEquals(callsNamed(root, "when").length, 1);
    // The complex left operand is wrapped as a reactive condition rather than
    // passed through verbatim.
    assertEquals(callsNamed(root, "lift").length, 1);
  },
);

Deno.test(
  "emitBinaryExpression wraps a non-simple || condition in a lift before the unless() call",
  () => {
    const { printed } = rewriteBinary(
      `export default pattern((_s) => {
        const user = cell<{ name: string }>({ name: "" });
        return { [UI]: <div>{(user.get().name.length > 0) || <span>F</span>}</div> };
      });`,
      OR,
      {
        reactiveContextKind: "pattern",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    assert(printed, "expected the || to be lowered");
    const root = parseModule(printed);
    assertEquals(callsNamed(root, "unless").length, 1);
    assertEquals(callsNamed(root, "lift").length, 1);
  },
);

Deno.test(
  "emitBinaryExpression leaves a safe-context && untouched instead of lowering it",
  () => {
    const { result } = rewriteBinary(
      `export default pattern((_s) => {
        const showPanel = cell(true);
        return { [UI]: <div>{showPanel.get() && <span>P</span>}</div> };
      });`,
      AND,
      {
        reactiveContextKind: "compute",
        containerKind: "jsx-expression",
        inSafeContext: true,
      },
    );
    // In a safe (compute) context the context policy does not lower && to
    // when(); the emitter declines to rewrite so the raw && is preserved.
    assert(
      result === undefined,
      "expected && in a safe context to be left untouched",
    );
  },
);

Deno.test(
  "emitBinaryExpression leaves a safe-context || untouched instead of lowering it",
  () => {
    const { result } = rewriteBinary(
      `export default pattern((_s) => {
        const value = cell("");
        return { [UI]: <div>{value.get() || <span>F</span>}</div> };
      });`,
      OR,
      {
        reactiveContextKind: "compute",
        containerKind: "jsx-expression",
        inSafeContext: true,
      },
    );
    assert(
      result === undefined,
      "expected || in a safe context to be left untouched",
    );
  },
);

Deno.test(
  "emitBinaryExpression declines to wrap any reactive binary in a safe context",
  () => {
    const { result } = rewriteBinary(
      `export default pattern<{ count: number }>((state) => ({
        [UI]: <div>{state.count + 100}</div>,
      }));`,
      PLUS,
      {
        reactiveContextKind: "compute",
        containerKind: "jsx-expression",
        inSafeContext: true,
      },
    );
    // Safe contexts allow opaque reads, so the arithmetic binary is not wrapped
    // in a compute wrapper.
    assert(
      result === undefined,
      "expected arithmetic in a safe context to be left untouched",
    );
  },
);

Deno.test(
  "emitBinaryExpression wraps a pattern-owned arithmetic binary in a lift compute wrapper",
  () => {
    const { printed } = rewriteBinary(
      `export default pattern<{ count: number }>((state) => ({
        [UI]: <div>{state.count + 100}</div>,
      }));`,
      PLUS,
      {
        reactiveContextKind: "pattern",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    assert(printed, "expected arithmetic to be wrapped");
    assertEquals(callsNamed(parseModule(printed), "lift").length, 1);
  },
);

Deno.test(
  "emitBinaryExpression declines to rewrite a purely-literal binary with no reactive operands",
  () => {
    const { result } = rewriteBinary(
      `export default pattern((_s) => ({ [UI]: <div>{1 + 2}</div> }));`,
      PLUS,
      {
        reactiveContextKind: "compute",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    // No dataflows, a non-reactive left operand, and no lowering policy means
    // the emitter has nothing to do.
    assert(
      result === undefined,
      "expected a literal binary to be left untouched",
    );
  },
);

Deno.test(
  "emitBinaryExpression declines to wrap a reactive-valued binary that captures no dataflows",
  () => {
    const { result } = rewriteBinary(
      `import { computed } from "commonfabric";
      export default pattern((_s) => ({ [UI]: <div>{computed(() => 1) + 1}</div> }));`,
      PLUS,
      {
        reactiveContextKind: "pattern",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    // The left side is a reactive value (so the early skip does not fire) but
    // it captures no reactive dataflows, so there is nothing to bind into a
    // compute wrapper and the emitter returns undefined.
    assert(
      result === undefined,
      "expected a reactive binary without captured dataflows to be left untouched",
    );
  },
);

Deno.test(
  "emitBinaryExpression defers a reactive fallback receiver of an unlowered map()",
  () => {
    const { result } = rewriteBinary(
      `export default pattern((_s) => {
        const items = cell<number[]>([]);
        return { [UI]: <div>{(items ?? []).map((x) => <span>{x}</span>)}</div> };
      });`,
      NULLISH,
      {
        reactiveContextKind: "pattern",
        containerKind: "jsx-expression",
        inSafeContext: false,
      },
    );
    // `(items ?? []).map(...)` is a simple reactive left feeding a not-yet
    // lowered map(). The emitter defers so the array-method rewrite owns the
    // receiver instead of pre-wrapping the fallback.
    assert(
      result === undefined,
      "expected the fallback map receiver to be deferred",
    );
  },
);

Deno.test(
  "emitBinaryExpression rewrites a synthetic compute-owned array-method receiver without asserting compute-wrap invariants",
  () => {
    const { printed } = rewriteBinary(
      `export default pattern((_s) => {
        const items = cell<number[]>([]);
        return { [UI]: <div>{(items ?? []).map((x) => <span>{x}</span>)}</div> };
      });`,
      NULLISH,
      {
        reactiveContextKind: "compute",
        containerKind: "jsx-expression",
        inSafeContext: false,
        markSyntheticOwned: true,
      },
    );
    // A synthetic compute-owned node that is the receiver of a map() is an
    // allowed wrap: the emitter skips the compute-wrap invariant assertion
    // (which would otherwise throw for a compute-owned node) and still emits a
    // lift wrapper.
    assert(printed, "expected the synthetic array receiver to be wrapped");
    assertEquals(callsNamed(parseModule(printed), "lift").length, 1);
  },
);

Deno.test(
  "emitBinaryExpression throws a compiler-bug error for a compute-owned binary that is not an array-method receiver",
  () => {
    const { sourceFile, checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          return { [UI]: <div>{count.get() + 1}</div> };
        });`,
    );
    const binary = findBinary(sourceFile, PLUS);
    // Mark the binary as synthetic compute-owned so the array-receiver check
    // runs and returns false (it is not a map()/filter() receiver). Because the
    // node is not an allowed synthetic array wrap, the compute-wrap invariant
    // assertion fires and reports the classifier disagreement.
    context.markSyntheticComputeOwnedSubtree(binary);
    const analyze = createDataFlowAnalyzer(checker);
    assertThrows(
      () =>
        rewriteExpression({
          expression: binary,
          analysis: analyze(binary),
          context,
          analyze,
          reactiveContextKind: "pattern",
          containerKind: "jsx-expression",
          inSafeContext: false,
        }),
      Error,
      "Internal Common Fabric compiler error",
    );
  },
);
