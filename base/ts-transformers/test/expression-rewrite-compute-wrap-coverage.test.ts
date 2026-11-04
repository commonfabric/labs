import { assertStrictEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../src/ast/mod.ts";
import { CrossStageState, TransformationContext } from "../src/core/mod.ts";
import {
  findPendingComputeWrapCandidate,
  resolveComputeWrapCandidate,
} from "../src/transformers/expression-rewrite/emitters/compute-wrap-invariants.ts";
import { rewriteHelperOwnedExpression } from "../src/transformers/expression-rewrite/emitters/helper-owned-expression.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// These tests exercise the compute-wrap invariant guard that emitters call
// before adding a compute wrapper, and the pending-candidate search that
// emitters use to find the reactive node to wrap. A disagreement between the
// emitter's wrap decision and the shared reactive-context classifier is
// handled two ways: an AUTHORED culprit inside an owned pattern boundary is
// reported as the author-facing `reactive:call-argument-computation`
// diagnostic (the guard returns a `{ kind: "skip-reported" }` verdict and the
// caller skips the wrap), while every synthetic-culprit disagreement stays a
// loud "compiler bug" error (thrown, never returned).
// Each test pins one of those behaviors: which node the search selects, when
// it yields nothing, which path reports vs throws, and what the messages
// contain.

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
  const sourceFile = program.getSourceFile(fileName)!;
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: { state: new CrossStageState() },
  });
  return { sourceFile, checker: program.getTypeChecker(), context };
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

function findObjectPropertyInitializer(
  expression: ts.Expression,
  propertyName: string,
): ts.Expression {
  if (!ts.isObjectLiteralExpression(expression)) {
    throw new Error("Expected object literal expression");
  }
  const property = expression.properties.find((node) =>
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === propertyName
  );
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new Error(`Property ${propertyName} not found`);
  }
  return property.initializer;
}

function findFirst<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("Expected node not found");
  return found;
}

Deno.test(
  "findPendingComputeWrapCandidate selects the reactive object-property value as the pending wrap",
  () => {
    const { sourceFile, checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const branch = { label: count.get() + " people" };
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const analyze = createDataFlowAnalyzer(checker);
    const branch = findInitializer(sourceFile, "branch");
    const label = findObjectPropertyInitializer(branch, "label");
    assertStrictEquals(
      findPendingComputeWrapCandidate(branch, analyze, context),
      label,
    );
  },
);

Deno.test(
  "findPendingComputeWrapCandidate treats a top-level function subtree as its own boundary and yields no candidate",
  () => {
    const { sourceFile, checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const fn = (x: number) => x + count.get();
          return { [UI]: <div>{fn(1)}</div> };
        });`,
    );
    const analyze = createDataFlowAnalyzer(checker);
    const fn = findInitializer(sourceFile, "fn");
    // A nested arrow establishes its own rewrite boundary; the search stops at
    // it without descending into its reactive body.
    assertStrictEquals(
      findPendingComputeWrapCandidate(fn, analyze, context),
      undefined,
    );
  },
);

Deno.test(
  "findPendingComputeWrapCandidate stops at the first candidate and skips sibling function subtrees",
  () => {
    const { sourceFile, checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const branch = {
            handler: (x: number) => x + count.get(),
            value: count.get() + 1,
            trailing: count.get() + 2,
          };
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const analyze = createDataFlowAnalyzer(checker);
    const branch = findInitializer(sourceFile, "branch");
    const value = findObjectPropertyInitializer(branch, "value");
    // The arrow-valued `handler` property is skipped as its own boundary; the
    // search returns the reactive `value` computation and does not overwrite it
    // with the later `trailing` computation.
    assertStrictEquals(
      findPendingComputeWrapCandidate(branch, analyze, context),
      value,
    );
  },
);

Deno.test(
  "resolveComputeWrapCandidate returns a wrap verdict when the wrap agrees with the classification",
  () => {
    const { sourceFile, checker: _checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const branch = count.get() + 1;
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const branch = findInitializer(sourceFile, "branch");
    assertStrictEquals(
      resolveComputeWrapCandidate(
        branch,
        branch,
        "binary expression",
        context,
      ).kind,
      "wrap",
    );
    assertStrictEquals(context.diagnostics.length, 0);
  },
);

Deno.test(
  "resolveComputeWrapCandidate throws when the culprit is already classified as compute",
  () => {
    const { sourceFile, checker: _checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const branch = count.get() + 1;
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const branch = findInitializer(sourceFile, "branch");
    context.markSyntheticComputeOwnedSubtree(branch);
    // Marking the node compute-owned makes the classifier disagree with an
    // emitter that still tried to wrap it, so the guard reports the bug.
    let message = "";
    try {
      resolveComputeWrapCandidate(
        branch,
        branch,
        "binary expression",
        context,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "Internal Common Fabric compiler error");
    assertStringIncludes(
      message,
      "shared context classifier already considers compute",
    );
  },
);

Deno.test(
  "resolveComputeWrapCandidate reports the call-argument diagnostic for an authored culprit inside an owned pattern boundary",
  () => {
    const { sourceFile, checker: _checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const lifted = lift((x: { v: number }) => x.v);
          const branch = lifted({ v: count }) + 1;
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const branch = findInitializer(sourceFile, "branch");
    // Container is `lifted({ v: count }) + 1`; the culprit is the reactive
    // object argument of the lift-applied call, which lives inside a supported
    // pattern boundary between it and the container. The culprit is authored
    // pattern code, so instead of the internal compiler-bug throw the guard
    // reports the author-facing hoist diagnostic and tells the caller to skip
    // the wrap.
    const culprit = findFirst(
      sourceFile,
      (node): node is ts.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(node),
    );
    assertStrictEquals(
      resolveComputeWrapCandidate(
        culprit,
        branch,
        "binary expression",
        context,
      ).kind,
      "skip-reported",
    );
    assertStrictEquals(context.diagnostics.length, 1);
    const diagnostic = context.diagnostics[0]!;
    assertStrictEquals(diagnostic.severity, "error");
    assertStrictEquals(diagnostic.type, "reactive:call-argument-computation");
    assertStringIncludes(
      diagnostic.message,
      "cannot be compiled inline in the arguments of `lifted(...)`",
    );
    assertStringIncludes(
      diagnostic.message,
      "Hoist it to a body-level const or computed(...)",
    );
  },
);

Deno.test(
  "resolveComputeWrapCandidate still throws for a synthetic culprit inside an owned pattern boundary",
  () => {
    const { sourceFile, checker: _checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const lifted = lift((x: { v: number }) => x.v);
          const branch = lifted({ v: count }) + 1;
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const branch = findInitializer(sourceFile, "branch");
    const authored = findFirst(
      sourceFile,
      (node): node is ts.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(node),
    );
    // A synthesized culprit in the same boundary position has no authored
    // source range to hang a diagnostic on, so the internal invariant stays a
    // loud compiler-bug error.
    const synthesized = ts.factory.createBinaryExpression(
      ts.factory.createNumericLiteral(1),
      ts.SyntaxKind.PlusToken,
      ts.factory.createNumericLiteral(2),
    );
    (synthesized as { parent: ts.Node }).parent = authored.parent;
    let message = "";
    try {
      resolveComputeWrapCandidate(
        synthesized,
        branch,
        "binary expression",
        context,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "Internal Common Fabric compiler error");
    assertStringIncludes(message, "already-supported pattern boundary");
    assertStrictEquals(context.diagnostics.length, 0);
  },
);

Deno.test(
  "rewriteHelperOwnedExpression skips the wrap and reports when its assert container spans an owned boundary",
  () => {
    const { sourceFile, checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const lifted = lift((x: { v: number }) => x.v);
          const outer = lifted({ v: count.get() + 1 }) ? "a" : "b";
          return { [UI]: <div>{outer}</div> };
        });`,
    );
    const analyze = createDataFlowAnalyzer(checker);
    const outer = findInitializer(sourceFile, "outer");
    const objectArg = findFirst(
      sourceFile,
      (node): node is ts.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(node),
    );
    const computation = findObjectPropertyInitializer(objectArg, "v");
    // The helper-arg rewriter is handed the computation with an assert
    // container above the lift-applied call (mirroring the conditional-helper
    // arg path, which passes the whole helper call as assertContainer). The
    // walk from the culprit to that container crosses the owned lift-applied
    // boundary, so the guard reports the hoist diagnostic and the rewriter
    // returns the expression unwrapped instead of value-lifting it.
    const result = rewriteHelperOwnedExpression({
      expression: computation,
      containerLabel: "ifElse branch",
      assertContainer: outer,
      context,
      analyze,
      rewriteChildren: (node) => node,
    });
    assertStrictEquals(result, computation);
    assertStrictEquals(context.diagnostics.length, 1);
    assertStrictEquals(
      context.diagnostics[0]!.type,
      "reactive:call-argument-computation",
    );
  },
);

Deno.test(
  "the compiler-bug message truncates a long culprit snippet with an ellipsis",
  () => {
    const longExpression = "count.get()" + " + count.get()".repeat(20);
    const { sourceFile, checker: _checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const branch = ${longExpression};
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const branch = findInitializer(sourceFile, "branch");
    context.markSyntheticComputeOwnedSubtree(branch);
    let message = "";
    try {
      resolveComputeWrapCandidate(
        branch,
        branch,
        "binary expression",
        context,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    // The culprit snippet is longer than the 160-character cap, so it is cut
    // off with an ellipsis.
    assertStringIncludes(message, "...");
  },
);

Deno.test(
  "the compiler-bug message falls back to the SyntaxKind name when a culprit has no source text",
  () => {
    const { sourceFile, checker: _checker, context } = createContext(
      HEADER +
        `export default pattern((_s) => {
          const count = cell(0);
          const branch = count.get() + 1;
          return { [UI]: <div>{branch}</div> };
        });`,
    );
    const branch = findInitializer(sourceFile, "branch");
    // A synthesized node has no real source positions, so reading its text
    // throws and the snippet helper falls back to the node's SyntaxKind name.
    const synthesized = ts.factory.createBinaryExpression(
      ts.factory.createNumericLiteral(1),
      ts.SyntaxKind.PlusToken,
      ts.factory.createNumericLiteral(2),
    );
    (synthesized as { parent: ts.Node }).parent = branch.parent;
    context.markSyntheticComputeOwnedSubtree(synthesized);
    let message = "";
    try {
      resolveComputeWrapCandidate(
        synthesized,
        branch,
        "binary expression",
        context,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "Internal Common Fabric compiler error");
    assertStringIncludes(message, "BinaryExpression");
  },
);
