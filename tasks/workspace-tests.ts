#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/** The root `deno task test` runner, which `runRootTestTask()` carries out. */

import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { decode, encode } from "@commonfabric/text/utf8";
import {
  FragmentWriter,
  readEnv,
  readResults,
  readSpool,
  recordingArguments,
  RECORDS_DIR_VARIABLE,
  recordsDir,
  SKIP_LIST_VARIABLE,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { pinShuffleSeed } from "@commonfabric/test-support/shuffle";
import { withoutPackageParent } from "./package-layout.ts";
import { DENO_TEST_TASK } from "./run-member-tests.ts";
import {
  finishRunRecording,
  type RunRecording,
  startRunRecording,
} from "./test-records.ts";
import {
  type FailedCommand,
  passed,
  printSummary,
  type TestResult,
  testResults,
  unitRerun,
} from "./test-summary.ts";

export function getPackageName(memberPath: string): string {
  return withoutPackageParent(memberPath.replace(/^\.\//, ""));
}

export async function initializeDb(cwd: string = Deno.cwd()): Promise<boolean> {
  console.log("Initializing database dependencies...");
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "initialize-db"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!result.success) {
    console.error("Failed to initialize database dependencies.");
    console.log(decode(result.stdout));
    console.error(decode(result.stderr));
    return false;
  }
  return true;
}

/** How one member's test task went. */
export interface PackageResult {
  memberPath: string;
  packageName: string;
  packagePath: string;
  durationMs: number;
  success: boolean;

  /** The file holding everything the task printed. */
  log: string;
}

/**
 * Runs a member's `test` task with everything it prints written to `log`,
 * standard output and standard error together in the order they arrive.
 */
export async function testPackage(
  memberPath: string,
  packageName: string,
  packagePath: string,
  coverageRoot: string | undefined,
  log: string,
  extraEnv?: Record<string, string>,
  recording: readonly string[] = [],
): Promise<PackageResult> {
  const startedAt = Date.now();
  const env: Record<string, string> = { ENV: "test", ...extraEnv };
  if (coverageRoot) {
    env.DENO_COVERAGE_DIR = path.join(
      coverageRoot,
      packageName.replaceAll("/", "__"),
    );
  }

  // Trailing arguments to `deno task` append to the task's command line,
  // which is what threads the flags down to the leaf `deno test`.
  const args = ["task", "test", ...recording];
  const file = await Deno.open(log, {
    write: true,
    create: true,
    truncate: true,
  });
  const write = (bytes: Uint8Array) => {
    for (let at = 0; at < bytes.length;) {
      at += file.writeSync(bytes.subarray(at));
    }
  };
  const copy = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) write(chunk);
  };
  let success: boolean;
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args,
      cwd: packagePath,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const [status] = await Promise.all([
      child.status,
      copy(child.stdout),
      copy(child.stderr),
    ]);
    success = status.success;
  } catch (error) {
    write(encode(`${error}\n`));
    success = false;
  } finally {
    file.close();
  }

  const durationMs = Date.now() - startedAt;
  const duration = (durationMs / 1000).toFixed(1);
  console.log(
    `Finished ${packageName} in ${duration}s (${success ? "ok" : "failed"})`,
  );
  return {
    memberPath,
    packageName,
    packagePath,
    durationMs,
    success,
    log,
  };
}

/**
 * What a member's tests recorded into `dir`, the directory its task was
 * given as its spool: the results its tests wrote, as records of kind
 * `unit` under the member's scope with the message each failure threw, and
 * the records any other producer inside the task spooled there.
 */
export async function readMemberRecords(
  dir: string,
  scope: string,
): Promise<{ records: TestRecord[]; failures: Map<TestRecord, string> }> {
  const results = await readResults(dir, { kind: "unit", scope });
  const spooled = await readSpool(dir);
  for (const warning of [...results.warnings, ...spooled.warnings]) {
    console.warn(`test records: ${warning}`);
  }
  return {
    records: [...results.records, ...spooled.records],
    failures: results.failures,
  };
}

// Read the workspace member list from the root manifest. Parsed with the JSONC
// parser so a `deno.jsonc` carrying comments is read correctly.
export async function readWorkspaceMembers(
  configPath: string | URL = "./deno.jsonc",
): Promise<string[]> {
  const manifest = parseJsonc(await Deno.readTextFile(configPath)) as {
    workspace?: string[];
  };
  // A manifest that declares no workspace is a member's own rather than
  // the root's, and answering with nothing would read downstream as a
  // repository holding no packages at all.
  if (!Array.isArray(manifest.workspace)) {
    throw new Error(`${configPath} declares no workspace`);
  }
  return manifest.workspace;
}

export function assertTaskTestsIncluded(members: string[]): void {
  if (members.some((memberPath) => getPackageName(memberPath) === "tasks")) {
    return;
  }
  throw new Error(
    "The root workspace must include tasks so the workspace test job runs the task tests.",
  );
}

// A member's leaf — its `test` task, or the `deno-test` that task hands
// the flags to when it runs `tasks/run-member-tests.ts` — takes appended
// flags whole when it runs exactly one `deno test`.
// That is read from the task itself, so a package that lands with an
// ordinary leaf is covered without being listed anywhere. A leaf carrying
// a shell metacharacter puts the appended flag somewhere other than the
// test command, and takes it for none.
//
// A leaf that runs a script of its own cannot show what the script does
// with the flags it is handed. `tasks/run-test-batches.ts` is the script
// known to forward them: it hands them to each of its `deno test` runs. A
// leaf running any other script is kept out: `identity` drives a browser harness that records through the
// deno-web-test reporter instead.
const FLAG_FORWARDING_RUNNER = "run-test-batches.ts";

/** Whether a leaf task runs the script that forwards its flags. */
function runsForwardingRunner(task: string): boolean {
  return task.split(/\s+/).some((word) =>
    path.basename(word) === FLAG_FORWARDING_RUNNER
  );
}

/**
 * A directory, given as a path or a URL, as a URL that member paths
 * resolve against. The trailing slash is what makes a member resolve
 * inside the directory rather than beside it.
 */
function directoryUrl(root: string | URL): URL {
  const url = root instanceof URL
    ? new URL(root.href)
    : path.toFileUrl(path.resolve(root));
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

/**
 * A task as a manifest writes it: the command line itself, or an object that
 * may carry one. An object with no `command` is defined by its `dependencies`
 * instead, and Deno runs those.
 */
type TaskDefinition = string | { command?: string };

/** The manifest Deno resolves for a member, and its `test` task. */
interface MemberManifest {
  /** Path to the manifest, relative to the workspace root. */
  readonly path: string;

  /** The `test` task it defines, where it defines one. */
  readonly testTask: TaskDefinition | undefined;
}

/**
 * The manifest Deno resolves for a member, and the `test` task that one
 * manifest defines. A member carrying both a `deno.json` and a `deno.jsonc`
 * is read the way its own tooling reads it: Deno takes the `deno.json` and
 * ignores the other file entirely rather than merging the two, so a `test`
 * task written in the manifest Deno ignores is not a task anything can run.
 *
 * A member with no manifest at all takes the `deno.jsonc` path, so that a
 * report naming it names the file to write. Such a member never reaches the
 * fall-through a `test` task exists to prevent, because Deno refuses to load
 * a workspace at all when one of its members has no config file.
 */
async function memberManifest(
  member: string,
  root: string | URL,
  task = "test",
): Promise<MemberManifest> {
  const rootUrl = directoryUrl(root);
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    const manifestPath = `${member}/${manifest}`;
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(manifestPath, rootUrl));
    } catch {
      continue;
    }
    const tasks = (parseJsonc(text) as {
      tasks?: Record<string, TaskDefinition>;
    })?.tasks;
    return { path: manifestPath, testTask: tasks?.[task] };
  }
  return { path: `${member}/deno.jsonc`, testTask: undefined };
}

/**
 * The wrapper a member's `test` task runs where it runs several
 * commands, and the task that wrapper hands the appended flags to.
 */
const MEMBER_TEST_RUNNER = "run-member-tests.ts";

/**
 * The command a member's appended flags reach.
 *
 * `deno task` appends to the `test` task's own command line, so for most
 * members that command is the one. A member running the wrapper above is
 * the exception: the wrapper hands the flags to that member's
 * `deno-test` and to nothing else, so that is the command whose shape
 * decides whether the recording permissions can be appended at all.
 *
 * Reading through the wrapper here is what keeps this runner and the
 * test topology reading one thing. The topology already prefers a
 * member's `deno-test` over its `test`, and a member whose two readers
 * disagree is selectable a file at a time and recorded not at all.
 */
export async function leafTask(
  member: string,
  root: string | URL = Deno.cwd(),
): Promise<string | undefined> {
  const task = await memberTestTask(member, root);
  if (task === undefined) return undefined;
  const runs = task.split(/\s+/).some((word) =>
    word.endsWith(`/${MEMBER_TEST_RUNNER}`)
  );
  if (!runs) return task;
  const { testTask } = await memberManifest(member, root, DENO_TEST_TASK);
  return typeof testTask === "string" ? testTask : testTask?.command;
}

/**
 * The command line a member's `test` task runs, when the manifest Deno
 * resolves for that member defines the task with a command. A task defined
 * by its `dependencies` alone carries no command and reads as `undefined`
 * here, the same as a member defining no `test` task at all;
 * `assertMemberTestTasksDefined()` is what tells those two apart.
 */
export async function memberTestTask(
  member: string,
  root: string | URL = Deno.cwd(),
): Promise<string | undefined> {
  const { testTask } = await memberManifest(member, root);
  return typeof testTask === "string" ? testTask : testTask?.command;
}

/**
 * Throws unless every member defines a `test` task of its own, in whatever
 * form — a command, or dependencies alone — in the manifest Deno resolves
 * for it. Starting a run with one missing is what this refuses: `deno task
 * test` in that member's directory resolves against the root workspace
 * instead, which is this suite, so the run re-enters itself once per such
 * member.
 */
export async function assertMemberTestTasksDefined(
  members: readonly string[],
  root: string | URL = Deno.cwd(),
): Promise<void> {
  const missing: string[] = [];
  for (const member of members) {
    const { path, testTask } = await memberManifest(member, root);
    if (testTask === undefined) missing.push(path);
  }
  if (missing.length === 0) return;
  const named = missing.map((manifest) => `\`${manifest}\``).join(", ");
  throw new Error(
    [
      `Every workspace member needs a \`test\` task of its own.`,
      `Missing from: ${named}.`,
      `Add a \`test\` entry to that manifest's \`tasks\` — one running`,
      `\`tasks/run-member-tests.ts\` over a \`deno-test\` entry where the`,
      `package has tests, as \`base/text/deno.jsonc\` shows, or`,
      `\`echo 'No tests defined.'\` where it has none yet. Put it in the file`,
      `named above rather than in a second manifest beside it: where a member`,
      `carries both a \`deno.json\` and a \`deno.jsonc\`, Deno takes the`,
      `\`deno.json\` and ignores the other whole, \`imports\` and all.`,
      `Without the entry, \`deno task test\` in the package directory resolves`,
      `against the root workspace instead, and the whole suite runs inside`,
      `itself.`,
    ].join(" "),
  );
}

/**
 * Whether flags appended to a member's `deno task test` reach the `deno
 * test` of its leaf `task`, whole, which is how the member's tests are
 * permitted to record.
 */
export function acceptsAppendedFlags(task: string | undefined): boolean {
  if (task === undefined) return false;
  if (/[&;|<>]/.test(task)) return false;
  if (runsForwardingRunner(task)) return true;
  return /(^|\s)deno test(\s|$)/.test(task);
}

/**
 * The spool this run records into, absolute, or undefined where there is
 * none or Deno cannot be told about the one there is.
 *
 * Resolving here is what makes one directory of three: the runner reads
 * the spool with the workspace as its working directory, each leaf runs
 * with its own package as one, and the write granted to a leaf names a
 * path. A comma separates one path from the next inside `--allow-write=`,
 * and Deno offers no way to write one that belongs to a path, so a spool
 * holding a comma is granted as two paths that are not it; such a run
 * records nothing and says so, as every other recording problem does.
 */
export function recordingSpool(
  raw: string | undefined,
  workspaceCwd: string,
  warn: (message: string) => void = console.warn,
): string | undefined {
  if (raw === undefined) return undefined;
  const spool = path.resolve(workspaceCwd, raw);
  if (!spool.includes(",")) return spool;
  warn(`test records: no recording, the spool holds a comma: ${spool}`);
  return undefined;
}

/**
 * The flags the leaf `deno test` of a member's task runs under. A
 * forwarding runner's task line holds two lists: the runner process's
 * own flags, and after `--` the ones it hands its leaf. The leaf is what
 * runs the tests, so the leaf's list is the one that decides what
 * permission they have. Every other member runs its leaf directly, and
 * the whole line is that leaf's.
 */
export function leafFlags(task: string): string[] {
  const tokens = task.split(/\s+/);
  if (!runsForwardingRunner(task)) return tokens;
  const forwarded = tokens.indexOf("--");
  return forwarded === -1 ? tokens : tokens.slice(forwarded + 1);
}

/**
 * What a member's leaf takes for its tests to record into `spool` and read
 * the skip list where there is one: the permissions its own flags do not
 * grant. A member whose task cannot take appended flags takes nothing,
 * and its tests record only where its own flags already permit them to.
 */
export async function memberRecordingArguments(
  member: string,
  spool: string,
  root: string | URL = Deno.cwd(),
  skipList?: string,
): Promise<string[]> {
  const task = await leafTask(member, root);
  return acceptsAppendedFlags(task)
    ? recordingArguments(leafFlags(task ?? ""), { spool, skipList })
    : [];
}

// A filename-safe slug for a member's log and records, unique per member.
function memberSlug(packageName: string): string {
  return packageName.replaceAll("/", "__").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

// Cap on concurrently running package test tasks. Individual packages may also
// parallelize their tests. Half the cores limits that nested concurrency while
// allowing independent packages to overlap. TEST_CONCURRENCY overrides it.
export function testConcurrency(
  raw = Deno.env.get("TEST_CONCURRENCY"),
): number {
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `Invalid TEST_CONCURRENCY "${raw}"; expected a positive integer.`,
      );
    }
    return parsed;
  }
  return Math.max(2, Math.floor(navigator.hardwareConcurrency / 2));
}

/**
 * Runs every member of the workspace at `workspaceCwd`, and returns whether
 * every one of them passed.
 *
 * Without `DENO_COVERAGE_DIR`, workers stop taking new members once one
 * fails, so a failing run leaves the rest unstarted, and names them. With it,
 * every member runs whatever fails, so the coverage profile holds a record
 * for every member: the coverage-debt metric reads a member with no record as
 * source no test loaded.
 *
 * With `recordResults`, the run records into the spool the environment
 * names. The `deno task test` entry point sets it; a test driving this
 * function over a workspace of its own leaves it unset, because that
 * workspace's members are the test's fixtures rather than tests of this
 * repository. Without it, every member is handed recording off, so none
 * records into a spool it inherited either.
 */
export async function runTests(
  workspaceCwd: string = Deno.cwd(),
  { recordResults = false }: { recordResults?: boolean } = {},
): Promise<boolean> {
  const suiteStartedAt = Date.now();
  const members = await readWorkspaceMembers(
    path.join(workspaceCwd, "deno.jsonc"),
  );
  // No member's test task is spawned until every member has been checked:
  // one with no `test` task of its own is what turns a single run into an
  // unbounded number of them.
  await assertMemberTestTasksDefined(members, workspaceCwd);
  if (members.length === 0) {
    console.error("No workspace packages to test.");
    return false;
  }
  // Resolve to an absolute path: each package's test subprocess runs with its
  // own cwd, so a relative DENO_COVERAGE_DIR would land under
  // the package directory instead of the shared workspace coverage directory.
  const coverageRootRaw = Deno.env.get("DENO_COVERAGE_DIR");
  const coverageRoot = coverageRootRaw
    ? path.resolve(workspaceCwd, coverageRootRaw)
    : undefined;

  // Every package's output goes to a log file of its own in one directory,
  // which a failing run keeps and names. Each package is handed a records
  // directory of its own beside its log as its spool, which its tests write
  // their results into; the summary is read from those. With recording on,
  // what each package recorded is appended to the run's spool under the
  // package's own scope; a fragment that cannot be opened turns recording
  // off with a warning and never fails the suite.
  const logDir = await Deno.makeTempDir({ prefix: "deno-task-test-" });
  const spoolDir = recordResults
    ? recordingSpool(recordsDir(), workspaceCwd)
    : undefined;
  const fragment = spoolDir !== undefined
    ? FragmentWriter.open(spoolDir)
    : undefined;
  const workspaceUrl = path.toFileUrl(`${path.resolve(workspaceCwd)}/`);
  // A skip list the run inherits reaches every member, each in a directory
  // of its own, so it is named to them by its absolute path.
  const inheritedSkipList = readEnv(SKIP_LIST_VARIABLE);
  const skipList = inheritedSkipList
    ? path.resolve(workspaceCwd, inheritedSkipList)
    : undefined;

  const tests: TestResult[] = [];
  const commands: FailedCommand[] = [];
  const unreported: string[] = [];
  let next = 0;
  let stopped = false;
  const workerCount = Math.min(testConcurrency(), members.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stopped && next < members.length) {
      const memberPath = members[next++]!;
      const packageName = getPackageName(memberPath);
      const packagePath = path.resolve(workspaceCwd, memberPath);
      const slug = memberSlug(packageName);
      const memberSpool = path.join(logDir, `${slug}.records`);
      const result = await testPackage(
        memberPath,
        packageName,
        packagePath,
        coverageRoot,
        path.join(logDir, `${slug}.log`),
        {
          [RECORDS_DIR_VARIABLE]: memberSpool,
          ...(skipList === undefined ? {} : { [SKIP_LIST_VARIABLE]: skipList }),
        },
        await memberRecordingArguments(
          memberPath,
          memberSpool,
          workspaceUrl,
          skipList,
        ),
      );
      const report = await readMemberRecords(memberSpool, packageName);
      for (const record of report.records) fragment?.append(record);
      const results = testResults(
        report.records,
        report.failures,
        (record) => unitRerun(memberPath, record.test.n),
      );
      for (const test of results) tests.push(test);
      if (result.success && results.length === 0) unreported.push(packageName);
      if (!result.success) {
        if (coverageRoot === undefined) stopped = true;
        if (results.every(({ record }) => record.outcome !== "fail")) {
          commands.push({
            label: packageName,
            output: await Deno.readTextFile(result.log),
            log: result.log,
          });
        }
      }
    }
  });
  await Promise.all(workers);
  fragment?.close();
  // Every member below `next` was handed to a worker; the members above it
  // are the ones a stop after a failure left unstarted.
  const unstarted = members.slice(next);
  const summary = {
    tests,
    commands,
    unreported: unreported.sort(),
    notes: unstarted.length === 0 ? [] : [
      `Not started, because a package failed: ${unstarted.join(", ")}`,
    ],
    logs: logDir,
    seconds: (Date.now() - suiteStartedAt) / 1000,
  };
  const ok = passed(summary);
  if (ok) await Deno.remove(logDir, { recursive: true });
  printSummary(ok ? { ...summary, logs: undefined } : summary);
  return ok;
}

/**
 * Runs every member of the workspace at `workspaceCwd`, which must include
 * `tasks`, once `initialize` has set up the database dependencies, and
 * records the run. Returns whether every member passed.
 */
export async function main(
  workspaceCwd: string = Deno.cwd(),
  initialize: (cwd: string) => Promise<boolean> = initializeDb,
): Promise<boolean> {
  assertTaskTestsIncluded(
    await readWorkspaceMembers(path.join(workspaceCwd, "deno.jsonc")),
  );
  if (!await initialize(workspaceCwd)) return false;
  return await runTests(workspaceCwd, { recordResults: true });
}

/** What the root `deno task test` reads from and does to its process. */
export interface RootTestHost {
  /** The process's environment, which every member's task inherits. */
  env: Pick<Deno.Env, "set">;

  /** Settles the seed this process and its children shuffle by. */
  pinShuffleSeed: () => void;

  startRecording: () => Promise<RunRecording>;
  finishRecording: (recording: RunRecording) => Promise<void>;

  /** Runs the suite, and returns whether it passed. */
  run: () => Promise<boolean>;
}

/** The {@link RootTestHost} that is this Deno process. */
const DENO_HOST: RootTestHost = {
  env: Deno.env,
  pinShuffleSeed,
  startRecording: startRunRecording,
  finishRecording: finishRunRecording,
  run: main,
};

/**
 * The root `deno task test`, given its arguments, and the status it exits
 * with: 2 for any argument at all, 1 for a failing run, 0 for a passing one.
 *
 * The run owns test recording: with a personal key present it stamps a
 * spool, points its producers at it, ships it when the run ends, and sweeps
 * for orphans. Inside CI it joins the job's spool instead, and with neither
 * the whole path is inert. Recording never changes the exit status, and is
 * finished however the run ends.
 */
export async function runRootTestTask(
  args: readonly string[],
  host: RootTestHost = DENO_HOST,
): Promise<number> {
  if (args.length > 0) {
    console.error(
      "The root `test` task takes no arguments, and runs every package's " +
        "tests. To pass flags such as `--filter`, run the task of the " +
        "package holding the test:\n\n" +
        "  cd packages/<package-name>\n" +
        '  deno task test --filter "test name"\n\n' +
        '"Running one test by name" in docs/development/TESTING.md says more.',
    );
    return 2;
  }
  // Settled before any member's task starts, so every leaf of this run
  // shuffles the same way.
  host.pinShuffleSeed();
  const recording = await host.startRecording();
  // The producers of this process and every child join an owned run through
  // the inherited environment. A run that joined one already has it there.
  if (recording.mode === "own") {
    host.env.set(RECORDS_DIR_VARIABLE, recording.spool.dir);
  }
  try {
    return await host.run() ? 0 : 1;
  } finally {
    await host.finishRecording(recording);
  }
}

if (import.meta.main) Deno.exit(await runRootTestTask(Deno.args));
