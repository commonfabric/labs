/**
 * Reads line coverage out of LCOV reports. One reader serves both the
 * coverage-debt gate and the combined report published for IDEs, so the two
 * cannot come to different conclusions about the same report. Line coverage is
 * all it reads: function and branch records are dropped, and the summary
 * counters are left to whoever writes a report back out.
 */

/** The line coverage one source file accumulated across the records read. */
export interface LcovFileCoverage {
  /**
   * The `SF:` path as the record that introduced this file wrote it, before
   * `mapPath` turned it into the key this entry is stored under.
   */
  sourcePath: string;

  /** The `TN:` name from the first record for this file that carried one. */
  testName?: string;

  /** Execution count per line number, summed over every record read. */
  lineHits: Map<number, number>;
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
 * are summed. Reports are read in the order given, and the records for one file
 * may be spread over several of them.
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

  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith("TN:")) {
      pendingTestName = line.slice(3) || undefined;
    } else if (line.startsWith("SF:")) {
      const sourcePath = line.slice(3);
      const key = mapPath(sourcePath);
      current = files.get(key);
      if (!current) {
        current = { sourcePath, lineHits: new Map() };
        files.set(key, current);
      }
      if (pendingTestName && !current.testName) {
        current.testName = pendingTestName;
      }
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
        current.lineHits.set(
          lineNumber,
          (current.lineHits.get(lineNumber) ?? 0) + hits,
        );
      }
    } else if (line === "end_of_record") {
      current = undefined;
      pendingTestName = undefined;
    }
  }
}
