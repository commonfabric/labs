#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

/**
 * Whether the topology still accounts for everything.
 *
 * The topology is only worth having if it stays complete: a test surface
 * nobody registered would vanish from the full run, which is a worse
 * failure than the workflow edit it replaced. A surface goes missing in
 * three ways, and a check answers each.
 *
 * The tree half needs no store and runs on every pull request. It walks
 * the tree for things that look like tests and fails on any that no
 * suite accounts for, or that two suites claim under the same record
 * surface and variant. This is what catches a pull request adding a test
 * surface nobody registered, at the moment it is added.
 *
 * The workflow half runs beside it, over the step definitions under
 * `.github`. A step can wrap a command in `run-recorded`. The three
 * words after it are the command's identity, and every record the
 * command writes carries that identity. The topology is the other place
 * an identity is written down. A lane builds its commands from the
 * topology, so a step whose identity no suite holds runs while that step
 * stands and stops when a lane takes over the job holding it. Nothing in
 * the tree carries such an identity, which is what puts it out of the
 * tree half's reach.
 *
 * The store half runs over the records of the run that checked this tree
 * out, and fails on any identity no suite recognizes,
 * or that more than one suite claims. This catches the subtler case: a
 * surface that is registered and whose files enumerate, but whose
 * recorded names or configuration do not map back to the topology, which
 * would leave those tests running in the full run and never selectable
 * on a pull request. Records from another commit are refused rather than
 * judged, because a tree disagrees with an earlier run's records over
 * every test deleted or renamed since.
 *
 * The reverse direction is reported rather than failed. A unit the
 * topology holds that no run has ever recorded is either a test that
 * never runs or a mapping that is wrong, and both are worth knowing
 * about without blocking anybody.
 *
 *   deno task check-test-topology            # tree and workflows
 *   deno task check-test-topology --commit <sha> --records <path>...
 *                                            # those and the store
 *
 * Each path is a file of records or a directory holding them, walked for
 * every `.ndjson` under it, so a run's downloaded record artifacts are
 * named as the one directory they arrive in. A directory a job gathered
 * carries the commit its records are from in the facts beside them, and
 * a path holding no records fails rather than being read as a part of
 * the run that had none.
 */

import * as path from "@std/path";
import {
  type AliasResolver,
  loadAliasResolver,
  parseReportGroups,
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import {
  commandWords,
  withoutComments,
  withoutContinuations,
} from "./ci-workflow.ts";
import { isLaneMeasurement } from "./lane-measurement.ts";
import { dayOf } from "./test-selection/build.ts";
import { DENO_TEST_FILE } from "./test-topology/deno-task.ts";
import { claimsFor, loadTopology } from "./test-topology.ts";
import { type Suite, unavailableUnits } from "./test-topology/suite.ts";

/** What the command line takes, for a command line it cannot act on. */
export const USAGE = `usage:
  check-test-topology                                   tree and workflows
  check-test-topology --commit <sha> --records <path>...   and the store

each <path> is a file of records or a directory of them, an artifact a run
gathered among them`;

/**
 * What the tree half looks at. The same rule the topology enumerates a
 * member's tests by, so a file one of them treats as a test cannot be a
 * file the other passes over.
 */
const TEST_FILE = DENO_TEST_FILE;

/** Directories that hold no test surface of their own. */
const SKIPPED = new Set([
  ".git",
  "node_modules",
  "vendor",
  "coverage",
  "dist",
  "target",
]);

/** Roots the walk starts from. Everything else holds no tests. */
const ROOTS = ["packages", "tasks", "scripts", "tools"];

/** Every path in the tree that looks like a test surface. */
export async function candidateSurfaces(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    // The entries are read before any of them is followed, and only that
    // read is allowed to answer "no such directory". A catch around the
    // recursion as well would let one directory that vanished mid-walk —
    // a temporary one a running test made and removed — end the walk at
    // every level above it, silently shortening the list the guard
    // checks against. That is the guard failing while reporting success.
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(path.join(root, relative)));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      const at = `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        if (!SKIPPED.has(entry.name)) await walk(at);
        continue;
      }
      if (!entry.isFile) continue;
      if (TEST_FILE.test(entry.name)) found.push(at);
      else if (
        entry.name.endsWith(".sh") && relative.endsWith("/integration")
      ) {
        found.push(at);
      }
    }
  };
  for (const start of ROOTS) await walk(start);
  return found.sort();
}

/**
 * Paths that look like tests and are not: fixtures a test drives rather
 * than tests of their own. An entry ending in `/` is a directory, and
 * covers everything under it. Each says why, and an entry that stops
 * applying fails, so the list cannot go stale unnoticed.
 */
const NOT_A_TEST_SURFACE: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "packages/deno-web-test/test/broken-config-project/pass.test.ts",
    reason: "a project the harness runs to prove it reports a bad config",
  },
  {
    path: "packages/deno-web-test/test/bundle-project/bundled.test.ts",
    reason: "a project the harness runs to prove it bundles before serving",
  },
  {
    path: "packages/deno-web-test/test/project-with-config/ed25519.test.ts",
    reason: "a project the harness runs to prove it reads a project config",
  },
  {
    path: "packages/deno-web-test/test/success-project/add.test.ts",
    reason: "a project the harness runs to prove a passing run reports green",
  },
  {
    path: "packages/deno-web-test/test/timeout-project/hang.test.ts",
    reason: "a project the harness runs to prove it reports a wedged test",
  },
  {
    path: "packages/cli/test/fixtures/",
    reason: "pattern tests the CLI's own tests hand to `cf test`, to check " +
      "what it reports for each",
  },
  {
    path: "packages/cli/integration/bulk-ops-demo.sh",
    reason: "a tour of the bulk commands, quoted by the documentation the " +
      "verb-session gate holds to it rather than run as a test",
  },
  {
    path: "packages/cli/integration/read-write-demo.sh",
    reason: "a tour of the read and write commands, quoted by the " +
      "documentation the verb-session gate holds to it",
  },
  {
    path: "packages/cli/integration/verb-session-demo.sh",
    reason: "the walkthrough the verb-session gate holds the documentation " +
      "to, read rather than run",
  },
];

/** Where the steps continuous integration runs are defined. */
const CI_DEFINITIONS = ".github";

/** The words that introduce a recording step, in the order they read. */
const RUN_RECORDED = ["deno", "task", "run-recorded"];

/** One recording step: the identity it writes, and the file holding it. */
export interface WorkflowRecord {
  test: TestIdentity;
  where: string;
}

/**
 * The identities the words of one file record. `deno task run-recorded`
 * is followed by the three parts of an identity, so the three words
 * after it are the identity. A step whose parts are quoted, or whose
 * identity holds a workflow expression the run resolves, gives an
 * identity no suite claims, and the check that reads it fails.
 */
function recordedIdentities(text: string, where: string): WorkflowRecord[] {
  const words = commandWords(withoutContinuations(withoutComments(text)));
  const found: WorkflowRecord[] = [];
  for (let at = 0; at + RUN_RECORDED.length < words.length; at++) {
    if (RUN_RECORDED.some((word, index) => words[at + index] !== word)) {
      continue;
    }
    const [k, s, n] = words.slice(at + RUN_RECORDED.length).slice(0, 3);
    if (k === undefined || s === undefined || n === undefined) {
      throw new Error(`${where} ends in the middle of a recording step`);
    }
    found.push({ test: { k, s, n }, where });
  }
  return found;
}

/** Every identity a step under `.github` records by hand. */
export async function workflowRecords(
  root: string,
): Promise<WorkflowRecord[]> {
  const found: WorkflowRecord[] = [];
  const walk = async (relative: string): Promise<void> => {
    // As in the tree walk, only the read of a directory's own entries
    // answers "no such directory". A directory that vanishes deeper in
    // the walk raises.
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(path.join(root, relative)));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : 1);
    for (const entry of entries) {
      const at = `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(at);
        continue;
      }
      if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
      const text = await Deno.readTextFile(path.join(root, at));
      found.push(...recordedIdentities(text, at));
    }
  };
  await walk(CI_DEFINITIONS);
  return found;
}

/** One thing the check found. */
export interface Finding {
  /** Whether it fails the check or is only reported. */
  fails: boolean;
  message: string;
}

/** Every path a suite accounts for exactly, and every one it contains. */
function claimsOf(
  suite: Suite,
): { exact: Set<string>; containers: string[] } {
  const exact = new Set<string>(suite.sources ?? []);
  const containers: string[] = [];
  for (const unit of suite.units) {
    if (TEST_FILE.test(unit)) exact.add(unit);
    else containers.push(unit);
  }
  for (const entry of suite.unavailable) exact.add(entry.unit);
  return { exact, containers };
}

/**
 * The tree half: everything that looks like a test is claimed by some
 * suite, and no two suites claim one path under the same variant.
 */
export function checkTree(
  suites: readonly Suite[],
  candidates: readonly string[],
  declared: {
    fixtures?: ReadonlyArray<{ path: string; reason: string }>;
  } = {},
): Finding[] {
  const findings: Finding[] = [];
  const claims = suites.map((suite) => ({ suite, ...claimsOf(suite) }));
  const fixtures = new Map(
    (declared.fixtures ?? []).map((entry) => [entry.path, entry.reason]),
  );
  // The entry covering a path: the path itself, or a directory above it.
  const fixtureOf = (candidate: string): string | undefined =>
    [...fixtures.keys()].find((entry) =>
      entry === candidate ||
      (entry.endsWith("/") && candidate.startsWith(entry))
    );
  const held = new Set<string>();
  for (const candidate of candidates) {
    const exact = claims.filter((claim) => claim.exact.has(candidate));
    // A default suite and a non-default suite may claim one source
    // file: they are distinct execution surfaces with separate
    // histories. Two suites sharing a variant may not.
    const byVariant = new Map<string, string[]>();
    for (const claim of exact) {
      const variant = claim.suite.variant ?? "";
      byVariant.set(variant, [
        ...byVariant.get(variant) ?? [],
        claim.suite.id,
      ]);
    }
    for (const [variant, ids] of byVariant) {
      if (ids.length > 1) {
        findings.push({
          fails: true,
          message: `${candidate} is claimed by ${ids.join(" and ")}` +
            (variant === "" ? "" : ` under variant ${variant}`),
        });
      }
    }
    const fixture = fixtureOf(candidate);
    if (exact.length > 0) {
      if (fixture !== undefined) {
        findings.push({
          fails: true,
          message: `${candidate} is claimed by a suite and is still listed ` +
            `as a fixture: ${fixtures.get(fixture)}`,
        });
      }
      continue;
    }
    if (fixture !== undefined) {
      held.add(fixture);
      continue;
    }
    // A suite whose units are coarser than a file — a workspace member
    // that runs whole, a directory one task owns — accounts for what it
    // contains.
    const containing = claims.filter((claim) =>
      claim.containers.some((unit) => candidate.startsWith(`${unit}/`))
    );
    // Containment is coarse and legitimately overlapping: a workspace
    // member that runs whole contains a directory another suite owns,
    // and a type-check group's unit is a scope name that reads as a
    // directory prefix. Only an exact claim is exclusive.
    if (containing.length > 0) continue;
    findings.push({
      fails: true,
      message: `${candidate} is claimed by no suite`,
    });
  }
  for (const path of fixtures.keys()) {
    if (held.has(path)) continue;
    if (candidates.some((candidate) => fixtureOf(candidate) === path)) {
      continue;
    }
    findings.push({
      fails: true,
      message: `${path} is listed as a fixture and the tree no longer holds it`,
    });
  }
  return findings;
}

/**
 * The workflow half: every identity a workflow step records by hand is
 * claimed by exactly one suite.
 */
export function checkWorkflows(
  suites: readonly Suite[],
  records: readonly WorkflowRecord[],
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const key = testIdentityKey(record.test);
    if (seen.has(key)) continue;
    seen.add(key);
    const claims = claimsFor(suites, record);
    if (claims.length === 1) continue;
    findings.push({
      fails: true,
      message: claims.length === 0
        ? `no suite claims ${key}, which ${record.where} records`
        : `${claims.map((claim) => claim.suite.id).join(" and ")} ` +
          `both claim ${key}, which ${record.where} records`,
    });
  }
  return findings;
}

/** A record as the store half reads one. */
export interface StoredIdentity {
  test: TestIdentity;
  file?: string;

  /** The commit the run that recorded it was checked out at. */
  commit?: string;

  /**
   * What the record was read from, named the way the run names it: the
   * artifact a job shipped, or the file when a path was given directly.
   * A failing identity is one somebody has to go and find, and this is
   * the job that produced it.
   */
  from?: string;
}

/**
 * The store half: every recorded identity is claimed by exactly one
 * suite, and every unit some run recorded is reported when no run did.
 *
 * The records have to be the ones this tree produced, which is what the
 * commit says. A tree judged against an earlier run's records disagrees
 * with them for every test the change between the two deleted, since the
 * topology has no unit for a test the tree no longer holds; the same
 * goes for a rename, whose alias reaches records from earlier days and
 * not records from today. Both are the repository working as intended,
 * and a guard that fails on them is a guard that fails on deleting a
 * test. So a record from another commit is refused rather than judged,
 * and so is one that names no commit, which is a record whose group
 * carried no context and which nothing can hold to this tree.
 */
export function checkStore(
  suites: readonly Suite[],
  records: readonly StoredIdentity[],
  commit: string,
): Finding[] {
  const findings: Finding[] = [];
  const elsewhere = new Set<string>();
  const nameless = new Set<string>();
  for (const record of records) {
    if (record.commit === undefined) nameless.add(record.from ?? "a record");
    else if (record.commit !== commit) {
      elsewhere.add(
        record.from === undefined
          ? record.commit
          : `${record.commit} (${record.from})`,
      );
    }
  }
  if (elsewhere.size > 0 || nameless.size > 0) {
    const named = [...elsewhere].sort();
    if (nameless.size > 0) {
      // Naming what carried no commit is what says which producer to go
      // to; a count alone leaves that to a search.
      named.push(`no commit at all from ${[...nameless].sort().join(", ")}`);
    }
    return [{
      fails: true,
      message: `the records name ${named.join(", ")} and this tree is ` +
        `${commit}: the store half judges a tree by the records that tree ` +
        `produced`,
    }];
  }
  const seen = new Set<string>();
  const recorded = new Set<string>();
  /**
   * Where a failing identity came from, for a reader who has to go and
   * find it. The identity alone says what disagreed; this says which job
   * wrote it down and which file it named, where either is known.
   */
  const whence = (record: StoredIdentity): string => {
    const parts = [
      ...(record.from === undefined ? [] : [`recorded by ${record.from}`]),
      ...(record.file === undefined ? [] : [`from ${record.file}`]),
    ];
    return parts.length === 0 ? "" : `, ${parts.join(" ")}`;
  };
  for (const record of records) {
    const key = testIdentityKey(record.test);
    if (seen.has(key)) continue;
    seen.add(key);
    // The lane measures its own setup and batches through the same
    // record machinery every test uses. Those are not test surfaces —
    // nothing enumerates them and no lane can be asked to run one — so
    // no suite claims them and none should.
    if (isLaneMeasurement(record.test)) continue;
    const claims = claimsFor(suites, record);
    if (claims.length === 0) {
      findings.push({
        fails: true,
        message: `no suite claims the recorded identity ${key}` +
          whence(record),
      });
      continue;
    }
    if (claims.length > 1) {
      findings.push({
        fails: true,
        message: `${claims.map((claim) => claim.suite.id).join(" and ")} ` +
          `both claim the recorded identity ${key}` + whence(record),
      });
      continue;
    }
    const claim = claims[0]!;
    if (claim.unit !== undefined) {
      recorded.add(`${claim.suite.id}\t${claim.unit}`);
    }
  }
  for (const suite of suites) {
    // A leaf declared unavailable leaves its unit expected to record,
    // because every other identity in that unit still runs.
    const unavailable = unavailableUnits(suite);
    for (const unit of suite.units) {
      if (unavailable.has(unit)) continue;
      if (recorded.has(`${suite.id}\t${unit}`)) continue;
      findings.push({
        fails: false,
        message: `${suite.id} enumerates ${unit}, which this run never ` +
          "recorded: either it never runs or its mapping is wrong",
      });
    }
  }
  return findings;
}

/** One file of records, and what is known about where it came from. */
interface RecordFile {
  path: string;

  /**
   * What to call it in a finding: the artifact directory a walk found it
   * in, or the path itself where the caller named the file.
   */
  from: string;

  /**
   * The commit the job that wrote this file was checked out at, where a
   * `job.json` beside it names one. A report carrying its own context
   * says so itself and does not need this.
   */
  commit?: string;
}

/**
 * Every record file a named path holds. A directory is walked, which is
 * what lets one name stand for a run's downloaded record artifacts: each
 * arrives as a directory of its own holding the records a job gathered
 * and the facts that job knew, and a run that produced a single one
 * arrives flattened into the directory above.
 *
 * A gathered artifact is a run's records without the context a report
 * opens with, which the relay composes when it ships them to the store.
 * The commit is the part of that context the store half holds a tree to,
 * and the job wrote it down in `job.json`, so that is where this reads
 * it rather than asking the caller to vouch for records that name none.
 */
async function recordFiles(at: string): Promise<RecordFile[]> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(at);
  } catch (error) {
    // A path that is not there holds no records, which the caller
    // already fails on, and in a sentence rather than a stack trace.
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  if (!info.isDirectory) return [{ path: at, from: at }];
  const found: RecordFile[] = [];
  const commit = await gatheredCommit(at);
  const from = path.basename(at);
  for await (const entry of Deno.readDir(at)) {
    const child = path.join(at, entry.name);
    if (entry.isDirectory) found.push(...await recordFiles(child));
    else if (entry.isFile && entry.name.endsWith(".ndjson")) {
      found.push({
        path: child,
        from,
        ...(commit === undefined ? {} : { commit }),
      });
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** The commit a gathered artifact's own facts name, where it holds them. */
async function gatheredCommit(dir: string): Promise<string | undefined> {
  let facts: unknown;
  try {
    facts = JSON.parse(await Deno.readTextFile(path.join(dir, "job.json")));
  } catch {
    // A directory that is not a gathered artifact, or one whose facts
    // cannot be read, leaves its records to say what commit they are
    // from. The store half is what refuses them when they say nothing.
    return undefined;
  }
  if (typeof facts !== "object" || facts === null) return undefined;
  const commit = (facts as Record<string, unknown>).commit;
  return typeof commit === "string" && commit.length > 0 ? commit : undefined;
}

/**
 * Reads a run's records out of the paths named on the command line, each
 * a file of records or a directory holding them. With no resolver given,
 * the repository's alias file is loaded.
 */
export async function readRecords(
  paths: readonly string[],
  aliases?: AliasResolver,
): Promise<StoredIdentity[]> {
  const resolver = aliases ?? await loadAliasResolver();
  const records: StoredIdentity[] = [];
  const files: RecordFile[] = [];
  for (const at of paths) files.push(...await recordFiles(at));
  for (const file of files) {
    const text = await Deno.readTextFile(file.path);
    for (const group of parseReportGroups(text)) {
      // An alias applies only to records from days before the rename, so
      // the day the report was written is what resolution is asked
      // against. A report with no context is one this cannot date, and
      // its identities resolve as written.
      const day = group.context === undefined
        ? "9999-12-31"
        : dayOf(group.context.startedAt);
      for (const record of group.records) {
        // A lane measuring itself is read as the lane wrote it. What
        // decides that a record is one of those is the written identity,
        // so a line in the alias file names a test or it names nothing.
        const resolved = isLaneMeasurement(record.test)
          ? record.test
          : resolver.resolve(record.test, day);
        records.push({
          test: resolved,
          ...(record.file === undefined ? {} : { file: record.file }),
          // A report opening with a context says which commit it is
          // from. One gathered into an artifact does not, and the facts
          // beside it do.
          ...(group.context !== undefined
            ? { commit: group.context.commit }
            : file.commit === undefined
            ? {}
            : { commit: file.commit }),
          from: file.from,
        });
      }
    }
  }
  return records;
}

/** What the check was asked to do. */
export interface CheckOptions {
  /** The tree to walk. */
  root: string;

  /**
   * What the store half is to judge: a run's records, and the commit
   * that run checked out. The two travel together, so neither can be
   * given without the other.
   */
  store?: { records: readonly string[]; commit: string };
}

/** A command line the check cannot act on. */
export class UsageError extends Error {
  override name = "UsageError";
}

/**
 * Reads the command line into what the check should do. An argument it
 * does not understand raises, rather than being passed over: a dropped
 * record file leaves the store half judging part of a run and reporting
 * that the topology accounts for everything.
 */
export function parseCheckArgs(
  args: readonly string[],
  root: string,
): CheckOptions {
  const records: string[] = [];
  let commit: string | undefined;
  let asked = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--commit") {
      if (commit !== undefined) throw new UsageError("--commit twice");
      const named = args[at + 1];
      if (named === undefined || named.length === 0 || named.startsWith("-")) {
        throw new UsageError("--commit takes the commit the records name");
      }
      commit = named;
      at += 1;
      continue;
    }
    if (arg === "--records") {
      if (asked) throw new UsageError("--records twice");
      asked = true;
      continue;
    }
    if (!asked || arg.startsWith("-")) {
      throw new UsageError(`unknown argument ${arg}`);
    }
    records.push(arg);
  }
  if (!asked && commit === undefined) return { root };
  if (!asked) {
    throw new UsageError("--commit names the commit --records were made at");
  }
  if (records.length === 0) {
    throw new UsageError("--records takes a file or a directory of them");
  }
  if (commit === undefined) {
    throw new UsageError("--records needs --commit, the commit they name");
  }
  return { root, store: { records, commit } };
}

/**
 * Runs whichever halves the options ask for. The tree and workflow
 * halves always run, because they need nothing but the checkout; the
 * store half runs when a run's records and their commit are named.
 */
export async function check(
  options: CheckOptions,
): Promise<{ findings: Finding[]; suites: number }> {
  const suites = await loadTopology(options.root);
  const findings = checkTree(
    suites,
    await candidateSurfaces(options.root),
    { fixtures: NOT_A_TEST_SURFACE },
  );
  findings.push(
    ...checkWorkflows(suites, await workflowRecords(options.root)),
  );
  if (options.store !== undefined) {
    // Each named path is read on its own, because a path holding nothing
    // is a part of the run the store half did not see, and summing them
    // first would let one path's records answer for another's. Judging
    // the part that did arrive is the guard reporting on a corpus it
    // only partly read.
    const resolver = await loadAliasResolver();
    const records: StoredIdentity[] = [];
    const empty: string[] = [];
    for (const at of options.store.records) {
      const read = await readRecords([at], resolver);
      if (read.length === 0) empty.push(at);
      records.push(...read);
    }
    if (empty.length > 0) {
      // This is said alone: every unit the topology holds would
      // otherwise report as never recorded, and bury it under thousands.
      findings.push({
        fails: true,
        message: `${empty.join(", ")} hold no records, so the store half ` +
          "read nothing of what they were to carry",
      });
      return { findings, suites: suites.length };
    }
    findings.push(...checkStore(suites, records, options.store.commit));
  }
  // The count travels with the findings because loading the topology
  // walks every workspace member and every test file, and doing that a
  // second time to print one number is the enumeration twice over.
  return { findings, suites: suites.length };
}

/** Prints what was found, and says whether anything failed. */
export function report(
  findings: readonly Finding[],
  suites: number,
  write: { out: (line: string) => void; err: (line: string) => void } = {
    out: console.log,
    err: console.error,
  },
): boolean {
  for (const finding of findings) {
    const line = `${
      finding.fails ? "topology" : "topology (reported)"
    }: ${finding.message}`;
    if (finding.fails) write.err(line);
    else write.out(line);
  }
  const failures = findings.filter((finding) => finding.fails).length;
  if (failures === 0) {
    write.out(
      `Topology accounts for every test surface (${suites} suites).`,
    );
    return true;
  }
  write.err(
    `${failures} test surface(s) the topology does not account for.`,
  );
  return false;
}

/**
 * Runs the check the way the command line runs it, and answers with the
 * status it would exit with. Zero when the topology accounts for
 * everything, and one when it does not: a surface nobody registered has
 * to stop a build, or the guard is a log line nobody reads.
 */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = Deno.cwd(),
): Promise<number> {
  let options: CheckOptions;
  try {
    options = parseCheckArgs(args, root);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const { findings, suites } = await check(options);
  return report(findings, suites) ? 0 : 1;
}

// `Deno.exitCode` rather than `Deno.exit`, which would end the process
// before the unload handlers run — and one of those is what writes a
// test run's name map into its spool.
if (import.meta.main) Deno.exitCode = await main();
