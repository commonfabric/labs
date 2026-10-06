#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

/**
 * The relay: the one CI principal that writes to the store. Runs in the
 * workflow_run follower with base-repository credentials, walks the
 * test-records-* artifacts its trigger produced, composes each artifact's
 * context line from the event payload plus the artifact's own job.json,
 * and creates one gzip-encoded object per artifact. Object names derive
 * from the run id, attempt, and artifact name, so re-running the relay
 * re-ships idempotently: an object that already exists collides on create
 * and is treated as shipped.
 *
 *   deno run -A tasks/test-records-relay.ts --artifacts <dir>
 *
 * The directory holds one subdirectory per downloaded artifact. The run's
 * facts come from the workflow_run event payload (GITHUB_EVENT_PATH), or
 * from --run-json <file> for a manual re-ship. The store coordinates come
 * from TEST_RECORDS_BUCKET and TEST_RECORDS_PREFIX, and the credential is
 * the federated access token in TEST_RECORDS_GCS_TOKEN. A failed artifact
 * is reported and the relay exits nonzero, visibly; rerunning it re-ships
 * only what is missing.
 */

import { join } from "@std/path";
import { ulid } from "@std/ulid";
import {
  buildObjectBody,
  ciObjectName,
  createObject,
  type Environment,
  gzipText,
  isSeed,
  parseRecordLine,
  readEnv,
  RECORD_SCHEMA_VERSION,
  type RunContext,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  ciSubmissionsPrefix,
  REPO,
  storeBucket,
} from "./test-records-config.ts";

/** The run facts the relay needs from the workflow_run payload. */
export interface RunFacts {
  workflowRunId: string;
  runAttempt: number;
  workflow: string;
  event: string;
  headSha: string;
  headBranch?: string;
  runStartedAt: string;

  /** True when the head repository differs from the base repository. */
  fork: boolean;

  /** Numeric id of the user whose push or pull request ran, when known. */
  actorId?: string;
}

/** Extracts the run facts from a workflow_run event payload. */
export function runFactsOfPayload(payload: unknown): RunFacts {
  if (!isObjectOrArray(payload)) {
    throw new Error("the event payload is not an object");
  }
  const run = (payload as Record<string, unknown>).workflow_run ?? payload;
  if (!isObjectOrArray(run)) {
    throw new Error("the event payload has no workflow_run");
  }
  const raw = run as Record<string, unknown>;
  const id = raw.id;
  const headSha = raw.head_sha;
  const runStartedAt = raw.run_started_at;
  const name = raw.name;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    typeof headSha !== "string" || typeof runStartedAt !== "string" ||
    typeof name !== "string"
  ) {
    throw new Error("the workflow_run payload is missing run facts");
  }
  const headRepository = (raw.head_repository as
    | Record<string, unknown>
    | undefined)?.full_name;
  const baseRepository = (raw.repository as
    | Record<string, unknown>
    | undefined)?.full_name;
  const facts: RunFacts = {
    workflowRunId: String(id),
    runAttempt: typeof raw.run_attempt === "number" ? raw.run_attempt : 1,
    workflow: name,
    event: typeof raw.event === "string" ? raw.event : "unknown",
    headSha,
    runStartedAt,
    // Fork when the repositories provably differ; a payload without both
    // names reads as a fork, so a run this repository cannot place never
    // stands as a baseline.
    fork: typeof headRepository === "string" &&
        typeof baseRepository === "string"
      ? headRepository !== baseRepository
      : true,
  };
  if (typeof raw.head_branch === "string" && raw.head_branch.length > 0) {
    facts.headBranch = raw.head_branch;
  }
  const actorId = (raw.actor as Record<string, unknown> | undefined)?.id;
  if (typeof actorId === "number" || typeof actorId === "string") {
    facts.actorId = String(actorId);
  }
  return facts;
}

/**
 * Whether a run's artifacts ship at all. Same-repository runs always
 * ship: only people with write access can create them. A fork run ships
 * only when its actor — the person whose push or pull request the run
 * executed, from the trusted payload — is on the team's member list, so
 * the public, immutable store accepts content authored by team members
 * working from their forks and nothing from anyone else. An empty list,
 * or a run with no readable actor, fails closed.
 */
export function shouldShipRun(
  run: RunFacts,
  memberActorIds: ReadonlySet<string>,
): boolean {
  if (!run.fork) return true;
  if (run.actorId === undefined) return false;
  return memberActorIds.has(run.actorId);
}

interface ArtifactFacts {
  job?: string;
  shard?: string;
  commit?: string;
  headCommit?: string;
  os?: string;
  arch?: string;
  denoVersion?: string;
  shuffleSeed?: number;
}

function artifactFactsOf(value: unknown): ArtifactFacts {
  if (!isObjectOrArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const facts: ArtifactFacts = {};
  for (
    const field of [
      "job",
      "shard",
      "commit",
      "headCommit",
      "os",
      "arch",
      "denoVersion",
    ] as const
  ) {
    const v = raw[field];
    if (typeof v === "string" && v.length > 0) facts[field] = v;
  }
  if (isSeed(raw.shuffleSeed)) facts.shuffleSeed = raw.shuffleSeed;
  return facts;
}

/**
 * Composes the context line for one artifact. Run identity comes from the
 * trusted event payload; the merge commit the jobs checked out, and the
 * machine facts, come from the artifact's job.json since the payload does
 * not carry them.
 */
export function composeCiContext(
  run: RunFacts,
  artifact: ArtifactFacts,
  artifactName: string,
): RunContext {
  const producedByAttempt = artifactName.match(/-a(\d+)$/);
  const context: RunContext = {
    schema: RECORD_SCHEMA_VERSION,
    line: "context",
    reportId: ulid(),
    repo: REPO,
    commit: artifact.commit ?? run.headSha,
    dirty: false,
    env: "ci",
    ci: {
      workflowRunId: run.workflowRunId,
      // The artifact name carries the attempt that produced it; the
      // payload's attempt is the one that triggered the relay, which is
      // not the same thing for an earlier attempt's artifacts on a
      // re-run.
      runAttempt: producedByAttempt !== null
        ? Number(producedByAttempt[1])
        : run.runAttempt,
      workflow: run.workflow,
      job: artifact.job ?? artifactName,
    },
    os: artifact.os ?? "unknown",
    arch: artifact.arch ?? "unknown",
    denoVersion: artifact.denoVersion ?? "unknown",
    startedAt: run.runStartedAt,
  };
  if (run.headBranch !== undefined) context.branch = run.headBranch;
  if (artifact.shuffleSeed !== undefined) {
    context.shuffleSeed = artifact.shuffleSeed;
  }
  if (artifact.shard !== undefined) context.ci!.shard = artifact.shard;
  if (run.event === "pull_request") {
    context.ci!.headCommit = artifact.headCommit ?? run.headSha;
  }
  // Provenance for decision-feeding consumers, from the trusted payload
  // only: the record lines and job facts of a fork run are fork-authored.
  context.ci!.event = run.event;
  context.ci!.fork = run.fork;
  return context;
}

// The gather step always writes records.ndjson, empty or not, so an
// artifact without a readable one is truncated; the raised error lands the
// artifact in the failed list rather than shipping a context-only object
// that would read as a run with no tests.
async function readArtifactRecords(dir: string): Promise<TestRecord[]> {
  const records: TestRecord[] = [];
  const text = await Deno.readTextFile(join(dir, "records.ndjson"));
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const record = parseRecordLine(line);
    if (record === undefined) {
      console.warn(`test records: dropped an unparsable line in ${dir}`);
      continue;
    }
    records.push(record);
  }
  return records;
}

export interface RelayOptions {
  artifactsDir: string;
  run: RunFacts;
  bucket: string;
  prefix: string;
  token: string;
  fetch?: typeof fetch;
}

/** Ships every artifact directory; returns the names that failed. */
export async function relayArtifacts(options: RelayOptions): Promise<string[]> {
  const failed: string[] = [];
  const names: string[] = [];
  for await (const entry of Deno.readDir(options.artifactsDir)) {
    if (entry.isDirectory) names.push(entry.name);
  }
  names.sort();
  if (names.length === 0) {
    console.log("test records: the run produced no test-records artifacts");
    return failed;
  }
  for (const name of names) {
    const dir = join(options.artifactsDir, name);
    try {
      let facts: ArtifactFacts = {};
      try {
        facts = artifactFactsOf(
          JSON.parse(await Deno.readTextFile(join(dir, "job.json"))),
        );
      } catch {
        console.warn(`test records: ${name} has no readable job.json`);
      }
      const records = await readArtifactRecords(dir);
      const context = composeCiContext(options.run, facts, name);
      const body = buildObjectBody(context, records);
      const gzipped = await gzipText(body);
      const objectName = `${options.prefix}/` + ciObjectName({
        runStartedAt: options.run.runStartedAt,
        workflowRunId: options.run.workflowRunId,
        artifactName: name,
      });
      const createOptions: Parameters<typeof createObject>[0] = {
        bucket: options.bucket,
        name: objectName,
        body: gzipped,
        token: options.token,
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      };
      if (options.fetch !== undefined) createOptions.fetch = options.fetch;
      const result = await createObject(createOptions);
      console.log(
        `test records: ${name}: ${records.length} record(s) ` +
          `${result === "created" ? "shipped to" : "already at"} ${objectName}`,
      );
    } catch (error) {
      console.error(`test records: shipping ${name} failed: ${error}`);
      failed.push(name);
    }
  }
  return failed;
}

function usage(): never {
  console.error(
    "usage: test-records-relay.ts --artifacts <dir> [--run-json <file>]",
  );
  Deno.exit(2);
}

/** Parses the command line; undefined means a malformed one. */
export function parseRelayArgs(
  argsIn: readonly string[],
): { artifactsDir: string; runJson?: string } | undefined {
  let artifactsDir: string | undefined;
  let runJson: string | undefined;
  const args = [...argsIn];
  while (args.length > 0) {
    const flag = args.shift()!;
    const value = args.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--artifacts":
        artifactsDir = value;
        break;
      case "--run-json":
        runJson = value;
        break;
      default:
        return undefined;
    }
  }
  if (artifactsDir === undefined) return undefined;
  const parsed: { artifactsDir: string; runJson?: string } = { artifactsDir };
  if (runJson !== undefined) parsed.runJson = runJson;
  return parsed;
}

/** The member list an environment carries: comma-separated numeric ids. */
export function memberActorIdsOf(
  env: Environment = Deno.env.get,
): Set<string> {
  return new Set(
    (readEnv("TEST_RECORDS_MEMBER_ACTOR_IDS", env) ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export interface RelayRunOptions {
  artifactsDir: string;
  runJson?: string;
  env?: Environment;
  fetchImpl?: typeof fetch;
}

/**
 * The whole relay run: reads the payload, applies the member gate, and
 * ships every artifact. Returns the process's exit code.
 */
export async function runRelay(options: RelayRunOptions): Promise<number> {
  const env = options.env ?? Deno.env.get;
  const payloadPath = options.runJson ?? readEnv("GITHUB_EVENT_PATH", env);
  if (payloadPath === undefined) {
    throw new Error("no event payload: set GITHUB_EVENT_PATH or --run-json");
  }
  const run = runFactsOfPayload(
    JSON.parse(await Deno.readTextFile(payloadPath)),
  );
  if (!shouldShipRun(run, memberActorIdsOf(env))) {
    console.log(
      `test records: run ${run.workflowRunId} is a fork run whose actor ` +
        "is not on the team member list; nothing ships.",
    );
    return 0;
  }
  const token = readEnv("TEST_RECORDS_GCS_TOKEN", env);
  if (token === undefined || token.length === 0) {
    throw new Error("TEST_RECORDS_GCS_TOKEN is not set");
  }
  const relayOptions: RelayOptions = {
    artifactsDir: options.artifactsDir,
    run,
    bucket: storeBucket(env),
    prefix: ciSubmissionsPrefix(env),
    token,
  };
  if (options.fetchImpl !== undefined) relayOptions.fetch = options.fetchImpl;
  const failed = await relayArtifacts(relayOptions);
  if (failed.length > 0) {
    console.error(
      `test records: ${failed.length} artifact(s) failed: ${failed.join(", ")}`,
    );
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseRelayArgs(Deno.args);
  if (parsed === undefined) usage();
  const code = await runRelay(parsed);
  if (code !== 0) Deno.exit(code);
}

if (import.meta.main) {
  await main();
}
