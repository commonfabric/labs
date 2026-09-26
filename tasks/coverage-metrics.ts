#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
import * as path from "@std/path";
import { hasExecutableCode } from "./executable-source.ts";
import { type LcovFileCoverage, parseLcovReports } from "./lcov.ts";
import { normalizeLcovInstancePaths } from "./write-coverage-lcov.ts";

export const COVERAGE_PROFILE_ARTIFACT_PREFIX = "coverage-profile-";
export const COVERAGE_METRIC_PREFIX = "coverage-debt:";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SOURCE_ROOTS = ["packages", "tasks"];
const EXCLUDED_PATH_PARTS = new Set([
  ".cache",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "integration",
  "node_modules",
  "test",
  "tests",
]);

const EXCLUDED_RELATIVE_PREFIXES = [
  "packages/generated-patterns/integration/",
  "packages/patterns/factory-outputs/",
  "packages/patterns-saves-backup/",
  "packages/static/assets/",
];

const EXCLUDED_FILE_SUFFIXES = [
  ".bench.ts",
  ".bench.tsx",
  ".d.ts",
  ".spec.ts",
  ".spec.tsx",
  ".test.ts",
  ".test.tsx",
];

export interface CoverageDebtMetricsOptions {
  rootDir: string;
  coverageProfileDir: string;
}

export interface CoverageDebtMetricsFromLcovOptions {
  rootDir: string;
  lcov: string;
}

export interface CoverageDebtMetric {
  name: string;
  uncoveredLines: number;
}

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  metricGroup: string;
  trackedLineCount: number;
}

/** The debt metrics for a coverage profile directory. */
export async function collectCoverageDebtMetrics(
  options: CoverageDebtMetricsOptions,
): Promise<CoverageDebtMetric[]> {
  return await collectCoverageDebtMetricsFromLcov({
    rootDir: options.rootDir,
    lcov: await lcovFromCoverageProfile(options.coverageProfileDir),
  });
}

/**
 * The debt metrics for one joined LCOV report: the uncovered line count of
 * every metric group, and their total.
 *
 * A file the report has no record for is charged by
 * `debtWithoutCoverageRecord()`, which reads the absence as a file no test
 * loaded. That reading holds only where every package ran.
 */
export async function collectCoverageDebtMetricsFromLcov(
  options: CoverageDebtMetricsFromLcovOptions,
): Promise<CoverageDebtMetric[]> {
  const sourceFiles = await collectSourceFiles(options.rootDir);
  const lcovCoverage = parseLcov(options.lcov);

  let workspaceUncovered = 0;
  const groupUncovered = new Map<string, number>();
  const groupNames = new Set(sourceFiles.map((source) => source.metricGroup));

  for (const source of sourceFiles) {
    const coverage = lcovCoverage.get(source.absolutePath);
    const uncovered = coverage
      ? countUncoveredProfileLines(coverage)
      : await debtWithoutCoverageRecord(source);

    workspaceUncovered += uncovered;
    groupUncovered.set(
      source.metricGroup,
      (groupUncovered.get(source.metricGroup) ?? 0) + uncovered,
    );
  }

  const metrics: CoverageDebtMetric[] = [{
    name: `${COVERAGE_METRIC_PREFIX} workspace uncovered lines`,
    uncoveredLines: workspaceUncovered,
  }];

  for (const group of [...groupNames].sort()) {
    metrics.push({
      name: `${COVERAGE_METRIC_PREFIX} ${group} uncovered lines`,
      uncoveredLines: groupUncovered.get(group) ?? 0,
    });
  }

  return metrics;
}

export interface MeasuredSetDebtOptions {
  rootDir: string;

  /** The joined LCOV of everything one measured set's units produced. */
  lcov: string;

  /** The workspace member whose lines are counted, repository-relative. */
  member: string;

  /**
   * Every workspace member, so that a file belonging to a member nested
   * inside this one is charged to that member's set instead of to this
   * one. A line under such a member belongs to one of the two rather than
   * to both.
   */
  members: readonly string[];
}

/** What one measured set's report came to over its member's lines. */
export interface MeasuredSetDebt {
  /** Tracked source lines of the member nothing in the report covered. */
  uncoveredLines: number;

  /**
   * How many of the member's files the report has a record for. Zero
   * says the report measured nothing rather than that it covered
   * nothing, which are different things and call for different
   * treatment.
   */
  files: number;
}

/**
 * What one measured set's report says about its member: the tracked
 * source lines of `member` that the report has no covering record for,
 * and how many of the member's files it has a record for at all.
 *
 * A file the report leaves out is charged by the same rule the
 * repository-wide metric uses, which reads the absence as a file no test
 * in this set loaded. That reading holds here whatever else the run did,
 * because a measured set runs every one of its units.
 */
export async function collectMeasuredSetDebt(
  options: MeasuredSetDebtOptions,
): Promise<MeasuredSetDebt> {
  const sourceFiles = await collectMemberSourceFiles(
    options.rootDir,
    options.member,
    options.members,
  );
  const lcovCoverage = parseLcov(options.lcov);
  let uncoveredLines = 0;
  let files = 0;
  for (const source of sourceFiles) {
    const record = lcovCoverage.get(source.absolutePath);
    // A record naming a file and carrying no line says nothing about it,
    // so it is read as the absence of a record rather than as a file
    // every line of which ran.
    const coverage = record?.lineHits.size ? record : undefined;
    if (coverage) files += 1;
    uncoveredLines += coverage
      ? countUncoveredProfileLines(coverage)
      : await debtWithoutCoverageRecord(source);
  }
  return { uncoveredLines, files };
}

/** The tracked source files one workspace member owns. */
async function collectMemberSourceFiles(
  rootDir: string,
  member: string,
  members: readonly string[],
): Promise<SourceFile[]> {
  const owned = toPosix(member).replace(/^\.\//, "");
  const nested = members
    .map((other) => toPosix(other).replace(/^\.\//, ""))
    .filter((other) => other.startsWith(`${owned}/`))
    .map((other) => `${other}/`);
  const files: SourceFile[] = [];
  const fullRoot = path.join(rootDir, owned);
  // A member the workspace declares always has a directory. Scoring an
  // absent one as nothing uncovered would pass a gate over a name that
  // measures nothing, which is the failure a count of zero cannot be
  // told apart from.
  if (!await existsDirectory(fullRoot)) {
    throw new Error(`no directory for the workspace member ${owned}`);
  }
  for await (const file of walkFiles(fullRoot)) {
    const relativePath = toPosix(path.relative(rootDir, file));
    if (!isTrackedSourcePath(relativePath)) continue;
    if (nested.some((prefix) => relativePath.startsWith(prefix))) continue;
    const content = await Deno.readTextFile(file);
    files.push({
      absolutePath: path.normalize(file),
      relativePath,
      metricGroup: metricGroupFor(relativePath),
      trackedLineCount: countTrackedSourceLines(content),
    });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Helper for `collectCoverageDebtMetricsFromLcov()`, which returns the debt
 * charged to a file the report has no record for. Three different things
 * produce a missing record, and they owe different amounts.
 *
 * A file no test ever loaded owes every tracked line: that is the case this
 * rule exists to catch.
 *
 * A file that opted out of coverage owes nothing. Deno leaves such a file out
 * of the report whether or not a test loaded it, so its absence says nothing
 * about what ran; see `isCoverageIgnoredFile()`.
 *
 * A file that compiles to no executable code — one holding only interfaces,
 * type aliases, or other declarations — owes nothing. It has no statement a
 * test could run, so loading it leaves the report exactly as not loading it
 * does, and no test could ever pay the debt down.
 *
 * The compile happens here, so only files the report leaves out pay for it.
 */
async function debtWithoutCoverageRecord(source: SourceFile): Promise<number> {
  const content = await Deno.readTextFile(source.absolutePath);
  if (isCoverageIgnoredFile(content)) return 0;
  return hasExecutableCode(content, source.absolutePath)
    ? source.trackedLineCount
    : 0;
}

/**
 * Returns whether `content` opts its file out of coverage, which a
 * `// deno-coverage-ignore-file` line comment does when it is the file's first
 * line, or the line after a shebang. Those are the lines Deno reads it from:
 * the same comment anywhere later leaves the file in the report, and so
 * leaves it charged here. Text may follow the directive after whitespace, as
 * in `// deno-coverage-ignore-file -- runs only in a browser`.
 */
export function isCoverageIgnoredFile(content: string): boolean {
  const lines = content.split(/\r?\n/, 2);
  const line = lines[0].startsWith("#!") ? lines[1] ?? "" : lines[0];
  return /^\s*\/\/\s*deno-coverage-ignore-file(?:\s|$)/.test(line);
}

/**
 * Return the uncovered source line numbers for specific files, keyed by their
 * repository-relative POSIX path. Only the requested files are inspected, so a
 * caller that needs per-line detail for a handful of files (e.g. a PR's changed
 * files) does not pay to materialize line arrays for the whole workspace.
 */
export async function collectUncoveredLinesForFiles(
  options: CoverageDebtMetricsFromLcovOptions & { files: Iterable<string> },
): Promise<Map<string, number[]>> {
  const lcovCoverage = parseLcov(options.lcov);
  const result = new Map<string, number[]>();

  for (const requested of options.files) {
    const relativePath = toPosix(requested);
    if (result.has(relativePath) || !shouldTrackSourceFile(relativePath)) {
      continue;
    }

    const absolutePath = path.normalize(
      path.join(options.rootDir, relativePath),
    );
    const coverage = lcovCoverage.get(absolutePath);

    let uncoveredLines: number[];
    if (coverage) {
      uncoveredLines = uncoveredProfileLineNumbers(coverage);
    } else {
      // No coverage record: either no test loaded the file, in which case every
      // tracked line is uncovered, or it opted out of coverage or compiles to
      // no executable code, in which case none of its lines counts (see
      // debtWithoutCoverageRecord).
      let content: string;
      try {
        content = await Deno.readTextFile(absolutePath);
      } catch (error) {
        // A file the PR deletes is in the changed list but absent from the
        // checkout; skip it. Surface any other read failure rather than
        // silently under-reporting coverage.
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      uncoveredLines = !isCoverageIgnoredFile(content) &&
          hasExecutableCode(content, absolutePath)
        ? trackedSourceLineNumbers(content)
        : [];
    }

    if (uncoveredLines.length > 0) result.set(relativePath, uncoveredLines);
  }

  return result;
}

/** One file's lines that this run leaves uncovered and an earlier run covered. */
export interface RegressedSourceLines {
  relativePath: string;
  metricGroup: string;
  lines: number[];
}

export interface RegressedLinesOptions {
  rootDir: string;

  /** LCOV from the run being gated. */
  lcov: string;

  /** LCOV from the `main` run its ratchet baseline came from. */
  baselineLcov: string;

  /** Metric groups to inspect; every other group is left alone. */
  groups: Set<string>;

  /** Repository-relative POSIX paths the pull request changed. */
  changedFiles: Set<string>;
}

/**
 * Find the lines a run leaves uncovered that its baseline run covered, for
 * source files the pull request did not touch.
 *
 * A group can end up over its baseline without the diff adding a single
 * uncovered line, because the two counts come from two separate measurements of
 * the same code. A line reached only on some runs — one whose branch depends on
 * scheduling, on load, or on how test files were distributed — moves the count
 * on its own. This says which lines moved, so the flapping line can be given a
 * test that covers it every time.
 *
 * Files the pull request changed are skipped: their line numbers moved between
 * the two checkouts, so a line number means something different in each report.
 * An untouched file has identical content in both, since the baseline measures
 * the base-branch commit this run merged.
 */
export async function collectRegressedLines(
  options: RegressedLinesOptions,
): Promise<RegressedSourceLines[]> {
  const sourceFiles = await collectSourceFiles(options.rootDir);
  const candidates = sourceFiles.filter((source) =>
    options.groups.has(source.metricGroup) &&
    !options.changedFiles.has(source.relativePath)
  );
  const groupByPath = new Map(
    candidates.map((source) => [source.relativePath, source.metricGroup]),
  );
  const paths = candidates.map((source) => source.relativePath);

  const [now, before] = await Promise.all([
    collectUncoveredLinesForFiles({
      rootDir: options.rootDir,
      lcov: options.lcov,
      files: paths,
    }),
    collectUncoveredLinesForFiles({
      rootDir: options.rootDir,
      lcov: options.baselineLcov,
      files: paths,
    }),
  ]);

  const regressed: RegressedSourceLines[] = [];
  for (const [relativePath, uncoveredNow] of now) {
    const uncoveredBefore = new Set(before.get(relativePath) ?? []);
    const lines = uncoveredNow.filter((line) => !uncoveredBefore.has(line));
    if (lines.length === 0) continue;
    regressed.push({
      relativePath,
      metricGroup: groupByPath.get(relativePath) ??
        metricGroupFor(relativePath),
      lines,
    });
  }
  return regressed.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function collectSourceFiles(
  rootDir: string,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const fullRoot = path.join(rootDir, sourceRoot);
    if (!await existsDirectory(fullRoot)) continue;

    for await (const file of walkFiles(fullRoot)) {
      const relativePath = toPosix(path.relative(rootDir, file));
      if (!shouldTrackSourceFile(relativePath)) continue;

      const content = await Deno.readTextFile(file);
      files.push({
        absolutePath: path.normalize(file),
        relativePath,
        metricGroup: metricGroupFor(relativePath),
        trackedLineCount: countTrackedSourceLines(content),
      });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Whether the metric charges for `relativePath`, a path relative to the
 * repository root. It has to be under a root the metric walks as well as pass
 * the file-level test below, which `collectSourceFiles` applies in that order.
 */
export function isTrackedSourcePath(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  const underSourceRoot = SOURCE_ROOTS.some((sourceRoot) =>
    normalized.startsWith(`${sourceRoot}/`)
  );
  return underSourceRoot && shouldTrackSourceFile(normalized);
}

export function shouldTrackSourceFile(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  if (normalized === "scripts" || normalized.startsWith("scripts/")) {
    return false;
  }

  const extension = path.extname(normalized);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;

  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return false;
  }

  if (
    EXCLUDED_RELATIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return false;
  }

  const parts = normalized.split("/");
  return !parts.some((part) => EXCLUDED_PATH_PARTS.has(part));
}

export function metricGroupFor(relativePath: string): string {
  const normalized = toPosix(relativePath);
  const parts = normalized.split("/");
  if (parts[0] === "packages" && parts[1]) {
    return `packages/${parts[1]}`;
  }
  return parts[0] ?? "workspace";
}

export function countTrackedSourceLines(content: string): number {
  return trackedSourceLineNumbers(content).length;
}

export function trackedSourceLineNumbers(content: string): number[] {
  const lineNumbers: number[] = [];
  let inBlockComment = false;

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    let text = lines[index].trim();
    if (text.length === 0) continue;

    while (text.length > 0) {
      if (inBlockComment) {
        const end = text.indexOf("*/");
        if (end < 0) {
          text = "";
          break;
        }
        text = text.slice(end + 2).trim();
        inBlockComment = false;
        continue;
      }

      if (text.startsWith("//")) {
        text = "";
        break;
      }

      if (text.startsWith("/*")) {
        const end = text.indexOf("*/", 2);
        if (end < 0) {
          text = "";
          inBlockComment = true;
          break;
        }
        text = text.slice(end + 2).trim();
        continue;
      }

      lineNumbers.push(index + 1);
      break;
    }
  }

  return lineNumbers;
}

/**
 * Read one `deno coverage --lcov` report, keyed by normalized source path.
 *
 * Per-instance suffixes (`?testRun=<uuid>` cache-busting imports) are
 * normalized away at LCOV GENERATION (write-coverage-lcov.ts,
 * `normalizeLcovInstancePaths` — CT-1861), so records arriving here already
 * share one path per physical file; duplicate `SF:` sections accumulate into
 * the same entry.
 */
export function parseLcov(lcov: string): Map<string, LcovFileCoverage> {
  return parseLcovReports([lcov], { mapPath: path.normalize });
}

export function countUncoveredProfileLines(coverage: LcovFileCoverage): number {
  return uncoveredProfileLineNumbers(coverage).length;
}

function uncoveredProfileLineNumbers(coverage: LcovFileCoverage): number[] {
  const lineNumbers: number[] = [];
  for (const [lineNumber, hits] of coverage.lineHits) {
    if (hits === 0) lineNumbers.push(lineNumber);
  }
  return lineNumbers.sort((a, b) => a - b);
}

/** Run `deno coverage --lcov` over a profile directory and return the report. */
export async function lcovFromCoverageProfile(
  coverageProfileDir: string,
): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "coverage-lcov-" });
  const outputPath = path.join(tmpDir, "coverage.lcov");
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "coverage",
        "--lcov",
        `--output=${outputPath}`,
        coverageProfileDir,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`deno coverage failed: ${stderr.trim()}`);
    }

    // Same generation-point normalization the CI artifact writer applies
    // (write-coverage-lcov.ts) — this is the LOCAL generation path.
    return normalizeLcovInstancePaths(await Deno.readTextFile(outputPath));
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

async function existsDirectory(dir: string): Promise<boolean> {
  try {
    return (await Deno.stat(dir)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function toPosix(filePath: string): string {
  return filePath.split(path.SEPARATOR).join("/");
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory && EXCLUDED_PATH_PARTS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory) {
      yield* walkFiles(full);
    } else {
      yield full;
    }
  }
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (const arg of Deno.args) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1], match[2]);
  }

  const rootDir = args.get("root") ?? Deno.cwd();
  const coverageProfileDir = args.get("profile-dir");
  if (!coverageProfileDir) {
    console.error("--profile-dir is required.");
    Deno.exit(1);
  }

  const metrics = await collectCoverageDebtMetrics({
    rootDir,
    coverageProfileDir,
  });
  console.log(JSON.stringify({ metrics }, null, 2));
}
