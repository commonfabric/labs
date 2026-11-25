/**
 * What a test process says about its own tests, and how a run reads that
 * back as records.
 *
 * The test module (`../testing.ts`) writes it. When a test file loads, the
 * module writes the names of every test the file registered. As each test
 * finishes, the module writes how it went. Each test file appends to a file
 * of its own in the run's spool, `results-<ulid>.ndjson`, so concurrent
 * files never contend and a run killed part way through keeps what
 * finished.
 *
 * A run's owner reads the lines back with the kind and scope its
 * invocation ran under, and turns them into the records
 * `docs/specs/test-records.md` defines. The lines name each test as the
 * list of names that encloses it, so nothing here splits a joined name to
 * find out what holds what.
 */

import { join } from "@std/path";
import { ulid } from "@std/ulid";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { type Environment, recordsDir, writableSpool } from "./paths.ts";
import {
  isRepositoryPath,
  NAME_SEPARATOR,
  type TestIdentity,
  type TestRecord,
} from "./schema.ts";

/** What a results file's name starts with, inside the spool. */
export const RESULTS_PREFIX = "results-";

/** What it ends with; the whole name is `results-<ulid>.ndjson`. */
export const RESULTS_SUFFIX = ".ndjson";

/** How one test, or one group of tests, went. */
export type Outcome = "pass" | "fail" | "skip";

/** The tests one test file registered, written once its module loaded. */
export interface RegisteredLine {
  line: "registered";

  /** The repository-relative test file. */
  file: string;

  /**
   * Every test and every group of tests the file registered, each as the
   * names that enclose it, outermost first, ending with its own.
   */
  names: string[][];
}

/** How one test, or one group of tests, went. */
export interface ResultLine {
  line: "result";

  /** The repository-relative test file. */
  file: string;

  /** The names that enclose the test, outermost first, ending with its own. */
  name: string[];

  /**
   * For a group, `fail` only where the group failed on its own account: a
   * hook of its threw or never settled, the test holding steps threw, what
   * runs around it threw, or an error reached the file uncaught while it ran.
   * A group whose only failures are those of the tests inside it passed.
   */
  outcome: Outcome;

  /**
   * From the start of its hooks to the end of them, everything inside
   * included.
   */
  durationMs: number;

  /** Present on a group: a `describe`, or a test that ran steps. */
  container?: true;

  /** What a failure threw, where it threw something. */
  failure?: string;

  /**
   * Present on a result the run's skip list named: a skip the list asked
   * for, rather than one the test declared, or a step that ran only because
   * its test did. It is a fact about the run's share of the tests, not about
   * the test.
   */
  listed?: true;
}

/** The part of an open results file the writer uses. */
type ResultsFile = Pick<Deno.FsFile, "writeSync" | "close">;

const encoder = new TextEncoder();

/**
 * Appends results lines to one file in the run's spool. A write that fails
 * warns once and stops the writer: recording never fails a test.
 */
export class ResultsWriter {
  #file: ResultsFile | undefined;

  private constructor(file: ResultsFile) {
    this.#file = file;
  }

  /**
   * A writer over a file the caller supplies, so that a test can supply one
   * whose writes fail.
   */
  static get accessForTestingOnly(): {
    create(file: ResultsFile): ResultsWriter;
  } {
    return { create: (file) => new ResultsWriter(file) };
  }

  /**
   * Opens a fresh results file in the active run's spool. Undefined when
   * recording is off, and when this process may not write into the spool,
   * which a process asked to record is not denied by accident: the run's
   * owner grants it.
   */
  static openForRun(env?: Environment): ResultsWriter | undefined {
    const dir = recordsDir(env);
    if (dir === undefined || !writableSpool(dir)) return undefined;
    try {
      Deno.mkdirSync(dir, { recursive: true });
      return new ResultsWriter(
        Deno.openSync(
          join(dir, `${RESULTS_PREFIX}${ulid()}${RESULTS_SUFFIX}`),
          {
            createNew: true,
            write: true,
          },
        ),
      );
    } catch (error) {
      console.warn(
        `test records: cannot open a results file in ${dir}: ${error}`,
      );
      return undefined;
    }
  }

  /** Appends one line, whole. */
  write(line: RegisteredLine | ResultLine): void {
    const file = this.#file;
    if (file === undefined) return;
    const bytes = encoder.encode(JSON.stringify(line) + "\n");
    try {
      for (let at = 0; at < bytes.length;) {
        at += file.writeSync(bytes.subarray(at));
      }
    } catch (error) {
      console.warn(`test records: cannot write a result: ${error}`);
      this.close();
    }
  }

  /** Closes the file. Writes after this are ignored. */
  close(): void {
    const file = this.#file;
    this.#file = undefined;
    try {
      file?.close();
    } catch {
      // A file a failed write already closed throws here.
    }
  }
}

/**
 * Whether a value is a list of names a line can carry. No name holds the
 * separator, which would make two lists one identity once joined.
 */
function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((name) =>
      typeof name === "string" && !name.includes(NAME_SEPARATOR)
    );
}

/**
 * Parses one results line. Undefined for anything that is not one, since a
 * line is read back across a process boundary.
 */
export function parseResultsLine(
  text: string,
): RegisteredLine | ResultLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObjectNotArray(value)) return undefined;
  const { line, file } = value;
  if (typeof file !== "string" || !isRepositoryPath(file)) return undefined;
  if (line === "registered") {
    const { names } = value;
    if (!Array.isArray(names) || !names.every(isNames)) return undefined;
    return { line, file, names };
  }
  if (line !== "result") return undefined;
  const { name, outcome, durationMs, container, failure, listed } = value;
  if (!isNames(name)) return undefined;
  if (outcome !== "pass" && outcome !== "fail" && outcome !== "skip") {
    return undefined;
  }
  if (
    typeof durationMs !== "number" || !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return undefined;
  }
  if (container !== undefined && container !== true) return undefined;
  if (failure !== undefined && typeof failure !== "string") return undefined;
  if (listed !== undefined && listed !== true) {
    return undefined;
  }
  return {
    line,
    file,
    name,
    outcome,
    durationMs,
    ...(container === undefined ? {} : { container }),
    ...(failure === undefined ? {} : { failure }),
    ...(listed === undefined ? {} : { listed }),
  };
}

/** How `readResults()` turns lines into records. */
export interface ReadResultsOptions {
  /** The kind every record is written under. */
  kind: string;

  /** The scope every record is written under. */
  scope: string;

  /**
   * Results files to leave out, by name: those the spool already held when
   * the invocation whose results these are started, where the spool holds
   * the results of other invocations as well.
   */
  ignoring?: ReadonlySet<string>;

  /**
   * Whether the caller already knows a group, recorded from a file, as an
   * identity. A group it knows is recorded whenever it runs, rather than
   * only when it fails on its own account, so that its history holds its
   * passes too.
   */
  known?: (test: TestIdentity, file: string) => boolean;
}

/** What a spool's results files came to. */
export interface Results {
  /**
   * One for each test that ran or skipped itself, and each group recorded.
   */
  records: TestRecord[];

  /**
   * One for each test the run's skip list named. Kept apart from the
   * records, since what the run's share caused says nothing about the test;
   * the run that wrote the list knows which of them do, and reads all of
   * them to see that the file registered and reached each test.
   */
  listed: TestRecord[];

  /**
   * One for each outermost group: the milliseconds its hooks took, which is
   * what it took that none of `records` holds. Not tests, so nothing places
   * them among the records.
   */
  hooks: TestRecord[];

  /** The message each failing record's test threw, where it threw one. */
  failures: Map<TestRecord, string>;

  /** A line no reader accepts, or a torn final line, by file. */
  warnings: string[];
}

/** The names of the results files a spool holds, in order. */
export async function resultsFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile && entry.name.startsWith(RESULTS_PREFIX) &&
        entry.name.endsWith(RESULTS_SUFFIX)
      ) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.toSorted();
}

/**
 * The lines of each results file a spool holds, which is to say of each
 * process that wrote one, but those `ignoring` names, and what could not be
 * read.
 */
async function linesIn(
  dir: string,
  ignoring: ReadonlySet<string> = new Set(),
): Promise<{
  processes: (RegisteredLine | ResultLine)[][];
  warnings: string[];
}> {
  const processes: (RegisteredLine | ResultLine)[][] = [];
  const warnings: string[] = [];
  for (const name of await resultsFiles(dir)) {
    if (ignoring.has(name)) continue;
    const texts = (await Deno.readTextFile(join(dir, name))).split("\n");
    const tail = texts.pop();
    if (tail !== undefined && tail.length > 0) {
      warnings.push(`dropped a torn final line in ${name}`);
    }
    const parsed: (RegisteredLine | ResultLine)[] = [];
    for (const text of texts) {
      const line = parseResultsLine(text);
      if (line === undefined) {
        warnings.push(`dropped a line no reader accepts in ${name}`);
      } else {
        parsed.push(line);
      }
    }
    processes.push(folded(parsed, name, warnings));
  }
  return { processes, warnings };
}

/**
 * One process's lines, from the results file `source`, with the results it
 * wrote more than once for one name folded into one. The test module writes
 * a file's own group more than once: as failed before each run of the
 * file's own hooks, which may never finish, again once they have, again as
 * the file unloads, and again for each error that reaches the file after
 * that. The last of those is the group's.
 * Any other second line is dropped with a warning.
 */
function folded(
  lines: readonly (RegisteredLine | ResultLine)[],
  source: string,
  warnings: string[],
): (RegisteredLine | ResultLine)[] {
  const byName = new Map<string, number>();
  const kept: (RegisteredLine | ResultLine)[] = [];
  for (const line of lines) {
    if (line.line !== "result") {
      kept.push(line);
      continue;
    }
    const key = keyOf(line.file, line.name);
    const earlier = byName.get(key);
    if (earlier === undefined) {
      byName.set(key, kept.length);
      kept.push(line);
    } else if (line.name.length === 1 && line.name[0] === line.file) {
      kept[earlier] = line;
    } else {
      warnings.push(
        `dropped a second result for ${
          line.name.join(NAME_SEPARATOR)
        } in ${source}`,
      );
    }
  }
  return kept;
}

/** A key naming one test of one file, for the maps below. */
function keyOf(file: string, name: readonly string[]): string {
  return JSON.stringify([file, ...name]);
}

/**
 * Reads the results files a spool holds and turns them into records of the
 * given kind and scope.
 *
 * Every test is a record. A group is one where it failed on its own
 * account, or where the caller knows it, and it then takes the time it
 * spent outside the groups and tests directly inside it.
 */
export async function readResults(
  dir: string,
  options: ReadResultsOptions,
): Promise<Results> {
  const { processes, warnings } = await linesIn(dir, options.ignoring);
  const identity = (name: readonly string[]): TestIdentity => ({
    k: options.kind,
    s: options.scope,
    n: name.join(NAME_SEPARATOR),
  });
  const records: TestRecord[] = [];
  const listed: TestRecord[] = [];
  const hooks: TestRecord[] = [];
  const failures = new Map<TestRecord, string>();
  // Each process's times are its own: two processes may run one file.
  for (const lines of processes) {
    const results = lines.filter((line): line is ResultLine =>
      line.line === "result"
    );

    // What the groups and tests directly inside each group took between
    // them.
    const inside = new Map<string, number>();
    for (const result of results) {
      if (result.name.length < 2) continue;
      const parent = keyOf(result.file, result.name.slice(0, -1));
      inside.set(parent, (inside.get(parent) ?? 0) + result.durationMs);
    }

    // The milliseconds the records inside each outermost group hold.
    const held = new Map<string, number>();
    for (const result of results) {
      const test = identity(result.name);
      if (
        result.container === true && result.outcome !== "fail" &&
        !(options.known?.(test, result.file) ?? false)
      ) {
        continue;
      }
      const durationMs = result.container === true
        ? Math.max(
          0,
          result.durationMs -
            (inside.get(keyOf(result.file, result.name)) ?? 0),
        )
        : result.durationMs;
      const record: TestRecord = {
        line: "record",
        test,
        outcome: result.outcome,
        durationMs: Math.round(durationMs),
        file: result.file,
      };
      if (result.listed === true) {
        listed.push(record);
        continue;
      }
      records.push(record);
      if (result.outcome === "fail" && result.failure !== undefined) {
        failures.set(record, result.failure);
      }
      const outermost = keyOf(result.file, result.name.slice(0, 1));
      held.set(outermost, (held.get(outermost) ?? 0) + durationMs);
    }

    for (const result of results) {
      if (result.container !== true || result.name.length !== 1) continue;
      hooks.push({
        line: "record",
        test: identity(result.name),
        outcome: result.outcome,
        durationMs: Math.round(Math.max(
          0,
          result.durationMs -
            (held.get(keyOf(result.file, result.name)) ?? 0),
        )),
        file: result.file,
      });
    }
  }

  return { records, listed, hooks, failures, warnings };
}

/**
 * Every name each test file in a spool registered, by repository-relative
 * file, joined. A file is named here once its module loaded, so the names
 * under it are every test and group it holds; a file whose module did not
 * load is not named, and nothing here says what it holds.
 */
export async function readRegistered(
  dir: string,
): Promise<Map<string, Set<string>>> {
  const registered = new Map<string, Set<string>>();
  for (const lines of (await linesIn(dir)).processes) {
    for (const line of lines) {
      if (line.line !== "registered") continue;
      const names = registered.get(line.file) ?? new Set();
      registered.set(line.file, names);
      for (const name of line.names) names.add(name.join(NAME_SEPARATOR));
    }
  }
  return registered;
}
