#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run=git

/**
 * The credential-free shipping step every CI test job ends with: gather the
 * job's spooled record fragments into one artifact directory that the relay
 * workflow later uploads to the store.
 *
 *   deno run -A tasks/test-records-gather.ts --out <dir> --job <name>
 *     [--shard <label>]
 *     [--variant <name>]
 *
 * The output directory holds records.ndjson (one record line per test) and
 * job.json (the facts only the job knows: its display name, shard, the
 * commit it checked out, and the machine). The relay composes the context
 * line from the workflow_run event payload plus job.json, so nothing here
 * carries credentials. A failure warns and exits zero: this is telemetry,
 * and it never fails the job.
 */

import { join } from "@std/path";
import {
  type Environment,
  readEnv,
  readResults,
  readSpool,
  recordsDir,
  serializeRecordLine,
  type TestIdentity,
  type TestRecord,
} from "@commonfabric/test-support/records";
import {
  commitMoment,
  parseSeed,
  SHUFFLE_SEED_VARIABLE,
} from "@commonfabric/test-support/shuffle";
import { isObjectOrArray } from "@commonfabric/js-values/types";

/** Facts only the job itself knows, shipped beside its records. */
export interface JobFacts {
  job: string;
  shard?: string;
  commit?: string;
  headCommit?: string;
  branch?: string;
  os: string;
  arch: string;
  denoVersion: string;

  /** The seed the job's test runners shuffled their order by. */
  shuffleSeed: number;
}

/** The head commit of the pull request the event describes, when any. */
export function headCommitOfEvent(payload: unknown): string | undefined {
  if (!isObjectOrArray(payload)) return undefined;
  const pr = (payload as Record<string, unknown>).pull_request;
  if (!isObjectOrArray(pr)) return undefined;
  const head = (pr as Record<string, unknown>).head;
  if (!isObjectOrArray(head)) return undefined;
  const sha = (head as Record<string, unknown>).sha;
  return typeof sha === "string" && sha.length > 0 ? sha : undefined;
}

/** What reading one execution's records needs. */
export interface CollectOptions {
  /** The spool the producers wrote their fragments and results into. */
  spoolDir?: string;

  /**
   * What the results the execution's tests wrote into the spool are
   * recorded as. Absent where the execution ran no tests that write any.
   */
  results?: { kind: string; scope: string };

  /**
   * The configuration these records were produced in. Every record takes
   * this value, replacing whatever a producer supplied, which is what
   * makes a variant a property of the suite that ran rather than of the
   * producer that reported.
   */
  variant?: string;

  /**
   * The kinds and scopes this execution's records may carry. Given, a
   * record outside them is not one the caller's topology describes, and
   * neither is one a producer marked with a variant of its own where
   * none was declared. Such a record keeps what its producer wrote and
   * is reported rather than being given a configuration it did not run
   * in. Absent, every record takes the declared variant.
   */
  surfaces?: ReadonlyArray<{ kind: string; scope: string }>;

  /**
   * Whether the caller already knows a test, recorded from a file, as an
   * identity, which ingestion then records whenever it reports, even where
   * it holds other tests.
   */
  known?: (test: TestIdentity, file: string | undefined) => boolean;
}

/** What one execution left behind. */
export interface Collected {
  /** Everything it recorded, the conflicts among them. */
  records: TestRecord[];

  /**
   * Those of them the declared surfaces do not describe. They are kept
   * as their producer wrote them rather than dropped, so they reach the
   * store, belong to no suite there, and the store half of the topology
   * drift guard is what fails on them.
   */
  conflicts: TestRecord[];

  /**
   * What the hooks of each outermost group of tests took, one record each,
   * as `readResults()` makes them, with the declared variant applied. They
   * are not tests, so they are in neither list above and nothing ships
   * them.
   */
  hooks: TestRecord[];

  /** The message each failing record's test threw, where it threw one. */
  failures: Map<TestRecord, string>;

  /**
   * One record for each test the invocation's skip list skipped, with the
   * declared variant applied. Kept apart from `records`, since a skip the
   * invocation's share caused is a fact about that share rather than about
   * the test; the caller ships the others.
   */
  listed: TestRecord[];
}

/**
 * The records one execution produced: what its producers spooled, and
 * what its tests' results come to, with the declared variant applied.
 *
 * This is the whole of what the shipping step and the lane runner share.
 * The shipping step gathers one job's spool at the end; the lane runner
 * gathers each batch execution as it finishes, before another execution
 * can reuse a runner-owned path. Neither is a second way of applying a
 * variant, which is the point of there being one function.
 */
export async function collectRecords(
  options: CollectOptions,
): Promise<Collected> {
  if (options.variant !== undefined && options.variant.length === 0) {
    throw new Error("a declared variant must not be empty");
  }
  const records: TestRecord[] = [];
  const hooks: TestRecord[] = [];
  const failures = new Map<TestRecord, string>();
  const listed: TestRecord[] = [];
  if (options.spoolDir !== undefined) {
    const spooled = await readSpool(options.spoolDir);
    for (const warning of spooled.warnings) {
      console.warn(`test records: ${warning}`);
    }
    for (const record of spooled.records) records.push(record);
    if (options.results !== undefined) {
      const read = await readResults(options.spoolDir, {
        ...options.results,
        ...(options.known === undefined ? {} : { known: options.known }),
      });
      for (const warning of read.warnings) {
        console.warn(`test records: ${warning}`);
      }
      for (const record of read.records) records.push(record);
      for (const record of read.hooks) hooks.push(record);
      for (const record of read.listed) listed.push(record);
      for (const [record, message] of read.failures) {
        failures.set(record, message);
      }
    }
  }

  const conflicts: TestRecord[] = [];
  for (const record of records) {
    if (options.surfaces !== undefined) {
      const described = options.surfaces.some((surface) =>
        surface.kind === record.test.k && surface.scope === record.test.s
      );
      // A record marked with a variant where none was declared is the
      // other half of the same mistake: the execution was a default one,
      // so a marker on it describes a configuration that did not run.
      if (!described || (options.variant === undefined && record.test.v)) {
        conflicts.push(record);
        continue;
      }
    }
    if (options.variant !== undefined) record.test.v = options.variant;
  }
  if (options.variant !== undefined) {
    for (const record of [...hooks, ...listed]) {
      record.test.v = options.variant;
    }
  }
  return { records, conflicts, hooks, failures, listed };
}

export interface GatherOptions {
  out: string;
  job: string;
  shard?: string;
  variant?: string;
  spoolDir?: string;
  env?: Environment;
}

/** Gathers the spool into the artifact directory. */
export async function gather(options: GatherOptions): Promise<void> {
  const { records } = await collectRecords({
    ...(options.spoolDir === undefined ? {} : { spoolDir: options.spoolDir }),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  });

  const env = options.env ?? Deno.env.get;
  const facts: JobFacts = {
    job: options.job,
    os: Deno.build.os,
    arch: Deno.build.arch,
    denoVersion: Deno.version.deno,
    // The same answer the job's runners reached: its override where the
    // job set one, and otherwise the day of the commit it checked out.
    shuffleSeed: parseSeed(
      readEnv(SHUFFLE_SEED_VARIABLE, env),
      commitMoment() ?? new Date(),
    ),
  };
  if (options.shard !== undefined) facts.shard = options.shard;
  const commit = readEnv("GITHUB_SHA", env);
  if (commit !== undefined && commit.length > 0) facts.commit = commit;
  const branch = readEnv("GITHUB_HEAD_REF", env) ??
    readEnv("GITHUB_REF_NAME", env);
  if (branch !== undefined && branch.length > 0) facts.branch = branch;
  const eventPath = readEnv("GITHUB_EVENT_PATH", env);
  if (eventPath !== undefined && eventPath.length > 0) {
    try {
      const payload = JSON.parse(await Deno.readTextFile(eventPath));
      const headCommit = headCommitOfEvent(payload);
      if (headCommit !== undefined) facts.headCommit = headCommit;
    } catch {
      // The event payload is optional context; a job without one still
      // records.
    }
  }

  await Deno.mkdir(options.out, { recursive: true });
  await Deno.writeTextFile(
    join(options.out, "job.json"),
    JSON.stringify(facts, null, 2) + "\n",
  );
  let lines = "";
  for (const record of records) {
    lines += serializeRecordLine(record);
  }
  await Deno.writeTextFile(join(options.out, "records.ndjson"), lines);
  console.log(
    `test records: gathered ${records.length} record(s) into ${options.out}`,
  );
}

const USAGE = "usage: test-records-gather.ts --out <dir> --job <name> " +
  "[--shard <label>] [--variant <name>]";

/**
 * Parses the command line into gather options, or returns undefined for a
 * malformed one.
 */
export function parseGatherArgs(
  argsIn: readonly string[],
): GatherOptions | undefined {
  let out: string | undefined;
  let job: string | undefined;
  let shard: string | undefined;
  let variant: string | undefined;
  const args = [...argsIn];
  while (args.length > 0) {
    const flag = args.shift()!;
    const value = args.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--out":
        out = value;
        break;
      case "--job":
        job = value;
        break;
      case "--shard":
        shard = value;
        break;
      case "--variant":
        if (value.length === 0) return undefined;
        variant = value;
        break;
      default:
        return undefined;
    }
  }
  if (out === undefined || job === undefined) return undefined;
  const options: GatherOptions = { out, job };
  if (shard !== undefined) options.shard = shard;
  if (variant !== undefined) options.variant = variant;
  return options;
}

/**
 * Gathers what a command line names, reading the enclosing run's spool and
 * the job's facts from `env`, and returns the exit status: 2 for a malformed
 * command line, and 0 otherwise, since telemetry never fails the job.
 */
export async function runGatherCommand(
  args: readonly string[],
  env: Environment = Deno.env.get,
): Promise<number> {
  const options = parseGatherArgs(args);
  if (options === undefined) {
    console.error(USAGE);
    return 2;
  }
  options.env = env;
  const spoolDir = recordsDir(env);
  if (spoolDir !== undefined) options.spoolDir = spoolDir;
  try {
    await gather(options);
  } catch (error) {
    console.warn(`test records: gathering failed: ${error}`);
  }
  return 0;
}

if (import.meta.main) Deno.exit(await runGatherCommand(Deno.args));
