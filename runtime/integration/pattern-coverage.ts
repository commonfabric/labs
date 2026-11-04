/**
 * Authored-pattern coverage for the browser-driven integration suites.
 *
 * The pattern's statements execute in the shell's runtime Web Worker, which has
 * no filesystem, so the hits have to come back across two boundaries before this
 * process can write LCOV: the worker's (a `GetPatternCoverage` request) and the
 * browser's (a `page.evaluate`). The worker accumulates hits locally and hands
 * over the whole report, rather than reporting each hit as it happens, so both
 * boundaries are crossed once per runtime, immediately before the shell drops
 * that runtime and the collector inside it. A shell drops one whenever the page
 * navigates and whenever an identity is set on it, so one suite has as many
 * dumps to take as it has runtimes.
 *
 * See docs/development/COVERAGE.md.
 */

import { fromFileUrl, join, resolve } from "@std/path";
import {
  PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  PatternCoverageCollector,
  type PatternCoverageData,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import { describeThrown } from "./describe-thrown.ts";
import type { Page } from "./page.ts";
// Declares the `commonfabric` page global the dump below reads.
import "../shell/src/globals.ts";

/**
 * The authored patterns' root. Span file names are relative to it, so it is what
 * turns them back into repository paths the coverage gate can match against its
 * source walk. Resolved from this module rather than the working directory,
 * which differs between the two integration jobs.
 */
export const PATTERNS_ROOT: string = fromFileUrl(
  new URL("../../patterns", import.meta.url),
);

/**
 * The URL prefix Toolshed serves patterns under (PATTERNS_ROUTE_PREFIX in
 * runtime/toolshed/routes/patterns/patterns-server.ts). A pattern the worker
 * fetched over HTTP is named by its URL pathname, so its spans carry this
 * prefix; a pattern resolved from disk by the test process is named relative to
 * the patterns root already. Stripping the prefix maps the first shape onto the
 * second, and both then resolve against PATTERNS_ROOT.
 */
const PATTERNS_ROUTE_PREFIX = "/api/patterns/";

/**
 * Every page's hits merge here. Realms share one span-id keyspace — they run the
 * same instrumented bytes, which carry the file name and span id of whichever
 * realm compiled them — so a page that only warm-loaded bytes still reports hits
 * that land on another page's spans.
 *
 * One collector per test file, not per run: `deno test` gives each test file its
 * own isolate, so each holds its own instance of this module. What merges here
 * is what one test file's realms ran.
 */
const collector = new PatternCoverageCollector();

/** Where to write the LCOV, or undefined when this run collects no coverage. */
export function patternCoverageDir(): string | undefined {
  const dir = Deno.env.get("CF_PATTERN_COVERAGE_DIR");
  return dir ? resolve(Deno.cwd(), dir) : undefined;
}

/**
 * The collector for a runtime this test process runs itself, or undefined when
 * the run collects no coverage. It is the same collector the browser dumps merge
 * into, so both realms' hits reach one report.
 *
 * Handing this to a pieces controller matters for more than its own coverage:
 * the pieces it creates are stored under the instrumented cached variant, so a
 * browser collecting coverage against that space warm-loads them. Without it
 * every browser misses the ordinary variant and cold-compiles each pattern —
 * including the space-root default pattern that `ensureDefaultPattern` exists to
 * compile once — which wedges each worker's event loop for seconds.
 */
export function patternCoverageCollector():
  | PatternCoverageCollector
  | undefined {
  return patternCoverageDir() === undefined ? undefined : collector;
}

/**
 * The file this collector writes, named apart from every other collector's in
 * the same run: a shard runs several test files and each holds a collector of
 * its own. The gate joins every `.lcov` an artifact carries, so a shard's report
 * arriving in several files reads the same as one.
 */
const OUTPUT_FILE_NAME =
  `pattern-integration-${Deno.pid}-${crypto.randomUUID()}.pattern-coverage.lcov`;

function outputPath(dir: string): string {
  return join(dir, OUTPUT_FILE_NAME);
}

export function withRepositoryFileNames(
  data: PatternCoverageData,
): PatternCoverageData {
  const rename = (fileName: string) =>
    fileName.startsWith(PATTERNS_ROUTE_PREFIX)
      ? `/${fileName.slice(PATTERNS_ROUTE_PREFIX.length)}`
      : fileName;
  return {
    spans: data.spans.map((span) => ({
      ...span,
      fileName: rename(span.fileName),
    })),
    hits: data.hits.map((hit) => ({ ...hit, fileName: rename(hit.fileName) })),
  };
}

/**
 * Turn on worker pattern coverage for this page. Read before the worker runtime
 * is constructed (at login), so this must run after navigation and before the
 * page logs in. A no-op unless the run collects coverage.
 */
export async function enablePatternCoverage(page: Page): Promise<void> {
  if (patternCoverageDir() === undefined) return;
  await page.evaluate(() => {
    globalThis.localStorage.setItem("patternCoverage", "true");
  });
}

/** What one page had to hand over when it was asked for its worker's hits. */
type PatternCoverageDump =
  | { noRuntime: true }
  | { noCoverageRequest: true }
  | { data: PatternCoverageData | null };

/**
 * Pull one page's accumulated hits and rewrite the merged LCOV. Must run before
 * the page's runtime is dropped, which takes the worker's collector with it.
 *
 * A page that cannot answer never fails the test it is collecting from. One
 * empty-handed answer costs nothing: a page that never booted a runtime holds
 * nothing, and says nothing. Every other one is a page whose worker ran authored
 * statements this report will not carry, which the gate charges to whoever
 * changes the tree next, so each of those names what was lost and why.
 *
 * Rewriting the whole merged report on every dump keeps the file complete
 * without needing a process-exit hook.
 */
export async function collectPatternCoverage(page: Page): Promise<void> {
  const dir = patternCoverageDir();
  if (dir === undefined) return;

  // Four answers, one of them normal. `noRuntime` is a page that never booted
  // one, so there was nothing to collect. A runtime with no `getPatternCoverage`
  // is a shell built against a runtime client from before the request existed. A
  // null report is a worker built without a collector — the flag `localStorage`
  // carries never reached its `InitializationData`. Anything thrown is a page
  // that could not be reached at all, the worker having gone first.
  let result: PatternCoverageDump;
  try {
    result = await page.evaluate(async () => {
      const rt = globalThis.commonfabric?.rt;
      if (!rt) return { noRuntime: true as const };
      if (!rt.getPatternCoverage) return { noCoverageRequest: true as const };
      return { data: await rt.getPatternCoverage() };
    }) as PatternCoverageDump;
  } catch (error) {
    console.warn(
      "[pattern-coverage] this page could not be asked for its worker's " +
        "pattern coverage, so every hit the worker held is lost: " +
        describeThrown(error),
    );
    return;
  }
  if ("noRuntime" in result) return;
  if ("noCoverageRequest" in result) {
    console.warn(
      "[pattern-coverage] this page's runtime client does not answer " +
        "getPatternCoverage, so its worker's pattern coverage is lost. The " +
        "shell it loaded was built against a runtime client without it.",
    );
    return;
  }

  const data = result.data;
  if (data === null) {
    console.warn(
      "[pattern-coverage] CF_PATTERN_COVERAGE_DIR is set but this page's " +
        "worker was built without a collector, so its pattern coverage is " +
        "lost. The host flag did not reach the worker's InitializationData.",
    );
    return;
  }
  // Hits with no spans beside them are a realm that only warm-loaded
  // already-instrumented bytes; they key against the spans the realm that
  // compiled those bytes registered, so they are ingested like any others. A
  // dump with neither ran no instrumented statement, so it has nothing to add.
  if (data.spans.length === 0 && data.hits.length === 0) return;

  collector.ingest(data);
  await writeMergedPatternCoverage(dir);
}

/**
 * Write every realm's hits as one LCOV.
 *
 * The rename happens here rather than as each realm reports, because the realms
 * do not all arrive through `ingest`: a runtime this process runs registers its
 * spans into the shared collector directly, as it compiles. Renaming on the way
 * in would cover the browser dumps and miss those.
 */
async function writeMergedPatternCoverage(dir: string): Promise<void> {
  const renamed = new PatternCoverageCollector();
  renamed.ingest(withRepositoryFileNames(collector.toData()));
  await writePatternCoverageLcov(renamed, outputPath(dir), {
    root: PATTERNS_ROOT,
    testName: PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  });
  await warnOnUnmappedRecords(outputPath(dir));
}

/**
 * Report any record whose source path does not exist in the checkout. The gate
 * matches records to files it walked, so such a record is not wrong-looking —
 * it simply matches nothing, and the coverage it carries is dropped silently.
 * Synthetic `cf-mount/` paths name a mounted module by identity and have no
 * file to find, so they are not checked.
 */
async function warnOnUnmappedRecords(lcovPath: string): Promise<void> {
  const paths = (await Deno.readTextFile(lcovPath))
    .split("\n")
    .filter((line) => line.startsWith("SF:"))
    .map((line) => line.slice(3))
    .filter((path) => path.startsWith("/"));

  const missing: string[] = [];
  for (const path of paths) {
    if (!await Deno.stat(path).then((s) => s.isFile).catch(() => false)) {
      missing.push(path);
    }
  }
  if (missing.length === 0) return;
  console.warn(
    `[pattern-coverage] ${missing.length} record(s) name a file that is not ` +
      `in this checkout, so the gate will not credit their coverage:\n` +
      missing.map((path) => `  ${path}`).join("\n"),
  );
}
