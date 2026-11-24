import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/dataflow.ts";

// A minimal branded-cell setup so that `state.*` reads resolve to a reactive
// (opaque) type under `noLib`, mirroring the reactive harness prelude.
const REACTIVE_PRELUDE = `
declare const CELL_BRAND: unique symbol;
type BrandedCell<T, Brand extends string> = { readonly [CELL_BRAND]: Brand };
interface OpaqueCell<T> extends BrandedCell<T, "opaque"> {}
declare const state: {
  readonly count: OpaqueCell<number>;
};
declare function tag(strings: TemplateStringsArray, ...values: unknown[]): string;
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

Deno.test("createDataFlowAnalyzer caches repeated analysis for the same node", () => {
  const { sourceFile, checker } = createProgram(`
    declare const foo: number;
    declare const bar: number;

    const value = foo + bar;
  `);

  const expression = findInitializer(sourceFile, "value");
  const analyze = createDataFlowAnalyzer(checker);

  const first = analyze(expression);
  const second = analyze(expression);

  assertStrictEquals(second, first);
});

Deno.test("property read of a const object spread still resolves through the literal", () => {
  // The aggregate's only property comes from a spread, so the static-property
  // lookup short-circuits on the spread assignment and falls back to the
  // resolved (reactive) property type.
  const { sourceFile, checker } = createProgram(`
    ${REACTIVE_PRELUDE}
    const src = { a: state.count };
    const agg = { ...src };
    const value = agg.a;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assert(analysis.containsReactive, "spread-sourced reactive prop is reactive");
});

Deno.test("property read of a const object shorthand follows the shorthand initializer", () => {
  // The aggregate uses a shorthand property whose name matches the access, so
  // the lookup returns the shorthand identifier and analyzes it.
  // `other` is a trailing shorthand that the reverse-order scan visits and
  // skips before reaching the matching `count` shorthand.
  const { sourceFile, checker } = createProgram(`
    ${REACTIVE_PRELUDE}
    const count = state.count;
    const other = 1;
    const agg = { count, other };
    const value = agg.count;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assert(analysis.containsReactive, "shorthand reactive prop is reactive");
});

Deno.test("property read of a const object missing the key is not reactive", () => {
  const { sourceFile, checker } = createProgram(`
    ${REACTIVE_PRELUDE}
    const agg = { a: 1 };
    const value = agg.a;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assertEquals(analysis.containsReactive, false);
  assertEquals(analysis.dataFlows.length, 0);
});

Deno.test("tagged template without substitutions is inert", () => {
  const { sourceFile, checker } = createProgram(`
    ${REACTIVE_PRELUDE}
    const value = tag\`plain text\`;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assertEquals(analysis.containsReactive, false);
  assertEquals(analysis.dataFlows.length, 0);
});

Deno.test("tagged template with a reactive substitution is reactive", () => {
  const { sourceFile, checker } = createProgram(`
    ${REACTIVE_PRELUDE}
    const value = tag\`count: \${state.count}\`;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assert(analysis.containsReactive, "substitution dataflow is reactive");
});

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

Deno.test("JSX fragment children carry through reactive dataflow", () => {
  const { sourceFile, checker } = createTsxProgram(`
    ${REACTIVE_PRELUDE}
    const value = <>{state.count}</>;
  `);
  const analysis = createDataFlowAnalyzer(checker)(
    findInitializer(sourceFile, "value"),
  );
  assert(analysis.containsReactive, "fragment child dataflow is reactive");
});
