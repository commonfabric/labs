import { assert, assertEquals, assertMatch } from "@std/assert";

import ts from "typescript";

import { CommonFabricTransformerPipeline } from "../src/cf-pipeline.ts";
import {
  type PatternCoverageOptions,
  type PatternCoverageSpan,
  TransformationContext,
  type TransformationDiagnostic,
} from "../src/core/mod.ts";
import {
  PatternCoverageTransformer,
} from "../src/transformers/pattern-coverage.ts";
import { collect, literalToValue, parseModule } from "./transformed-ast.ts";

interface TransformResult {
  output: string;
  spans: PatternCoverageSpan[];
}

function createProgramForSource(
  fileName: string,
  source: string,
  scriptKind = ts.ScriptKind.TSX,
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2020,
    true,
    scriptKind,
  );
  const host = ts.createCompilerHost(compilerOptions);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);

  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? sourceFile
      : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.readFile = (name) => name === fileName ? source : baseReadFile(name);
  host.fileExists = (name) => name === fileName || baseFileExists(name);

  return {
    program: ts.createProgram([fileName], compilerOptions, host),
    sourceFile,
  };
}

function printResult(result: ts.TransformationResult<ts.SourceFile>): string {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  try {
    return printer.printFile(result.transformed[0]);
  } finally {
    result.dispose();
  }
}

function transformWithCoverage(
  source: string,
  options: Partial<PatternCoverageOptions> = {},
): TransformResult {
  const fileName = "/pattern.tsx";
  const { program, sourceFile } = createProgramForSource(fileName, source);
  const spans: PatternCoverageSpan[] = [];
  const coverage: PatternCoverageOptions = {
    ...options,
    registerSpan: (span) => {
      spans.push(span);
      options.registerSpan?.(span);
    },
  };
  const transformer = new PatternCoverageTransformer({
    patternCoverage: coverage,
  });
  const result = ts.transform(sourceFile, [transformer.toFactory(program)]);

  return {
    output: printResult(result),
    spans,
  };
}

function transformWithDirectCall(source: string): string {
  const fileName = "/pattern.tsx";
  const { program, sourceFile } = createProgramForSource(fileName, source);
  const transformer = new PatternCoverageTransformer({});
  const result = ts.transform(sourceFile, [
    (tsContext) => (file) => {
      const context = new TransformationContext({
        program,
        sourceFile: file,
        tsContext,
        options: {},
      });
      return transformer.transform(context);
    },
  ]);

  return printResult(result);
}

// Every emitted `globalThis.__cfPatternCoverage?.hit(file, id)` call, with its
// arguments evaluated to their JS values. The callee is an optional-chain member
// access, so it is matched by checking the `.hit` member name rather than by a
// simple call-name lookup. Parens are unwrapped first so a callee printed in
// either form is matched.
function hitCallArgs(root: ts.Node): unknown[][] {
  return collect(root, ts.isCallExpression)
    .filter((call) => {
      let callee: ts.Expression = call.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      return ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "hit";
    })
    .map((call) => call.arguments.map((arg) => literalToValue(arg)));
}

function sourceTextForSpan(source: string, span: PatternCoverageSpan): string {
  return source.split("\n").slice(span.startLine - 1, span.endLine).join("\n");
}

function expectSpanContaining(
  spans: PatternCoverageSpan[],
  source: string,
  text: string,
): void {
  assertEquals(
    spans.some((span) => sourceTextForSpan(source, span).includes(text)),
    true,
  );
}

function expectNoSpanContaining(
  spans: PatternCoverageSpan[],
  source: string,
  text: string,
): void {
  assertEquals(
    spans.some((span) => sourceTextForSpan(source, span).includes(text)),
    false,
  );
}

Deno.test("instrumented code runs without a collector installed", () => {
  // The probe has to be part of the optional chain. Emitted as a plain call
  // around a chained callee it prints `(globalThis.__cfPatternCoverage?.hit)(…)`,
  // whose parens end the chain: the short-circuit yields `undefined` and calling
  // it throws. Every runtime that evaluates an instrumented body without
  // installing the collector would then fail, so this pins the behavior rather
  // than the printed shape — a regex on the emit cannot tell the two apart at a
  // glance, and the throwing form looks correct.
  const { output: emitted } = transformWithCoverage(
    ["const top = 1;", "function run() {", "  return top + 1;", "}"].join("\n"),
  );
  assert(emitted.includes("__cfPatternCoverage?.hit"));

  const globals = globalThis as Record<string, unknown>;
  assertEquals(globals.__cfPatternCoverage, undefined);
  // Runs the module body's probes, then the function body's via run().
  const run = new Function(`${emitted}\nreturn run;`)();
  run();

  // With a collector installed the same code reports its hits.
  const hits: [string, number][] = [];
  globals.__cfPatternCoverage = {
    hit: (file: string, id: number) => hits.push([file, id]),
  };
  try {
    new Function(`${emitted}\nreturn run;`)()();
    assert(hits.length > 0);
    assert(hits.every(([file]) => file === "/pattern.tsx"));
  } finally {
    delete globals.__cfPatternCoverage;
  }
});

Deno.test("PatternCoverageTransformer skips files when coverage is disabled", () => {
  const source = "const value = 1;";
  const { program, sourceFile } = createProgramForSource(
    "/pattern.tsx",
    source,
  );
  const transformer = new PatternCoverageTransformer({});
  const result = ts.transform(sourceFile, [transformer.toFactory(program)]);

  assertEquals(printResult(result), "const value = 1;\n");
  assertEquals(transformWithDirectCall(source), "const value = 1;\n");
});

Deno.test("PatternCoverageTransformer skips declaration files", () => {
  const source = "declare const value: string;";
  const { program, sourceFile } = createProgramForSource(
    "/types.d.ts",
    source,
    ts.ScriptKind.TS,
  );
  const spans: PatternCoverageSpan[] = [];
  const transformer = new PatternCoverageTransformer({
    patternCoverage: {
      registerSpan: (span) => spans.push(span),
    },
  });
  const result = ts.transform(sourceFile, [transformer.toFactory(program)]);

  assertEquals(printResult(result), "declare const value: string;\n");
  assertEquals(spans, []);
});

Deno.test("PatternCoverageTransformer instruments runtime statements", () => {
  const source = `import "./dep.ts";
export type ExportedType = string;
interface Shape {
  value: string;
}
type Alias = number;
declare const declaredValue: string;
declare namespace Ambient {
  export const ambientValue: number;
}
const enum Hidden {
  A,
}
namespace TypeOnly {
  export interface Inner {
    value: string;
  }
  export type Name = string;
}
namespace NestedTypeOnly {
  export namespace Inner {
    export interface Value {
      value: string;
    }
  }
}
namespace DottedTypeOnly.Inner {
  export interface Value {
    value: string;
  }
}
namespace RuntimeNamespace {
  export const value = 1;
}
const skipMe = "not registered";
const topLevel = 1;
if (topLevel > 0) {
  console.log(topLevel);
}
function declaredFunction(flag: boolean) {
  const inside = flag ? 1 : 2;
  return inside;
}
const expressionFunction = function () {
  const local = declaredFunction(true);
  return local;
};
const arrowBlock = () => {
  const local = 1;
  return local;
};
const arrowExpression = (value: number) => value + topLevel;
class Demo {
  static value = 0;
  static {
    Demo.value = 1;
  }
  value = 0;
  constructor() {
    this.value = 1;
  }
  get count() {
    return this.value;
  }
  set count(value: number) {
    this.value = value;
  }
  method() {
    return arrowExpression(this.value);
  }
}
export {};
`;
  const { output, spans } = transformWithCoverage(source, {
    fileName: (sourceFileName) => `mapped:${sourceFileName}`,
    mapSpan: (span) => {
      const line = source.split("\n")[span.startLine - 1] ?? "";
      if (line.includes("skipMe")) return undefined;
      return { ...span, id: span.id + 1000 };
    },
  });

  assertEquals(
    spans.every((span) => span.fileName === "mapped:/pattern.tsx"),
    true,
  );
  assertEquals(spans.every((span) => span.id > 1000), true);
  assertEquals(
    spans.some((span) => {
      const line = source.split("\n")[span.startLine - 1] ?? "";
      return line.includes("skipMe");
    }),
    false,
  );
  expectNoSpanContaining(spans, source, 'import "./dep.ts";');
  expectNoSpanContaining(spans, source, "export type ExportedType = string;");
  expectNoSpanContaining(spans, source, "interface Shape");
  expectNoSpanContaining(spans, source, "type Alias = number;");
  expectNoSpanContaining(spans, source, "declare const declaredValue");
  expectNoSpanContaining(spans, source, "declare namespace Ambient");
  expectNoSpanContaining(spans, source, "ambientValue");
  expectNoSpanContaining(spans, source, "const enum Hidden");
  expectNoSpanContaining(spans, source, "namespace TypeOnly");
  expectNoSpanContaining(spans, source, "namespace NestedTypeOnly");
  expectNoSpanContaining(spans, source, "namespace DottedTypeOnly");
  expectSpanContaining(spans, source, "namespace RuntimeNamespace");
  expectSpanContaining(spans, source, "const topLevel = 1;");
  expectSpanContaining(spans, source, "if (topLevel > 0)");
  expectSpanContaining(spans, source, "const inside = flag ? 1 : 2;");
  expectSpanContaining(spans, source, "return inside;");
  expectSpanContaining(spans, source, "const local = declaredFunction(true);");
  expectSpanContaining(spans, source, "const local = 1;");
  expectSpanContaining(spans, source, "value + topLevel");
  expectSpanContaining(spans, source, "Demo.value = 1;");
  expectSpanContaining(spans, source, "this.value = 1;");
  expectSpanContaining(spans, source, "return this.value;");
  expectSpanContaining(spans, source, "this.value = value;");
  expectSpanContaining(spans, source, "return arrowExpression(this.value);");
  const root = parseModule(output);
  // The first mapped span (id 1 + 1000) becomes a hit call keyed by the mapped
  // file name and mapped id.
  assert(
    hitCallArgs(root).some((args) =>
      args.length === 2 && args[0] === "mapped:/pattern.tsx" && args[1] === 1001
    ),
    "expected a hit call for the mapped file and id 1001",
  );
  // The authored `declaredFunction(flag: boolean)` signature survives the
  // instrumenting transform.
  const declared = collect(root, ts.isFunctionDeclaration).find((fn) =>
    fn.name?.text === "declaredFunction"
  );
  assert(declared, "expected declaredFunction to be emitted");
  const flag = declared.parameters[0];
  assert(flag && ts.isIdentifier(flag.name) && flag.name.text === "flag");
  assertEquals(flag.type?.kind, ts.SyntaxKind.BooleanKeyword);
  assertMatch(
    output,
    /function declaredFunction\(flag: boolean\) \{\s+globalThis\.__cfPatternCoverage\?\.hit/,
  );
  assertMatch(
    output,
    /const arrowExpression = \(value: number\) => \{\s+globalThis\.__cfPatternCoverage\?\.hit[\s\S]+return value \+ topLevel;/,
  );
  assertMatch(
    output,
    /constructor\(\) \{\s+globalThis\.__cfPatternCoverage\?\.hit/,
  );
  assertMatch(
    output,
    /get count\(\) \{\s+globalThis\.__cfPatternCoverage\?\.hit/,
  );
  assertMatch(
    output,
    /set count\(value: number\) \{\s+globalThis\.__cfPatternCoverage\?\.hit/,
  );
  assertMatch(
    output,
    /method\(\) \{\s+globalThis\.__cfPatternCoverage\?\.hit/,
  );
});

Deno.test("PatternCoverageTransformer maps every registered span", () => {
  const source = `const first = 1;
function run() {
  const second = 2;
  return second;
}
`;
  const { spans } = transformWithCoverage(source, {
    fileName: () => "mapped:/pattern.tsx",
    mapSpan: (span) => ({
      ...span,
      id: span.id + 10,
      startLine: span.startLine + 100,
      endLine: span.endLine + 100,
    }),
  });

  assertEquals(spans, [
    {
      fileName: "mapped:/pattern.tsx",
      id: 11,
      kind: "runtime",
      startLine: 101,
      endLine: 101,
      startColumn: 1,
      endColumn: 16,
    },
    {
      fileName: "mapped:/pattern.tsx",
      id: 12,
      kind: "runtime",
      startLine: 103,
      endLine: 103,
      startColumn: 3,
      endColumn: 19,
    },
    {
      fileName: "mapped:/pattern.tsx",
      id: 13,
      kind: "runtime",
      startLine: 104,
      endLine: 104,
      startColumn: 3,
      endColumn: 16,
    },
  ]);
});

Deno.test("PatternCoverageTransformer leaves directive prologues first", () => {
  const source = `"use strict";
const top = 1;
function run() {
  "use strict";
  const value = 1;
  return value;
}
`;
  const { output, spans } = transformWithCoverage(source);

  expectSpanContaining(spans, source, "const top = 1;");
  expectSpanContaining(spans, source, "const value = 1;");
  assertMatch(
    output,
    /^"use strict";\s+globalThis\.__cfPatternCoverage\?\.hit[\s\S]+const top = 1;/,
  );
  assertMatch(
    output,
    /function run\(\) \{\s+"use strict";\s+globalThis\.__cfPatternCoverage\?\.hit/,
  );
});

Deno.test("CommonFabricTransformerPipeline clears diagnostics", () => {
  const pipeline = new CommonFabricTransformerPipeline();
  const diagnostics = pipeline.getDiagnostics() as TransformationDiagnostic[];
  diagnostics.push({
    severity: "error",
    type: "test",
    message: "diagnostic for clear test",
    fileName: "/test.ts",
    line: 1,
    column: 1,
    start: 0,
    length: 1,
  });
  assertEquals(pipeline.getDiagnostics().length, 1);
  pipeline.clearDiagnostics();
  assertEquals(pipeline.getDiagnostics(), []);
});

Deno.test("statements rebuilt as synthetic nodes still get coverage", () => {
  const fileName = "/pattern.tsx";
  const source = "const keep = 1;\nconst drop = 2;\n";
  const { program, sourceFile } = createProgramForSource(fileName, source);
  const spans: PatternCoverageSpan[] = [];

  // Model an earlier pipeline stage that rebuilds `drop` as a fresh node (pos
  // === end === -1) while keeping a link to the authored node via
  // setOriginalNode, as factory updates and lowerings do.
  const rebuildDropStatement: ts.TransformerFactory<ts.SourceFile> = (
    tsContext,
  ) =>
  (file) => {
    const statements = file.statements.map((statement) => {
      if (
        ts.isVariableStatement(statement) &&
        ts.isIdentifier(statement.declarationList.declarations[0]!.name) &&
        statement.declarationList.declarations[0]!.name.text === "drop"
      ) {
        const rebuilt = tsContext.factory.createVariableStatement(
          undefined,
          tsContext.factory.createVariableDeclarationList(
            [tsContext.factory.createVariableDeclaration(
              "drop",
              undefined,
              undefined,
              tsContext.factory.createNumericLiteral(2),
            )],
            ts.NodeFlags.Const,
          ),
        );
        return ts.setOriginalNode(rebuilt, statement);
      }
      return statement;
    });
    return tsContext.factory.updateSourceFile(file, statements);
  };

  const transformer = new PatternCoverageTransformer({
    patternCoverage: { registerSpan: (span) => spans.push(span) },
  });
  ts.transform(sourceFile, [
    rebuildDropStatement,
    transformer.toFactory(program),
  ]).dispose();

  // Both authored statements must be instrumented; the rebuilt `drop` keeps its
  // authored line (2) through its linked original node.
  assertEquals(spans.length, 2);
  assertEquals(spans.map((span) => span.startLine).sort((a, b) => a - b), [
    1,
    2,
  ]);
});

Deno.test("a synthetic statement with no original keeps its source map range", () => {
  const fileName = "/pattern.tsx";
  const source = "const keep = 1;\nconst drop = 2;\n";
  const { program, sourceFile } = createProgramForSource(fileName, source);
  const spans: PatternCoverageSpan[] = [];

  // Model a stage that rebuilds `drop` without linking the authored node, and
  // records where it came from as a source map range instead. That range is
  // the only thing left to place the span by.
  const rebuildWithSourceMapRange: ts.TransformerFactory<ts.SourceFile> = (
    tsContext,
  ) =>
  (file) => {
    const statements = file.statements.map((statement) => {
      if (
        ts.isVariableStatement(statement) &&
        ts.isIdentifier(statement.declarationList.declarations[0]!.name) &&
        statement.declarationList.declarations[0]!.name.text === "drop"
      ) {
        const rebuilt = tsContext.factory.createVariableStatement(
          undefined,
          tsContext.factory.createVariableDeclarationList(
            [tsContext.factory.createVariableDeclaration(
              "drop",
              undefined,
              undefined,
              tsContext.factory.createNumericLiteral(2),
            )],
            ts.NodeFlags.Const,
          ),
        );
        return ts.setSourceMapRange(rebuilt, {
          pos: statement.getStart(file),
          end: statement.getEnd(),
        });
      }
      return statement;
    });
    return tsContext.factory.updateSourceFile(file, statements);
  };

  const transformer = new PatternCoverageTransformer({
    patternCoverage: { registerSpan: (span) => spans.push(span) },
  });
  ts.transform(sourceFile, [
    rebuildWithSourceMapRange,
    transformer.toFactory(program),
  ]).dispose();

  assertEquals(spans.length, 2);
  assertEquals(spans.map((span) => span.startLine).sort((a, b) => a - b), [
    1,
    2,
  ]);
});

Deno.test("leading non-directive string statement is instrumented", () => {
  const source = `function f() {
  "leading note";
  doStuff();
}
`;
  const { spans } = transformWithCoverage(source);

  expectSpanContaining(spans, source, "doStuff();");
  // The bare `"leading note";` statement is on authored line 2; a span must
  // start there.
  assertEquals(spans.some((span) => span.startLine === 2), true);
});

Deno.test("empty fall-through switch case is recorded", () => {
  const source = `const x = 2;
switch (x) {
  case 1:
  case 2:
    doTwo();
    break;
}
`;
  const { spans } = transformWithCoverage(source);
  const caseOneLine =
    source.split("\n").findIndex((line) => line.includes("case 1:")) + 1;

  expectSpanContaining(spans, source, "doTwo();");
  // A span must start on the `case 1:` label line so reaching the case is
  // recorded.
  assertEquals(spans.some((span) => span.startLine === caseOneLine), true);
});

Deno.test("switch default clause statements are recorded", () => {
  const source = `const x = 3;
switch (x) {
  case 1:
    doOne();
    break;
  default:
    doDefault();
}
`;
  const { output, spans } = transformWithCoverage(source);

  // The default clause is rebuilt like a case clause, so its statements carry
  // their own span rather than inheriting the switch's.
  expectSpanContaining(spans, source, "doOne();");
  expectSpanContaining(spans, source, "doDefault();");
  // The rebuilt clause is what carries the hit call into the emitted code.
  assertMatch(
    output,
    /default:\s+globalThis\.__cfPatternCoverage\?\.hit\([\s\S]+?\);\s+doDefault\(\);/,
  );
});

Deno.test("an empty switch default clause is recorded at its label", () => {
  const source = `const x = 3;
switch (x) {
  case 1:
    doOne();
    break;
  default:
}
`;
  const { output, spans } = transformWithCoverage(source);
  const defaultLine =
    source.split("\n").findIndex((line) => line.includes("default:")) + 1;

  // A clause with no statements gets a hit call of its own, so falling into
  // the default is recorded even though it does nothing.
  assertEquals(spans.some((span) => span.startLine === defaultLine), true);
  assertMatch(
    output,
    /default:\s+globalThis\.__cfPatternCoverage\?\.hit\([\s\S]+?\);\s+\}/,
  );
});

Deno.test("single-statement control-flow bodies are wrapped and recorded", () => {
  const source = `const flag = 1;
if (flag > 0) doThen(); else doElse();
if (flag > 0) doIfOnly();
while (flag < 0) doWhile();
do doDo(); while (flag < 0);
for (let i = 0; i < 0; i++) doFor();
`;
  const { output, spans } = transformWithCoverage(source);

  // Each non-block branch/body is instrumented even without braces.
  expectSpanContaining(spans, source, "doThen();");
  expectSpanContaining(spans, source, "doElse();");
  expectSpanContaining(spans, source, "doWhile();");
  expectSpanContaining(spans, source, "doDo();");
  expectSpanContaining(spans, source, "doFor();");

  // The bare statements are lifted into blocks carrying a hit call.
  assertMatch(
    output,
    /if \(flag > 0\)\s*\{\s+globalThis\.__cfPatternCoverage\?\.hit[\s\S]+doThen\(\);/,
  );
  assertMatch(
    output,
    /while \(flag < 0\)\s*\{\s+globalThis\.__cfPatternCoverage\?\.hit[\s\S]+doWhile\(\);/,
  );
});
