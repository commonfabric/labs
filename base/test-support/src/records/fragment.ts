/**
 * The producer side of recording: append record lines to a fragment file in
 * the run's spool directory. Each producer process writes its own fragment,
 * so concurrent producers never contend; lines are flushed as results
 * arrive, so a killed run keeps the records of every test that finished. A
 * producer that cannot write warns once and stops recording; it never fails
 * the tests.
 */

import { ulid } from "@std/ulid";
import { join } from "@std/path";
import { serializeRecordLine, type TestRecord } from "./schema.ts";
import { type Environment, recordsDir } from "./paths.ts";

/** Leading half of a fragment file's name: `fragment-<ulid>.ndjson` inside
 * the spool. */
export const FRAGMENT_PREFIX = "fragment-";

/** The extension that completes that name. */
export const FRAGMENT_SUFFIX = ".ndjson";

const encoder = new TextEncoder();

/** The part of an open fragment file a writer uses. */
type FragmentFile = Pick<Deno.FsFile, "writeSync" | "close">;

/** Appends test records to one fragment file, line by line. */
export class FragmentWriter {
  #file: FragmentFile | undefined;
  readonly #path: string;

  private constructor(path: string, file: FragmentFile) {
    this.#path = path;
    this.#file = file;
  }

  /** The fragment file this writer appends to. */
  get path(): string {
    return this.#path;
  }

  /**
   * A constructor taking the file to append to, so that a test can supply
   * one whose writes fail.
   */
  static get accessForTestingOnly(): {
    create(path: string, file: FragmentFile): FragmentWriter;
  } {
    return { create: (path, file) => new FragmentWriter(path, file) };
  }

  /**
   * Opens a fresh fragment in the given spool directory, creating the
   * directory when it does not exist yet — in CI no run owner precedes the
   * producers. Returns undefined, after one warning, when the directory
   * cannot be created or written.
   */
  static open(dir: string): FragmentWriter | undefined {
    const path = join(dir, `${FRAGMENT_PREFIX}${ulid()}${FRAGMENT_SUFFIX}`);
    try {
      Deno.mkdirSync(dir, { recursive: true });
      const file = Deno.openSync(path, {
        createNew: true,
        write: true,
      });
      return new FragmentWriter(path, file);
    } catch (error) {
      warnOnce(`cannot open a record fragment in ${dir}: ${error}`);
      return undefined;
    }
  }

  /**
   * Opens a fragment in the active run's spool, or returns undefined when
   * recording is off (CF_TEST_RECORDS_DIR unset).
   */
  static openForRun(env?: Environment): FragmentWriter | undefined {
    const dir = recordsDir(env);
    if (dir === undefined) return undefined;
    return FragmentWriter.open(dir);
  }

  /**
   * Appends one record. The write is synchronous and whole-line, so a
   * fragment never interleaves partial lines; a failure warns once and
   * stops this writer for good.
   */
  append(record: TestRecord): void {
    const file = this.#file;
    if (file === undefined) return;
    const bytes = encoder.encode(serializeRecordLine(record));
    try {
      let written = 0;
      while (written < bytes.length) {
        written += file.writeSync(bytes.subarray(written));
      }
    } catch (error) {
      warnOnce(`cannot append to ${this.#path}: ${error}`);
      this.close();
    }
  }

  /**
   * Closes the fragment. Appends after close are ignored. A close that fails
   * fails nothing: recording never fails a test.
   */
  close(): void {
    const file = this.#file;
    this.#file = undefined;
    try {
      file?.close();
    } catch {
      // A file that a failed write already closed throws here.
    }
  }
}

let warnedOnce = false;

function warnOnce(message: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`test records: ${message}`);
}

/** Resets the process-wide warn-once latch. Test use only. */
export function resetFragmentWarningsForTesting(): void {
  warnedOnce = false;
}
