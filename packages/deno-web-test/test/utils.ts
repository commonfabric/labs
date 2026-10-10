import * as path from "@std/path";
import { AssertionError } from "@std/assert";
import { copy } from "@std/fs";
import { parse as parseJsonc } from "@std/jsonc";
import { removeDirectory } from "@commonfabric/utils/remove-directory";
import { RECORDS_DIR_VARIABLE } from "@commonfabric/test-support/records";
import { decode } from "@commonfabric/utils/encoding";

const dirname = import.meta.dirname as string;
const CLI_PATH = path.join(dirname, "..", "cli.ts");
const DenoWebTestCache: Map<string, Promise<HarnessRun>> = new Map();
const encoder = new TextEncoder();
const STDERR_BOUNDARY_ENV = "DENO_WEB_TEST_STDERR_BOUNDARY";
const DOWNLOAD_HTTP_PREFIX = encoder.encode("Download http://");
const DOWNLOAD_HTTPS_PREFIX = encoder.encode("Download https://");

function skipSgrSequences(
  value: Uint8Array,
  offset: number,
): number {
  let next = offset;
  while (value[next] === 0x1b && value[next + 1] === 0x5b) {
    let end = next + 2;
    while (
      end < value.length &&
      (
        value[end] >= 0x30 && value[end] <= 0x39 ||
        value[end] === 0x3a ||
        value[end] === 0x3b
      )
    ) {
      end++;
    }
    if (value[end] !== 0x6d) {
      break;
    }
    next = end + 1;
  }
  return next;
}

function startsWithVisibleBytes(
  value: Uint8Array,
  prefix: Uint8Array,
  offset: number,
): boolean {
  let valueIndex = offset;
  for (let i = 0; i < prefix.length; i++) {
    valueIndex = skipSgrSequences(value, valueIndex);
    if (value[valueIndex] !== prefix[i]) {
      return false;
    }
    valueIndex++;
  }
  return true;
}

function indexOfBytes(
  value: Uint8Array,
  target: Uint8Array,
): number {
  for (let start = 0; start <= value.length - target.length; start++) {
    let matches = true;
    for (let i = 0; i < target.length; i++) {
      if (value[start + i] !== target[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return -1;
}

function stripDenoDownloadDiagnostics(
  stderr: Uint8Array<ArrayBuffer>,
  boundary: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const boundaryStart = indexOfBytes(stderr, boundary);
  if (boundaryStart === -1) {
    return stderr;
  }

  const retained: Uint8Array[] = [];
  let retainedLength = stderr.length - boundary.length;
  let lineStart = 0;
  while (lineStart < boundaryStart) {
    const lineBreak = stderr.indexOf(0x0a, lineStart);
    const lineEnd = lineBreak === -1 || lineBreak >= boundaryStart
      ? boundaryStart
      : lineBreak + 1;
    if (
      startsWithVisibleBytes(stderr, DOWNLOAD_HTTP_PREFIX, lineStart) ||
      startsWithVisibleBytes(stderr, DOWNLOAD_HTTPS_PREFIX, lineStart)
    ) {
      retainedLength -= lineEnd - lineStart;
    } else {
      retained.push(stderr.subarray(lineStart, lineEnd));
    }
    lineStart = lineEnd;
  }
  retained.push(stderr.subarray(boundaryStart + boundary.length));

  const filtered = new Uint8Array(retainedLength);
  let offset = 0;
  for (const part of retained) {
    filtered.set(part, offset);
    offset += part.length;
  }
  return filtered;
}

export function sanitizeDenoWebTestOutput(
  output: Deno.CommandOutput,
  boundary: string,
): Deno.CommandOutput {
  return {
    ...output,
    stderr: stripDenoDownloadDiagnostics(
      output.stderr,
      encoder.encode(`${boundary}\n`),
    ),
  };
}

// One completed run of the harness against a test project: how the process
// exited, both of its streams as bytes and as text, and an `assert` that
// carries the whole transcript into the failure message.
export class HarnessRun {
  readonly projectDir: string;
  readonly success: boolean;
  readonly code: number;
  readonly signal: Deno.Signal | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutText: string;
  readonly stderrText: string;

  constructor(projectDir: string, output: Deno.CommandOutput) {
    this.projectDir = projectDir;
    this.success = output.success;
    this.code = output.code;
    this.signal = output.signal;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
    this.stdoutText = decode(output.stdout);
    this.stderrText = decode(output.stderr);
  }

  /**
   * Fails with `message` followed by the whole transcript. An assertion here
   * reads one line of what the run printed, and the rest of that output is what
   * says why the line is not the one it should be.
   */
  assert(condition: boolean, message: string): void {
    if (condition) {
      return;
    }
    throw new AssertionError(`${message}\n\n${this.transcript()}`);
  }

  transcript(): string {
    // The exit code of a run the kernel killed is 128 plus the signal number.
    // That reads as an ordinary exit. The ending names the signal as well.
    const ending = this.signal === null
      ? `exited with code ${this.code}`
      : `was killed by ${this.signal}, exiting with code ${this.code}`;
    return [
      `deno-web-test in ${this.projectDir} ${ending}.`,
      "--- stdout ---",
      this.stdoutText,
      "--- stderr ---",
      this.stderrText,
      "--- end of transcript ---",
    ].join("\n");
  }
}

// Runs deno-web-test in `projectDir` with `environment` added to the
// variables it inherits, and caches the results for multiple test usages.
//
// Due to running within a workspace, these test subprojects
// need to be workspace members in order to run deno tasks.
// This is untenable, so move the test package to a temp dir
// before running tests.
export const runDenoWebTest = async (
  projectDir: string,
  environment: Record<string, string> = {},
): Promise<HarnessRun> => {
  const cacheKey = `${projectDir} ${JSON.stringify(environment)}`;
  const fromCache = DenoWebTestCache.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  // Copy over test project to temp directory.
  const tmp = await Deno.makeTempDir();
  const projectPath = path.join(dirname, projectDir);
  const tmpProjectPath = path.join(tmp, projectDir);
  await copy(projectPath, tmpProjectPath);

  // Overwrite the test project's "test" task with the
  // absolute path of deno-web-test's `cli.ts` export.
  const manifestPath = path.join(tmpProjectPath, "deno.jsonc");
  const manifest = parseJsonc(await Deno.readTextFile(manifestPath)) as {
    tasks: { test: string };
    imports?: Record<string, string>;
  };
  // The copy sits outside the workspace, so a project reaches the module its
  // tests import from this package through an explicit mapping.
  manifest.imports = {
    ...manifest.imports,
    "@commonfabric/deno-web-test/commands":
      path.toFileUrl(path.join(dirname, "..", "commands.ts")).href,
  };
  manifest.tasks.test =
    `deno run --allow-env --allow-read --allow-write --allow-run --allow-net ${CLI_PATH} *.test.ts`;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

  // Populate the cache for the harness and each test entrypoint before the task.
  const testEntrypoints = [...Deno.readDirSync(tmpProjectPath)]
    .filter((entry) => entry.isFile && entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(tmpProjectPath, entry.name))
    .sort();
  const { success: installSuccess } = await new Deno.Command(Deno.execPath(), {
    args: [
      "install",
      "--entrypoint",
      CLI_PATH,
      ...testEntrypoints,
    ],
    cwd: tmpProjectPath,
  }).output();
  if (!installSuccess) {
    throw new Error("Failed to run `deno install`");
  }

  const stderrBoundary = `deno-web-test:${crypto.randomUUID()}`;
  const run = new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "test",
    ],
    cwd: tmpProjectPath,
    env: {
      [STDERR_BOUNDARY_ENV]: stderrBoundary,
      // The harness inside the child records one browser-kind record per
      // test it runs. These projects are fixtures of the tests in this
      // directory rather than tests of this repository, so the child is
      // given no spool to write them to.
      [RECORDS_DIR_VARIABLE]: "",
      ...environment,
    },
  }).output().then((output) =>
    new HarnessRun(
      projectDir,
      sanitizeDenoWebTestOutput(output, stderrBoundary),
    )
  );
  DenoWebTestCache.set(cacheKey, run);

  // The copy is the run's working directory, and a `HarnessRun` holds what
  // the run printed rather than anything under it, so the copy goes once the
  // run has settled, whichever way it settled. What the cache holds is the
  // run, so a removal that fails says so here without becoming what every
  // later caller reads.
  await Promise.allSettled([run]);
  await removeDirectory(tmp);
  return run;
};
