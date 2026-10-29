/**
 * Implementation of the root `deno task test` runner. The entry point is
 * tasks/test.ts; the logic lives here because `deno coverage` skips files
 * whose names end in test.ts, and the coverage-debt metric scores an
 * unmeasured file as fully uncovered.
 */

import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { decode, encode } from "@commonfabric/utils/encoding";
import {
  FragmentWriter,
  readEnv,
  readJUnit,
  readNameMaps,
  recordingArguments,
  RECORDS_DIR_VARIABLE,
  recordsDir,
  SKIP_LIST_VARIABLE,
} from "@commonfabric/test-support/records";
import { withoutPackageParent } from "./package-layout.ts";
import { DENO_TEST_TASK } from "./run-member-tests.ts";
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
  junitPath?: string,
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
  // which is what threads the flags down to the leaf `deno test`. The
  // recording arguments travel with the JUnit path because they reach
  // the leaf the same way and the report is what the preload's map is
  // joined onto; a member whose task cannot take one cannot take the
  // other.
  const args = ["task", "test"];
  if (junitPath !== undefined) {
    args.push(`--junit-path=${junitPath}`);
    for (const argument of recording) args.push(argument);
  }
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
 * The records of the JUnit report a member's leaf wrote, and the message
 * each failing one failed with. A leaf that wrote no report, because it
 * crashed before the end and `deno test` writes the file only at process
 * exit, has none, and a malformed report warns and has none. The name
 * maps a recording leaf's preload left in the spool are what give each
 * case its file; they are read here rather than once for the suite so
 * that a run killed part way through keeps the attribution of every
 * package that finished.
 */
async function readLeafReport(
  junitPath: string,
  scope: string,
  memberPath: string,
  spoolDir: string | undefined,
): Promise<ReturnType<typeof readJUnit> | undefined> {
  let xml: string;
  try {
    xml = await Deno.readTextFile(junitPath);
  } catch {
    return undefined;
  }
  try {
    const prefix = memberPath.replace(/^\.\//, "");
    return readJUnit(xml, {
      kind: "unit",
      scope,
      filePrefix: prefix,
      fileByName: spoolDir === undefined
        ? new Map()
        : await readNameMaps(spoolDir, { ranIn: prefix }),
    });
  } catch (error) {
    console.warn(`test summary: reading ${junitPath} failed: ${error}`);
    return undefined;
  }
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
// the flags to when it runs `tasks/run-member-tests.ts` — takes an
// appended `--junit-path` whole when it runs exactly one `deno test`.
// That is read from the task itself, so a package that lands with an
// ordinary leaf is covered without being listed anywhere. A leaf carrying
// a shell metacharacter puts the appended flag somewhere other than the
// test command, and takes it for none.
//
// A leaf that runs a script of its own cannot show what the script does
// with the flags it is handed. `tasks/run-test-batches.ts` is the script
// known to forward them: it hands them to its `deno test` runs and leaves
// one report where the flag names. A leaf running any other script is kept
// out: `identity` drives a browser harness that records through the
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
 * decides whether a report path and the preload can be used at all.
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
      `package has tests, as \`base/utils/deno.jsonc\` shows, or`,
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
 * Whether an appended `--junit-path` reaches the `deno test` of a member
 * whose leaf is `task`, whole, so the runner can thread the flag and
 * ingest the XML it writes.
 */
export function acceptsJUnitPath(task: string | undefined): boolean {
  if (task === undefined) return false;
  if (/[&;|<>]/.test(task)) return false;
  if (runsForwardingRunner(task)) return true;
  return /(^|\s)deno test(\s|$)/.test(task);
}

/**
 * Whether an appended `--preload` reaches this member's `deno test` and
 * loads once it gets there. A member naming its own import map is the one
 * that cannot: that map governs every module of the invocation, the
 * preload included, so a specifier the preload needs and the map does not
 * carry fails the whole run rather than the preload alone. What that
 * member gives up is the preload's name map, so its files come from the
 * report's own class names, which name the test file for a registration
 * with nothing of this repository's own between the file and
 * `Deno.test`.
 */
export function acceptsPreload(task: string | undefined): boolean {
  if (!acceptsJUnitPath(task)) return false;
  return task === undefined || !/--import-map[= ]/.test(task);
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
 * loads the preload, so the leaf's list is the one that decides what
 * permission the preload has. Every other member runs its leaf directly,
 * and the whole line is that leaf's.
 */
export function leafFlags(task: string): string[] {
  const tokens = task.split(/\s+/);
  if (!runsForwardingRunner(task)) return tokens;
  const forwarded = tokens.indexOf("--");
  return forwarded === -1 ? tokens : tokens.slice(forwarded + 1);
}

/**
 * What each member's leaf takes to record, beyond the JUnit path: the
 * preload, and the permissions it needs to find the repository, read the
 * skip list where there is one, and leave its name map in the spool. A
 * member whose task cannot take the preload takes neither, and appears
 * with no arguments at all.
 */
export async function memberRecordingArguments(
  members: readonly string[],
  spool: string,
  root: string | URL = Deno.cwd(),
  skipList?: string,
): Promise<Map<string, string[]>> {
  const rootPath = path.fromFileUrl(directoryUrl(root));
  const recording = new Map<string, string[]>();
  for (const member of members) {
    const task = await leafTask(member, root);
    recording.set(
      member,
      acceptsPreload(task)
        ? recordingArguments(leafFlags(task ?? ""), {
          spool,
          root: rootPath,
          skipList,
        })
        : [],
    );
  }
  return recording;
}

/** The members whose leaves take the flag, read from their manifests. */
export async function junitCapableMembers(
  members: readonly string[],
  root: string | URL = Deno.cwd(),
): Promise<Set<string>> {
  const capable = new Set<string>();
  for (const member of members) {
    if (acceptsJUnitPath(await leafTask(member, root))) {
      capable.add(member);
    }
  }
  return capable;
}

// A filename-safe slug for a member's JUnit file, unique per member.
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
  // which a failing run keeps and names, and junit-capable leaves write
  // their reports beside the logs. The summary is read from the reports.
  // With recording on, each leaf is handed the recording preload as well,
  // and its records are appended to the spool under the package's own
  // scope; a fragment that cannot be opened turns recording off with a
  // warning and never fails the suite.
  const logDir = await Deno.makeTempDir({ prefix: "deno-task-test-" });
  const spoolDir = recordResults
    ? recordingSpool(recordsDir(), workspaceCwd)
    : undefined;
  const fragment = spoolDir !== undefined
    ? FragmentWriter.open(spoolDir)
    : undefined;
  const workspaceUrl = path.toFileUrl(`${path.resolve(workspaceCwd)}/`);
  const capable = await junitCapableMembers(members, workspaceUrl);
  // A skip list the run inherits reaches every member, each in a directory
  // of its own, so it is named to them by its absolute path.
  const inheritedSkipList = readEnv(SKIP_LIST_VARIABLE);
  const skipList = inheritedSkipList
    ? path.resolve(workspaceCwd, inheritedSkipList)
    : undefined;
  const recording = spoolDir !== undefined
    ? await memberRecordingArguments(
      members,
      spoolDir,
      workspaceUrl,
      skipList,
    )
    : new Map<string, string[]>();

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
      const junitPath = capable.has(memberPath)
        ? path.join(logDir, `${slug}.xml`)
        : undefined;
      const result = await testPackage(
        memberPath,
        packageName,
        packagePath,
        coverageRoot,
        path.join(logDir, `${slug}.log`),
        {
          [RECORDS_DIR_VARIABLE]: spoolDir ?? "",
          ...(skipList === undefined ? {} : { [SKIP_LIST_VARIABLE]: skipList }),
        },
        junitPath,
        recording.get(memberPath),
      );
      const report = junitPath === undefined
        ? undefined
        : await readLeafReport(junitPath, packageName, memberPath, spoolDir);
      for (const record of report?.records ?? []) fragment?.append(record);
      const results = testResults(
        report?.records ?? [],
        report?.failures ?? new Map(),
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

export async function main(): Promise<boolean> {
  assertTaskTestsIncluded(await readWorkspaceMembers());
  // A failure here returns rather than exits: the entry point's recording
  // teardown runs in a finally that an exit would skip.
  if (!await initializeDb()) return false;
  return await runTests(Deno.cwd(), { recordResults: true });
}
