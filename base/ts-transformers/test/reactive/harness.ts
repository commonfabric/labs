import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/mod.ts";

// Shared prelude for tests that need Cell variants
export const CELL_VARIANTS_PRELUDE = `
interface Cell<T> extends BrandedCell<T, "cell"> {}
interface Stream<T> extends BrandedCell<T, "stream"> {}
interface ComparableCell<T> extends BrandedCell<T, "comparable"> {}
interface ReadonlyCell<T> extends BrandedCell<T, "readonly"> {}
interface WriteonlyCell<T> extends BrandedCell<T, "writeonly"> {}

declare const cells: {
  cell: Cell<number>;
  stream: Stream<string>;
  comparable: ComparableCell<boolean>;
  readonly: ReadonlyCell<number>;
  writeonly: WriteonlyCell<number>;
};
`;

export interface AnalysisHarnessResult {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly expression: ts.Expression;
  readonly analysis: ReturnType<ReturnType<typeof createDataFlowAnalyzer>>;
}

interface AnalyzeOptions {
  readonly prelude?: string;
}

export function analyzeExpression(
  source: string,
  options: AnalyzeOptions = {},
): AnalysisHarnessResult {
  const fileName = "/analysis.ts";
  const programSource = `
declare const CELL_BRAND: unique symbol;

type BrandedCell<T, Brand extends string> = {
  readonly [CELL_BRAND]: Brand;
};

interface OpaqueCell<T> extends BrandedCell<T, "opaque"> {
  map<S>(fn: (...args: unknown[]) => S): OpaqueCell<S[]>;
}

declare const state: {
  readonly count: OpaqueCell<number>;
  readonly flag: OpaqueCell<boolean>;
  readonly items: OpaqueCell<number[]>;
};

declare function ifElse<T>(predicate: boolean, whenTrue: T, whenFalse: T): T;
declare function pattern<T>(body: () => T): T;

${options.prelude ?? ""}

const result = ${source};
`;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    noLib: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    programSource,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TS,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? programSource : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  const checker = program.getTypeChecker();

  const declaration = sourceFile.statements
    .filter((statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement)
    )
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .find((decl) => decl.initializer && ts.isExpression(decl.initializer));

  if (!declaration?.initializer || !ts.isExpression(declaration.initializer)) {
    throw new Error("Expected initializer expression");
  }

  const expression = declaration.initializer;
  const analyze = createDataFlowAnalyzer(checker);
  const analysis = analyze(expression);

  return { sourceFile, checker, expression, analysis };
}
