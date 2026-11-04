import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import type {
  PatternCoverageKind,
  PatternCoverageSpan,
} from "@commonfabric/ts-transformers";
import { FABRIC_MOUNT_ROOT } from "./sandbox/module-record-compiler.ts";

export type { PatternCoverageKind, PatternCoverageSpan };

export type PatternCoverageFileReport = {
  path: string;
  spans: (PatternCoverageSpan & { count: number })[];
  totals: {
    runtimeLines: number;
    coveredRuntimeLines: number;
    uncoveredRuntimeLines: number;
  };
  lines: {
    runtime: number[];
    coveredRuntime: number[];
    uncoveredRuntime: number[];
  };
};

export type PatternCoverageReport = {
  version: 1;
  generatedAt: string;
  files: PatternCoverageFileReport[];
  totals: {
    runtimeLines: number;
    coveredRuntimeLines: number;
    uncoveredRuntimeLines: number;
  };
};

export type PatternCoverageReportOptions = {
  root?: string;
  includeTestFiles?: boolean;
};

/**
 * A collector's raw spans and per-span hit counts in a plain-JSON shape that
 * survives serialization across a process, worker, or browser boundary. It
 * carries the unnormalized `fileName`s the transformer baked into the compiled
 * bytes, so a report produced in one realm (a browser worker) can be
 * {@link PatternCoverageCollector.ingest}ed into a collector in another (the
 * test process) with matching `(fileName, id)` keys.
 */
export type PatternCoverageData = {
  spans: PatternCoverageSpan[];
  hits: { fileName: string; id: number; count: number }[];
};

/** Default LCOV test name for pattern-coverage records (see {@link isPatternRuntimeTestName} in the gate). */
export const PATTERN_COVERAGE_TEST_NAME = "pattern-runtime";

/** LCOV test name for pattern coverage collected through the integration jobs. */
export const PATTERN_COVERAGE_INTEGRATION_TEST_NAME =
  "pattern-runtime-integration";

export class PatternCoverageCollector {
  #spans = new Map<string, PatternCoverageSpan>();
  #hits = new Map<string, number>();

  registerSpan(span: PatternCoverageSpan): void {
    this.#spans.set(spanKey(span.fileName, span.id), span);
  }

  registerSpans(spans: readonly PatternCoverageSpan[]): void {
    for (const span of spans) this.registerSpan(span);
  }

  spansForFile(fileName: string): PatternCoverageSpan[] {
    return [...this.#spans.values()]
      .filter((span) => span.fileName === fileName)
      .map((span) => ({ ...span }));
  }

  hit(fileName: string, id: number): void {
    const key = spanKey(fileName, id);
    this.#hits.set(key, (this.#hits.get(key) ?? 0) + 1);
  }

  sandboxGlobal(): { hit: (fileName: string, id: number) => void } {
    return {
      hit: (fileName: string, id: number) => this.hit(fileName, id),
    };
  }

  /**
   * Export this collector's spans and per-span hit counts as plain JSON, so a
   * collector filled in another realm can be moved across a boundary and merged
   * into a collector here with {@link ingest}. `fileName`s are the raw values
   * the transformer baked into the compiled bytes — no path normalization —
   * which is what keeps `(fileName, id)` keys aligned across realms that ran the
   * same bytes.
   */
  toData(): PatternCoverageData {
    const hits: PatternCoverageData["hits"] = [];
    for (const [key, count] of this.#hits) {
      const { fileName, id } = splitSpanKey(key);
      hits.push({ fileName, id, count });
    }
    return { spans: [...this.#spans.values()], hits };
  }

  /**
   * Merge another realm's {@link toData} export into this collector: register
   * its spans (idempotent by `(fileName, id)`) and add its hit counts. A realm
   * that only warm-loaded already-instrumented bytes reports hits with no spans
   * of its own; the spans come from whichever realm compiled the bytes, so the
   * union across realms carries both.
   */
  ingest(data: PatternCoverageData): void {
    this.registerSpans(data.spans);
    for (const { fileName, id, count } of data.hits) {
      if (count === 0) continue;
      const key = spanKey(fileName, id);
      this.#hits.set(key, (this.#hits.get(key) ?? 0) + count);
    }
  }

  report(options: PatternCoverageReportOptions = {}): PatternCoverageReport {
    const files = new Map<
      string,
      (PatternCoverageSpan & { count: number })[]
    >();
    for (const span of this.#spans.values()) {
      const path = normalizeReportPath(span.fileName, options.root);
      if (options.includeTestFiles !== true && isTestFile(path)) continue;
      const spans = files.get(path) ?? [];
      spans.push({
        ...span,
        fileName: path,
        count: this.#hits.get(spanKey(span.fileName, span.id)) ?? 0,
      });
      files.set(path, spans);
    }

    const fileReports = [...files.entries()]
      .map(([path, spans]) => reportForFile(path, spans))
      .sort((a, b) => a.path.localeCompare(b.path));

    const totals = fileReports.reduce(
      (acc, file) => {
        acc.runtimeLines += file.totals.runtimeLines;
        acc.coveredRuntimeLines += file.totals.coveredRuntimeLines;
        acc.uncoveredRuntimeLines += file.totals.uncoveredRuntimeLines;
        return acc;
      },
      {
        runtimeLines: 0,
        coveredRuntimeLines: 0,
        uncoveredRuntimeLines: 0,
      },
    );

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: fileReports,
      totals,
    };
  }
}

declare module "./harness/types.ts" {
  interface TypeScriptHarnessProcessOptions {
    patternCoverage?: PatternCoverageCollector;
  }
}

export async function writePatternCoverageLcov(
  collector: PatternCoverageCollector,
  outputPath: string,
  options: PatternCoverageReportOptions & { testName?: string } = {},
): Promise<void> {
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  await Deno.writeTextFile(
    outputPath,
    patternCoverageReportToLcov(collector.report(options), options.testName),
  );
}

export function patternCoverageReportToLcov(
  report: PatternCoverageReport,
  testName: string = PATTERN_COVERAGE_TEST_NAME,
): string {
  const lines: string[] = [];
  for (const file of report.files) {
    lines.push(`TN:${testName}`);
    lines.push(`SF:${normalizeLcovPath(file.path)}`);

    const hitsByLine = hitsByRuntimeLine(file.spans);

    let coveredLineCount = 0;
    for (const line of file.lines.runtime) {
      const hits = hitsByLine.get(line) ?? 0;
      if (hits > 0) coveredLineCount++;
      lines.push(`DA:${line},${hits}`);
    }
    lines.push(`LF:${file.lines.runtime.length}`);
    lines.push(`LH:${coveredLineCount}`);
    lines.push("end_of_record");
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function reportForFile(
  path: string,
  spans: (PatternCoverageSpan & { count: number })[],
): PatternCoverageFileReport {
  spans.sort((a, b) => a.startLine - b.startLine || a.id - b.id);
  const hitsByLine = hitsByRuntimeLine(spans);
  const runtimeLines = sortedLines(new Set(hitsByLine.keys()));
  const coveredRuntimeLines = runtimeLines.filter((line) =>
    (hitsByLine.get(line) ?? 0) > 0
  );
  const uncoveredRuntimeLines = runtimeLines.filter((line) =>
    (hitsByLine.get(line) ?? 0) === 0
  );

  return {
    path,
    spans,
    totals: {
      runtimeLines: runtimeLines.length,
      coveredRuntimeLines: coveredRuntimeLines.length,
      uncoveredRuntimeLines: uncoveredRuntimeLines.length,
    },
    lines: {
      runtime: runtimeLines,
      coveredRuntime: coveredRuntimeLines,
      uncoveredRuntime: uncoveredRuntimeLines,
    },
  };
}

function hitsByRuntimeLine(
  spans: (PatternCoverageSpan & { count: number })[],
): Map<number, number> {
  const hitsByLine = new Map<number, number>();
  const widthsByLine = new Map<number, number>();
  const boundaryHitsByLine = new Map<number, number>();

  for (const span of spans) {
    if (span.kind !== "runtime") continue;
    const width = spanWidth(span);
    for (let line = span.startLine; line <= span.endLine; line++) {
      if (line === span.startLine || line === span.endLine) {
        boundaryHitsByLine.set(
          line,
          Math.max(boundaryHitsByLine.get(line) ?? 0, span.count),
        );
      }
      const existingWidth = widthsByLine.get(line);
      if (existingWidth === undefined || width < existingWidth) {
        widthsByLine.set(line, width);
        hitsByLine.set(line, span.count);
      } else if (width === existingWidth) {
        hitsByLine.set(line, Math.max(hitsByLine.get(line) ?? 0, span.count));
      }
    }
  }

  for (const [line, hits] of boundaryHitsByLine) {
    hitsByLine.set(line, Math.max(hitsByLine.get(line) ?? 0, hits));
  }

  return hitsByLine;
}

function spanWidth(span: PatternCoverageSpan): number {
  return (span.endLine - span.startLine) * 100_000 +
    Math.max(0, span.endColumn - span.startColumn);
}

function sortedLines(lines: Set<number>): number[] {
  return [...lines].sort((a, b) => a - b);
}

function spanKey(fileName: string, id: number): string {
  return `${fileName}\0${id}`;
}

function splitSpanKey(key: string): { fileName: string; id: number } {
  const separator = key.lastIndexOf("\0");
  return {
    fileName: key.slice(0, separator),
    id: Number(key.slice(separator + 1)),
  };
}

function normalizeReportPath(fileName: string, root?: string): string {
  if (fileName.startsWith("file://")) {
    return fromFileUrl(fileName);
  }
  if (root && fileName.startsWith(FABRIC_MOUNT_ROOT)) {
    return `cf-mount/${fileName.slice(FABRIC_MOUNT_ROOT.length)}`;
  }
  if (fileName.startsWith("/") && root) {
    return resolve(root, fileName.slice(1));
  }
  if (fileName.startsWith("/")) {
    return fileName;
  }
  if (root) return join(root, fileName);
  return fileName;
}

function normalizeLcovPath(fileName: string): string {
  if (fileName.startsWith(FABRIC_MOUNT_ROOT)) {
    return `cf-mount/${fileName.slice(FABRIC_MOUNT_ROOT.length)}`;
  }
  return fileName;
}

function isTestFile(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path);
}

export function patternCoverageOutputPath(
  coverageDir: string,
  testPath: string,
  suffix?: string,
): string {
  const relativePath = relative(Deno.cwd(), testPath).replaceAll("\\", "/");
  const encodedPath = encodePathSegment(relativePath);
  const encodedSuffix = suffix ? encodePathSegment(suffix) : undefined;
  const label = encodedSuffix
    ? `${encodedPath}--${encodedSuffix}`
    : encodedPath;
  return join(coverageDir, `${label}.pattern-coverage.lcov`);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
