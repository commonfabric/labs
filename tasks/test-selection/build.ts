/**
 * Turning what the store holds into a manifest.
 *
 * The publisher keeps a rolling aggregate rather than re-reading history
 * every time: a three-week read is a quarter of a million objects, and
 * nothing can afford that every four hours. So each run reads the newest
 * state, folds in the objects whose runs are not already in it, ages the
 * counters, scores everything, and writes a new state beside the new
 * manifest.
 */

import {
  type AliasResolver,
  parseReportGroups,
  type RunContext,
  type StoredReport,
  type TestIdentity,
  testIdentityKey,
  testIdentityOfKey,
} from "@commonfabric/test-support/records";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  costSeconds,
  type DaySamples,
  daysBetween,
  emptyContext,
  emptySamples,
  emptyState,
  flakeCounts,
  flakeRate,
  type FoldContext,
  foldObservations,
  type IdentityState,
  mergeSamples,
  type Observation,
  parseContext,
  readCostsForward,
  sampleDuration,
  scoreInputs,
  sealDay,
  serializeContext,
  type StoredFoldContext,
  trimContext,
  trimWindows,
  value,
} from "./score.ts";
import { claimsFor } from "../test-topology.ts";
import { isLaneMeasurement } from "../lane-measurement.ts";
import {
  isLaneObservation,
  type LaneObservation,
  laneObservationsOf,
} from "./calibrate.ts";
import { type Suite, unavailableUnits } from "../test-topology/suite.ts";
import {
  type Calibration,
  declaredSchema,
  dialSnapshot,
  digestIdentities,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  type ManifestEntry,
  type WithheldEntry,
  writtenAhead,
} from "./manifest.ts";
import { ObservationSpool } from "./observation-spool.ts";
import {
  COST_WINDOW_DAYS,
  FLAKE_ANCHOR_EXECUTIONS,
  FLAKE_ANCHOR_RATE,
  FLAKE_EXCLUSION_RATE,
  FLAKE_MIN_EXECUTIONS,
  LANE_PROLOGUE_SECONDS,
  MAX_EXECUTIONS,
} from "./policy.ts";

/** The publisher's rolling aggregate, as one stored object. */
export interface AggregateState {
  schema: typeof MANIFEST_SCHEMA_VERSION;

  /** The day the counters were last aged to. */
  day: string;

  /**
   * The reports already folded in, by object name. Object names carry the
   * workflow run, so this is exact rather than a guess from timestamps,
   * and a relay that re-ships an old run is handled correctly.
   */
  folded: string[];

  /**
   * What the two backward-looking rules saw in the runs already folded.
   * Both reach across objects — whether an identity disagreed with itself
   * at a commit, and how many sources a failure spans — and a commit's
   * runs can arrive in two different publisher runs, so the context has
   * to survive between them or those rules silently stop reaching.
   */
  context?: StoredFoldContext;

  /**
   * The source-and-date pairs folded from a rollup rather than from their
   * raw objects, each `"<source>\t<date>"`. A rollup carries its pair's
   * reports whole, so those raw objects are not in `folded` and a later
   * run over a wide window would otherwise fold them on top of it and
   * double every catch in them.
   *
   * Scoped to the source and not only to the date, because rollups cover
   * the continuous-integration area alone. A receipt naming the date by
   * itself would say the day is accounted for, and the local submissions
   * of that day — the evidence the score weighs highest — would never be
   * read.
   */
  compacted: string[];

  states: Record<string, IdentityState>;

  /**
   * The file each identity's records named, by identity key, for the
   * identities whose records named one at all. Everything else about an
   * identity's surface follows from the identity, and an identity absent
   * here is its own invocation unit.
   *
   * Carried so that a manifest holds every identity the aggregate scores
   * rather than the ones that ran lately. A run reads records only from
   * the objects it folds for the first time, so surfaces gathered from
   * those alone name the identities that ran inside that run's window;
   * the publisher keeps the identities it can place, and an identity it
   * has no surface for is not one of them.
   */
  files: Record<string, string>;

  /**
   * What lanes have measured about themselves, against the day each ran.
   * A lane's cost beyond its tests is fitted from this, and it is kept
   * here rather than recomputed because a publisher run folds a few
   * hours of objects and a fit wants the window `COST_WINDOW_DAYS`
   * names.
   */
  lanes?: LaneObservation[];
}

/** A fresh aggregate, for a cold start. */
export function emptyAggregate(day: string): AggregateState {
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    day,
    folded: [],
    context: serializeContext(emptyContext()),
    compacted: [],
    states: {},
    files: {},
  };
}

/** The submission area an object was written into. */
export const CI_SOURCE = "ci";

/**
 * The area a submission object belongs to: the shared
 * continuous-integration one, or one person's own. It is what a rollup
 * covers and what a receipt is scoped to.
 */
export function sourceOf(objectName: string): string {
  const who = localReporter(objectName);
  return who === undefined ? CI_SOURCE : `local/${who}`;
}

/** The day partition in a submission object's name. */
export function partitionOf(objectName: string): string {
  return objectName.match(/\/v1\/(\d{4}\/\d{2}\/\d{2})\//)?.[1] ?? "";
}

/** How a source and a date name one pair, for a receipt or a lookup. */
export function sourceDateKey(source: string, date: string): string {
  return `${source}\t${date}`;
}

/**
 * Reads a stored aggregate. Returns undefined for anything that is not
 * one, rather than half of a half-understood one.
 *
 * That is a statement about the one body, not about what the publisher
 * has: it folds onto the newest stored state this reads, over a walk
 * back bounded by the days its run covers, and starts from an empty
 * aggregate only where the store holds no state object at all.
 *
 * Takes the body's text or the value it parses to, as `parseManifest`
 * does, so that a reader asking this and `writtenAhead` about one body
 * parses it once. An aggregate is the whole corpus.
 */
export function parseAggregate(value: unknown): AggregateState | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isObjectOrArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  // An aggregate written under an older shape is read forward, field by
  // field, the way each field below says. Refusing it instead would cost
  // every catch it holds, which accumulate over unbounded history and
  // cannot be recovered from a window of records.
  if (declaredSchema(state) === undefined || writtenAhead(state)) {
    return undefined;
  }
  if (typeof state.day !== "string" || !Array.isArray(state.folded)) {
    return undefined;
  }
  // An array is an object, and read as one it would give a state set
  // keyed by index. Every such key fails to name an identity, so the
  // aggregate would be read as holding nothing rather than refused.
  if (
    !isObjectNotArray(state.states)
  ) {
    return undefined;
  }
  for (const name of state.folded) {
    if (typeof name !== "string") return undefined;
  }
  // An aggregate written before rollups were read carries no list, and
  // an empty one is the truthful reading of it: nothing was compacted.
  // The context is an optimization rather than a stored fact, so an
  // aggregate written without one, or with a malformed one, simply starts
  // the two cross-run rules from nothing.
  //
  // A receipt written before the source was part of one names a date
  // alone. Reading it forward as the continuous-integration area is
  // exact rather than a guess: that area is the only one a rollup has
  // ever covered, so nothing else could have written the receipt.
  const written = state.compacted ?? state.compactedDays ?? [];
  if (!Array.isArray(written)) return undefined;
  for (const pair of written) {
    if (typeof pair !== "string") return undefined;
  }
  const compacted = state.compacted === undefined
    ? (written as string[]).map((day) => sourceDateKey(CI_SOURCE, day))
    : written as string[];
  // Each lane observation stands alone, so one that will not read is
  // dropped by itself rather than taking the rest with it. What the list
  // holds is a week of measurements, and the fit reads every figure in
  // it as a number.
  const lanes = Array.isArray(state.lanes)
    ? state.lanes.filter(isLaneObservation)
    : undefined;
  // An aggregate written before the files were carried holds none, and
  // an empty map is the truthful reading of it: each identity is then
  // read as its own invocation unit until one of its records names a
  // file again. Anything else in that place is a state this cannot read,
  // and reading it wrongly would decide which identities the manifest
  // holds, so the aggregate is refused instead.
  const files = state.files === undefined ? {} : state.files;
  if (!isObjectNotArray(files)) {
    return undefined;
  }
  for (const file of Object.values(files as Record<string, unknown>)) {
    if (typeof file !== "string") return undefined;
  }
  // An identity whose state is not a record of one is dropped, and the
  // rest of the aggregate is read. Such an identity is then read as one
  // with no history, which is what a test nothing has been recorded for
  // is, and what that costs is the identity running until it has a
  // history again. Refusing the aggregate over it would cost every
  // identity the one thing here that no window of records rebuilds.
  const states: Record<string, IdentityState> = {};
  for (const [key, held] of Object.entries(state.states)) {
    if (typeof held !== "object" || held === null || Array.isArray(held)) {
      continue;
    }
    states[key] = held as IdentityState;
  }
  for (const identity of Object.values(states)) readCostsForward(identity);
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    day: state.day,
    folded: state.folded as string[],
    context: serializeContext(parseContext(state.context)),
    compacted,
    states,
    files: files as Record<string, string>,
    ...(lanes === undefined ? {} : { lanes }),
  };
}

/** The reporting person named by a local submission's object name. */
export function localReporter(objectName: string): string | undefined {
  return objectName.match(/\/submissions\/local\/([^/]+)\//)?.[1];
}

/** The UTC calendar day of an ISO 8601 timestamp. */
export function dayOf(startedAt: string): string {
  return startedAt.slice(0, 10);
}

/**
 * Where one report's executions happened, and who saw them. Undefined for
 * a report a decision must not read: a run with no context cannot say
 * where it came from, a continuous-integration run naming no branch
 * cannot be told apart from any other naming none, and a local object
 * whose name holds no reporter has nobody to attribute it to.
 */
export function provenance(
  context: RunContext | undefined,
  objectName: string,
): { place: Observation["place"]; source: string } | undefined {
  if (context === undefined) return undefined;
  if (context.env === "local") {
    const reporter = localReporter(objectName);
    return reporter === undefined
      ? undefined
      : { place: "local", source: reporter };
  }
  if (context.ci === undefined) return undefined;
  const branch = context.branch ?? "";
  if (branch.length === 0) return undefined;
  // A baseline is a run of code the tree itself carries: a push to the
  // default branch that the fork flag does not mark. The flag marks a run
  // whose head repository differs from this one, and marks a run whose
  // payload did not name both, so neither can stand as a baseline.
  const place =
    context.ci.event === "push" && branch === "main" && !context.ci.fork
      ? "main"
      : "pr";
  return { place, source: branch };
}

/** What one stored object says, once the parts nothing may read are out. */
export interface ReadReport {
  observations: Observation[];

  /** Where each identity in it runs, by identity key. */
  surfaces: Map<string, Surface>;

  /** Every passing duration, by identity key and then by day. */
  durations: Map<string, Map<string, number[]>>;

  /** What the lanes in this object measured about themselves. */
  lanes: LaneObservation[];

  /**
   * The day of each lane measurement in a group nothing may read, which
   * the cost model is therefore fitted without. A lane exercised only
   * from runs the fold cannot place records what it measured like any
   * other lane and contributes nothing, and these are what tell that
   * apart from no lane having run at all.
   *
   * The day travels with each of them so that a caller holds them to
   * the same window as the measurements it kept. A group whose start
   * time will not read as one has no day, and contributes none.
   */
  declinedDays: string[];
}

/**
 * Reads one stored object. A report a decision must not read contributes
 * nothing: `provenance()` says which those are, and a group whose start
 * time is not a time has no place in the order the rules read along.
 */
export function readReport(
  report: StoredReport,
  resolver: AliasResolver,
): ReadReport {
  const observations: Observation[] = [];
  const surfaces = new Map<string, Surface>();
  const durations = new Map<string, Map<string, number[]>>();
  const lanes: LaneObservation[] = [];
  const declinedDays: string[] = [];
  for (const group of report.reports) {
    const where = provenance(group.context, report.objectName);
    if (
      where === undefined || group.context === undefined ||
      !Number.isFinite(Date.parse(group.context.startedAt))
    ) {
      // The identity as the lane wrote it, rather than as the resolver
      // would rewrite it: a group this cannot place has no day to
      // resolve an alias against, and no alias renames a measurement a
      // lane writes about itself.
      const startedAt = group.context?.startedAt;
      if (startedAt !== undefined && Number.isFinite(Date.parse(startedAt))) {
        const day = dayOf(startedAt);
        for (const record of group.records) {
          if (isLaneMeasurement(record.test)) declinedDays.push(day);
        }
      }
      continue;
    }
    const day = dayOf(group.context.startedAt);
    // What a lane spent on its own setup and on each of its batches is
    // not scored, and not discarded either: it is what the packer's
    // charges for both are fitted from. One group is one lane's
    // artifact, so a batch's two halves are here together.
    lanes.push(
      ...laneObservationsOf(report.objectName, group.records, day),
    );
    for (const record of group.records) {
      // A lane measuring its own setup or one of its batches is not a
      // test, so nothing here scores it: a catch, a flake observation and
      // a churn rate are all statements about a test, and a lane is
      // neither passing nor failing in the sense they read. It reaches
      // the store as an ordinary record so that it travels the path every
      // record travels, and this is where that path parts. What a record
      // is, is asked of the identity the lane wrote, so no line in the
      // alias file decides whether a measurement is scored as a test.
      if (isLaneMeasurement(record.test)) continue;
      const test = resolver.resolve(record.test, day);
      const key = testIdentityKey(test);
      // A record with no file names its own identity as the unit, which
      // is all an unmapped record can say. Where another record of the
      // same identity did carry a file, that is the better answer and the
      // unmapped one must not overwrite it: the suites are mid-migration
      // onto the preload, so one identity can have records of both kinds.
      const surface = recordSurface(test, record.file);
      const known = surfaces.get(key);
      if (known === undefined || surface.fromFile) surfaces.set(key, surface);
      observations.push({
        test,
        outcome: record.outcome,
        day,
        startedAt: group.context.startedAt,
        commit: group.context.commit,
        ...(group.context.shuffleSeed === undefined
          ? {}
          : { seed: group.context.shuffleSeed }),
        source: where.source,
        place: where.place,
      });
      // A cost predicts what a lane will spend running this test again,
      // and only a passing execution measures that. A failure ended
      // where the failure was reached, and where a wait's safety net
      // ended it, its duration is that net's bound.
      if (record.outcome !== "pass") continue;
      let byDay = durations.get(key);
      if (byDay === undefined) {
        byDay = new Map();
        durations.set(key, byDay);
      }
      byDay.set(day, [...(byDay.get(day) ?? []), record.durationMs]);
    }
  }
  return { observations, surfaces, durations, lanes, declinedDays };
}

/** The invocation unit and suite a record belongs to. */
export interface Surface {
  suite: string;
  unit: string;

  /** Whether the unit came from a record's file rather than its name. */
  fromFile: boolean;
}

/**
 * How an identity is grouped, until the topology says. A record's kind
 * and scope name the surface that produced it, and the file the
 * registration preload captured names what a runner can be pointed at; an
 * identity with no file is its own invocation unit, which is what every
 * suite outside the unit tests already is.
 */
export function recordSurface(
  test: TestIdentity,
  file: string | undefined,
): Surface {
  return {
    suite: surfaceName(test),
    unit: file ?? test.n,
    fromFile: file !== undefined,
  };
}

/**
 * The surface an identity's own record names: the kind of check, the
 * workspace member that owns it, and the configuration it ran under where
 * that is not the default one.
 */
export function surfaceName(test: TestIdentity): string {
  return test.v === undefined
    ? `${test.k}:${test.s}`
    : `${test.k}:${test.s}:${test.v}`;
}

/** What the topology could not place, and why. */
export interface Unplaced {
  /**
   * Identities whose only claim is on the suite as a whole: the
   * overlapping whole-invocation measurements a script records beside
   * its own steps. They name no unit, so nothing can be asked to run one
   * of them, and summing them with their own steps would count that work
   * twice.
   */
  suiteLevel: string[];

  /**
   * Identities no suite claims. What decides an identity's unit is its
   * own records: the file, for a suite whose units are files, and the
   * recorded name for one whose units are not. An identity whose records
   * say neither is given a unit the first time it records one the tree
   * holds. The lane's measurements of itself are not here: they are not
   * test surfaces, and `isLaneMeasurement` is what says so.
   *
   * These span the aggregate's whole history rather than one run's
   * reads, because the surfaces they are read from do.
   */
  unclaimed: string[];

  /**
   * Identities more than one suite claims, which is a topology defect
   * the drift guard fails on rather than a record that says too little.
   * Apart here because the tree holds the test twice over rather than
   * not at all, and what is done about an identity the tree has lost
   * must not be done about one it holds.
   */
  contested: string[];
}

/**
 * Where each identity runs, as the topology says rather than as its own
 * record surface guesses.
 *
 * Both halves of the system key on the suite identifier and unit a
 * manifest carries: the lane runner asks the topology for the suite by
 * that name, and the packer charges that suite's overhead and its
 * capabilities. A manifest naming a surface derived from the record's
 * own kind and scope matches no suite, so every unit reads as unknown
 * and every selection is dropped for naming a suite the tree does not
 * hold.
 *
 * An identity this cannot place is left out of the manifest rather than
 * carried under a name nothing can run, and is reported so that the two
 * reasons for it stay visible.
 */
export function locateSurfaces(
  suites: readonly Suite[],
  surfaces: ReadonlyMap<string, Surface>,
): { placed: Map<string, Surface>; unplaced: Unplaced } {
  const placed = new Map<string, Surface>();
  const unplaced: Unplaced = { suiteLevel: [], unclaimed: [], contested: [] };
  for (const [key, surface] of surfaces) {
    const test = testIdentityOfKey(key);
    if (test === undefined) continue;
    // A lane's measurement of its own setup or of one of its batches is
    // not a test surface: no suite claims one, and none should.
    if (isLaneMeasurement(test)) continue;
    const claims = claimsFor(suites, {
      test,
      // The unit a record's own surface fell back to is the file where
      // one was recorded, and the identity's own name where none was.
      // Only the first is a file, and only that is what `locate` joins
      // on.
      ...(surface.fromFile ? { file: surface.unit } : {}),
    });
    // Two suites claiming one identity is a topology defect rather than
    // an ambiguity to settle here, and the drift guard is what fails on
    // it. Placing it either way would put the work in whichever suite
    // came first.
    if (claims.length === 1) {
      const unit = claims[0]!.unit;
      if (unit === undefined) unplaced.suiteLevel.push(key);
      else {
        placed.set(key, {
          suite: claims[0]!.suite.id,
          unit,
          fromFile: surface.fromFile,
        });
      }
      continue;
    }
    if (claims.length === 0) unplaced.unclaimed.push(key);
    else unplaced.contested.push(key);
  }
  return { placed, unplaced };
}

/**
 * The identities the aggregate carries for tests the tree has lost.
 *
 * A test deleted from the repository leaves its records in the store,
 * and the store is what the fold reads, so the aggregate carries its
 * state for good. Nothing can select it, because the topology has no
 * unit for it and the manifest holds only what the topology placed. What
 * it costs is a state read, scored and written back on every publisher
 * run, and a place in the count of identities the topology has no unit
 * for, which is the count that says a surface is recording without
 * saying where it runs.
 *
 * Two things have to hold before one is dropped, and neither is enough
 * alone. No suite claims the identity at all: an identity two suites
 * both claim is a topology defect over a test the tree holds twice, and
 * is not here. And no run of it has
 * been recorded inside the longest window a state keeps counters for,
 * which is what `lastRun` having no answer says: the default branch runs
 * every test the tree holds, so a test that is still there and still
 * runs records inside that window whether or not a change selects it.
 *
 * The second is what holds this against a topology that reads the tree
 * wrongly. A suite that enumerates nothing leaves every identity it
 * would have claimed with no unit, and every one of those is running, so
 * none of them is dropped.
 *
 * A skip is not a run, so a test the tree holds that nothing ever runs
 * is dropped like a deleted one. What that costs is catches from before
 * the window: every counter inside it is empty either way, since a skip
 * is the one outcome a state records nothing for.
 *
 * A unit a configuration declares unavailable is kept, under the variant
 * that declared it. The declaration is the tree saying the test is there
 * and does not run in this configuration, which is how the drift guard
 * and `verify` each read one as well.
 */
export function departed(
  suites: readonly Suite[],
  unplaced: Unplaced,
  folded: Pick<FoldResult, "states" | "surfaces">,
): string[] {
  // A skip registry belongs to one configuration, and the file it names
  // is a unit of every configuration of that suite. Keyed by the variant
  // as well, so a file skipped in one of them says nothing about the
  // same file's identities in another.
  const declared = new Set<string>();
  for (const suite of suites) {
    for (const unit of unavailableUnits(suite)) {
      declared.add(`${suite.variant ?? ""}\t${unit}`);
    }
  }
  return unplaced.unclaimed.filter((key) => {
    const state = folded.states.get(key);
    if (state === undefined || lastRun(state) !== undefined) return false;
    const unit = folded.surfaces.get(key)?.unit;
    const test = testIdentityOfKey(key);
    return !declared.has(`${test?.v ?? ""}\t${unit}`);
  });
}

/**
 * How many times a lane runs an identity, given how flaky it is.
 *
 * A test that has never disagreed with itself runs once. Any rate at all
 * puts it on the line through `FLAKE_MIN_EXECUTIONS` at a rate of
 * nothing and `FLAKE_ANCHOR_EXECUTIONS` at `FLAKE_ANCHOR_RATE`, which
 * carries on past that anchor until `MAX_EXECUTIONS` stops it.
 *
 * The line runs past `FLAKE_EXCLUSION_RATE` on purpose. A test that
 * flaky is not selected, so the only way it reaches a lane is a change
 * that edits it or that its suite maps onto its unit — which is very
 * likely a fix, and the count is what makes it prove itself.
 */
export function executionsFor(rate: number): number {
  if (rate <= 0) return 1;
  const line = FLAKE_MIN_EXECUTIONS +
    (FLAKE_ANCHOR_EXECUTIONS - FLAKE_MIN_EXECUTIONS) *
      (rate / FLAKE_ANCHOR_RATE);
  return Math.min(
    MAX_EXECUTIONS,
    Math.max(FLAKE_MIN_EXECUTIONS, Math.round(line)),
  );
}

/** What a manifest is built from beyond the folded state. */
export interface BuildInput {
  states: Map<string, IdentityState>;

  /** Where each identity runs, by identity key. */
  surfaces: ReadonlyMap<string, Surface>;

  /** The day the score is taken as of. */
  today: string;

  generatedAt: string;
  seed: string;
  commit: string;
  runs: number;
  calibration?: Partial<Calibration>;
}

/**
 * The last day this identity is known to have run. The run counts are
 * kept per day and aged rather than kept forever, so an identity nothing
 * has run inside that reach has no answer, which the exploration draw
 * reads as the longest unrun of all.
 */
export function lastRun(state: IdentityState): string | undefined {
  let latest: string | undefined;
  for (const [day, runs] of Object.entries(state.runsByDay)) {
    if (runs <= 0) continue;
    if (latest === undefined || day > latest) latest = day;
  }
  return latest;
}

/** Builds a manifest from folded state. */
export function buildManifest(input: BuildInput): Manifest {
  const entries: ManifestEntry[] = [];
  const withheld: WithheldEntry[] = [];
  for (const [key, state] of input.states) {
    const test = testIdentityOfKey(key);
    if (test === undefined) continue;
    const surface = input.surfaces.get(key) ?? recordSurface(test, undefined);
    const inputs = scoreInputs(state, input.today);
    const evidence = flakeCounts(state, input.today);
    // Every figure here is written as it was measured. Thresholds are
    // compared against these, so a figure rounded on the way in decides
    // at the rounding rather than at the threshold: a share rounded to
    // four places reaches zero once a test has twenty thousand runs
    // behind one disagreement, and zero is what the execution count
    // steps at. Reading these is what rounds them, and a reader that
    // shows one to a person rounds it there.
    const rate = flakeRate(state, input.today);
    const ran = lastRun(state);
    entries.push({
      test,
      suite: surface.suite,
      unit: surface.unit,
      cost: costSeconds(state, input.today),
      score: value(inputs, input.today),
      inputs,
      flakeRate: rate,
      flakeEvidence: evidence,
      repeats: executionsFor(rate),
      ...(ran === undefined ? {} : { lastRun: ran }),
    });
    if (rate > FLAKE_EXCLUSION_RATE) {
      withheld.push({ test, suite: surface.suite, reason: "flaky" });
    }
  }
  entries.sort((a, b) =>
    testIdentityKey(a.test).localeCompare(testIdentityKey(b.test))
  );
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    seed: input.seed,
    commit: input.commit,
    runs: input.runs,
    dials: dialSnapshot(),
    calibration: {
      setupCost: input.calibration?.setupCost ?? {},
      suites: input.calibration?.suites ?? {},
      prologue: input.calibration?.prologue ?? LANE_PROLOGUE_SECONDS,
    },
    entries,
    withheld,
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: {
      count: entries.length,
      digest: digestIdentities(entries.map((e) => testIdentityKey(e.test))),
    },
    coverageBaselines: [],
  };
}

/**
 * What reading stored objects gives a fold beyond the observations they
 * hold: where each identity runs, what the lanes in them measured, what
 * their passing runs took, which objects they came from, and how many
 * lane measurements had to be declined.
 *
 * A fold holds one of these. A read that has to land whole or not at all
 * reads into a second and merges it in once every object has arrived,
 * which is what leaves the fold as it was when such a read fails part
 * way.
 */
interface Contributions {
  /** Where each identity runs, by identity key. */
  surfaces: Map<string, Surface>;

  /** What the lanes in them measured about themselves. */
  lanes: LaneObservation[];

  /** The slowest passing runs of each identity, by key and then by day. */
  samples: Map<string, Map<string, DaySamples>>;

  /**
   * The objects these came from, which is both what the aggregate
   * persists and what says an object handed over again contributes
   * nothing. A set rather than a list because the question is asked once
   * per listed object per run and the answer grows without bound.
   */
  objects: Set<string>;

  /** Lane measurements read inside the cost window and declined. */
  declined: number;
}

/** What nothing read yet contributes. */
function noContributions(): Contributions {
  return {
    surfaces: new Map(),
    lanes: [],
    samples: new Map(),
    objects: new Set(),
    declined: 0,
  };
}

/**
 * Records where one identity runs. A file names something a runner can be
 * pointed at, and an identity's own name does not, so a surface with no
 * file must not replace one that has it — whether the one with no file
 * arrives in a later report or in a batch merged in afterwards.
 */
function rememberSurface(
  into: Contributions,
  key: string,
  surface: Surface,
): void {
  if (!into.surfaces.has(key) || surface.fromFile) {
    into.surfaces.set(key, surface);
  }
}

/**
 * Merges what one batch contributed into what a fold holds, giving what
 * reading that batch's objects into the fold directly would have given.
 * The duration samples are the part of that which has to be shown rather
 * than assumed: a day's sample keeps only its slowest runs, and
 * `mergeSamples` keeps of two parts what one accumulation of the whole
 * would have kept, so a day read in parts costs what the day costs.
 */
function absorb(into: Contributions, batch: Contributions): void {
  for (const [key, surface] of batch.surfaces) {
    rememberSurface(into, key, surface);
  }
  // Appended one at a time rather than spread, for the reason a report's
  // observations are: a batch holds a whole day, and spreading that many
  // arguments onto the stack is past what a call can carry.
  for (const lane of batch.lanes) into.lanes.push(lane);
  for (const [key, byDay] of batch.samples) {
    let known = into.samples.get(key);
    if (known === undefined) {
      known = new Map();
      into.samples.set(key, known);
    }
    for (const [day, sampled] of byDay) {
      const held = known.get(day);
      known.set(
        day,
        held === undefined ? sampled : mergeSamples(held, sampled),
      );
    }
  }
  for (const object of batch.objects) into.objects.add(object);
  into.declined += batch.declined;
}

/** A fold in progress, which the caller feeds reports to in time order. */
export class Fold {
  readonly #states: Map<string, IdentityState>;
  readonly #context: FoldContext;
  readonly #held: Contributions;
  readonly #compacted: string[];

  /**
   * The source-and-date pairs `folded` holds raw objects from, which is
   * what says a rollup written later would overlap them.
   */
  readonly #rawPairs: Set<string>;
  readonly #resolver: AliasResolver;
  readonly #today: string;
  #observations = 0;
  #intact = true;

  constructor(
    aggregate: AggregateState,
    resolver: AliasResolver,
    today: string,
  ) {
    this.#states = new Map(
      Object.entries(aggregate.states)
        // An aggregate written before lane measurements stopped being
        // folded carries a state for each of them. Nothing new adds one,
        // and a state nothing adds to is a state nothing removes either,
        // so an aggregate carrying one carries it for good unless it is
        // dropped on the way in.
        .filter(([key]) => {
          const test = testIdentityOfKey(key);
          return test === undefined || !isLaneMeasurement(test);
        })
        .map(([key, state]) => [key, { ...emptyState(), ...state }]),
    );
    // A record produces a state and a surface together, so an identity
    // the aggregate holds a state for has a surface, and the file its
    // records named is the only part of that surface the identity does
    // not already say. Seeding these is what makes the manifest hold
    // every identity the aggregate scores rather than the ones whose
    // records this run happened to read.
    this.#held = noContributions();
    for (const key of this.#states.keys()) {
      const test = testIdentityOfKey(key);
      if (test === undefined) continue;
      this.#held.surfaces.set(key, recordSurface(test, aggregate.files[key]));
    }
    this.#context = parseContext(aggregate.context);
    for (const lane of aggregate.lanes ?? []) this.#held.lanes.push(lane);
    for (const name of aggregate.folded) this.#held.objects.add(name);
    this.#compacted = [...aggregate.compacted];
    this.#rawPairs = new Set(
      aggregate.folded.map((name) =>
        sourceDateKey(sourceOf(name), partitionOf(name))
      ),
    );
    this.#resolver = resolver;
    this.#today = today;
  }

  /** How many executions have been folded in. */
  get observations(): number {
    return this.#observations;
  }

  /**
   * Lane measurements this fold read and had to decline, counted over
   * the objects it folded and over the same window the cost model is
   * fitted across. What that model is fitted from is what a lane
   * measured about itself, so a figure here is a lane that ran inside
   * the window and whose measurement cannot be used, which is a
   * different thing from a lane that has not run.
   */
  get declined(): number {
    return this.#held.declined;
  }

  /**
   * Whether this fold is everything it was before the batch that failed,
   * which is what says whether those records may be read another way.
   *
   * A batch read through `addUnordered` gives what it reads to the batch
   * rather than to the fold, so reports that fail to arrive leave this
   * true. Merging a batch in is what makes it false, and a failure from
   * there on leaves part of the batch counted, so reading the same
   * records again would count that part twice. `add` folds as it reads,
   * so this falls ahead of its first report.
   */
  get intact(): boolean {
    return this.#intact;
  }

  /** Whether this object's records are already part of the aggregate. */
  knows(objectName: string): boolean {
    return this.#held.objects.has(objectName);
  }

  /**
   * Whether this source and date were folded from a rollup. Their raw
   * objects are not in `folded`, so a caller listing them has to ask
   * about the pair instead or it will fold the pair twice.
   */
  settled(source: string, date: string): boolean {
    return this.#compacted.includes(sourceDateKey(source, date));
  }

  /**
   * Whether any raw object of this source and date is already folded. A
   * rollup written later would overlap those contributions, and nothing
   * in a rollup of this format says by how much, so a pair that answers
   * yes stays on the raw path.
   */
  hasRaw(source: string, date: string): boolean {
    return this.#rawPairs.has(sourceDateKey(source, date));
  }

  /**
   * Records that a source and date came from their rollup, so no later
   * run folds the raw objects the rollup summarizes.
   */
  markSettled(source: string, date: string): void {
    const key = sourceDateKey(source, date);
    if (!this.#compacted.includes(key)) this.#compacted.push(key);
  }

  /**
   * Folds one batch. The batch must be in ascending time order, and later
   * batches must be later than earlier ones, because the rules that decide
   * whether a failure is a catch look backwards at what `main` last said
   * and forwards at what it says next.
   *
   * An object the aggregate already holds contributes nothing, however
   * often it is handed over. Its executions are in the counters and its
   * durations in the day's samples, and both of those add rather than
   * replace, so folding one a second time would count all of it twice.
   */
  add(reports: readonly StoredReport[]): void {
    this.#intact = false;
    const observations: Observation[] = [];
    for (const report of reports) {
      if (this.knows(report.objectName)) continue;
      const read = readReport(report, this.#resolver);
      // Appended one at a time rather than spread: a rollup shard holds a
      // whole day, and spreading that many arguments onto the stack is
      // past what a call can carry.
      for (const observation of read.observations) {
        observations.push(observation);
      }
      this.#remember(read, this.#held);
      this.#held.objects.add(report.objectName);
    }
    // Sorted here rather than by object, because one object can hold many
    // reports — a rollup holds a whole day of them — and a batch can hold
    // objects whose reports interleave in time. The rules that decide
    // whether a failure is a catch look backwards and forwards along this
    // order, so it has to be the order the runs actually happened in.
    // By the parsed instant rather than the text: these come from two
    // producers, and one writing fractional seconds where the other does
    // not makes the later run sort first, because "." precedes "Z".
    observations.sort((a, b) =>
      Date.parse(a.startedAt) - Date.parse(b.startedAt)
    );
    this.#observations += observations.length;
    foldObservations(observations, {
      prior: this.#states,
      context: this.#context,
    });
    // The two cross-batch rules reach back a couple of days, so what is
    // older cannot change a verdict and is dropped rather than carried
    // through a bootstrap's whole read.
    const newest = observations.at(-1)?.day;
    if (newest !== undefined) trimContext(this.#context, newest);
    this.#intact = true;
  }

  /**
   * Folds one logical batch from reports arriving in arbitrary order.
   * Each run is spooled to disk, then replayed in time order for every
   * evidence pass and the final classification pass.
   *
   * The batch lands whole or not at all: what the reports give is held
   * aside until the last of them has arrived, and a read that fails part
   * way leaves this fold as it was. That is what lets a caller read the
   * same records another way — a rollup is a read optimization rather
   * than the record of its day, and that day's raw objects are all still
   * in the store — which it could not do if part of the day were already
   * counted.
   *
   * An object the aggregate already holds contributes nothing, the way
   * `add` passes over one.
   */
  async addUnordered(reports: AsyncIterable<StoredReport>): Promise<void> {
    // The spool is released before the fold says it is whole again.
    // Releasing it is a file being closed and removed and can fail on its
    // own, and a fold that had folded the batch and then said it was
    // untouched would offer those records to be read a second time.
    await this.#foldBatch(reports);
    this.#intact = true;
  }

  /** Reads a batch aside and folds it, holding the spool meanwhile. */
  async #foldBatch(reports: AsyncIterable<StoredReport>): Promise<void> {
    using observations = new ObservationSpool();
    const batch = noContributions();
    for await (const report of reports) {
      const name = report.objectName;
      if (this.knows(name) || batch.objects.has(name)) continue;
      for (const group of report.reports) {
        const read = readReport({
          objectName: name,
          context: group.context,
          records: group.records,
          reports: [group],
        }, this.#resolver);
        observations.add(read.observations);
        this.#remember(read, batch);
      }
      batch.objects.add(name);
    }
    this.#intact = false;
    absorb(this.#held, batch);
    this.#observations += observations.count;
    foldObservations(observations, {
      prior: this.#states,
      context: this.#context,
    });
    if (observations.newestDay !== undefined) {
      trimContext(this.#context, observations.newestDay);
    }
  }

  /**
   * Whether a lane's measurement is recent enough to charge against.
   * Both ends of the fold ask this rather than spelling the comparison
   * out twice, so a day that will not parse as one is dropped at both
   * rather than accepted at one and refused at the other.
   */
  #withinCostWindow(lane: LaneObservation): boolean {
    return daysBetween(lane.day, this.#today) <= COST_WINDOW_DAYS;
  }

  /** Closes the fold, sealing each day's cost and aging the counters. */
  finish(): FoldResult {
    for (const [key, byDay] of this.#held.samples) {
      const state = this.#states.get(key);
      if (state === undefined) continue;
      for (const [day, sampled] of byDay) sealDay(state, day, sampled);
    }
    for (const state of this.#states.values()) {
      trimWindows(state, this.#today);
    }
    // Aged the way every other window is, so what a lane cost a week ago
    // stops deciding what the packer charges today.
    const lanes = this.#held.lanes.filter((lane) =>
      this.#withinCostWindow(lane)
    );
    return {
      aggregate: {
        schema: MANIFEST_SCHEMA_VERSION,
        day: this.#today,
        folded: [...this.#held.objects],
        context: serializeContext(this.#context),
        compacted: this.#compacted,
        states: Object.fromEntries(this.#states),
        lanes,
        files: Object.fromEntries(
          [...this.#held.surfaces]
            .filter(([, surface]) => surface.fromFile)
            .map(([key, surface]) => [key, surface.unit]),
        ),
      },
      states: this.#states,
      surfaces: this.#held.surfaces,
      observations: this.#observations,
    };
  }

  /**
   * Records what one object gives beyond its observations: invocation
   * surfaces, lane measurements, bounded duration samples, and the lane
   * measurements inside the cost window that had to be declined. The
   * declined ones are counted against that window rather than against
   * everything read, because a run reading a wider window — a bootstrap,
   * or a window somebody asked for — would otherwise offer a stale
   * measurement as the reason a current model is empty.
   */
  #remember(read: ReadReport, into: Contributions): void {
    for (const [key, surface] of read.surfaces) {
      rememberSurface(into, key, surface);
    }
    // A day past the cost window is dropped again by the same `finish`
    // that would keep it, so reading one buys nothing and a bootstrap
    // holds sixty days of them at once.
    for (const lane of read.lanes) {
      if (this.#withinCostWindow(lane)) into.lanes.push(lane);
    }
    for (const [key, byDay] of read.durations) {
      let known = into.samples.get(key);
      for (const [day, sampled] of byDay) {
        // A day past the cost window is sealed and then dropped again
        // by the same `finish` that sealed it, so sampling it buys
        // nothing and a bootstrap holds sixty days of it at once.
        if (daysBetween(day, this.#today) > COST_WINDOW_DAYS) continue;
        if (known === undefined) {
          known = new Map();
          into.samples.set(key, known);
        }
        const samples = known.get(day) ?? emptySamples();
        for (const durationMs of sampled) sampleDuration(samples, durationMs);
        known.set(day, samples);
      }
    }
    for (const day of read.declinedDays) {
      if (daysBetween(day, this.#today) <= COST_WINDOW_DAYS) into.declined++;
    }
  }
}

/** What a finished fold produced. */
export interface FoldResult {
  aggregate: AggregateState;
  states: Map<string, IdentityState>;
  surfaces: Map<string, Surface>;
  observations: number;
}

/** Folds a whole set of reports at once, for a caller holding them all. */
export function foldReports(
  aggregate: AggregateState,
  reports: readonly StoredReport[],
  resolver: AliasResolver,
  today: string,
): FoldResult {
  const fold = new Fold(aggregate, resolver, today);
  fold.add(reports);
  return fold.finish();
}

/** Parses object text the way the store's reader does, for offline use. */
export function reportFromText(
  objectName: string,
  text: string,
): StoredReport {
  const reports = parseReportGroups(text);
  return {
    objectName,
    context: reports[0]?.context,
    records: reports.flatMap((report) => report.records),
    reports,
  };
}
