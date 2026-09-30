#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run=git

/**
 * The credential-free shipping step every CI test job ends with: gather the
 * job's spooled record fragments and its JUnit files into one artifact
 * directory that the relay workflow later uploads to the store.
 *
 *   deno run -A tasks/test-records-gather.ts --out <dir> --job <name>
 *     [--shard <label>]
 *     [--variant <name>]
 *     [--junit kind=<kind>,scope=<scope>[,prefix=<repo path>],glob=<glob>]...
 *
 * The output directory holds records.ndjson (one record line per test) and
 * job.json (the facts only the job knows: its display name, shard, the
 * commit it checked out, and the machine). The relay composes the context
 * line from the workflow_run event payload plus job.json, so nothing here
 * carries credentials. A failure warns and exits zero: this is telemetry,
 * and it never fails the job.
 */

import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import {
  type Environment,
  ingestJUnit,
  readEnv,
  readNameMaps,
  readSpool,
  recordsDir,
  serializeRecordLine,
  type TestRecord,
} from "@commonfabric/test-support/records";
import {
  commitMoment,
  parseSeed,
  SHUFFLE_SEED_VARIABLE,
} from "@commonfabric/test-support/shuffle";
import { isObjectOrArray } from "@commonfabric/utils/types";

/** One JUnit ingestion request from the command line. */
export interface JUnitSpec {
  kind: string;
  scope: string;
  prefix?: string;
  glob: string;
}

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

/** Parses one `kind=...,scope=...[,prefix=...],glob=...` specification. */
export function parseJUnitSpec(text: string): JUnitSpec {
  const fields = new Map<string, string>();
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`not a key=value pair in --junit: ${part}`);
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const kind = fields.get("kind");
  const scope = fields.get("scope");
  const glob = fields.get("glob");
  if (kind === undefined || scope === undefined || glob === undefined) {
    throw new Error(`--junit needs kind, scope, and glob: ${text}`);
  }
  const spec: JUnitSpec = { kind, scope, glob };
  const prefix = fields.get("prefix");
  if (prefix !== undefined) spec.prefix = prefix;
  return spec;
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
  /** The spool the producers wrote their fragments into. */
  spoolDir?: string;

  /** The JUnit reports to ingest, each with the surface it carries. */
  junit: readonly JUnitSpec[];

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
}

/**
 * The records one execution produced: what its producers spooled, and
 * what its JUnit reports name, with the declared variant applied.
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
  // The registration preload leaves a name-to-file map in the spool.
  // Where it installed, every class name names the wrapper it put in
  // front of `Deno.test`, so the map is the only thing that can tell a
  // bdd leaf its file; where it did not, the spool holds no map and
  // ingestion reads the report's own class names.
  const fileByName = options.spoolDir === undefined
    ? new Map<string, string>()
    : await readNameMaps(options.spoolDir);
  if (options.spoolDir !== undefined) {
    const spooled = await readSpool(options.spoolDir);
    for (const warning of spooled.warnings) {
      console.warn(`test records: ${warning}`);
    }
    records.push(...spooled.records);
  }
  for (const spec of options.junit) {
    let matched = 0;
    try {
      for await (const entry of expandGlob(spec.glob)) {
        if (!entry.isFile) continue;
        matched++;
        // Caught per file: one unreadable or malformed report costs only
        // itself, not the records of every later file the glob matched.
        try {
          const xml = await Deno.readTextFile(entry.path);
          const ingestOptions: Parameters<typeof ingestJUnit>[1] = {
            kind: spec.kind,
            scope: spec.scope,
            fileByName,
          };
          if (spec.prefix !== undefined) ingestOptions.filePrefix = spec.prefix;
          records.push(...ingestJUnit(xml, ingestOptions));
        } catch (error) {
          console.warn(
            `test records: ingesting ${entry.path} failed: ${error}`,
          );
        }
      }
    } catch (error) {
      console.warn(`test records: expanding ${spec.glob} failed: ${error}`);
    }
    if (matched === 0) {
      console.warn(`test records: no JUnit files matched ${spec.glob}`);
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
  return { records, conflicts };
}

export interface GatherOptions {
  out: string;
  job: string;
  shard?: string;
  variant?: string;
  junit: JUnitSpec[];
  spoolDir?: string;
  env?: Environment;
}

/** Gathers the spool and JUnit files into the artifact directory. */
export async function gather(options: GatherOptions): Promise<void> {
  const { records } = await collectRecords({
    ...(options.spoolDir === undefined ? {} : { spoolDir: options.spoolDir }),
    junit: options.junit,
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

function usage(): never {
  console.error(
    "usage: test-records-gather.ts --out <dir> --job <name> " +
      "[--shard <label>] [--variant <name>] [--junit <spec>]...",
  );
  Deno.exit(2);
}

/**
 * Parses the command line into gather options, or returns undefined for a
 * malformed one. A malformed --junit specification skips itself with a
 * warning: the spool and the other specifications still gather, so one bad
 * flag does not cost the job's whole record set.
 */
export function parseGatherArgs(
  argsIn: readonly string[],
): GatherOptions | undefined {
  let out: string | undefined;
  let job: string | undefined;
  let shard: string | undefined;
  let variant: string | undefined;
  const junit: JUnitSpec[] = [];
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
      case "--junit":
        try {
          junit.push(parseJUnitSpec(value));
        } catch (error) {
          console.warn(`test records: ignoring --junit ${value}: ${error}`);
        }
        break;
      default:
        return undefined;
    }
  }
  if (out === undefined || job === undefined) return undefined;
  const options: GatherOptions = { out, job, junit };
  if (shard !== undefined) options.shard = shard;
  if (variant !== undefined) options.variant = variant;
  return options;
}

async function main(): Promise<void> {
  const options = parseGatherArgs(Deno.args);
  if (options === undefined) usage();
  const spoolDir = recordsDir();
  if (spoolDir !== undefined) options.spoolDir = spoolDir;
  await gather(options);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Telemetry never fails the job; a usage error above still exits 2.
    console.warn(`test records: gathering failed: ${error}`);
  }
}
