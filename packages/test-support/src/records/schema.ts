/**
 * The test-run record schema: the identity of a test, the record of one
 * execution, and the context line that heads every uploaded object. The
 * design, including the field discipline that keeps every value public
 * material, is docs/history/plans/test-run-telemetry.md.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";

/** Schema version carried by every context line and object path. */
export const RECORD_SCHEMA_VERSION = 1;

/**
 * Durable name of a test: the kind of check, the workspace member that owns
 * it (or "repo" for repository-level checks), the full name the test's own
 * runner reports, and a non-default configuration when one needs separate
 * history.
 */
export interface TestIdentity {
  /** Class of check: "unit", "browser", "pattern", "integration",
   * "typecheck", "lint", "format", or "gate". */
  k: string;

  /** Owning workspace member, or "repo". */
  s: string;

  /** Name as reported by the test's own runner. */
  n: string;

  /** Non-default configuration under which the test ran. */
  v?: string;
}

/** Stable JSON-array key for grouping records by test identity. */
export function testIdentityKey(test: TestIdentity): string {
  return JSON.stringify(
    test.v === undefined
      ? [test.k, test.s, test.n]
      : [test.k, test.s, test.n, test.v],
  );
}

/** The identity a stable key names. Undefined for anything that is not one. */
export function testIdentityOfKey(key: string): TestIdentity | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length < 3 || parts.length > 4) {
    return undefined;
  }
  const [k, s, n, v] = parts as unknown[];
  if (!isNonEmptyString(k) || !isNonEmptyString(s) || !isNonEmptyString(n)) {
    return undefined;
  }
  if (v !== undefined && !isNonEmptyString(v)) return undefined;
  return v === undefined ? { k, s, n } : { k, s, n, v };
}

/** One line stating that one test executed once in one run. */
export interface TestRecord {
  line: "record";
  test: TestIdentity;
  outcome: "pass" | "fail" | "skip";
  durationMs: number;

  /** Repository-relative source file, when reliably known. Metadata, not
   * identity. */
  file?: string;
}

/** CI run facts, present when a context's env is "ci". */
export interface CiContext {
  /** GitHub workflow run id; spans every job of the workflow run. */
  workflowRunId: string;

  runAttempt: number;
  workflow: string;

  /** Job identity including the matrix leg, as in "Test (3/8)". */
  job: string;

  /** Shard label like "3/8" when the job is sharded. */
  shard?: string;

  /** Pull request head commit; `commit` is the ephemeral merge commit. */
  headCommit?: string;

  /** Triggering event, from the trusted payload: "push", "pull_request". */
  event?: string;

  /**
   * True when the run's head repository is not the base repository, and
   * true when the payload did not name both: a run this repository
   * cannot place reads as a fork. Stamped from the trusted payload,
   * never from job artifacts. The member gate means every stored run was
   * authored under the repository's write access, so what this leaves a
   * consumer is that a run it marks is never a baseline. See
   * `docs/specs/test-records.md`, "Trust boundaries for consumers".
   */
  fork?: boolean;
}

/** First line of every uploaded object. */
export interface RunContext {
  schema: typeof RECORD_SCHEMA_VERSION;
  line: "context";

  /** ULID; unique per uploaded object. */
  reportId: string;

  /** Canonical repository name, as in "commonfabric/labs". */
  repo: string;

  /** Full hash of the commit the tests ran against. */
  commit: string;

  /** True when the working tree had uncommitted changes. */
  dirty: boolean;

  branch?: string;
  env: "ci" | "local";
  ci?: CiContext;

  /**
   * Opaque label for the operating agent: CF_TEST_AGENT, or the
   * harness a run was started under when that variable is unset.
   */
  agent?: string;

  os: string;
  arch: string;
  denoVersion: string;

  /** ISO 8601 UTC. */
  startedAt: string;

  /**
   * The seed the run's test runners shuffled their order by. Absent from
   * a run that did not shuffle, whose tests ran in the order they were
   * declared, so two contexts agree on the order exactly when this field
   * does.
   */
  shuffleSeed?: number;
}

const OUTCOMES = new Set(["pass", "fail", "skip"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Whether a value is a seed `deno test --shuffle` would take. */
export function isSeed(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Serializes a record as one NDJSON line, newline included. */
export function serializeRecordLine(record: TestRecord): string {
  return JSON.stringify(record) + "\n";
}

/** Serializes a context as one NDJSON line, newline included. */
export function serializeContextLine(context: RunContext): string {
  return JSON.stringify(context) + "\n";
}

/**
 * Parses one line as a test record. Returns undefined for anything that is
 * not a structurally valid record line; records are untrusted input at every
 * read boundary.
 */
export function parseRecordLine(line: string): TestRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObjectOrArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.line !== "record") return undefined;
  const test = record.test as Record<string, unknown> | undefined;
  if (!isObjectOrArray(test)) return undefined;
  if (
    !isNonEmptyString(test.k) || !isNonEmptyString(test.s) ||
    !isNonEmptyString(test.n)
  ) {
    return undefined;
  }
  if (test.v !== undefined && !isNonEmptyString(test.v)) return undefined;
  if (!OUTCOMES.has(record.outcome as string)) return undefined;
  if (
    typeof record.durationMs !== "number" ||
    !Number.isFinite(record.durationMs) || record.durationMs < 0
  ) {
    return undefined;
  }
  if (!isOptionalString(record.file)) return undefined;
  const result: TestRecord = {
    line: "record",
    test: { k: test.k, s: test.s, n: test.n },
    outcome: record.outcome as TestRecord["outcome"],
    durationMs: record.durationMs,
  };
  if (test.v !== undefined) result.test.v = test.v;
  if (record.file !== undefined) result.file = record.file as string;
  return result;
}

/**
 * Parses one line as a run context. Returns undefined for anything that is
 * not a structurally valid context line of this schema version.
 */
export function parseContextLine(line: string): RunContext | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObjectOrArray(value)) return undefined;
  const context = value as Record<string, unknown>;
  if (context.line !== "context") return undefined;
  if (context.schema !== RECORD_SCHEMA_VERSION) return undefined;
  if (
    !isNonEmptyString(context.reportId) || !isNonEmptyString(context.repo) ||
    !isNonEmptyString(context.commit) ||
    typeof context.dirty !== "boolean" ||
    (context.env !== "ci" && context.env !== "local") ||
    !isNonEmptyString(context.os) || !isNonEmptyString(context.arch) ||
    !isNonEmptyString(context.denoVersion) ||
    !isNonEmptyString(context.startedAt) ||
    !isOptionalString(context.branch) || !isOptionalString(context.agent) ||
    (context.shuffleSeed !== undefined && !isSeed(context.shuffleSeed))
  ) {
    return undefined;
  }
  // The ci block and the env tag assert the same provenance; a line where
  // they disagree is malformed, not a context with one of them believed.
  if ((context.env === "ci") !== (context.ci !== undefined)) {
    return undefined;
  }
  let ci: CiContext | undefined;
  if (context.ci !== undefined) {
    if (!isObjectOrArray(context.ci)) {
      return undefined;
    }
    const raw = context.ci as Record<string, unknown>;
    if (
      !isNonEmptyString(raw.workflowRunId) ||
      typeof raw.runAttempt !== "number" ||
      !isNonEmptyString(raw.workflow) || !isNonEmptyString(raw.job) ||
      !isOptionalString(raw.shard) || !isOptionalString(raw.headCommit) ||
      !isOptionalString(raw.event) ||
      (raw.fork !== undefined && typeof raw.fork !== "boolean")
    ) {
      return undefined;
    }
    ci = {
      workflowRunId: raw.workflowRunId,
      runAttempt: raw.runAttempt,
      workflow: raw.workflow,
      job: raw.job,
    };
    if (raw.shard !== undefined) ci.shard = raw.shard as string;
    if (raw.headCommit !== undefined) ci.headCommit = raw.headCommit as string;
    if (raw.event !== undefined) ci.event = raw.event as string;
    if (raw.fork !== undefined) ci.fork = raw.fork as boolean;
  }
  const result: RunContext = {
    schema: RECORD_SCHEMA_VERSION,
    line: "context",
    reportId: context.reportId as string,
    repo: context.repo as string,
    commit: context.commit as string,
    dirty: context.dirty as boolean,
    env: context.env as RunContext["env"],
    os: context.os as string,
    arch: context.arch as string,
    denoVersion: context.denoVersion as string,
    startedAt: context.startedAt as string,
  };
  if (context.branch !== undefined) result.branch = context.branch as string;
  if (ci !== undefined) result.ci = ci;
  if (context.agent !== undefined) result.agent = context.agent as string;
  if (context.shuffleSeed !== undefined) {
    result.shuffleSeed = context.shuffleSeed as number;
  }
  return result;
}

/**
 * Builds the body of one uploaded object: the context line followed by one
 * line per record.
 */
export function buildObjectBody(
  context: RunContext,
  records: readonly TestRecord[],
): string {
  let body = serializeContextLine(context);
  for (const record of records) {
    body += serializeRecordLine(record);
  }
  return body;
}

/** Date partition ("yyyy/mm/dd", UTC) for an ISO 8601 start time. */
export function datePartition(startedAt: string): string {
  const match = startedAt.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) {
    throw new Error(`Not an ISO 8601 UTC timestamp: ${startedAt}`);
  }
  return `${match[1]}/${match[2]}/${match[3]}`;
}

const OBJECT_NAME_UNSAFE = /[^A-Za-z0-9._-]+/g;

/** Reduces a label to characters safe in an object name. */
export function objectNameSlug(label: string): string {
  const slug = label.replace(OBJECT_NAME_UNSAFE, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "unnamed";
}

/**
 * Object name for a locally shipped spool, relative to the writer's
 * `submissions/local/<username>/` folder. The report id makes the name
 * deterministic, so shipping the same spool twice collides on create and the
 * duplicate never comes into being.
 */
export function localObjectName(context: RunContext): string {
  const slug = objectNameSlug(context.branch ?? "detached");
  return `v${RECORD_SCHEMA_VERSION}/${datePartition(context.startedAt)}/` +
    `${context.reportId}-${slug}.ndjson`;
}

/**
 * Object name for one CI artifact's records, relative to the relay's
 * `submissions/ci/` folder. The run id and the artifact name — which
 * carries the attempt that produced it — are unique within a repository,
 * and the repository is in the folder path, so the name is deterministic
 * and re-running the relay is idempotent: a later attempt's relay
 * re-ships an earlier attempt's artifacts into a collision and ships the
 * re-run jobs' new artifacts as new objects.
 *
 * That collision needs both attempts to land in one partition, and the
 * partition comes from `runStartedAt`, which GitHub reports per attempt.
 * Two attempts separated by a UTC midnight therefore compute different
 * partitions, and the earlier attempt's artifacts are stored a second
 * time under the later day rather than colliding.
 */
export function ciObjectName(options: {
  runStartedAt: string;
  workflowRunId: string;
  artifactName: string;
}): string {
  const artifact = objectNameSlug(options.artifactName);
  return `v${RECORD_SCHEMA_VERSION}/` +
    `${datePartition(options.runStartedAt)}/` +
    `run-${options.workflowRunId}-${artifact}.ndjson`;
}
