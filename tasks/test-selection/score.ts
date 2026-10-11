/**
 * What the record store says about one test, and what that is worth.
 *
 * A test earns its place in a pull request by having caught real breakage
 * before, so the score is built on catches and decays slowly. Deciding
 * whether a failure is a catch is the delicate part: a test that is flaky
 * on `main` produces one failure per commit and would otherwise look like
 * the most valuable test in the repository. `foldObservations` is where
 * that judgement is made, once per observation, with the state it needs
 * carried forward from the day before.
 */

import type {
  FlakeEvidence,
  ScoreInputs,
  TestIdentity,
} from "@commonfabric/test-support/records";
import { testIdentityKey } from "@commonfabric/test-support/records";
import { minOf } from "@commonfabric/utils/math";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  BREADTH_SATURATION,
  CATCH_BREADTH_WINDOW_DAYS,
  CATCH_WEIGHT_LOCAL,
  CATCH_WEIGHT_MAIN,
  CATCH_WEIGHT_PR,
  CHURN_HALF_LIFE_DAYS,
  CHURN_WINDOW_DAYS,
  COMMIT_REACH_DAYS,
  COST_WINDOW_DAYS,
  ENVIRONMENTAL_MIN_SOURCES,
  FLAKE_COMMIT_REACH,
  FLAKE_HALF_LIFE_RUNS,
  FLAKE_WINDOW_DAYS,
  FRESHNESS_FLOOR,
  FRESHNESS_HALF_LIFE_DAYS,
  MASS_FAILURE_MIN_IDENTITIES,
  PROVEN_SATURATION,
  SAME_COMMIT_REACH_DAYS,
  VALUE_FLOOR,
  WEIGHT_BREADTH,
  WEIGHT_CHURN,
  WEIGHT_PROVEN,
} from "./policy.ts";

/** Where a failure happened, which changes what it means. */
export type CatchPlace = "local" | "pr" | "main";

/** One execution of one test, as the publisher reads it from a report. */
export interface Observation {
  test: TestIdentity;
  outcome: "pass" | "fail" | "skip";

  /** UTC calendar day, "yyyy-mm-dd". */
  day: string;

  /**
   * When the run this came from started, ISO 8601 UTC. The day is what
   * the counters are kept by; this is what the order is taken from, which
   * a day is too coarse for.
   */
  startedAt: string;

  /** The commit the tests ran against. */
  commit: string;

  /**
   * The seed the run shuffled its tests by, absent for a run that ran
   * them in the order they were declared. Two observations at one commit
   * ran under the same conditions only where this agrees too: an
   * order-dependent test passes in one order and fails in another, and
   * that is a bug in the test rather than chance.
   */
  seed?: number;

  /**
   * Who saw it: the branch for a continuous-integration run, the
   * reporting person's login for a local one.
   */
  source: string;

  /** Where it ran, which is what a catch there is worth. */
  place: CatchPlace;
}

/** What one identity's history has accumulated. */
export interface IdentityState {
  /** Catches on a workstation. */
  localCatches: number;

  /** Catches on a pull request. */
  prCatches: number;

  /** Catches on the default branch. */
  mainCatches: number;

  /** The day of the most recent catch, absent when there are none. */
  lastCatch?: string;

  /** The distinct sources among the catches. */
  sources: string[];

  /** Failures per day, the numerator of the churn term. */
  failuresByDay: Record<string, number>;

  /** Runs per day, the denominator of that term and of the flake rate. */
  runsByDay: Record<string, number>;

  /** Flake observations per day, the numerator of the flake rate. */
  flakesByDay: Record<string, number>;

  /**
   * The day's passing durations, counted by bucket. Counted rather than
   * kept, because keeping every duration would make the state object
   * grow with the number of runs rather than with the number of tests.
   * A day is the unit because that is what ages out of the cost window.
   */
  costByDay: Record<string, DaySamples>;

  /** The outcome of the most recent `main` run this identity appeared in. */
  lastMainOutcome?: "pass" | "fail" | "skip";

  /**
   * Failures on `main` that no later `main` run has judged yet. A
   * failure that the next `main` run passes was fixed by the change
   * between them, which makes it a catch unless it arrived in a crowd;
   * one that is still failing is the same breakage continuing, and waits.
   */
  pendingMain: Array<PendingMainFailure>;
}

/** A failure on `main` waiting for a later `main` run to judge it. */
export interface PendingMainFailure {
  day: string;
  commit: string;
  seed?: number;
  source: string;

  /**
   * Whether the breakage arrived in a crowd: a run that newly broke at
   * least `MASS_FAILURE_MIN_IDENTITIES` identities. Whichever of them a
   * change runs sees that breakage, so it is no one test's catch.
   */
  crowded?: true;
}

/**
 * Which set of rules credited the catches an aggregate holds: what
 * decides whether a failure is a catch, and when and where it is counted.
 * Change it to any other value in the same change that alters those. A
 * catch is held as a count rather than as the failure it came from, so a
 * count credited under other rules cannot be judged again by itself, and
 * the publisher folds the whole history behind it again instead. The
 * values are not ordered and nothing but equality is asked of them; an
 * aggregate carrying none was written before the stamps began.
 */
export const CATCH_RULE = 1;

/** A fresh, empty history. */
export function emptyState(): IdentityState {
  return {
    localCatches: 0,
    prCatches: 0,
    mainCatches: 0,
    sources: [],
    failuresByDay: {},
    runsByDay: {},
    flakesByDay: {},
    costByDay: {},
    pendingMain: [],
  };
}

/** Days between two "yyyy-mm-dd" days, `later` minus `earlier`. */
export function daysBetween(earlier: string, later: string): number {
  const from = Date.parse(`${earlier}T00:00:00Z`);
  const to = Date.parse(`${later}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function addSource(state: IdentityState, source: string): void {
  if (!state.sources.includes(source)) state.sources.push(source);
}

function creditCatch(
  state: IdentityState,
  place: CatchPlace,
  day: string,
  source: string,
): void {
  if (place === "local") state.localCatches++;
  else if (place === "pr") state.prCatches++;
  else state.mainCatches++;
  if (state.lastCatch === undefined || state.lastCatch < day) {
    state.lastCatch = day;
  }
  addSource(state, source);
}

function bump(counts: Record<string, number>, day: string): void {
  counts[day] = (counts[day] ?? 0) + 1;
}

/**
 * The longest window any of a state's per-day counters is kept for, which
 * is also how long a failure on the default branch waits to be judged.
 */
const LONGEST_WINDOW_DAYS = Math.max(CHURN_WINDOW_DAYS, FLAKE_WINDOW_DAYS);

/**
 * Judges the failures on `main` that were waiting for a later `main` run.
 * A failure the next run still shows is the same breakage continuing, so
 * it keeps waiting and nothing new is learned. A failure the next run
 * does not show is a flake when that run is at the same commit in the
 * same order, and a catch when it is at a later commit in the same
 * order. A pass in a different order is neither, and the failures in
 * other orders are dropped: an order-dependent test stops failing when
 * the order moves on, so the pass says nothing about whether a change
 * fixed anything. Failures in the pass's own order are judged whatever
 * else is waiting beside them.
 * Nothing separates a failure a change fixed from one that healed
 * itself, so a failure that healed itself in one order is credited as a
 * catch as well. A breakage that arrived in a crowd is no catch however
 * it ends, since whichever of the crowd a change runs would have found
 * it.
 */
function resolvePendingMain(
  state: IdentityState,
  observation: Observation,
): void {
  if (state.pendingMain.length === 0) return;
  if (observation.outcome === "fail") return;
  // A failure nothing has judged inside the longest window a state keeps
  // is one the default branch has carried for that long, and crediting a
  // catch for it now would credit the test with a fix it did not find.
  // `trimWindows` ages these by the same window, and applies it too late
  // to answer this on its own: a fold resolves every observation it
  // reads before it ages anything.
  const live = state.pendingMain.filter((pending) =>
    daysBetween(pending.day, observation.day) <= LONGEST_WINDOW_DAYS &&
    pending.seed === observation.seed
  );
  state.pendingMain = [];
  if (live.length === 0) return;
  // One breakage, one catch. A test that stays red across several runs on
  // the default branch has one thing wrong with it, and the change that
  // makes it green fixed that one thing; crediting every run it failed
  // would make a long outage look like the most valuable test in the
  // repository. The first failure is the one the catch belongs to, since
  // that is where the breakage entered.
  const first = live.reduce((earliest, pending) =>
    pending.day < earliest.day ? pending : earliest
  );
  if (first.commit === observation.commit) {
    // The same commit, passing now and failing before, is the test
    // disagreeing with itself there. The two runs can arrive in separate
    // batches, so the same-commit check that catches this within one
    // batch does not see it, and dropping the pending failure silently
    // would lose the flake as well as the catch.
    bump(state.flakesByDay, first.day);
    return;
  }
  if (first.crowded === true) return;
  creditCatch(state, "main", first.day, first.source);
}

/**
 * Where an observation was made, as the rules that compare two runs need
 * it: the commit, and the order its tests ran in. A run with no seed ran
 * in declaration order, which is an order of its own, so its point is
 * the bare commit and matches no seeded run's.
 */
function pointOf(observation: Pick<Observation, "commit" | "seed">): string {
  return observation.seed === undefined
    ? observation.commit
    : `${observation.commit}#${observation.seed}`;
}

/**
 * The run an observation belongs to, as the rule about crowds counts
 * one: what one source saw at one point (see `pointOf`), and for a
 * workstation, at one start. A workstation runs its uncommitted changes
 * on top of the commit it names, so two of its runs at one commit ran
 * two different trees. A continuous-integration run is held together by
 * its point and source alone, so its lanes, and a rerun of some of them,
 * count as one run.
 */
function runOf(observation: Observation): string {
  const run = `${pointOf(observation)} ${observation.source}`;
  return observation.place === "local"
    ? `${run} ${observation.startedAt}`
    : run;
}

/**
 * The cross-batch context two of the rules need. A batch cannot be judged
 * on its own: whether an identity disagreed with itself at a commit, and
 * whether a failure spans enough sources to read as the environment, are
 * both questions about observations that may sit in another batch. A
 * caller folding a stream carries one of these along and trims it.
 */
export interface FoldContext {
  /**
   * The outcomes seen at one commit in one order, by identity, with the
   * commit's day. Keyed by that point (see `pointOf`) rather than by the
   * pair of point and identity so that the window below can drop a whole
   * point at once, and so that a point's name is stored once instead of
   * against every identity that ran at it.
   */
  outcomesAtCommit: Map<
    string,
    { day: string; identities: Map<string, Set<string>> }
  >;

  /**
   * The most recently seen points (see `pointOf`), oldest first, at most
   * `FLAKE_COMMIT_REACH` of them. Outcomes are remembered at a point
   * while it is in here, and afterwards only for identities the failure
   * witness still names. A commit run in one order is one point, which is
   * every commit that runs without an override.
   */
  recentCommits: string[];

  /**
   * What the default branch said about one identity at one point (see
   * `pointOf`), with the day. A rerun of a commit can arrive long after the run it
   * repeats, so this outlives the batch: without it, a later pass
   * elsewhere would make that rerun look like the first failure at a
   * commit the branch had already shown broken.
   */
  mainAtCommit: Map<string, { day: string; outcome: "pass" | "fail" }>;

  /**
   * The commit and source pairs a catch has already been credited to,
   * against the day it was credited on, so the set can be aged like
   * everything else here rather than growing with every catch ever made.
   */
  credited: Map<string, string>;

  /** Where and when each identity has been seen failing. */
  failures: Map<string, Array<{ day: string; source: string }>>;

  /**
   * The identities each run (see `runOf`) newly broke, with the run's
   * day. A run's objects can arrive in more than one batch, so this
   * outlives the batch and ages with the outcomes at a commit.
   */
  crowds: Map<string, { day: string; identities: Set<string> }>;
}

/** A context holding nothing, for a fold with no history behind it. */
export function emptyContext(): FoldContext {
  return {
    outcomesAtCommit: new Map(),
    recentCommits: [],
    mainAtCommit: new Map(),
    credited: new Map(),
    failures: new Map(),
    crowds: new Map(),
  };
}

/** A fold context as it travels between runs. */
export interface StoredFoldContext {
  outcomesAtCommit: Array<
    [string, { day: string; identities: Array<[string, string[]]> }]
  >;
  recentCommits: string[];
  mainAtCommit: Array<[string, { day: string; outcome: "pass" | "fail" }]>;
  credited: Array<[string, string]>;
  failures: Array<[string, Array<{ day: string; source: string }>]>;
  crowds?: Array<[string, { day: string; identities: string[] }]>;
}

/** The outcomes a record may carry, for validating a stored context. */
const OUTCOMES = new Set(["pass", "fail", "skip"]);

/**
 * Whether a value is a "yyyy-mm-dd" day this reader can measure from.
 * The parse alone is not enough: a date the calendar does not have rolls
 * into the next month, so "2026-02-31" parses as March 3rd and would be
 * aged from three days later than it claims. What round-trips is a day.
 */
function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(at.getTime()) &&
    at.toISOString().slice(0, 10) === value;
}

/** The context, flattened for the aggregate that carries it. */
export function serializeContext(context: FoldContext): StoredFoldContext {
  return {
    outcomesAtCommit: [...context.outcomesAtCommit].map(([commit, seen]) => [
      commit,
      {
        day: seen.day,
        identities: [...seen.identities].map((
          [key, outcomes],
        ) => [key, [...outcomes]] as [string, string[]]),
      },
    ]),
    recentCommits: [...context.recentCommits],
    mainAtCommit: [...context.mainAtCommit],
    credited: [...context.credited],
    failures: [...context.failures],
    crowds: [...context.crowds].map(([run, crowd]) => [
      run,
      { day: crowd.day, identities: [...crowd.identities] },
    ]),
  };
}

/**
 * The context a previous run left. Anything malformed yields an empty
 * one: a context is an optimization over re-reading, and losing it costs
 * the two cross-run rules their reach rather than any stored fact.
 */
export function parseContext(value: unknown): FoldContext {
  const context = emptyContext();
  if (!isObjectOrArray(value)) return context;
  const stored = value as Partial<StoredFoldContext>;
  const pairs = (raw: unknown): Array<[string, unknown]> =>
    Array.isArray(raw)
      ? raw.filter((entry): entry is [string, unknown] =>
        Array.isArray(entry) && typeof entry[0] === "string"
      )
      : [];

  for (const [commit, seen] of pairs(stored.outcomesAtCommit)) {
    if (!isObjectOrArray(seen)) continue;
    const held = seen as { day?: unknown; identities?: unknown };
    if (!isDay(held.day)) continue;
    const identities = new Map<string, Set<string>>();
    for (const [key, raw] of pairs(held.identities)) {
      if (!Array.isArray(raw)) continue;
      // An outcome this reader does not know would read as one more
      // thing the identity did at that commit, and two of them is the
      // test disagreeing with itself — which suppresses a real catch.
      const outcomes = raw.filter((outcome): outcome is string =>
        typeof outcome === "string" && OUTCOMES.has(outcome)
      );
      if (outcomes.length > 0) identities.set(key, new Set(outcomes));
    }
    if (identities.size === 0) continue;
    context.outcomesAtCommit.set(commit, { day: held.day, identities });
  }
  if (Array.isArray(stored.recentCommits)) {
    context.recentCommits = stored.recentCommits
      .filter((commit): commit is string => typeof commit === "string")
      .slice(-FLAKE_COMMIT_REACH);
  }
  for (const [at, seen] of pairs(stored.mainAtCommit)) {
    if (!isObjectOrArray(seen)) continue;
    const held = seen as { day?: unknown; outcome?: unknown };
    if (!isDay(held.day)) continue;
    if (held.outcome !== "pass" && held.outcome !== "fail") continue;
    context.mainAtCommit.set(at, { day: held.day, outcome: held.outcome });
  }
  for (const [attribution, day] of pairs(stored.credited)) {
    // A day that cannot be read cannot be aged, and an entry that is
    // never aged suppresses that catch for good.
    if (isDay(day)) context.credited.set(attribution, day);
  }
  for (const [key, seen] of pairs(stored.failures)) {
    if (!Array.isArray(seen)) continue;
    const kept = seen.filter((failure): failure is {
      day: string;
      source: string;
    } =>
      isObjectOrArray(failure) &&
      isDay((failure as { day?: unknown }).day) &&
      typeof (failure as { source?: unknown }).source === "string"
    );
    if (kept.length > 0) context.failures.set(key, kept);
  }
  for (const [run, crowd] of pairs(stored.crowds)) {
    if (!isObjectOrArray(crowd)) continue;
    const held = crowd as { day?: unknown; identities?: unknown };
    if (!isDay(held.day) || !Array.isArray(held.identities)) continue;
    const identities = held.identities.filter((key): key is string =>
      typeof key === "string"
    );
    context.crowds.set(run, { day: held.day, identities: new Set(identities) });
  }
  return context;
}

/**
 * Drops what the rules can no longer reach, each on the span its own
 * question needs. A stream that never trimmed would grow with the number
 * of runs rather than with the number of tests.
 */
export function trimContext(context: FoldContext, today: string): void {
  const beyondBreadth = (day: string) =>
    daysBetween(day, today) > CATCH_BREADTH_WINDOW_DAYS;
  for (const [key, seen] of context.failures) {
    const kept = seen.filter((failure) => !beyondBreadth(failure.day));
    if (kept.length === 0) context.failures.delete(key);
    else context.failures.set(key, kept);
  }
  for (const [commit, seen] of context.outcomesAtCommit) {
    if (daysBetween(seen.day, today) > SAME_COMMIT_REACH_DAYS) {
      context.outcomesAtCommit.delete(commit);
    }
  }
  for (const [run, crowd] of context.crowds) {
    if (daysBetween(crowd.day, today) > SAME_COMMIT_REACH_DAYS) {
      context.crowds.delete(run);
    }
  }
  context.recentCommits = context.recentCommits.filter((commit) =>
    context.outcomesAtCommit.has(commit)
  );
  // A commit is re-run within days of the run it repeats, not months, so
  // these age on the same window. Kept forever they would grow with the
  // number of catches the repository has ever made.
  const old = (day: string) => daysBetween(day, today) > COMMIT_REACH_DAYS;
  for (const [at, seen] of context.mainAtCommit) {
    if (old(seen.day)) context.mainAtCommit.delete(at);
  }
  for (const [attribution, day] of context.credited) {
    if (old(day)) context.credited.delete(attribution);
  }
}

/** What a fold may be told beyond the observations themselves. */
export interface FoldOptions {
  /** The state each identity's history had reached before this batch. */
  prior?: Map<string, IdentityState>;

  /** What earlier batches of the same stream saw. */
  context?: FoldContext;
}

/**
 * Folds a batch of observations into per-identity state.
 *
 * The observations must be in ascending time order, because the rules
 * that decide whether a failure is a catch look backwards at what `main`
 * last said and forwards at what it says next. Observations at one commit
 * in one order are considered together: an identity that both passed and
 * failed there disagreed with itself, which is a flake observation and
 * never a catch.
 *
 * Both of those need the whole batch in view before any one observation is
 * judged, so this walks the batch more than once and the iterable has to
 * replay it each time. A one-shot iterator would leave every pass after
 * the first with nothing to read and score the batch as though most of it
 * had never run, so one is refused rather than folded.
 *
 * Returns the state each identity was folded into, which is the map
 * `options.prior` names when a caller carries one across batches.
 */
export function foldObservations(
  observations: Iterable<Observation>,
  options: FoldOptions = {},
): Map<string, IdentityState> {
  // An iterator is its own iterable, which is what tells the two apart.
  if (Object.is(observations[Symbol.iterator](), observations)) {
    throw new Error(
      "foldObservations needs an iterable that replays, not an iterator.",
    );
  }
  const states = options.prior ?? new Map<string, IdentityState>();
  const context = options.context ?? emptyContext();
  const stateOf = (key: string): IdentityState => {
    let state = states.get(key);
    if (state === undefined) {
      state = emptyState();
      states.set(key, state);
    }
    return state;
  };

  // Same-commit disagreement, and the sources a failing identity appeared
  // on inside the environmental window, both need the whole batch in view
  // before any one observation can be judged.
  const outcomesAtCommit = context.outcomesAtCommit;
  const failures = context.failures;
  const recent = context.recentCommits;

  // The failure witness first, so that the pass below can tell a test that
  // has failed from one that never has. What the default branch said at
  // each commit is gathered alongside it: only the classification pass
  // reads that, and it depends on nothing gathered here, so it rides along
  // rather than walking the batch again. Gathering it before anything is
  // judged is what stops a failure elsewhere at one commit being weighed
  // against whatever `main` happened to say last in this batch.
  const mainAtCommit = new Map<string, "pass" | "fail" | "skip">();
  for (const observation of observations) {
    const key = testIdentityKey(observation.test);
    if (observation.outcome === "fail") {
      const list = failures.get(key) ?? [];
      list.push({ day: observation.day, source: observation.source });
      failures.set(key, list);
    }
    if (observation.place !== "main" || observation.outcome === "skip") {
      continue;
    }
    const at = `${key} ${pointOf(observation)}`;
    // A failure anywhere at one commit in one order is the commit being
    // broken; a pass beside it does not clear that.
    if (observation.outcome === "fail" || !mainAtCommit.has(at)) {
      mainAtCommit.set(at, observation.outcome);
    }
  }

  // Already broken on the default branch, so a run elsewhere learned
  // nothing about the change in front of it. What that branch says at
  // this very commit outranks what it last said, and is known ahead of
  // time so that the order this batch happened to arrive in cannot decide
  // the verdict.
  const brokenOnMain = (
    key: string,
    observation: Observation,
    lastMain: IdentityState["lastMainOutcome"],
  ): boolean => {
    const here = mainAtCommit.get(`${key} ${pointOf(observation)}`);
    return here === "fail" || (here === undefined && lastMain === "fail");
  };

  // Outcomes at a commit, for as long as they can still be asked about.
  // Every identity runs at nearly every commit, so keeping all of them
  // costs the corpus times the commits: one measured day is 2.6 million
  // pairs and 442MB, which is more than a string can hold. A commit is
  // remembered whole while it is one of the last `FLAKE_COMMIT_REACH`
  // seen, and once it slides out it keeps only the identities the
  // failure witness names — so a test that has failed is exact until the
  // commit ages out at `SAME_COMMIT_REACH_DAYS`, and one that never has
  // is remembered only as long as its rerun could plausibly still
  // arrive.
  //
  // What each run newly broke rides along: on the default branch, an
  // identity whose previous run there did not fail; anywhere else, one
  // the default branch was not already failing. Whether another rule sets a
  // failure aside needs the whole batch, so `crowded` asks that later.
  const crowds = context.crowds;
  const lastMainOf = new Map<string, "pass" | "fail">();
  for (const observation of observations) {
    // A skip is a test that deliberately did not run, so it agrees with
    // nothing and contradicts nothing; counting it as disagreement would
    // read a skip beside a failure as the test disagreeing with itself.
    if (observation.outcome === "skip") continue;
    const key = testIdentityKey(observation.test);
    const lastMain = lastMainOf.has(key)
      ? lastMainOf.get(key)
      : states.get(key)?.lastMainOutcome;
    if (observation.place === "main") {
      lastMainOf.set(key, observation.outcome);
    }
    if (
      observation.outcome === "fail" &&
      !(observation.place === "main"
        ? lastMain === "fail"
        : brokenOnMain(key, observation, lastMain))
    ) {
      const run = runOf(observation);
      let crowd = crowds.get(run);
      if (crowd === undefined) {
        crowd = { day: observation.day, identities: new Set() };
        crowds.set(run, crowd);
      }
      crowd.identities.add(key);
    }
    const point = pointOf(observation);
    let seen = outcomesAtCommit.get(point);
    if (seen === undefined) {
      seen = { day: observation.day, identities: new Map() };
      outcomesAtCommit.set(point, seen);
      recent.push(point);
      while (recent.length > FLAKE_COMMIT_REACH) {
        const dropped = recent.shift()!;
        const held = outcomesAtCommit.get(dropped);
        if (held === undefined) continue;
        for (const identity of [...held.identities.keys()]) {
          if (!failures.has(identity)) held.identities.delete(identity);
        }
        if (held.identities.size === 0) outcomesAtCommit.delete(dropped);
      }
    }
    if (!recent.includes(point) && !failures.has(key)) continue;
    const outcomes = seen.identities.get(key) ?? new Set<string>();
    outcomes.add(observation.outcome);
    seen.identities.set(key, outcomes);
  }

  // It passed and failed at one commit in one order, with nothing between
  // the two runs but chance.
  const disagreed = (key: string, observation: Observation): boolean =>
    (outcomesAtCommit.get(pointOf(observation))?.identities.get(key)?.size ??
      0) > 1;

  const environmental = (key: string, day: string, source: string): boolean => {
    const nearby = new Set<string>([source]);
    for (const failure of failures.get(key) ?? []) {
      if (Math.abs(daysBetween(failure.day, day)) > CATCH_BREADTH_WINDOW_DAYS) {
        continue;
      }
      nearby.add(failure.source);
    }
    return nearby.size >= ENVIRONMENTAL_MIN_SOURCES;
  };

  // A breakage a crowd of tests sees is found by whichever of them a
  // change runs, so it says nothing about any one of them. The crowd is
  // what one run newly broke and no other rule sets aside, counted once
  // per run and batch.
  const crowdSizes = new Map<string, number>();
  const crowded = (observation: Observation): boolean => {
    const run = runOf(observation);
    let size = crowdSizes.get(run);
    if (size === undefined) {
      size = 0;
      for (const key of crowds.get(run)?.identities ?? []) {
        if (
          !disagreed(key, observation) &&
          !environmental(key, observation.day, observation.source)
        ) {
          size++;
        }
      }
      crowdSizes.set(run, size);
    }
    return size >= MASS_FAILURE_MIN_IDENTITIES;
  };

  // A catch is attributed to the pair of the commit and the source that
  // saw it, so re-running one broken commit ten times counts once.
  const credited = context.credited;

  for (const observation of observations) {
    const key = testIdentityKey(observation.test);
    const state = stateOf(key);
    const day = observation.day;

    // A skip is a test that deliberately did not run. It says nothing
    // about the test and nothing about the change, so it does not reach
    // `lastMainOutcome` either: a test skipped on the default branch has
    // not been shown to be fixed, and the last run that did execute it is
    // the last thing known about it. A failure elsewhere therefore goes
    // on being read as the default branch's, and is not credited to the
    // change in front of it.
    if (observation.outcome === "skip") continue;

    bump(state.runsByDay, day);
    const lastMain = state.lastMainOutcome;
    if (observation.place === "main") {
      resolvePendingMain(state, observation);
      state.lastMainOutcome = observation.outcome;
    }
    if (observation.outcome === "pass") continue;

    bump(state.failuresByDay, day);

    if (disagreed(key, observation)) {
      bump(state.flakesByDay, day);
      continue;
    }
    if (environmental(key, day, observation.source)) continue;
    if (observation.place === "main") {
      // Whether this was a catch depends on what the next `main` run
      // says, so it waits. A failure continuing a breakage already
      // waiting is part of that breakage, crowd and all.
      const waiting = state.pendingMain;
      const inCrowd = waiting.length > 0
        ? waiting.some((pending) => pending.crowded === true)
        : crowded(observation);
      waiting.push({
        day,
        commit: observation.commit,
        ...(observation.seed === undefined ? {} : { seed: observation.seed }),
        source: observation.source,
        ...(inCrowd ? { crowded: true as const } : {}),
      });
      continue;
    }
    if (brokenOnMain(key, observation, lastMain) || crowded(observation)) {
      continue;
    }
    const attribution = `${key} ${observation.commit} ${observation.source}`;
    if (credited.has(attribution)) continue;
    credited.set(attribution, day);
    creditCatch(state, observation.place, day, observation.source);
  }

  return states;
}

/**
 * How finely a day's durations are counted: this many buckets to each
 * doubling of a duration. A bucket is read as the largest duration it
 * counts, so a percentile read from buckets is at most one bucket's
 * width, about 2.2%, above the exact one, and never below it.
 */
export const COST_BUCKETS_PER_DOUBLING = 32;

/**
 * The passing executions of one identity on one day, counted by bucket.
 * Counts add, so any number of days, and any parts of one day, combine
 * into exactly the counts one accumulation of all of them would give.
 */
export interface DaySamples {
  /** The bucket `counts[0]` counts. */
  lowest: number;

  /** How many executions each bucket from `lowest` upward counts. */
  counts: number[];

  /**
   * Which set of cost rules measured them, on a day a state holds. A
   * batch on its way into one carries none, since the day it is sealed
   * into is what records the set that sealed it.
   */
  rule?: number;
}

/**
 * Which set of cost rules a day a state holds was sealed under: which
 * executions reach a day's sample. Change it to any other value in the
 * same change that alters that. A change to how a day's sample is stored
 * leaves it alone and reads the days stored before it forward instead,
 * as `readCostsForward()` does. The values are not ordered and nothing
 * but equality is asked of them; a day carrying none was sealed before
 * the stamps began, under the first set.
 */
export const COST_RULE = 3;

/** The largest duration a bucket counts, in milliseconds. */
function bucketBound(bucket: number): number {
  return 2 ** (bucket / COST_BUCKETS_PER_DOUBLING);
}

/**
 * The bucket a duration is counted in: the lowest whose bound is at
 * least the duration. Everything up to a millisecond is counted in
 * bucket zero.
 */
function bucketOf(durationMs: number): number {
  if (!(durationMs > 1)) return 0;
  const bucket = Math.ceil(Math.log2(durationMs) * COST_BUCKETS_PER_DOUBLING);
  // The logarithm can round a duration just past a bound down onto it.
  return bucketBound(bucket) < durationMs ? bucket + 1 : bucket;
}

/** A fresh, empty sample. */
export function emptySamples(): DaySamples {
  return { lowest: 0, counts: [] };
}

/** Adds `count` executions to one bucket of a sample. */
function countInto(samples: DaySamples, bucket: number, count: number): void {
  if (count === 0) return;
  if (samples.counts.length === 0) samples.lowest = bucket;
  if (bucket < samples.lowest) {
    const gap = new Array<number>(samples.lowest - bucket).fill(0);
    samples.counts = [...gap, ...samples.counts];
    samples.lowest = bucket;
  }
  const at = bucket - samples.lowest;
  while (samples.counts.length <= at) samples.counts.push(0);
  samples.counts[at]! += count;
}

/** Counts one duration into a day's sample. */
export function sampleDuration(samples: DaySamples, durationMs: number): void {
  countInto(samples, bucketOf(durationMs), 1);
}

/**
 * The ninetieth percentile of a list of values in ascending order, by
 * nearest rank: the value at that rank rather than one between two.
 */
export function percentile90(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(0.9 * sorted.length) - 1]!;
}

/**
 * The ninetieth percentile of the executions a sample counts, by nearest
 * rank, read as the bound of the bucket that rank falls in.
 */
export function sampledPercentile90(samples: DaySamples): number {
  const count = samples.counts.reduce((sum, each) => sum + each, 0);
  if (count === 0) return 0;
  const rank = Math.ceil(0.9 * count);
  let seen = 0;
  const at = samples.counts.findIndex((each) => (seen += each) >= rank);
  return bucketBound(samples.lowest + at);
}

/** One list of a day's durations, as the day's sample of them. */
export function samplesOf(durationsMs: readonly number[]): DaySamples {
  const samples = emptySamples();
  for (const durationMs of durationsMs) sampleDuration(samples, durationMs);
  return samples;
}

/** Two samples read as one: the counts of both, bucket by bucket. */
export function mergeSamples(a: DaySamples, b: DaySamples): DaySamples {
  const merged = emptySamples();
  for (const part of [a, b]) {
    for (const [at, count] of part.counts.entries()) {
      countInto(merged, part.lowest + at, count);
    }
  }
  return merged;
}

/**
 * Folds a batch of one day's durations into that day's sample.
 *
 * A day is read across as many runs as it takes for its objects to
 * arrive, so this is given part of a day at a time and combines rather
 * than replaces. Combining the samples rather than a figure taken from
 * them is what makes the cost a percentile of every execution it covers:
 * a batch carrying one execution contributes one duration, where a
 * percentile of that batch would be that one duration standing for every
 * execution the day holds.
 */
export function sealDay(
  state: IdentityState,
  day: string,
  batch: DaySamples,
): void {
  if (batch.counts.length === 0) return;
  // A day another set of rules sealed answers only until these rules
  // have sealed one, and this is that sealing, so the rest of what that
  // set left goes here. What is left afterwards is one set's days.
  for (const [sealed, samples] of Object.entries(state.costByDay)) {
    if (samples.rule !== COST_RULE) delete state.costByDay[sealed];
  }
  // The only writer of a day's sample, so what is already there is
  // another sealing of the same day from an earlier run and can be
  // combined with this one. Nothing writes a provisional value alongside
  // it, whose counts would then be added to counts that already include
  // it.
  state.costByDay[day] = {
    ...mergeSamples(state.costByDay[day] ?? emptySamples(), batch),
    rule: COST_RULE,
  };
}

/**
 * A day as it was stored before it was counted by bucket: its slowest
 * durations, or its percentile alone, and how many executions it held.
 * It has no `counts`, which is what tells it from a day counted by
 * bucket.
 */
type StoredSlowest =
  | { slowest: number[]; count: number; rule?: number; counts?: undefined }
  | { p90: number; count: number; rule?: number; counts?: undefined };

/**
 * Reads a state's stored days forward. A day stored as its slowest
 * durations and a count is read as those durations, with each execution
 * that was not kept counted at the smallest that was. A day stored as a
 * percentile and a count is read the same way, as one kept duration.
 * Either reading is at or above the executions it stands for, so a
 * percentile read from it errs high, and the whole day's count stays in
 * it: one execution standing for the day would be outweighed by the
 * first part to arrive after it, which is how a day of slow runs would
 * come to report a fast one. The day keeps the stamp of the rules that
 * sealed it, since those decided which executions it holds, and how they
 * were stored did not.
 */
export function readCostsForward(state: IdentityState): void {
  const held = state.costByDay;
  const days = isObjectNotArray(held) ? held : {};
  state.costByDay = days;
  // A stored day is one shape or another, which the state's own declared
  // type cannot say.
  const read: Record<string, DaySamples | StoredSlowest> = days;
  for (const [day, held] of Object.entries(read)) {
    // A day that is not a record of figures at all is read as a day
    // with nothing in it, which is what a day this cannot make sense of
    // is worth. Ending the read of the whole state is not, and a state
    // is read back through this before anything has looked at what it
    // holds.
    if (!isObjectOrArray(held)) {
      days[day] = emptySamples();
      continue;
    }
    if (held.counts === undefined) days[day] = readSlowest(held);
    else if (!isCounted(held)) days[day] = emptySamples();
  }
}

/**
 * Whether a day stored by bucket holds figures this can count with: a
 * bucket index and a count per bucket, each a whole number and none
 * negative. A day that does not is read as a day with nothing in it,
 * for the reason a day that is not a record is.
 */
function isCounted(held: DaySamples): boolean {
  const whole = (value: number) => Number.isInteger(value) && value >= 0;
  return whole(held.lowest) && Array.isArray(held.counts) &&
    held.counts.every(whole);
}

/**
 * One day as earlier rules stored it, as these rules count it. A day
 * whose stored figures are not numbers is read as a day with nothing in
 * it, for the reason a day that is not a record is.
 */
function readSlowest(held: StoredSlowest): DaySamples {
  const kept = "slowest" in held ? held.slowest : [held.p90];
  if (
    !Array.isArray(kept) || kept.length === 0 ||
    !kept.every(Number.isFinite) || !Number.isInteger(held.count) ||
    held.count < kept.length
  ) {
    return emptySamples();
  }
  const samples = samplesOf(kept);
  countInto(
    samples,
    bucketOf(minOf(kept)),
    held.count - kept.length,
  );
  if (held.rule !== undefined) samples.rule = held.rule;
  return samples;
}

/** Ages a state's per-day counters, dropping days past their windows. */
export function trimWindows(state: IdentityState, today: string): void {
  const drop = (counts: Record<string, unknown>, windowDays: number): void => {
    for (const day of Object.keys(counts)) {
      if (daysBetween(day, today) > windowDays) delete counts[day];
    }
  };
  // The run counts answer three questions with two windows: the churn
  // term's denominator, the flake rate's, and how recently `lastRun` saw
  // the test. They are kept for the longer of the two windows, and each
  // reader reads back only as far as its own.
  drop(state.runsByDay, LONGEST_WINDOW_DAYS);
  drop(state.failuresByDay, CHURN_WINDOW_DAYS);
  drop(state.flakesByDay, FLAKE_WINDOW_DAYS);
  drop(state.costByDay, COST_WINDOW_DAYS);
  // A failure on the default branch waits here for a later run to judge
  // it, and a test the branch does not go red for is one no run has to
  // arrive for. So this is aged like everything else, over the longest
  // window a state keeps: a failure nothing has judged in that time is
  // one the branch has carried for that long, and crediting a catch for
  // it afterwards would credit the test with a fix it did not find.
  state.pendingMain = state.pendingMain.filter((pending) =>
    daysBetween(pending.day, today) <= LONGEST_WINDOW_DAYS
  );
}

/**
 * A share of a test's runs over the days inside `windowDays`, each day's
 * counts weighed by `weigh` against how old the day is and how many runs
 * have followed it.
 *
 * Decayed rather than summed flat, because a sum cannot tell two
 * histories apart that a reader would never confuse. A test that
 * disagreed twice and then passed two hundred times has settled; one
 * that passed two hundred times and then disagreed twice has just
 * started. The same counts, and not the same test.
 *
 * Read over a window as well, so what is measured stays bounded. Past
 * four half-lives a day is worth under one part in sixteen, which makes
 * the window a performance choice rather than a policy one.
 */
function decayedShare(
  counted: Record<string, number>,
  state: IdentityState,
  today: string,
  windowDays: number,
  weigh: (ageDays: number, runsSince: number) => number,
): number {
  // Newest day first, so the runs a day has been followed by are known
  // by the time that day is weighed. A day's own runs are weighed
  // together, as though all of them happened at the end of it, which is
  // as fine a grain as counters kept per day can answer at.
  const days = Object.keys(state.runsByDay).sort().reverse();
  let runsSince = 0;
  let top = 0;
  let runs = 0;
  for (const day of days) {
    const age = daysBetween(day, today);
    if (age > windowDays) continue;
    const count = state.runsByDay[day] ?? 0;
    const weight = weigh(age, runsSince);
    runs += count * weight;
    top += (counted[day] ?? 0) * weight;
    runsSince += count;
  }
  return runs === 0 ? 0 : top / runs;
}

/**
 * The churn term: recent failures over recent runs. A ratio over a long
 * undecayed window measures total historical brokenness rather than the
 * current rate, and a week of failures eight months ago would otherwise
 * outrank a test that is failing right now.
 */
export function churn(state: IdentityState, today: string): number {
  return decayedShare(
    state.failuresByDay,
    state,
    today,
    CHURN_WINDOW_DAYS,
    (age) => 0.5 ** (age / CHURN_HALF_LIFE_DAYS),
  );
}

/**
 * The share of a test's runs it was seen disagreeing with itself over.
 *
 * Runs rather than failures in the denominator, because what the rate
 * decides is whether running this test once fails somebody's change for
 * something its author cannot act on, and that is a chance per run. The
 * two differ by everything a test's passes say: a test that failed once
 * in ten thousand runs, and passed on the rerun, has every one of its
 * failures a flake, and a share of failures would read it as wholly
 * unreliable. Counting runs is also what lets an exclusion reverse, since
 * a run that does not disagree lowers the share.
 *
 * A disagreement's weight halves every `FLAKE_HALF_LIFE_RUNS` runs that
 * follow it, so a test that has settled since is not judged as though it
 * had just started. Runs rather than days, because what shows a test has
 * settled is running without disagreeing. A test that has not run has
 * shown nothing, and time alone should not clear it.
 *
 * A lower bound on how often the test fails on its own, because the only
 * spurious failure this can count is one with a pass beside it at the
 * same commit. What raises the bound is repeats, which put several
 * executions at one commit, and which a rising share is what buys.
 *
 * Nothing is charged against the count, and no belief about how tests
 * usually behave survives into it. A disagreement is not a sample from
 * an unknown rate the way a failure is; it is a proof, since a test that
 * is deterministic cannot pass and fail at one commit. Shrinking the
 * share toward zero would be shrinking it toward what the observation
 * has already ruled out. So a test seen twice that disagreed once reads
 * a half, and one that disagreed once in ten thousand runs reads a
 * ten-thousandth: what separates them is how much each has been run, not
 * how much either is believed.
 */
export function flakeRate(state: IdentityState, today: string): number {
  return decayedShare(
    state.flakesByDay,
    state,
    today,
    FLAKE_WINDOW_DAYS,
    (_age, runsSince) => 0.5 ** (runsSince / FLAKE_HALF_LIFE_RUNS),
  );
}

/**
 * What a person is shown beside the share: the disagreements inside the
 * flake window and the runs they were seen among, counted flat. A share
 * cannot be weighed without them, and they are not what the share
 * divides — the share weights recent days more heavily, so a test with
 * these counts reads higher when the disagreements are the recent part
 * of them.
 */
export function flakeCounts(
  state: IdentityState,
  today: string,
): FlakeEvidence {
  let flakes = 0;
  for (const [day, count] of Object.entries(state.flakesByDay)) {
    if (daysBetween(day, today) > FLAKE_WINDOW_DAYS) continue;
    flakes += count;
  }
  let runs = 0;
  for (const [day, count] of Object.entries(state.runsByDay)) {
    if (daysBetween(day, today) > FLAKE_WINDOW_DAYS) continue;
    runs += count;
  }
  return { flakes, runs };
}

/**
 * What one execution of this identity costs, in seconds: the ninetieth
 * percentile of every passing execution inside the cost window, taken
 * together. Each execution counts once, however the days fall, so a slow
 * day raises the cost by as much of the window as it holds rather than
 * setting the cost alone. The ninetieth percentile rather than the mean,
 * because a cost model that under-estimates blows the time budget.
 */
export function costSeconds(state: IdentityState, today: string): number {
  let window = emptySamples();
  for (const [day, samples] of Object.entries(state.costByDay)) {
    if (daysBetween(day, today) > COST_WINDOW_DAYS) continue;
    window = mergeSamples(window, samples);
  }
  return sampledPercentile90(window) / 1000;
}

export type { FlakeEvidence, ScoreInputs };

/** The score's inputs for one identity, as of a given day. */
export function scoreInputs(
  state: IdentityState,
  today: string,
): ScoreInputs {
  const inputs: ScoreInputs = {
    catches: CATCH_WEIGHT_LOCAL * state.localCatches +
      CATCH_WEIGHT_PR * state.prCatches +
      CATCH_WEIGHT_MAIN * state.mainCatches,
    sources: state.sources.length,
    churn: churn(state, today),
  };
  if (state.lastCatch !== undefined) inputs.lastCatch = state.lastCatch;
  return inputs;
}

/**
 * What a test is worth running.
 *
 * The no-catch branch is not decoration. A test with no catches has no
 * `lastCatch`, so the age of its most recent one does not exist, and
 * multiplying zero by a missing number yields a missing number rather
 * than zero. A missing score sorts unpredictably against real ones, so
 * the branch is written rather than left to the algebra.
 */
export function value(inputs: ScoreInputs, today: string): number {
  let record = 0;
  if (inputs.catches > 0 && inputs.lastCatch !== undefined) {
    const proven = 1 - 0.5 ** (inputs.catches / PROVEN_SATURATION);
    const age = daysBetween(inputs.lastCatch, today);
    const freshness = FRESHNESS_FLOOR +
      (1 - FRESHNESS_FLOOR) * 0.5 ** (age / FRESHNESS_HALF_LIFE_DAYS);
    record = proven * freshness;
  }
  const breadth = 1 - 0.5 ** (inputs.sources / BREADTH_SATURATION);
  return VALUE_FLOOR + WEIGHT_PROVEN * record + WEIGHT_BREADTH * breadth +
    WEIGHT_CHURN * inputs.churn;
}
