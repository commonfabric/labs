import { assert, assertEquals, assertObjectMatch } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { setCompileCacheRuntimeVersionForTesting } from "../src/compilation-cache/cell-cache.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  PatternCoverageCollector,
  patternCoverageOutputPath,
  patternCoverageReportToLcov,
  Runtime,
  type RuntimeProgram,
  writePatternCoverageLcov,
} from "../src/index.ts";

function lineContaining(source: string, text: string): number {
  const line = source.split("\n").findIndex((entry) => entry.includes(text));
  if (line < 0) throw new Error(`Could not find source line: ${text}`);
  return line + 1;
}

function lineHits(lcov: string, sourcePath: string): Map<number, number> {
  const hits = new Map<number, number>();
  let inSource = false;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      inSource = line === `SF:${sourcePath}`;
      continue;
    }
    if (line === "end_of_record") {
      inSource = false;
      continue;
    }
    if (!inSource || !line.startsWith("DA:")) continue;
    const [lineNumber, count] = line.slice(3).split(",").map(Number);
    hits.set(lineNumber, count);
  }
  return hits;
}

function assertLineHit(
  source: string,
  lcov: string,
  sourcePath: string,
  sourceLineText: string,
): void {
  const hits = lineHits(lcov, sourcePath);
  assert((hits.get(lineContaining(source, sourceLineText)) ?? 0) > 0);
}

function assertLineMiss(
  source: string,
  lcov: string,
  sourcePath: string,
  sourceLineText: string,
): void {
  const hits = lineHits(lcov, sourcePath);
  assertEquals(hits.get(lineContaining(source, sourceLineText)), 0);
}

Deno.test("pattern coverage records original runtime lines", async () => {
  const identity = await Identity.fromPassphrase("pattern coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "export function choose(value: number) {",
            "  const next = value + 1;",
            "  if (next > 1) {",
            "    return next;",
            "  }",
            "  return 0;",
            "}",
          ].join("\n"),
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(typeof main.choose, "function");
    assertEquals(main.choose(1), 2);

    const report = coverage.report();
    assertObjectMatch(report.totals, {
      coveredRuntimeLines: 4,
      uncoveredRuntimeLines: 1,
    });
    assertEquals(report.files[0].path, "/main.tsx");
    assertEquals(report.files[0].lines.coveredRuntime, [2, 3, 4, 5]);
    assertEquals(report.files[0].lines.uncoveredRuntime, [6]);

    assertEquals(
      patternCoverageReportToLcov(report),
      [
        "TN:pattern-runtime",
        "SF:/main.tsx",
        "DA:2,1",
        "DA:3,1",
        "DA:4,1",
        "DA:5,1",
        "DA:6,0",
        "LF:5",
        "LH:4",
        "end_of_record",
        "",
      ].join("\n"),
    );
    assertEquals(
      patternCoverageOutputPath(
        "/tmp/coverage",
        `${Deno.cwd()}/pattern.test.tsx`,
      ),
      "/tmp/coverage/pattern.test.tsx.pattern-coverage.lcov",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage records top-level runtime lines", async () => {
  const identity = await Identity.fromPassphrase("top-level coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "export const first = 1;",
            "export const result = 2;",
          ].join("\n"),
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.result, 2);

    const report = coverage.report();
    assertObjectMatch(report.totals, {
      coveredRuntimeLines: 2,
      uncoveredRuntimeLines: 0,
    });
    assertEquals(report.files[0].lines.coveredRuntime, [1, 2]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage skips erased type-only namespaces", async () => {
  const identity = await Identity.fromPassphrase(
    "type namespace coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "namespace Types {",
            "  export interface Value { value: number }",
            "}",
            "export type Result = Types.Value;",
            "export const result = 1;",
          ].join("\n"),
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.result, 1);

    const report = coverage.report();
    assertObjectMatch(report.totals, {
      coveredRuntimeLines: 1,
      uncoveredRuntimeLines: 0,
    });
    assertEquals(report.files[0].lines.coveredRuntime, [5]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage does not let outer spans cover unrun callback bodies", async () => {
  const identity = await Identity.fromPassphrase(
    "unrun callback coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      'import { handler } from "commonfabric";',
      "export const unused = handler(false, false, () => {",
      "  const never = 1;",
      "  return never;",
      "});",
      "export const loaded = 1;",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.loaded, 1);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "export const unused");
    assertLineMiss(source, lcov, "/main.tsx", "const never = 1;");
    assertLineMiss(source, lcov, "/main.tsx", "return never;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage records taken and untaken control-flow branches", async () => {
  const identity = await Identity.fromPassphrase("branch coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      "export function choose(flag: boolean) {",
      "  let value = 0;",
      "  if (flag) {",
      "    value = 1;",
      "  } else {",
      "    value = 2;",
      "  }",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.choose(true), 1);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "value = 1;");
    assertLineMiss(source, lcov, "/main.tsx", "value = 2;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage treats compact control flow as line coverage", async () => {
  const identity = await Identity.fromPassphrase(
    "compact branch coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      "export function choose(flag: boolean) {",
      "  let value = 0;",
      "  if (flag) value = 1;",
      "  for (let i = 0; i < 2; i++) if (flag) value++;",
      "  if (flag) { value = 2;",
      "  }",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.choose(false), 0);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "if (flag) value = 1;");
    assertLineHit(source, lcov, "/main.tsx", "for (let i = 0;");
    assertLineHit(source, lcov, "/main.tsx", "if (flag) { value = 2;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage keeps authored lines for mixed default and named imports", async () => {
  const identity = await Identity.fromPassphrase("mixed import coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      'import base, { extra } from "./dep.ts";',
      "export function run() {",
      "  const value = base + extra;",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: source },
        {
          name: "/dep.ts",
          contents: "export default 1;\nexport const extra = 2;",
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.run(), 3);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "const value = base + extra;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage keeps authored lines when Common Fabric transform is disabled", async () => {
  const identity = await Identity.fromPassphrase(
    "disabled transform coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      "export function run() {",
      "  const value = 1;",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.run(), 1);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "const value = 1;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage records callback body lines after the full pipeline", async () => {
  const identity = await Identity.fromPassphrase("callback coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      'import { action, computed, pattern, Writable } from "commonfabric";',
      "export default pattern(() => {",
      "  const count = new Writable(0);",
      "  const inc = action(() => {",
      "    count.set(count.get() + 1);",
      "  });",
      "  const isOne = computed(() => {",
      "    const value = count.get();",
      "    return value === 1;",
      "  });",
      "  return { inc, isOne };",
      "});",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    const resultCell = runtime.getCell(identity.did(), "callback-coverage");
    await runtime.setup(undefined, main.default, {}, resultCell);
    runtime.start(resultCell);
    await resultCell.pull();
    resultCell.key("inc").send({});
    await resultCell.pull();
    await runtime.scheduler.idle();

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "const count = new Writable");
    assertLineHit(source, lcov, "/main.tsx", "count.set(count.get() + 1);");
    assertLineHit(source, lcov, "/main.tsx", "const value = count.get();");
    assertLineHit(source, lcov, "/main.tsx", "return value === 1;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage reports fabric mount paths as virtual paths", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/~cf/fid1abc/main.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.hit("/~cf/fid1abc/main.tsx", 1);

  const report = coverage.report({ root: "/repo" });

  assertEquals(report.files[0].path, "cf-mount/fid1abc/main.tsx");
  assertEquals(
    patternCoverageReportToLcov(report),
    [
      "TN:pattern-runtime",
      "SF:cf-mount/fid1abc/main.tsx",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("pattern coverage keeps raw mount report keys before LCOV emission", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/~cf/fid1abc/main.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.hit("/~cf/fid1abc/main.tsx", 1);

  const report = coverage.report();

  assertEquals(report.files[0].path, "/~cf/fid1abc/main.tsx");
  assertEquals(
    patternCoverageReportToLcov(report),
    [
      "TN:pattern-runtime",
      "SF:cf-mount/fid1abc/main.tsx",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("pattern coverage normalizes file URLs and relative paths", () => {
  const fileUrlCoverage = new PatternCoverageCollector();
  fileUrlCoverage.registerSpan({
    fileName: "file:///tmp/pattern.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(fileUrlCoverage.report().files[0].path, "/tmp/pattern.tsx");

  const absoluteCoverage = new PatternCoverageCollector();
  absoluteCoverage.registerSpan({
    fileName: "/absolute.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(
    absoluteCoverage.report({ root: "/repo" }).files[0].path,
    "/repo/absolute.tsx",
  );

  const relativeCoverage = new PatternCoverageCollector();
  relativeCoverage.registerSpan({
    fileName: "relative.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(
    relativeCoverage.report({ root: "/repo" }).files[0].path,
    "/repo/relative.tsx",
  );
  assertEquals(relativeCoverage.report().files[0].path, "relative.tsx");
});

Deno.test("pattern coverage ignores non-runtime spans", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "non-runtime" as "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertObjectMatch(coverage.report().files[0], {
    totals: {
      runtimeLines: 0,
      coveredRuntimeLines: 0,
      uncoveredRuntimeLines: 0,
    },
  });
});

Deno.test("pattern coverage uses the highest hit count for equal-width spans", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 2,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.hit("/subject.tsx", 1);
  coverage.hit("/subject.tsx", 2);
  coverage.hit("/subject.tsx", 2);

  assertEquals(
    patternCoverageReportToLcov(coverage.report()),
    [
      "TN:pattern-runtime",
      "SF:/subject.tsx",
      "DA:1,2",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("pattern coverage excludes test files by default", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.registerSpan({
    fileName: "/subject.test.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(
    coverage.report().files.map((file) => file.path),
    ["/subject.tsx"],
  );
  assertEquals(
    coverage.report({ includeTestFiles: true }).files.map((file) => file.path),
    ["/subject.test.tsx", "/subject.tsx"],
  );
});

Deno.test("runtime-level coverage instruments the cell-cache compile path", async () => {
  const identity = await Identity.fromPassphrase("cell-cache coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const coverage = new PatternCoverageCollector();
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
    patternCoverage: coverage,
  });
  try {
    const source = [
      'import { pattern } from "commonfabric";',
      'const greeting = "hi";',
      "export default pattern(() => {",
      "  return { greeting };",
      "});",
    ].join("\n");
    // compilePattern with a target space takes the content-addressed cell-cache
    // path (compileViaCellCache) — the same path a piece creation and a browser
    // pattern load take — rather than the direct compile the other tests use.
    await runtime.patternManager.compilePattern(source, {
      space: identity.did(),
    });

    // Prove the cell-cache path actually ran, and cold-compiled. Only
    // compileViaCellCache touches these counters, so the direct compile — which
    // instruments too, and would satisfy the coverage assertions below on its
    // own — leaves them at zero and fails here instead of passing quietly.
    assertEquals(runtime.patternManager.getCompileCacheStats(), {
      hits: 0,
      misses: 1,
      byIdentityHits: 0,
    });

    const report = coverage.report();
    assert(report.files.length > 0, "cell-cache compile registered no spans");
    // The top-level statements run at module evaluation, so they record hits.
    assert(
      report.totals.coveredRuntimeLines > 0,
      "cell-cache compile recorded no covered lines",
    );

    // A stored coverage closure must carry its span metadata back into the
    // engine. Without those spans the engine rejects the cached bodies and
    // recompiles them.
    const { compiler } = await runtime.harness.initialize();
    const originalCompileToModules = compiler.compileToModules;
    const originalCompileToModulesInterleaved =
      compiler.compileToModulesInterleaved;
    const failWarmCompile = () => {
      throw new Error("warm coverage cache recompiled");
    };
    compiler.compileToModules =
      failWarmCompile as typeof compiler.compileToModules;
    compiler.compileToModulesInterleaved =
      failWarmCompile as typeof compiler.compileToModulesInterleaved;
    try {
      await runtime.patternManager.compilePattern(source, {
        space: identity.did(),
      });
    } finally {
      compiler.compileToModules = originalCompileToModules;
      compiler.compileToModulesInterleaved =
        originalCompileToModulesInterleaved;
    }
    assertEquals(runtime.patternManager.getCompileCacheStats(), {
      hits: 1,
      misses: 1,
      byIdentityHits: 0,
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("runtime-level coverage instruments the direct (no-space) compile path", async () => {
  const identity = await Identity.fromPassphrase("direct compile coverage");
  const storageManager = StorageManager.emulate({ as: identity });
  const coverage = new PatternCoverageCollector();
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
    patternCoverage: coverage,
  });
  try {
    const source = [
      'import { pattern } from "commonfabric";',
      'const greeting = "hi";',
      "export default pattern(() => {",
      "  return { greeting };",
      "});",
    ].join("\n");
    // No target space → compilePattern takes the direct compileToRecordGraph
    // path rather than compileViaCellCache.
    await runtime.patternManager.compilePattern(source);
    assert(coverage.report().totals.coveredRuntimeLines > 0);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("runtime-level coverage instruments the cell-cache path with no resolved compile version", async () => {
  const identity = await Identity.fromPassphrase(
    "no-version cell-cache coverage",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const coverage = new PatternCoverageCollector();
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
    patternCoverage: coverage,
  });
  // Force getCompileCacheRuntimeVersion() to resolve undefined, which routes
  // compileViaCellCache through its no-cache-version branch.
  const restore = setCompileCacheRuntimeVersionForTesting(undefined);
  try {
    const source = [
      'import { pattern } from "commonfabric";',
      'const greeting = "hi";',
      "export default pattern(() => {",
      "  return { greeting };",
      "});",
    ].join("\n");
    await runtime.patternManager.compilePattern(source, {
      space: identity.did(),
    });
    assert(coverage.report().totals.coveredRuntimeLines > 0);
  } finally {
    restore();
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("toData/ingest round-trips spans and hit counts", () => {
  const source = new PatternCoverageCollector();
  const span = {
    fileName: "/subject.tsx",
    kind: "runtime" as const,
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  };
  source.registerSpan({ ...span, id: 1 });
  source.registerSpan({ ...span, id: 2, startLine: 2, endLine: 2 });
  source.hit("/subject.tsx", 1);
  source.hit("/subject.tsx", 1);

  // A JSON round-trip stands in for the process/worker boundary the data crosses.
  const data = JSON.parse(JSON.stringify(source.toData()));
  const sink = new PatternCoverageCollector();
  sink.ingest(data);

  assertEquals(
    patternCoverageReportToLcov(sink.report()),
    patternCoverageReportToLcov(source.report()),
  );
});

Deno.test("ingest merges hit-only data against another realm's spans", () => {
  // The realm that compiled the pattern owns the spans; a realm that only
  // warm-loaded the already-instrumented bytes reports hits with no spans. The
  // union carries both, keyed by the fileName the transformer baked in.

  const compiler = new PatternCoverageCollector();
  compiler.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  const merged = new PatternCoverageCollector();
  merged.ingest(compiler.toData()); // spans, no hits (compiler never ran)
  merged.ingest({
    spans: [],
    hits: [{ fileName: "/subject.tsx", id: 1, count: 3 }],
  });

  assertEquals(
    patternCoverageReportToLcov(merged.report()),
    [
      "TN:pattern-runtime",
      "SF:/subject.tsx",
      "DA:1,3",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("ingest ignores zero-count hits", () => {
  // A realm that ran the instrumented bytes but never reached a statement
  // reports it with count 0; merging that must not mark the line covered.

  const collector = new PatternCoverageCollector();
  collector.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  collector.ingest({
    spans: [],
    hits: [{ fileName: "/subject.tsx", id: 1, count: 0 }],
  });
  assertEquals(collector.report().totals.coveredRuntimeLines, 0);
});

Deno.test("writePatternCoverageLcov writes the tagged report to a file", async () => {
  const collector = new PatternCoverageCollector();
  collector.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  collector.hit("/subject.tsx", 1);

  const dir = await Deno.makeTempDir({ prefix: "write-pattern-lcov-" });
  try {
    // A nested path exercises the mkdir the writer does before writing.
    const outputPath = join(dir, "nested", "coverage.lcov");
    await writePatternCoverageLcov(collector, outputPath, {
      testName: PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
    });

    const written = await Deno.readTextFile(outputPath);
    assertEquals(
      written,
      patternCoverageReportToLcov(
        collector.report(),
        PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
      ),
    );
    assert(written.includes("TN:pattern-runtime-integration"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("patternCoverageReportToLcov tags the integration stream", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.hit("/subject.tsx", 1);

  const lcov = patternCoverageReportToLcov(
    coverage.report(),
    PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  );
  assertEquals(lcov.split("\n")[0], "TN:pattern-runtime-integration");
});

Deno.test("pattern coverage output paths distinguish separators from underscores", () => {
  const coverageDir = "/tmp/coverage";
  const cwd = Deno.cwd();
  const withSeparator = patternCoverageOutputPath(
    coverageDir,
    `${cwd}/fixtures/a/b.test.tsx`,
  );
  const withUnderscores = patternCoverageOutputPath(
    coverageDir,
    `${cwd}/fixtures/a__b.test.tsx`,
  );

  assert(withSeparator.includes("fixtures%2Fa%2Fb.test.tsx"));
  assert(withUnderscores.includes("fixtures%2Fa__b.test.tsx"));
  assert(withSeparator !== withUnderscores);
});

// A piece created in one realm and resumed in another loads source-free BY
// IDENTITY: the resuming runtime holds only the entry's content identity, so it
// reads the compiled closure from storage and evaluates it without a compile.
// That path has to carry coverage on its own — it never runs the transformer, so
// the spans naming the instrumented lines can only come from the stored
// document, and the collector only observes probes if it is installed as the
// sandbox global for the evaluation. This is where authored event-handler bodies
// actually execute in the browser.
const RESUME_COVERAGE_SOURCE = [
  `import { handler, pattern, schema, type Stream } from "commonfabric";`,
  `import "commonfabric/schema";`,
  ``,
  `interface Input {`,
  `  messageCount: number;`,
  `}`,
  ``,
  `interface Output {`,
  `  messageCount: number;`,
  `  recordMessage: Stream<{ message: string }>;`,
  `}`,
  ``,
  `const model = schema({`,
  `  type: "object",`,
  `  properties: {`,
  `    messageCount: { type: "number", default: 0, asCell: ["cell"] },`,
  `  },`,
  `  default: { messageCount: 0 },`,
  `});`,
  ``,
  `const recordMessage = handler(`,
  `  {`,
  `    type: "object",`,
  `    properties: { message: { type: "string" } },`,
  `    required: ["message"],`,
  `  },`,
  `  model,`,
  `  (_event, state) => {`,
  `    const next = state.messageCount.get() + 1;`,
  `    state.messageCount.set(next);`,
  `  },`,
  `);`,
  ``,
  `export const coveragePattern = pattern<Input, Output>(`,
  `  (cell) => {`,
  `    return {`,
  `      messageCount: cell.messageCount,`,
  `      recordMessage: recordMessage(cell),`,
  `    };`,
  `  },`,
  `  model,`,
  `);`,
].join("\n");

Deno.test("pattern coverage records a piece resumed by identity", async () => {
  const signer = await Identity.fromPassphrase("by-identity pattern coverage");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });

  const program: RuntimeProgram = {
    main: "/main.tsx",
    mainExport: "coveragePattern",
    files: [{ name: "/main.tsx", contents: RESUME_COVERAGE_SOURCE }],
  };
  const resultCause = "by-identity pattern coverage resume";

  const authorCoverage = new PatternCoverageCollector();
  const resumeCoverage = new PatternCoverageCollector();
  const newRuntime = (patternCoverage: PatternCoverageCollector) =>
    new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      patternCoverage,
    });
  const rt1 = newRuntime(authorCoverage);
  const rt2 = newRuntime(resumeCoverage);
  try {
    // Session 1: compile + run the piece, then flush its compiled closure to
    // storage so a second runtime can resume it.
    const pm1 = rt1.patternManager;
    const tx1 = rt1.edit();
    const cold = await pm1.compilePattern(program, { space, tx: tx1 });
    const resultCell1 = rt1.getCell<Record<string, unknown>>(
      space,
      resultCause,
      undefined,
      tx1,
    );
    const r1 = rt1.run(tx1, cold, {}, resultCell1);
    await tx1.commit().settled;
    await r1.pull();
    await pm1.flushCompileCacheWrites();
    await rt1.storageManager.synced();

    // Session 2: a fresh runtime resumes the SAME piece from storage. Its nodes
    // come from the persisted graph, so resolution runs purely by identity.
    const pm2 = rt2.patternManager;
    const tx2 = rt2.edit();
    const resultCell2 = rt2.getCell<Record<string, unknown>>(
      space,
      resultCause,
      undefined,
      tx2,
    );
    await tx2.commit().settled;
    await resultCell2.sync();
    const started = await rt2.start(resultCell2);
    assertEquals(started, true);
    // Pins the path under test: a cold compile in session 2 would report
    // coverage for its own reasons and let everything below pass vacuously.
    assertEquals(pm2.getCompileCacheStats().byIdentityHits, 1);

    // Drive the handler in the RESUMED runtime — its body runs only on invoke,
    // so the lines asserted below can only be covered by this send.
    await resultCell2.pull();
    resultCell2.key("recordMessage").send({ message: "world" });
    await resultCell2.pull();
    assertEquals(
      (resultCell2.getAsQueryResult() as { messageCount: number }).messageCount,
      1,
    );

    const report = resumeCoverage.report();
    assert(report.files.length > 0);
    assert(report.totals.coveredRuntimeLines > 0);
    const lcov = patternCoverageReportToLcov(report);
    assertLineHit(
      RESUME_COVERAGE_SOURCE,
      lcov,
      "/main.tsx",
      "state.messageCount.set(next);",
    );
  } finally {
    await rt2.dispose();
    await rt1.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage records a piece authored without coverage and resumed with it", async () => {
  // The integration scenario: a non-coverage realm authored the piece, so the
  // coverage-keyed compiled closure the resuming runtime looks for does not
  // exist. The resume then falls back to cold recovery — a recompile from the
  // stored source closure — which is the only place the instrumentation can
  // come from.

  const signer = await Identity.fromPassphrase(
    "cold-recovery pattern coverage",
  );
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });

  const program: RuntimeProgram = {
    main: "/main.tsx",
    mainExport: "coveragePattern",
    files: [{ name: "/main.tsx", contents: RESUME_COVERAGE_SOURCE }],
  };
  const resultCause = "cold-recovery pattern coverage resume";

  const resumeCoverage = new PatternCoverageCollector();
  const healedCoverage = new PatternCoverageCollector();
  const newRuntime = (patternCoverage?: PatternCoverageCollector) =>
    new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      ...(patternCoverage ? { patternCoverage } : {}),
    });
  // Session 1 has coverage OFF, so it writes only the ordinary compiled variant.
  const rt1 = newRuntime();
  const rt2 = newRuntime(resumeCoverage);
  const rt3 = newRuntime(healedCoverage);
  try {
    const pm1 = rt1.patternManager;
    const tx1 = rt1.edit();
    const cold = await pm1.compilePattern(program, { space, tx: tx1 });
    const resultCell1 = rt1.getCell<Record<string, unknown>>(
      space,
      resultCause,
      undefined,
      tx1,
    );
    const r1 = rt1.run(tx1, cold, {}, resultCell1);
    await tx1.commit().settled;
    await r1.pull();
    await pm1.flushCompileCacheWrites();
    await rt1.storageManager.synced();

    // Session 2: coverage ON. Its closure read is keyed by the coverage variant,
    // which session 1 never wrote, so this resume can only be served by the
    // cold-recovery recompile.
    const pm2 = rt2.patternManager;
    const tx2 = rt2.edit();
    const resultCell2 = rt2.getCell<Record<string, unknown>>(
      space,
      resultCause,
      undefined,
      tx2,
    );
    await tx2.commit().settled;
    await resultCell2.sync();
    assertEquals(await rt2.start(resultCell2), true);
    // Pins the path under test. `tryColdLoadByIdentity` is the one load path
    // that touches no counter: a warm by-identity hit (session 1's variant
    // reused, uninstrumented) or a compile through `compilePattern` (which
    // instruments for its own reasons) would each satisfy the coverage
    // assertions below without proving anything about cold recovery.
    assertEquals(pm2.getCompileCacheStats(), {
      hits: 0,
      misses: 0,
      byIdentityHits: 0,
    });

    // Drive the handler in the RESUMED runtime — its body runs only on invoke,
    // so the lines asserted below can only be covered by this send.
    await resultCell2.pull();
    resultCell2.key("recordMessage").send({ message: "world" });
    await resultCell2.pull();
    assertEquals(
      (resultCell2.getAsQueryResult() as { messageCount: number }).messageCount,
      1,
    );

    const report = resumeCoverage.report();
    assert(report.files.length > 0, "cold recovery registered no spans");
    assert(report.totals.coveredRuntimeLines > 0);
    assertLineHit(
      RESUME_COVERAGE_SOURCE,
      patternCoverageReportToLcov(report),
      "/main.tsx",
      "state.messageCount.set(next);",
    );

    // Session 2's recovery wrote its instrumented bodies back under the
    // coverage variant, so a third coverage-on session warm-loads them instead
    // of recompiling, and still reports coverage — the recovery heals the
    // coverage key rather than repeating per session.
    await pm2.flushCompileCacheWrites();
    await rt2.storageManager.synced();

    const pm3 = rt3.patternManager;
    const tx3 = rt3.edit();
    const resultCell3 = rt3.getCell<Record<string, unknown>>(
      space,
      resultCause,
      undefined,
      tx3,
    );
    await tx3.commit().settled;
    await resultCell3.sync();
    assertEquals(await rt3.start(resultCell3), true);
    assertEquals(pm3.getCompileCacheStats().byIdentityHits, 1);

    await resultCell3.pull();
    resultCell3.key("recordMessage").send({ message: "again" });
    await resultCell3.pull();

    const healedReport = healedCoverage.report();
    assert(healedReport.totals.coveredRuntimeLines > 0);
    assertLineHit(
      RESUME_COVERAGE_SOURCE,
      patternCoverageReportToLcov(healedReport),
      "/main.tsx",
      "state.messageCount.set(next);",
    );
  } finally {
    await rt3.dispose();
    await rt2.dispose();
    await rt1.dispose();
    await storageManager.close();
  }
});
