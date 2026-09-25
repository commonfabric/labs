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
  ingestJUnit,
  preloadArgument,
  readNameMaps,
  RECORDS_DIR_VARIABLE,
  recordsDir,
  spoolWriteArgument,
} from "@commonfabric/test-support/records";
import { DENO_TEST_TASK } from "./run-member-tests.ts";
import { parseShard, type Shard } from "./shard-utils.ts";
import { WORKSPACE_TEST_WEIGHTS } from "./test-timing-weights.ts";
import { writeUnlaunchedMembers } from "./unlaunched-members.ts";
import { assignWeightedShards } from "./weighted-shards.ts";

export const ALL_DISABLED: string[] = [];

export function getPackageName(memberPath: string): string {
  const relativePath = memberPath.replace(/^\.\//, "");
  return relativePath.replace(/^packages\//, "");
}

export function parseDisabledPackageList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).filter((name) => name.length > 0);
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

export async function testPackage(
  memberPath: string,
  packageName: string,
  packagePath: string,
  coverageRoot: string | undefined,
  extraEnv?: Record<string, string>,
  junitPath?: string,
  recording: readonly string[] = [],
): Promise<{
  memberPath: string;
  packageName: string;
  packagePath: string;
  durationMs: number;
  result: Deno.CommandOutput;
}> {
  const startedAt = Date.now();
  let result: Deno.CommandOutput;
  try {
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
      args.push(`--junit-path=${junitPath}`, ...recording);
    }
    result = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: packagePath,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    result = {
      success: false,
      stdout: new Uint8Array(),
      stderr: encode(`${e}`),
      code: 1,
      signal: null,
    };
  }

  const durationMs = Date.now() - startedAt;
  const duration = (durationMs / 1000).toFixed(1);
  const status = result.success ? "ok" : "failed";
  console.log(`Finished ${packageName} in ${duration}s (${status})`);

  return {
    memberPath,
    packageName,
    packagePath,
    durationMs,
    result,
  };
}

type PackageResult = Awaited<ReturnType<typeof testPackage>>;

function reportPackageFailure(result: PackageResult): void {
  console.error(`Failed ${result.packageName} (${result.packagePath})`);
  console.log(decode(result.result.stdout));
  console.error(decode(result.result.stderr));
}

// Reads one leaf's JUnit XML and appends its cases to the spool. A leaf
// that wrote no XML — it crashed before the end, since deno test writes
// the file only at process exit — contributes nothing, and a malformed
// file warns without failing anything. The name maps the leaf's preload
// left in the spool are what give each case its file; they are read here
// rather than once for the suite so that a run killed part way through
// keeps the attribution of every package that finished.
async function ingestLeafJUnit(
  fragment: FragmentWriter,
  spoolDir: string,
  junitPath: string,
  scope: string,
  memberPath: string,
): Promise<void> {
  let xml: string;
  try {
    xml = await Deno.readTextFile(junitPath);
  } catch {
    return;
  }
  try {
    const prefix = memberPath.replace(/^\.\//, "");
    for (
      const record of ingestJUnit(xml, {
        kind: "unit",
        scope,
        filePrefix: prefix,
        fileByName: await readNameMaps(spoolDir, { ranIn: prefix }),
      })
    ) {
      fragment.append(record);
    }
  } catch (error) {
    console.warn(`test records: ingesting ${junitPath} failed: ${error}`);
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

// One `deno task test` invocation: a workspace member, plus environment
// variables when the member is one slice of an internally sharded package.
export interface TestUnit {
  memberPath: string;
  packageName: string;
  env?: Record<string, string>;
}

// Packages whose test runner supports internal sharding via an environment
// variable. When the workspace run itself is sharded, such a package is
// expanded into `total` weighted units so one heavy package can run across
// several workspace shards. Without a workspace shard (local runs), the
// package runs as a single unit and the variable stays unset.
const INTERNALLY_SHARDED_PACKAGES: Record<
  string,
  { total: number; envVar: string }
> = {
  "connectors/agents/host": {
    total: 5,
    envVar: "AGENTS_HOST_TEST_SHARD",
  },
  cli: { total: 10, envVar: "CLI_TEST_SHARD" },
  piece: { total: 3, envVar: "PIECE_TEST_SHARD" },
  tasks: { total: 3, envVar: "TASK_TEST_SHARD" },
};

// A member's leaf — its `test` task, or the `deno-test` that task hands
// the flags to when it runs `tasks/run-member-tests.ts` — takes an
// appended `--junit-path` whole when it runs exactly one `deno test`.
// That is read from the task itself, so a package that lands with an
// ordinary leaf is covered without being listed anywhere. A leaf carrying
// a shell metacharacter puts the appended flag somewhere other than the
// test command, and takes it for none.
//
// A leaf that runs a script of its own cannot show what the script does
// with the flags it is handed. `tasks/run-sharded-test-files.ts` is the
// script known to forward them: it hands them to its `deno test` runs and
// leaves one report where the flag names. A leaf running any other script
// is kept out: `identity` drives a browser harness that records through
// the deno-web-test reporter instead.
const FLAG_FORWARDING_RUNNER = "run-sharded-test-files.ts";

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
      `package has tests, as \`packages/utils/deno.jsonc\` shows, or`,
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
 * preload, and the write permission it needs to leave its name map in
 * the spool. A member whose task cannot take the preload takes neither,
 * and appears with no arguments at all.
 */
export async function memberRecordingArguments(
  members: readonly string[],
  spool: string,
  root: string | URL = Deno.cwd(),
): Promise<Map<string, string[]>> {
  const recording = new Map<string, string[]>();
  for (const member of members) {
    const task = await leafTask(member, root);
    if (!acceptsPreload(task)) {
      recording.set(member, []);
      continue;
    }
    const write = spoolWriteArgument(leafFlags(task ?? ""), spool);
    recording.set(
      member,
      write === undefined ? [preloadArgument()] : [preloadArgument(), write],
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

// The identity scope of a unit: the package name with any internal slice
// label stripped, so the records of "cli (3/10)" and "cli (7/10)" join.
export function unitScope(packageName: string): string {
  return packageName.replace(/ \(\d+\/\d+\)$/, "");
}

// A filename-safe slug for a unit's JUnit file, unique per slice.
export function unitSlug(packageName: string): string {
  return packageName.replaceAll("/", "__").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

// Enabled workspace members are split by observed test cost. Without a shard,
// every enabled member is selected as a single unit.
export function selectShardMembers(
  members: string[],
  disabledPackages: string[],
  shard: Shard | undefined,
): TestUnit[] {
  const enabled = members.filter(
    (memberPath) => !disabledPackages.includes(getPackageName(memberPath)),
  );
  if (!shard) {
    return enabled.map((memberPath) => ({
      memberPath,
      packageName: getPackageName(memberPath),
    }));
  }

  const units: TestUnit[] = [];
  for (const memberPath of enabled) {
    const packageName = getPackageName(memberPath);
    const split = INTERNALLY_SHARDED_PACKAGES[packageName];
    if (!split) {
      units.push({ memberPath, packageName });
      continue;
    }
    for (let slice = 1; slice <= split.total; slice++) {
      units.push({
        memberPath,
        packageName: `${packageName} (${slice}/${split.total})`,
        env: { [split.envVar]: `${slice}/${split.total}` },
      });
    }
  }

  const assignments = assignWeightedShards(
    units.map((unit) => ({
      name: unit.packageName,
      weight: WORKSPACE_TEST_WEIGHTS[unit.packageName] ?? 1,
      group: unit.memberPath,
    })),
    shard.total,
  );
  return units
    .filter((unit) => assignments.get(unit.packageName) === shard.index)
    .sort((a, b) =>
      (WORKSPACE_TEST_WEIGHTS[b.packageName] ?? 1) -
        (WORKSPACE_TEST_WEIGHTS[a.packageName] ?? 1) ||
      a.packageName.localeCompare(b.packageName)
    );
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
 * Runs the enabled members of the workspace at `workspaceCwd`, or this shard's
 * share of them, and returns whether every one of them passed.
 *
 * Workers stop taking new members once one fails, so a failing run leaves the
 * rest unstarted. With coverage collection on, the members it never started
 * are recorded in the coverage profile directory, since their coverage is
 * unknown rather than absent; see `unlaunched-members.ts`.
 */
export async function runTests(
  disabledPackages: string[],
  shard?: Shard,
  workspaceCwd: string = Deno.cwd(),
): Promise<boolean> {
  const suiteStartedAt = Date.now();
  const members = await readWorkspaceMembers(
    path.join(workspaceCwd, "deno.jsonc"),
  );
  // No member's test task is spawned until every member has been checked,
  // and every member is checked rather than this shard's: one with no `test`
  // task of its own is what turns a single run into an unbounded number of
  // them.
  await assertMemberTestTasksDefined(members, workspaceCwd);
  const units = selectShardMembers(members, disabledPackages, shard);
  if (units.length === 0) {
    console.error("No workspace packages selected to test.");
    return false;
  }
  // Resolve to an absolute path: each package's test subprocess runs with its
  // own cwd, so a relative DENO_COVERAGE_DIR would land under
  // packages/<pkg>/... instead of the shared workspace coverage directory.
  const coverageRootRaw = Deno.env.get("DENO_COVERAGE_DIR");
  const coverageRoot = coverageRootRaw
    ? path.resolve(workspaceCwd, coverageRootRaw)
    : undefined;

  // With recording on, junit-capable leaves get a --junit-path in a
  // temporary directory, and each leaf's XML is ingested into the spool as
  // unit-kind records under the package's own scope. The runner stays
  // plumbing: it forwards the flag and moves the results; the reported
  // names come from the leaves. A temporary directory that cannot be
  // created turns recording off with a warning; it never fails the suite.
  const spoolDir = recordingSpool(recordsDir(), workspaceCwd);
  let junitRoot: string | undefined;
  if (spoolDir !== undefined) {
    try {
      junitRoot = await Deno.makeTempDir({ prefix: "workspace-junit-" });
    } catch (error) {
      console.warn(`test records: no JUnit directory: ${error}`);
    }
  }
  const fragment = spoolDir !== undefined && junitRoot !== undefined
    ? FragmentWriter.open(spoolDir)
    : undefined;
  // Read once here rather than per unit: an internally sharded package
  // appears as several units that share one manifest.
  const memberPaths = units.map((unit) => unit.memberPath);
  const workspaceUrl = new URL(`file://${path.resolve(workspaceCwd)}/`);
  const capable = junitRoot !== undefined
    ? await junitCapableMembers(memberPaths, workspaceUrl)
    : new Set<string>();
  const recording = junitRoot !== undefined && spoolDir !== undefined
    ? await memberRecordingArguments(memberPaths, spoolDir, workspaceUrl)
    : new Map<string, string[]>();

  const results: PackageResult[] = [];
  let nextUnit = 0;
  let failureSeen = false;
  const workerCount = Math.min(testConcurrency(), units.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failureSeen && nextUnit < units.length) {
      const unit = units[nextUnit++];
      console.log(`Testing ${unit.packageName}...`);
      const packagePath = path.resolve(workspaceCwd, unit.memberPath);
      const junitPath = junitRoot !== undefined && capable.has(unit.memberPath)
        ? path.join(junitRoot, `${unitSlug(unit.packageName)}.xml`)
        : undefined;
      const result = await testPackage(
        unit.memberPath,
        unit.packageName,
        packagePath,
        coverageRoot,
        spoolDir === undefined
          ? unit.env
          : { ...unit.env, [RECORDS_DIR_VARIABLE]: spoolDir },
        junitPath,
        recording.get(unit.memberPath),
      );
      results.push(result);
      if (
        junitPath !== undefined && fragment !== undefined &&
        spoolDir !== undefined
      ) {
        await ingestLeafJUnit(
          fragment,
          spoolDir,
          junitPath,
          unitScope(unit.packageName),
          unit.memberPath,
        );
      }
      if (!result.result.success) {
        failureSeen = true;
        reportPackageFailure(result);
      }
    }
  });
  await Promise.all(workers);
  fragment?.close();
  if (junitRoot !== undefined) {
    await Deno.remove(junitRoot, { recursive: true }).catch(() => {});
  }
  // Every unit below `nextUnit` was handed to a worker; the units above it are
  // the ones the stop after a failure left unstarted. An internally sharded
  // package is several units over one member, and a member with any unstarted
  // slice is measured over less than its own tests, so the member is named
  // whichever of its slices went unstarted.
  const unlaunchedMembers = [
    ...new Set(units.slice(nextUnit).map((unit) => unit.memberPath)),
  ];
  if (coverageRoot !== undefined) {
    await writeUnlaunchedMembers(coverageRoot, unlaunchedMembers);
  }

  const durationResults = [...results].sort((a, b) =>
    b.durationMs - a.durationMs
  );
  const failedPackages = results.filter((result) => !result.result.success);

  console.log("Package timings:");
  for (const result of durationResults) {
    const duration = (result.durationMs / 1000).toFixed(1);
    const status = result.result.success ? "ok" : "failed";
    console.log(`- ${result.packageName}: ${duration}s (${status})`);
  }
  console.log(
    `Total wall time: ${((Date.now() - suiteStartedAt) / 1000).toFixed(1)}s`,
  );

  if (failedPackages.length === 0) {
    console.log("All tests passing!");
  } else {
    console.error("One or more tests failed.");
    console.error("Failed packages:");
    for (const result of failedPackages) {
      console.error(`- ${result.packageName} (${result.packagePath})`);
    }
  }

  if (unlaunchedMembers.length > 0) {
    console.error("Packages this run selected and never started:");
    for (const member of unlaunchedMembers) {
      console.error(`- ${member}`);
    }
  }

  return failedPackages.length === 0;
}

export async function main(): Promise<boolean> {
  const shardRaw = Deno.env.get("TEST_SHARD");
  const shard = shardRaw ? parseShard(shardRaw) : undefined;
  assertTaskTestsIncluded(await readWorkspaceMembers());
  // A failure here returns rather than exits: the entry point's recording
  // teardown runs in a finally that an exit would skip.
  if (!await initializeDb()) return false;
  return await runTests(
    [
      ...ALL_DISABLED,
      ...parseDisabledPackageList(Deno.env.get("TEST_DISABLED_PACKAGES")),
    ],
    shard,
  );
}
