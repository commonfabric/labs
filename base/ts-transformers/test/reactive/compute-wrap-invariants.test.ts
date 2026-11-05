import { assertStrictEquals } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/mod.ts";
import { CrossStageState, TransformationContext } from "../../src/core/mod.ts";
import { findPendingComputeWrapCandidate } from "../../src/transformers/expression-rewrite/emitters/compute-wrap-invariants.ts";

function createProgramAndContext(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  context: TransformationContext;
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
    ts.ScriptKind.TS,
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
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: {
      state: new CrossStageState(),
    },
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

const findPendingComputeWrapCandidateWithExclude =
  findPendingComputeWrapCandidate as unknown as (
    expr: ts.Expression,
    analyze: ReturnType<typeof createDataFlowAnalyzer>,
    context: TransformationContext,
    excludeSubtree?: ts.Node,
  ) => ts.Expression | undefined;

Deno.test(
  "findPendingComputeWrapCandidate excludes the queried subtree from circular analysis",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare const CELL_BRAND: unique symbol;
      type BrandedCell<T, Brand extends string> = {
        readonly [CELL_BRAND]: Brand;
      };
      type Reactive<T> = BrandedCell<T, "opaque">;
      declare const count: Reactive<number>;

      const branch = { label: count + " people" };
    `);

    const analyze = createDataFlowAnalyzer(checker);
    const branch = findInitializer(sourceFile, "branch");
    const label = findObjectPropertyInitializer(branch, "label");

    assertStrictEquals(
      findPendingComputeWrapCandidate(branch, analyze, context),
      label,
    );
    assertStrictEquals(
      findPendingComputeWrapCandidateWithExclude(
        branch,
        analyze,
        context,
        label,
      ),
      undefined,
    );
  },
);

Deno.test(
  "findPendingComputeWrapCandidate still finds independent candidates after exclusion",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare const CELL_BRAND: unique symbol;
      type BrandedCell<T, Brand extends string> = {
        readonly [CELL_BRAND]: Brand;
      };
      type Reactive<T> = BrandedCell<T, "opaque">;
      declare const count: Reactive<number>;

      const branch = {
        label: count + " people",
        total: count * 2,
      };
    `);

    const analyze = createDataFlowAnalyzer(checker);
    const branch = findInitializer(sourceFile, "branch");
    const label = findObjectPropertyInitializer(branch, "label");
    const total = findObjectPropertyInitializer(branch, "total");

    assertStrictEquals(
      findPendingComputeWrapCandidateWithExclude(
        branch,
        analyze,
        context,
        label,
      ),
      total,
    );
  },
);

Deno.test(
  "findPendingComputeWrapCandidate does not treat custom map methods as supported rewrite boundaries",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare const CELL_BRAND: unique symbol;
      type BrandedCell<T, Brand extends string> = {
        readonly [CELL_BRAND]: Brand;
      };
      type Reactive<T> = BrandedCell<T, "opaque">;
      declare const count: Reactive<number>;
      declare const collection: {
        map<T>(fn: (item: number) => T): T[];
      };

      const branch = { value: collection.map((item) => item + count) };
    `);

    const analyze = createDataFlowAnalyzer(checker);
    const branch = findInitializer(sourceFile, "branch");
    const value = findObjectPropertyInitializer(branch, "value");

    assertStrictEquals(
      findPendingComputeWrapCandidate(branch, analyze, context),
      value,
    );
  },
);
