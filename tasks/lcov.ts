/**
 * Reads line coverage out of LCOV reports. One reader serves both the
 * coverage-debt gate and the combined report published for IDEs, so the two
 * cannot come to different conclusions about the same report. Line coverage is
 * all it reads: function and branch records are dropped, and the summary
 * counters are left to whoever writes a report back out.
 */

/**
 * The `TN:` name every record the pattern runtime's instrumentation writes
 * carries, alone or followed by a hyphen and the path that collected it. It
 * repeats the runner's own constant rather than importing it, which would
 * bring the runner's module graph into every script that reads a report;
 * `lcov.test.ts` reads the runner's writer's records to keep the two equal.
 */
const PATTERN_COVERAGE_TEST_NAME = "pattern-runtime";

/**
 * Whether `testName`, a record's `TN:` name, says the pattern runtime's
 * instrumentation wrote the record. {@linkcode LcovFileCoverage} says what
 * that changes.
 */
function isPatternCoverageTestName(testName: string): boolean {
  return testName === PATTERN_COVERAGE_TEST_NAME ||
    testName.startsWith(`${PATTERN_COVERAGE_TEST_NAME}-`);
}

/**
 * The line coverage one source file accumulated across the records read.
 *
 * Two producers write records, and they name different lines of the same
 * statement. Deno's coverage names every line it counts as executable, run or
 * not, and leaves out a line holding only the end of a statement begun on an
 * earlier line, such as a closing `);`. The pattern runtime's instrumentation
 * names only the statements it instruments, and names every line each of
 * them spans.
 *
 * So once a record from Deno's coverage has named any line of the file, the
 * lines that count are the lines Deno's records name. Each carries the hits
 * every record gave it, the instrumentation's included. A line only the
 * instrumentation names belongs to a statement that Deno counts on a line it
 * does name, so the statement is charged or not on that line, unless a
 * `deno-coverage-ignore` comment opted the statement out of Deno's coverage.
 * For a file whose lines no record from Deno's coverage names, the lines that
 * count are the lines the instrumentation names.
 *
 * A record from Deno's coverage carries no `TN:` name, and one from the
 * instrumentation carries a name {@linkcode isPatternCoverageTestName}
 * accepts. {@linkcode addLcovReport} refuses a record with any other name.
 */
export class LcovFileCoverage {
  #sourcePath: string;
  #testName: string | undefined;
  #hits = new Map<number, number>();
  #linesDenoNames: Set<number> | undefined;
  #lineHits: ReadonlyMap<number, number> | undefined;

  /** Constructs the coverage of the file a record names as `sourcePath`. */
  constructor(sourcePath: string) {
    this.#sourcePath = sourcePath;
  }

  /**
   * The `SF:` path as the record that introduced this file wrote it, before
   * `mapPath` turned it into the key this entry is stored under.
   */
  get sourcePath(): string {
    return this.#sourcePath;
  }

  /** The `TN:` name from the first record for this file that carried one. */
  get testName(): string | undefined {
    return this.#testName;
  }

  /** Whether a record from Deno's coverage named a line of this file. */
  get namedByDeno(): boolean {
    return this.#linesDenoNames !== undefined;
  }

  /**
   * Execution count per line number, summed over every record read, for the
   * lines that count.
   */
  get lineHits(): ReadonlyMap<number, number> {
    const named = this.#linesDenoNames;
    return this.#lineHits ??= named === undefined
      ? this.#hits
      : new Map([...this.#hits].filter(([line]) => named.has(line)));
  }

  /**
   * Adds `hits` to `lineNumber`'s count, from a record written by Deno's
   * coverage when `fromDeno` is true and by the instrumentation otherwise.
   */
  addHits(lineNumber: number, hits: number, fromDeno: boolean): void {
    this.#hits.set(lineNumber, (this.#hits.get(lineNumber) ?? 0) + hits);
    if (fromDeno) (this.#linesDenoNames ??= new Set()).add(lineNumber);
    this.#lineHits = undefined;
  }

  /** Records `testName` unless an earlier record already gave one. */
  nameTest(testName: string): void {
    this.#testName ??= testName;
  }
}

/** Options for {@linkcode parseLcovReports}. */
export interface ParseLcovOptions {
  /**
   * Turns each `SF:` path into the key its coverage is stored under. Records
   * whose paths map to the same key merge into one entry. The path is used
   * unchanged when this is not given.
   */
  mapPath?: (sourcePath: string) => string;
}

/**
 * Read the line coverage out of LCOV reports, merging every record that refers
 * to the same source file into a single entry whose per-line execution counts
 * are summed, over the lines {@linkcode LcovFileCoverage} says count. Reports
 * are read in the order given, the records for one file may be spread over
 * several of them, and the order changes nothing.
 *
 * Only `TN:`, `SF:` and `DA:` are read. The summary counters (`LF:`, `LH:`) are
 * recomputed by whoever writes a report back out. Function (`FN:`) and branch
 * (`BRDA:`) records are dropped: LCOV keys function hits by name, and a single
 * source file can declare several functions with the same name (for example a
 * free function and a method), so merging them faithfully is not possible from
 * the report alone. Line coverage is what IDEs use to color the gutter and
 * what the coverage-debt metric counts.
 */
export function parseLcovReports(
  reports: readonly string[],
  options: ParseLcovOptions = {},
): Map<string, LcovFileCoverage> {
  const files = new Map<string, LcovFileCoverage>();
  for (const report of reports) addLcovReport(files, report, options);
  return files;
}

/**
 * Reads one LCOV report into `files`, merging its records into the entries
 * already there the way {@linkcode parseLcovReports} merges across reports.
 * A reader with more reports than it can hold as text at once adds each as
 * it reads it, and holds only what they cover.
 */
export function addLcovReport(
  files: Map<string, LcovFileCoverage>,
  report: string,
  options: ParseLcovOptions = {},
): void {
  const mapPath = options.mapPath ?? ((sourcePath: string) => sourcePath);
  let current: LcovFileCoverage | undefined;
  // A record opens with an optional `TN:` test-name line before its `SF:`
  // line, so a test name is held until the source path is known.
  let pendingTestName: string | undefined;
  let recordTestName: string | undefined;

  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith("TN:")) {
      pendingTestName = line.slice(3) || undefined;
      if (
        pendingTestName !== undefined &&
        !isPatternCoverageTestName(pendingTestName)
      ) {
        throw new Error(
          `an LCOV record names the test "${pendingTestName}", but Deno's ` +
            `coverage names none and the pattern instrumentation names ` +
            `"${PATTERN_COVERAGE_TEST_NAME}" or a name starting ` +
            `"${PATTERN_COVERAGE_TEST_NAME}-"`,
        );
      }
    } else if (line.startsWith("SF:")) {
      const sourcePath = line.slice(3);
      const key = mapPath(sourcePath);
      current = files.get(key);
      if (!current) {
        current = new LcovFileCoverage(sourcePath);
        files.set(key, current);
      }
      if (pendingTestName) current.nameTest(pendingTestName);
      recordTestName = pendingTestName;
      pendingTestName = undefined;
    } else if (!current) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [lineNumberText, hitsText] = line.slice(3).split(",");
      // Both fields have to carry something. `Number("")` is 0, so a record
      // missing its line number reads as line 0 and one missing its count
      // reads as a line nobody ran.
      const lineNumber = lineNumberText?.trim() ? Number(lineNumberText) : NaN;
      const hits = hitsText?.trim() ? Number(hitsText) : NaN;
      if (
        Number.isInteger(lineNumber) && lineNumber > 0 &&
        Number.isFinite(hits)
      ) {
        current.addHits(lineNumber, hits, recordTestName === undefined);
      }
    } else if (line === "end_of_record") {
      current = undefined;
      pendingTestName = undefined;
    }
  }
}
