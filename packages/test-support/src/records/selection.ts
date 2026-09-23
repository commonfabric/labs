/**
 * The test-selection manifest: what the publisher writes, what a lane
 * reads to decide what to run, and what the dashboard reads to show what
 * selection is doing. It holds every identity the store knows, what each
 * is worth, what each costs, what was withheld and why, and a reference
 * packing into lanes.
 *
 * A lane treats a manifest as untrusted input, the same as a record line,
 * so everything here is validated whole. A manifest that does not parse
 * is treated as absent, and a lane with no manifest runs the mandatory
 * set plus a deterministic slice rather than guessing at a half-read one.
 * The worst a corrupted manifest could achieve is a pull request that ran
 * fewer tests than it should have, which the full run on `main` catches;
 * that is what lets it be an ordinary public object rather than a signed
 * artifact.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import { type TestIdentity, testIdentityKey } from "./schema.ts";

/** The inputs behind one identity's score, as a manifest records them. */
export interface ScoreInputs {
  /** Catches, weighted by where each happened. */
  catches: number;

  /** The day of the most recent catch, absent when there are none. */
  lastCatch?: string;

  /** How many distinct sources are among the catches. */
  sources: number;

  /** Recent failures over recent runs, decayed as they age. */
  churn: number;
}

/**
 * The newest shape a reader here knows how to read. A stored body says
 * which shape it was written in, and a reader reads anything at or under
 * this. A body above it is treated as absent, because a reader that does
 * not know a field cannot know what obeying the rest would mean.
 *
 * Most of the reading forward is done field by field and asks this
 * nothing: a field a body does not carry has a defined reading, and
 * bodies of several shapes stand under one number. What this is for is
 * the change that cannot be read that way, where the same field means
 * different things on either side of it and a reader has to know which.
 * Raise it for one of those, and read the shape below it by this number.
 *
 * What a raise costs is every reader deployed below it: such a reader
 * passes over each manifest written in the new shape, and once
 * `MANIFESTS_LOOKED_BACK` of them stand in front of the newest one it
 * can read it has none at all, which for a lane means running the whole
 * corpus. A branch that has not rebased past the raise is the reader in
 * that position, so the stretch over which one exists is what the
 * publisher's cadence and that figure between them decide.
 *
 * It asks nothing of the store, in either direction. `SELECTION_AREA`
 * names the area both a manifest and the publisher's aggregate are
 * written under and does not move with this; a stored body under this
 * number is read forward; and the publisher passes over a stored
 * aggregate above it for the newest one behind that it can read. No
 * change to this number calls for a bootstrap, which would throw away
 * the history the stored aggregates hold.
 *
 * Lowering it asks one thing of an operator, and only where the number
 * it is lowered from stood for longer than the publisher's window: the
 * aggregates written above the new number are then the whole of what
 * that window reaches, and a run has to be dispatched with a window wide
 * enough to reach one below them. The publisher's refusal says that the
 * states behind are out of its reach; which window reaches one of them
 * comes from listing the area, since the refusal names the day the run
 * stopped at rather than a day a readable state was written on.
 */
export const MANIFEST_SCHEMA_VERSION = 2;

/**
 * The shape in which a suite's fit gained the figure for what one more
 * of its units costs a batch already running others. A fit written
 * before it carries no such figure and charged nothing per unit; one
 * written in this shape carries it, so a body of this shape without it
 * is one this reader cannot read rather than one it reads forward.
 */
const UNIT_OVERHEAD_SINCE = 2;

/**
 * The segment naming the area the selection store writes under.
 *
 * It does not move when the schema does. The area holds the publisher's
 * rolling aggregate, which is where every catch a test has ever been
 * credited with lives, and an area that moved with the schema would
 * leave that behind: the publisher would have no aggregate to carry
 * forward and would stop and ask for a bootstrap, which an operator runs
 * by hand and which reads only as far back as its window. Between the
 * two, nothing publishes, and a consumer with no manifest runs the whole
 * corpus.
 *
 * The publisher's identity holds create and not delete or overwrite, so
 * what is already stored stays in the area it was written under, which
 * is the one this names.
 */
export const SELECTION_AREA = "v1";

/**
 * How far back a reader looks for a body written in a shape it knows.
 *
 * Every reader uses this one figure. A reader looking back further than
 * another would obey a manifest the other passed over, and two readers
 * obeying different manifests is what the whole store is arranged to
 * avoid: a dashboard would then report a figure no pull request obeys.
 *
 * The publisher's walk back through stored aggregates is bounded by the
 * days its run reads instead. There is one such reader, so there is no
 * second one for it to agree with, and what decides how far back it may
 * go is which records are there to fold over the gap.
 */
export const MANIFESTS_LOOKED_BACK = 8;

/**
 * The shape a stored body declares, when it declares one at all. It says
 * whether a body a reader cannot read is one from further ahead than the
 * reader or one that is simply not a manifest, which are different
 * enough to be reported differently.
 *
 * It takes a parsed value rather than the text, so that a reader asking
 * both this and `parseManifest` about one body parses it once. A body is
 * the whole corpus.
 */
export function declaredSchema(value: unknown): number | undefined {
  // The shape has to be the body's own. A body inheriting one from a
  // polluted prototype declares nothing, and reading it as a declaration
  // would have a reader pass over an object that is not a manifest.
  if (!isRecord(value) || !Object.hasOwn(value, "schema")) return undefined;
  const schema = value.schema;
  return typeof schema === "number" && Number.isInteger(schema) && schema > 0
    ? schema
    : undefined;
}

/**
 * Whether a body says it was written in a shape from further ahead than
 * this reader, which is the one reason to pass over it and read the one
 * before it instead.
 *
 * Every reader asks this rather than comparing a declared shape against
 * a bound of its own, so that what counts as too far ahead is answered
 * in one place and a reader passing over a body and a validator refusing
 * it cannot come to disagree.
 */
export function writtenAhead(value: unknown): boolean {
  const schema = declaredSchema(value);
  return schema !== undefined && schema > MANIFEST_SCHEMA_VERSION;
}

/** One selectable identity, with everything selection needs to know. */
export interface ManifestEntry {
  /** The complete identity, variant included when there is one. */
  test: TestIdentity;

  /** The suite that runs it. */
  suite: string;

  /**
   * The invocation unit it lives in: a file for a `deno test` suite, a
   * dispatch arm for a script. What a runner can be pointed at.
   */
  unit: string;

  /** What one execution costs, in seconds. */
  cost: number;

  /** What it is worth running. */
  score: number;

  /** The inputs behind that score, so a manifest explains itself. */
  inputs: ScoreInputs;

  /**
   * The share of the runs it took part in that it was seen disagreeing
   * with itself over, rather than the share of the failures among them.
   */
  flakeRate: number;

  /**
   * The evidence behind that share, so a manifest explains this figure
   * as it does the score. Counted flat, where the share weights recent
   * days more heavily, so the share is not these divided. Absent from a
   * manifest written before they were published: a reader shows nothing
   * for it, since refusing the manifest would cost every test its score
   * to save one column.
   */
  flakeEvidence?: FlakeEvidence;

  /** How many times a lane runs it. Every one of them must pass. */
  repeats: number;

  /**
   * The last day anything is known to have run it, absent where nothing
   * within the aggregate's reach has. The exploration draw takes the
   * longest-unrun first, so this is what stops the draw sampling the
   * same corpus with replacement forever.
   */
  lastRun?: string;
}

/**
 * What a flake share was measured over. A share alone cannot be weighed:
 * one disagreement in two runs and a thousand in two thousand are the
 * same ratio and not the same claim.
 */
export interface FlakeEvidence {
  /** Runs seen to disagree with another run of the same commit. */
  flakes: number;

  /** Runs they were seen among, inside the flake window. */
  runs: number;
}

/** Why an identity is not selectable on a pull request. */
export type WithheldReason = "flaky";

/** One identity held back, and why. */
export interface WithheldEntry {
  test: TestIdentity;
  suite: string;
  reason: WithheldReason;
}

/** A test a configuration deliberately does not run. */
export interface UnavailableEntry {
  suite: string;
  variant?: string;
  unit: string;

  /** The exact leaf, when only one identity inside the unit is skipped. */
  leafName?: string;

  /** Which part of the run it was unavailable in. */
  phase?: string;

  /** Why it is unavailable, in words a person reads. */
  reason: string;
}

/** An identity no lane can hold, however it is packed. */
export interface UnschedulableEntry {
  test: TestIdentity;
  suite: string;
  cost: number;
}

/** The fitted numbers a lane's own timing records produced. */
export interface Calibration {
  /** Seconds each capability's setup takes. */
  setupCost: Record<string, number>;

  /**
   * Per suite: the intercept, the slope on what its own tests take, and
   * what one more of its units costs a batch already running others.
   */
  suites: Record<
    string,
    { overhead: number; correction: number; unitOverhead: number }
  >;

  /** Seconds a lane spends outside its batches. */
  prologue: number;
}

/** One lane of the reference packing. */
export interface LanePlan {
  lane: number;

  /**
   * Seconds this lane is expected to take: the identities' own measured
   * time through their suites' corrections, plus every overhead and
   * capability setup the lane opens. A reader cannot recompute this from
   * the entries alone, which is why the packing carries it.
   */
  projectedSeconds: number;

  batches: Array<{ suite: string; identities: string[] }>;
}

/**
 * What one measured set reached at one `main` commit: the uncovered line
 * count of `member` as one suite's tests alone measured it.
 *
 * Two sets over one member are two baselines and are never added
 * together, which is why the suite is part of what identifies one.
 */
export interface CoverageBaseline {
  suite: string;
  member: string;
  commit: string;

  /**
   * When the run that measured it was created, ISO 8601. It decides one
   * thing: a publisher keeps a baseline while it is younger than the
   * window a manifest covers, and drops it once it is older than that.
   * Which baseline a comparison takes is decided by the order of their
   * commits in the default branch's history, and never by this.
   */
  createdAt: string;

  uncoveredLines: number;
}

/** One publisher run's whole output. */
export interface Manifest {
  schema: typeof MANIFEST_SCHEMA_VERSION;

  /** ISO 8601 UTC. */
  generatedAt: string;

  /** Seeds the exploration draw, so five lanes draw the same set. */
  seed: string;

  /** The `main` commit whose topology was enumerated. */
  commit: string;

  /** How many workflow runs the aggregate behind this manifest saw. */
  runs: number;

  /** Every dial this manifest was built with. */
  dials: Record<string, unknown>;

  calibration: Calibration;
  entries: ManifestEntry[];
  withheld: WithheldEntry[];
  unavailable: UnavailableEntry[];
  unschedulable: UnschedulableEntry[];
  lanes: LanePlan[];

  /** How many item-level identities the store knows, and their digest. */
  known: { count: number; digest: string };

  coverageBaselines: CoverageBaseline[];
}

/**
 * A digest over the identities a manifest knows, order-independent, so
 * two manifests built from the same set agree whatever order they walked
 * it in. Used to tell a lane whether an identity it enumerated is one the
 * store has never seen, which is what makes an unknown identity run.
 */
export function digestIdentities(keys: Iterable<string>): string {
  // A sum of per-key hashes: commutative, so order cannot change it, and
  // this is a change detector rather than anything anybody trusts.
  let low = 0;
  let high = 0;
  for (const key of [...keys].sort()) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    low = (low + (hash >>> 0)) % 0x100000000;
    high = (high + (hash >>> 16)) % 0x100000000;
  }
  return `${low.toString(16).padStart(8, "0")}` +
    `${high.toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectNotArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * An ISO 8601 UTC instant. A reader measures a manifest's age from this,
 * and a value that is not a date parses as a missing number, which
 * compares false against every threshold — so a corrupt manifest would
 * read as freshly generated forever.
 */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function parseIdentity(value: unknown): TestIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.k) || !isNonEmptyString(value.s) ||
    !isNonEmptyString(value.n)
  ) {
    return undefined;
  }
  if (value.v !== undefined && !isNonEmptyString(value.v)) return undefined;
  const test: TestIdentity = { k: value.k, s: value.s, n: value.n };
  if (value.v !== undefined) test.v = value.v;
  return test;
}

function parseInputs(value: unknown): ScoreInputs | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isFiniteNumber(value.catches) || !isFiniteNumber(value.sources) ||
    !isFiniteNumber(value.churn)
  ) {
    return undefined;
  }
  if (value.lastCatch !== undefined && !isNonEmptyString(value.lastCatch)) {
    return undefined;
  }
  const inputs: ScoreInputs = {
    catches: value.catches,
    sources: value.sources,
    churn: value.churn,
  };
  if (value.lastCatch !== undefined) inputs.lastCatch = value.lastCatch;
  return inputs;
}

function parseEntry(value: unknown): ManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  const test = parseIdentity(value.test);
  const inputs = parseInputs(value.inputs);
  if (test === undefined || inputs === undefined) return undefined;
  if (!isNonEmptyString(value.suite) || !isNonEmptyString(value.unit)) {
    return undefined;
  }
  if (
    !isFiniteNumber(value.cost) || value.cost < 0 ||
    !isFiniteNumber(value.score) ||
    // A share of a test's runs, so outside zero to one it is not one. A
    // negative rate would sit under the exclusion threshold and stay
    // selectable, which is the direction a corrupt manifest must not go.
    !isFiniteNumber(value.flakeRate) || value.flakeRate < 0 ||
    value.flakeRate > 1 ||
    // A count of runs. Nothing can run a test one and a half times.
    !isFiniteNumber(value.repeats) || !Number.isInteger(value.repeats) ||
    value.repeats < 1
  ) {
    return undefined;
  }
  if (value.lastRun !== undefined && !isNonEmptyString(value.lastRun)) {
    return undefined;
  }
  const evidence = parseFlakeEvidence(value.flakeEvidence);
  if (value.flakeEvidence !== undefined && evidence === undefined) {
    return undefined;
  }
  const entry: ManifestEntry = {
    test,
    suite: value.suite,
    unit: value.unit,
    cost: value.cost,
    score: value.score,
    inputs,
    flakeRate: value.flakeRate,
    repeats: value.repeats,
  };
  if (value.lastRun !== undefined) entry.lastRun = value.lastRun;
  if (evidence !== undefined) entry.flakeEvidence = evidence;
  return entry;
}

/**
 * Validates the counts behind a flake share. Counts of runs, so neither
 * is fractional or negative, and a test cannot disagree with itself more
 * often than it ran.
 */
function parseFlakeEvidence(value: unknown): FlakeEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const { flakes, runs } = value;
  if (
    !isFiniteNumber(flakes) || !Number.isInteger(flakes) || flakes < 0 ||
    !isFiniteNumber(runs) || !Number.isInteger(runs) || runs < 0 ||
    flakes > runs
  ) {
    return undefined;
  }
  return { flakes, runs };
}

/**
 * Validates the withheld list, keeping the entries whose reason this
 * reader honors. A well-formed entry naming any other reason is dropped
 * rather than refused: an unreadable manifest is treated as an absent
 * one, which makes the whole corpus mandatory, so a writer that names a
 * reason this reader has no rule for must not cost every other entry the
 * manifest carries. A malformed entry still refuses the manifest, since
 * that is a corrupt writer rather than a reason from elsewhere.
 */
function parseWithheldEntries(value: unknown): WithheldEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: WithheldEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    const test = parseIdentity(raw.test);
    if (test === undefined || !isNonEmptyString(raw.suite)) return undefined;
    if (!isNonEmptyString(raw.reason)) return undefined;
    if (raw.reason !== "flaky") continue;
    entries.push({ test, suite: raw.suite, reason: raw.reason });
  }
  return entries;
}

function parseUnavailable(value: unknown): UnavailableEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.suite) || !isNonEmptyString(value.unit) ||
    !isNonEmptyString(value.reason)
  ) {
    return undefined;
  }
  for (const optional of ["variant", "leafName", "phase"] as const) {
    if (value[optional] !== undefined && !isNonEmptyString(value[optional])) {
      return undefined;
    }
  }
  const entry: UnavailableEntry = {
    suite: value.suite,
    unit: value.unit,
    reason: value.reason,
  };
  if (value.variant !== undefined) entry.variant = value.variant as string;
  if (value.leafName !== undefined) entry.leafName = value.leafName as string;
  if (value.phase !== undefined) entry.phase = value.phase as string;
  return entry;
}

function parseUnschedulable(value: unknown): UnschedulableEntry | undefined {
  if (!isRecord(value)) return undefined;
  const test = parseIdentity(value.test);
  if (test === undefined || !isNonEmptyString(value.suite)) return undefined;
  if (!isFiniteNumber(value.cost) || value.cost < 0) return undefined;
  return { test, suite: value.suite, cost: value.cost };
}

function parseCalibration(
  value: unknown,
  schema: number,
): Calibration | undefined {
  if (!isRecord(value)) return undefined;
  const numbers = (raw: unknown): Record<string, number> | undefined => {
    if (!isRecord(raw)) return undefined;
    const out: Record<string, number> = {};
    for (const [name, seconds] of Object.entries(raw)) {
      if (!isFiniteNumber(seconds) || seconds < 0) return undefined;
      out[name] = seconds;
    }
    return out;
  };
  const setupCost = numbers(value.setupCost);
  if (setupCost === undefined) return undefined;
  if (!isRecord(value.suites)) return undefined;
  if (!isFiniteNumber(value.prologue) || value.prologue < 0) return undefined;
  const suites: Calibration["suites"] = {};
  for (const [suite, fitted] of Object.entries(value.suites)) {
    if (!isRecord(fitted)) return undefined;
    if (
      !isFiniteNumber(fitted.overhead) || fitted.overhead < 0 ||
      !isFiniteNumber(fitted.correction) || fitted.correction <= 0
    ) {
      return undefined;
    }
    // Absent from a fit written before the figure existed, where it
    // reads as the nothing per unit such a fit charged. Absent from one
    // written since is a body this reader cannot read, and reading that
    // as nothing would hide it while the packer under-charged every unit
    // a lane opens.
    //
    // A body of the earlier shape carries a map of its own beside the
    // suites, keyed by invocation unit. It is dropped rather than read
    // here: nothing ever wrote an entry into one, and a suite is the
    // grain a batch's timing supports.
    const carried = fitted.unitOverhead;
    const unitOverhead = carried === undefined && schema < UNIT_OVERHEAD_SINCE
      ? 0
      : carried;
    if (!isFiniteNumber(unitOverhead) || unitOverhead < 0) return undefined;
    suites[suite] = {
      overhead: fitted.overhead,
      correction: fitted.correction,
      unitOverhead,
    };
  }
  return { setupCost, suites, prologue: value.prologue };
}

function parseLane(value: unknown): LanePlan | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFiniteNumber(value.lane) || value.lane < 1) return undefined;
  if (!isFiniteNumber(value.projectedSeconds) || value.projectedSeconds < 0) {
    return undefined;
  }
  if (!Array.isArray(value.batches)) return undefined;
  const batches: LanePlan["batches"] = [];
  for (const raw of value.batches) {
    if (!isRecord(raw) || !isNonEmptyString(raw.suite)) return undefined;
    if (!Array.isArray(raw.identities)) return undefined;
    for (const key of raw.identities) {
      if (!isNonEmptyString(key)) return undefined;
    }
    batches.push({ suite: raw.suite, identities: raw.identities as string[] });
  }
  return {
    lane: value.lane,
    projectedSeconds: value.projectedSeconds,
    batches,
  };
}

function parseBaseline(value: unknown): CoverageBaseline | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.suite) || !isNonEmptyString(value.member) ||
    !isNonEmptyString(value.commit) ||
    !isTimestamp(value.createdAt) ||
    !isFiniteNumber(value.uncoveredLines) ||
    value.uncoveredLines < 0
  ) {
    return undefined;
  }
  return {
    suite: value.suite,
    member: value.member,
    commit: value.commit,
    createdAt: value.createdAt,
    uncoveredLines: value.uncoveredLines,
  };
}

/** Maps a list through a parser, failing whole if any element fails. */
function parseAll<T>(
  value: unknown,
  parse: (raw: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const raw of value) {
    const parsed = parse(raw);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

/**
 * Validates a manifest whole. Returns undefined for anything that is not
 * a manifest this reader knows a shape for, which is one declaring a
 * schema at or under `MANIFEST_SCHEMA_VERSION`. An older one is read
 * forward field by field. A newer one is refused, because a reader that
 * does not know a field cannot know what obeying the rest would mean.
 */
export function parseManifest(value: unknown): Manifest | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  const schema = declaredSchema(value);
  if (schema === undefined || writtenAhead(value)) return undefined;
  if (
    !isTimestamp(value.generatedAt) || !isNonEmptyString(value.seed) ||
    !isNonEmptyString(value.commit) || !isFiniteNumber(value.runs) ||
    value.runs < 0 || !isRecord(value.dials)
  ) {
    return undefined;
  }
  const calibration = parseCalibration(value.calibration, schema);
  const entries = parseAll(value.entries, parseEntry);
  const withheld = parseWithheldEntries(value.withheld);
  const unavailable = parseAll(value.unavailable, parseUnavailable);
  const unschedulable = parseAll(value.unschedulable, parseUnschedulable);
  const lanes = parseAll(value.lanes, parseLane);
  const coverageBaselines = parseAll(value.coverageBaselines, parseBaseline);
  if (
    calibration === undefined || entries === undefined ||
    withheld === undefined || unavailable === undefined ||
    unschedulable === undefined || lanes === undefined ||
    coverageBaselines === undefined
  ) {
    return undefined;
  }
  if (
    !isRecord(value.known) || !isFiniteNumber(value.known.count) ||
    value.known.count < 0 || !isNonEmptyString(value.known.digest)
  ) {
    return undefined;
  }
  // One identity may not appear twice: the packer removes an identity
  // from the selectable set as it takes it, and a duplicate would let a
  // later pass take it again.
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = testIdentityKey(entry.test);
    if (seen.has(key)) return undefined;
    seen.add(key);
  }
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    generatedAt: value.generatedAt,
    seed: value.seed,
    commit: value.commit,
    runs: value.runs,
    dials: value.dials,
    calibration,
    entries,
    withheld,
    unavailable,
    unschedulable,
    lanes,
    known: { count: value.known.count, digest: value.known.digest },
    coverageBaselines,
  };
}

/** Serializes a manifest for the store. */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest);
}
