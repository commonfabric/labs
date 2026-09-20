/**
 * Every number test selection can be tuned by, and nothing else holds any
 * of them. `deno task test-selection dials` prints these with their
 * comments, and every manifest records the values it was built with, so a
 * manifest explains its own behavior and a change in what runs can always
 * be traced to a change here.
 *
 * A **chosen** dial is a decision somebody made, and editing it is how the
 * decision changes. A **measured** dial is worked out from the data and
 * written back by the publisher, so the value here is only the seed used
 * before there is anything to measure. A **derived** dial is computed from
 * other dials, and editing it means editing those. The three look
 * identical in a source file, which is why `DIALS` says which each one is:
 * somebody who tunes a measured value is arguing with a tape measure.
 */

/** How many jobs a pull request's tests are packed into. */
export const LANES = 5;

/**
 * The hard bound on a lane's work step. A lane job's own timeouts have to
 * be set against this, and no lane job exists yet to carry them.
 */
export const LANE_BOUND_SECONDS = 300;

/** Checkout, Deno, cache restore, ship, and job overhead. */
export const LANE_PROLOGUE_SECONDS = 40;

/** Headroom for a slower-than-usual runner. */
export const LANE_SAFETY_SECONDS = 30;

/**
 * What the packer may fill, derived rather than chosen so that the bound,
 * the prologue, and the safety margin cannot drift into a budget that
 * does not fit inside its own bound.
 */
export const LANE_BUDGET_SECONDS = LANE_BOUND_SECONDS -
  LANE_PROLOGUE_SECONDS - LANE_SAFETY_SECONDS;

/**
 * The hard bound on a lane of the full run on `main`. Ten minutes: `main`
 * makes no promise about a first answer the way a pull request does, so
 * this is chosen for how many jobs the run should take rather than for
 * how long anybody waits.
 */
export const FULL_LANE_BOUND_SECONDS = 600;

/**
 * What the packer may fill in a lane of the full run, derived from that
 * lane's bound exactly as a pull request's is from its own. A lane of
 * either run pays the same prologue and wants the same headroom, because
 * both are the same job doing the same setup on the same runner; what
 * differs between them is only the bound they are held to.
 */
export const FULL_LANE_BUDGET_SECONDS = FULL_LANE_BOUND_SECONDS -
  LANE_PROLOGUE_SECONDS - LANE_SAFETY_SECONDS;

/** The label that runs everything on a pull request. */
export const FULL_RUN_LABEL = "ci: full";

/**
 * What one execution of a test nothing has measured is charged, where the
 * suite it belongs to has no measured unit to take a figure from. Above
 * zero, so that the packer charges work it knows nothing about for some
 * time: free work all fits in the first lane it is offered.
 */
export const UNMEASURED_COST_SECONDS = 1;

/** The score of a test that has never failed anywhere. */
export const VALUE_FLOOR = 0.05;

/** The share of the score a record of catching things carries. */
export const WEIGHT_PROVEN = 0.55;

/** The share of the score distinct reporting sources carry. */
export const WEIGHT_BREADTH = 0.25;

/** The share of the score recent failures carry. */
export const WEIGHT_CHURN = 0.15;

/** Weighted catches at which `proven` reaches half its ceiling. */
export const PROVEN_SATURATION = 2;

/** Days over which a catch loses half the value age can take. */
export const FRESHNESS_HALF_LIFE_DAYS = 120;

/** What a catch keeps however old it gets. */
export const FRESHNESS_FLOOR = 0.3;

/** What a catch on a workstation counts for. */
export const CATCH_WEIGHT_LOCAL = 2.0;

/** What a catch on a pull request counts for; the other two's unit. */
export const CATCH_WEIGHT_PR = 1.0;

/** What a catch on `main` counts for. */
export const CATCH_WEIGHT_MAIN = 1.5;

/** Distinct sources at which `breadth` reaches half its ceiling. */
export const BREADTH_SATURATION = 2;

/**
 * Distinct sources a failure must appear across, inside
 * `CATCH_BREADTH_WINDOW_DAYS`, before it reads as the environment rather
 * than as any one change.
 */
export const ENVIRONMENTAL_MIN_SOURCES = 5;

/** Days over which a day's failure count halves. */
export const CHURN_HALF_LIFE_DAYS = 14;

/** Days of decayed failure counts the churn term reads. */
export const CHURN_WINDOW_DAYS = 60;

/**
 * Runs after a disagreement over which its weight halves. Runs rather
 * than days, because what shows a test has settled is running without
 * disagreeing; a test that has not run has shown nothing.
 */
export const FLAKE_HALF_LIFE_RUNS = 200;

/** Days of flake counts the flake rate reads at all. */
export const FLAKE_WINDOW_DAYS = 60;

/** Days of durations an item's cost estimate reads. */
export const COST_WINDOW_DAYS = 7;

/** The share of the run's budget spent in descending value. */
export const FILL_VALUE_SHARE = 0.60;

/** The share spent in descending value per second. */
export const FILL_DENSITY_SHARE = 0.25;

/** The share spent on items the value ordering did not pick. */
export const FILL_EXPLORATION_SHARE = 0.15;

/**
 * How far apart a suite's batches must have been in the time their own
 * tests took before its fitted slope is believed: the largest figure any
 * of them recorded, less the smallest.
 *
 * A slope says what one more second of test time costs, and it is read
 * far outside the range it was fitted over: a suite whose every batch
 * anybody has seen held six seconds of tests may be charged thousands
 * the first time a lane packs it whole. Inside a narrow range the fixed
 * cost dominates and the slope is noise, so fitting one there and
 * reading it out there is how a lane comes to believe that six thousand
 * seconds of tests are free. A range is narrow wherever it sits, so this
 * is the width of the range rather than where it falls: batches of 229,
 * 230 and 230 seconds say as little about a slope as batches of two,
 * three and four.
 *
 * Below this the slope is one, which is the reading that needs no
 * evidence: a second of test time costs a second.
 */
export const MIN_CORRECTION_SPAN_SECONDS = LANE_BUDGET_SECONDS / 10;

/**
 * Observations a suite needs before its slope is fitted at all.
 *
 * Two points fit a line exactly, so a line through two of them says
 * whatever they say and nothing about their noise. It is low because a
 * slope fitted too high only over-charges, where one fitted too low lets
 * a lane pack work it has no time for: two batches of one suite have
 * fitted a slope of zero, which says a second of its tests costs nothing.
 */
export const MIN_CORRECTION_SAMPLES = 3;

/** The flake rate above which an item leaves the selectable set. */
export const FLAKE_EXCLUSION_RATE = 0.005;

/**
 * What an item that has ever disagreed with itself runs, however rarely
 * it does. One execution cannot tell a pass from a lucky pass, so an
 * item with any flake rate at all is run at least twice.
 */
export const FLAKE_MIN_EXECUTIONS = 2;

/**
 * The flake rate the execution count is anchored at, with
 * `FLAKE_ANCHOR_EXECUTIONS`. Between that point and
 * `FLAKE_MIN_EXECUTIONS` at a rate of nothing, and beyond it, the count
 * is the line through the two.
 */
export const FLAKE_ANCHOR_RATE = 0.01;

/** What an item at `FLAKE_ANCHOR_RATE` runs. */
export const FLAKE_ANCHOR_EXECUTIONS = 5;

/** The most times one item is run inside a lane. */
export const MAX_EXECUTIONS = 10;

/** The suite flake rate above which a suite's new items are repeated. */
export const SUITE_FLAKE_PRIOR_RATE = 0.02;

/** Uncovered lines a change must add before the comment mentions it. */
export const COVERAGE_COMMENT_LINES = 25;

/** Seconds past which a measured set's units are reported as expensive. */
export const LOCAL_COVERAGE_MAX_SECONDS = 30;

/** Measured sets a change may reach and still be gated. */
export const LOCAL_COVERAGE_MAX_SETS = 2;

/**
 * How old a measured set's coverage baseline may be and still be
 * published. A publisher keeps one measured within this many days of the
 * moment it publishes, and drops the rest.
 */
export const LOCAL_COVERAGE_BASELINE_DAYS = 7;

/** Weeks of rising debt before the coverage tile goes amber. */
export const COVERAGE_TREND_WEEKS = 3;

/** Days within which failures across branches read as the environment. */
export const CATCH_BREADTH_WINDOW_DAYS = 2;

/**
 * Days the fold remembers what an identity did at a commit, which is how
 * a rerun that disagrees with the run it repeats is read as the test
 * disagreeing with itself rather than as a catch.
 *
 * Its own dial rather than the breadth window's, because the two ask
 * different questions over different spans. Breadth asks whether many
 * branches saw one test fail around the same time, which is a question
 * about weeks. This asks whether a rerun of one commit could still
 * arrive, which is a question about hours: a commit is superseded long
 * before a day is out, and nothing reruns a three-week-old one.
 *
 * It is also the expensive one. Every identity runs at nearly every
 * commit, so what is remembered is the corpus times the commits: over 21
 * days of the store that is 63.8 million pairs, past what a `Map` can
 * hold at all. Keeping only the identities the failure witness names
 * brings 21 days to 4.2 million, and two days to 40 thousand.
 *
 * A floor rather than an exact span. Aging happens once per batch, after
 * the batch has been judged, so an entry older than this survives until
 * the next batch arrives and can still answer for a rerun that lands
 * late. That is the more accurate answer — a pass and a failure at one
 * commit is the test disagreeing with itself however far apart they
 * arrive — so the lateness is left alone rather than tightened.
 */
export const SAME_COMMIT_REACH_DAYS = 2;

/**
 * How many of the most recently observed commits the fold remembers
 * outcomes at, so that a failure arriving in a later batch than the pass
 * it disagrees with is still read as the test disagreeing with itself.
 *
 * Every identity runs at nearly every commit, so this multiplies by the
 * whole corpus: one measured day of the store holds 2.6 million
 * identity-and-commit pairs, of which 23 carry a failure and 13 carry
 * both a pass and a failure. Remembering all of them costs 442MB for one
 * day, which is more than a string can hold.
 *
 * What slides out of the window keeps the identities the failure witness
 * still names. So a test that has already failed goes on being exact,
 * and stops when `SAME_COMMIT_REACH_DAYS` drops the commit — that span,
 * not the witness's own, is what bounds it.
 */
export const FLAKE_COMMIT_REACH = 8;

/**
 * How alike two test names have to be before one is offered as the
 * other's new name, between zero and one. A rename usually keeps most of
 * a name, and below this the pairing is a guess: a wrong bridge silently
 * credits one test with another's record, and the whole score rests on
 * catch attribution, so there is no downstream check that would notice.
 */
export const RENAME_SIMILARITY = 0.7;

/**
 * How far ahead of the next candidate the best pairing has to be before
 * a rename is offered, in the same units. Test names share a describe
 * chain, so several leaves under one chain are alike; what separates a
 * rename from a deletion beside an unrelated addition is that a rename's
 * new name is clearly closer than anything else that arrived.
 */
export const RENAME_MARGIN = 0.1;

/** The most rename suggestions one comment carries. */
export const RENAME_SUGGESTIONS = 5;

/**
 * Catches a rename may discard before the alias gate fails a pull
 * request. Undefined switches the gate off, which is where it starts:
 * most renames cost nothing, so a gate that fired on every rename would
 * be noise nobody reads.
 */
export const ALIAS_GATE_MIN_CATCHES: number | undefined = undefined;

/**
 * Workspace members that carry no measured set, each with the reason it
 * is here. A list rather than a rule that measures each member and
 * decides, because such a rule can take a member's gate away for a change
 * nobody meant as a change to coverage, and a gate that silently stops
 * gating is worse than no gate.
 */
export const EXCLUDED_FROM_COVERAGE_GATE: ReadonlyMap<string, string> = new Map(
  [
    [
      "packages/generated-patterns",
      "Its test task defines no tests. Its test files run in the " +
      "generated-patterns integration job.",
    ],
    ["packages/home-schemas", "It has no tests."],
    [
      "packages/patterns",
      "Authored pattern code is measured by transformer instrumentation " +
      "in the pattern unit and integration jobs. The package's own " +
      "`deno test` ignores the pattern files deliberately.",
    ],
    [
      "packages/runner",
      "Its whole set is past what all five lanes hold together.",
    ],
    [
      "packages/cli",
      "The command line's real coverage comes from the integration " +
      "script rather than from these tests, so gating on them would " +
      "ratchet the wrong number.",
    ],
    [
      "packages/identity",
      "Every one of its tests runs in a browser through deno-web-test. " +
      "It has no Deno-only half to measure.",
    ],
    [
      "packages/deno-web-test",
      "Its tests drive the browser harness end to end.",
    ],
    [
      "packages/toolshed",
      "Its tests want the service's own environment and its initialized " +
      "database.",
    ],
  ],
);

/** Whether a dial is a decision, a measurement, or computed. */
export type DialSource = "chosen" | "measured" | "derived";

/** One dial, as `deno task test-selection dials` prints it. */
export interface Dial {
  name: string;
  value: number | string | undefined | readonly number[];
  unit: string;
  setBy: DialSource;

  /** Why you would move it, and which way. */
  why: string;
}

/** Returns `dial`'s value as one line of text. */
export function dialValue(dial: Dial): string {
  return Array.isArray(dial.value)
    ? dial.value.join(", ")
    : dial.value === undefined
    ? "off"
    : String(dial.value);
}

/**
 * Every dial, with the unit its value counts and the reason to move it.
 * The units matter because several dials are bare fractions that do not
 * mean the same thing: `WEIGHT_BREADTH` is a share of a test's score and
 * `FILL_DENSITY_SHARE` is a share of the run's budget, and naming the unit
 * is what keeps them from being compared to each other.
 */
export const DIALS: readonly Dial[] = [
  {
    name: "LANES",
    value: LANES,
    unit: "lanes",
    setBy: "chosen",
    why:
      "Up when pull-request feedback is too thin and runner capacity allows " +
      "more; down when the wave crowds other workflows off the shared runners.",
  },
  {
    name: "LANE_BOUND_SECONDS",
    value: LANE_BOUND_SECONDS,
    unit: "seconds",
    setBy: "chosen",
    why:
      "Up when more should fit in a lane; down when five minutes is longer " +
      "than anybody will wait for a first answer. The lane jobs that this " +
      "bounds do not exist yet; when they do, their work-step and job " +
      "timeouts in `deno.yml` have to move with it, and nothing checks " +
      "that until they are written.",
  },
  {
    name: "LANE_PROLOGUE_SECONDS",
    value: LANE_PROLOGUE_SECONDS,
    unit: "seconds",
    setBy: "measured",
    why: "Never. The publisher overwrites it from the lanes' own timing " +
      "records, and the checked-in figure is only what the first lane uses " +
      "before any lane has reported one.",
  },
  {
    name: "LANE_SAFETY_SECONDS",
    value: LANE_SAFETY_SECONDS,
    unit: "seconds",
    setBy: "chosen",
    why: "Up when lanes overrun their bound on slow runners; down when they " +
      "finish early every time and the headroom is buying nothing.",
  },
  {
    name: "LANE_BUDGET_SECONDS",
    value: LANE_BUDGET_SECONDS,
    unit: "seconds",
    setBy: "derived",
    why:
      "Nothing edits this. It is the bound less the prologue and the safety " +
      "margin, so a budget that does not fit inside its own bound cannot be " +
      "written down.",
  },
  {
    name: "FULL_LANE_BOUND_SECONDS",
    value: FULL_LANE_BOUND_SECONDS,
    unit: "seconds",
    setBy: "chosen",
    why: "Up when the run on `main` uses more jobs than it needs; down when " +
      "`main` takes too long to say something broke.",
  },
  {
    name: "FULL_LANE_BUDGET_SECONDS",
    value: FULL_LANE_BUDGET_SECONDS,
    unit: "seconds",
    setBy: "derived",
    why: "Nothing edits this. It is the full run's bound less the same " +
      "prologue and safety margin a pull request's lane pays, since a lane " +
      "of either run is the same job doing the same setup on the same " +
      "runner.",
  },
  {
    name: "FULL_RUN_LABEL",
    value: FULL_RUN_LABEL,
    unit: "a label",
    setBy: "chosen",
    why: "Not a quantity. Change it only if the label collides with one the " +
      "repository already uses for something else.",
  },
  {
    name: "UNMEASURED_COST_SECONDS",
    value: UNMEASURED_COST_SECONDS,
    unit: "seconds",
    setBy: "chosen",
    why: "Up when a lane holding new tests runs long; down when it finishes " +
      "early. It is reached for only by a suite with no measured unit at " +
      "all, since a suite that has any charges an unmeasured one the larger " +
      "of its units' mean and their ninetieth percentile.",
  },
  {
    name: "VALUE_FLOOR",
    value: VALUE_FLOOR,
    unit: "score",
    setBy: "chosen",
    why:
      "Up when the cheap tail is not being swept up; down when it crowds out " +
      "tests with a record of catching things.",
  },
  {
    name: "WEIGHT_PROVEN",
    value: WEIGHT_PROVEN,
    unit: "share of the score",
    setBy: "chosen",
    why:
      "Up when a record of catching things should count for more. The three " +
      "weights are shares of one score, so what this gains the other two lose.",
  },
  {
    name: "WEIGHT_BREADTH",
    value: WEIGHT_BREADTH,
    unit: "share of the score",
    setBy: "chosen",
    why: "Up when a test that several distinct sources have hit should count " +
      "for more; down when breadth is mostly telling you about the " +
      "environment rather than the test.",
  },
  {
    name: "WEIGHT_CHURN",
    value: WEIGHT_CHURN,
    unit: "share of the score",
    setBy: "chosen",
    why:
      "Up when something going wrong right now should jump the queue faster; " +
      "down when the queue keeps being jumped by noise.",
  },
  {
    name: "PROVEN_SATURATION",
    value: PROVEN_SATURATION,
    unit: "catches",
    setBy: "chosen",
    why: "Where the `proven` term reaches half its ceiling. Up when the " +
      "term should go on telling eight catches from four; down when one " +
      "catch should already be worth nearly everything a test can earn.",
  },
  {
    name: "FRESHNESS_HALF_LIFE_DAYS",
    value: FRESHNESS_HALF_LIFE_DAYS,
    unit: "days",
    setBy: "chosen",
    why:
      "Up when old catches should keep more of their value; down when a test " +
      "that caught something a year ago crowds out one that caught something " +
      "last week.",
  },
  {
    name: "FRESHNESS_FLOOR",
    value: FRESHNESS_FLOOR,
    unit: "multiplier",
    setBy: "chosen",
    why:
      "Up when a very old catch should keep more of its worth; down when age " +
      "should be allowed to retire one almost completely.",
  },
  {
    name: "CATCH_WEIGHT_LOCAL",
    value: CATCH_WEIGHT_LOCAL,
    unit: "multiplier",
    setBy: "chosen",
    why: "Up when evidence from a workstation should count for more; down if " +
      "local records ever arrive in volume and stop being the scarce signal " +
      "they are today.",
  },
  {
    name: "CATCH_WEIGHT_PR",
    value: CATCH_WEIGHT_PR,
    unit: "multiplier",
    setBy: "chosen",
    why:
      "Neither. It is the unit the other two are expressed against, so move " +
      "those instead.",
  },
  {
    name: "CATCH_WEIGHT_MAIN",
    value: CATCH_WEIGHT_MAIN,
    unit: "multiplier",
    setBy: "chosen",
    why:
      "Up when an escape should pull harder on what gets selected next; down " +
      "when the failures on `main` are mostly environmental rather than real.",
  },
  {
    name: "BREADTH_SATURATION",
    value: BREADTH_SATURATION,
    unit: "sources",
    setBy: "chosen",
    why: "Where the `breadth` term reaches half its ceiling. Up when the " +
      "term should go on telling eight sources from four; down when one " +
      "source should already be worth nearly all it can give.",
  },
  {
    name: "ENVIRONMENTAL_MIN_SOURCES",
    value: ENVIRONMENTAL_MIN_SOURCES,
    unit: "sources",
    setBy: "chosen",
    why: "How many distinct sources a failure must span inside " +
      "`CATCH_BREADTH_WINDOW_DAYS` before it reads as the environment. Up " +
      "when a genuinely broad regression is written off; down when a " +
      "broken runner's failures still count as catches.",
  },
  {
    name: "CHURN_HALF_LIFE_DAYS",
    value: CHURN_HALF_LIFE_DAYS,
    unit: "days",
    setBy: "chosen",
    why:
      "Up when recent trouble should stay relevant for longer; down when a " +
      "problem already fixed keeps its tests selected for weeks afterwards.",
  },
  {
    name: "CHURN_WINDOW_DAYS",
    value: CHURN_WINDOW_DAYS,
    unit: "days",
    setBy: "chosen",
    why: "How far back the decayed counts are read. Past this the weight is " +
      "under one part in sixteen, so moving it is a performance decision " +
      "rather than a policy one.",
  },
  {
    name: "FLAKE_HALF_LIFE_RUNS",
    value: FLAKE_HALF_LIFE_RUNS,
    unit: "runs",
    setBy: "chosen",
    why: "How many runs without disagreeing halve what a disagreement counts " +
      "for. It is also how much evidence the share is measured over, so far " +
      "below one over `FLAKE_EXCLUSION_RATE` the share swings about on too " +
      "little: up when it does; down when a test that has plainly settled " +
      "is still judged by what it did.",
  },
  {
    name: "FLAKE_WINDOW_DAYS",
    value: FLAKE_WINDOW_DAYS,
    unit: "days",
    setBy: "chosen",
    why: "How far back the counts are read at all. The weight decays by " +
      "runs rather than by days, so this bounds what is remembered rather " +
      "than marking where the weight has faded: a test that runs rarely can " +
      "still be carrying weight when its days fall off the end.",
  },
  {
    name: "COST_WINDOW_DAYS",
    value: COST_WINDOW_DAYS,
    unit: "days",
    setBy: "chosen",
    why:
      "Up when cost estimates are noisy; down when durations drift with the " +
      "code or the runner image faster than the estimate follows.",
  },
  {
    name: "FILL_VALUE_SHARE",
    value: FILL_VALUE_SHARE,
    unit: "share of the run's budget",
    setBy: "chosen",
    why: "Up when expensive high-value tests are crowded out by cheap ones; " +
      "down when a lane spends its budget on a few slow tests and runs " +
      "little else. The three shares sum to one.",
  },
  {
    name: "FILL_DENSITY_SHARE",
    value: FILL_DENSITY_SHARE,
    unit: "share of the run's budget",
    setBy: "chosen",
    why: "Up when more of the cheap tail should run; down when the tail is " +
      "displacing tests with a record.",
  },
  {
    name: "FILL_EXPLORATION_SHARE",
    value: FILL_EXPLORATION_SHARE,
    unit: "share of the run's budget",
    setBy: "chosen",
    why:
      "Up when the unselected corpus is going stale; down when lanes spend " +
      "the share on tests that never find anything.",
  },
  {
    name: "MIN_CORRECTION_SPAN_SECONDS",
    value: MIN_CORRECTION_SPAN_SECONDS,
    unit: "seconds",
    setBy: "derived",
    why: "A tenth of a lane's budget, measured as the widest gap between " +
      "the time two batches' own tests took. Down when a suite's real slope " +
      "is going unbelieved for too long; up when a slope fitted inside a " +
      "narrow range is being read far outside it.",
  },
  {
    name: "MIN_CORRECTION_SAMPLES",
    value: MIN_CORRECTION_SAMPLES,
    unit: "batches",
    setBy: "chosen",
    why:
      "Up when a slope is being fitted from too little and swinging about; " +
      "down when a suite's real slope takes too long to be believed.",
  },
  {
    name: "FLAKE_EXCLUSION_RATE",
    value: FLAKE_EXCLUSION_RATE,
    unit: "share of runs",
    setBy: "chosen",
    why:
      "Up when fewer tests should be held back from pull requests; down when " +
      "flakes are still blocking people.",
  },
  {
    name: "FLAKE_MIN_EXECUTIONS",
    value: FLAKE_MIN_EXECUTIONS,
    unit: "runs of one item",
    setBy: "chosen",
    why: "What an item that has ever disagreed runs. Down to one when the " +
      "cheapest evidence of intermittency is not worth a second execution; " +
      "nowhere useful above two, since the line through the anchor covers " +
      "everything flakier.",
  },
  {
    name: "FLAKE_ANCHOR_RATE",
    value: FLAKE_ANCHOR_RATE,
    unit: "share of runs",
    setBy: "chosen",
    why: "With `FLAKE_ANCHOR_EXECUTIONS`, the point the count's line passes " +
      "through. Down to make the count climb faster with the rate; up to " +
      "make it climb slower.",
  },
  {
    name: "FLAKE_ANCHOR_EXECUTIONS",
    value: FLAKE_ANCHOR_EXECUTIONS,
    unit: "runs of one item",
    setBy: "chosen",
    why: "What an item at `FLAKE_ANCHOR_RATE` runs. Up when intermittent " +
      "regressions still get through; down when executions crowd a lane.",
  },
  {
    name: "MAX_EXECUTIONS",
    value: MAX_EXECUTIONS,
    unit: "runs of one item",
    setBy: "chosen",
    why:
      "Where the line stops. Up when the flakiest items a change forces in " +
      "still are not proven by what runs; down when they crowd a lane.",
  },
  {
    name: "SUITE_FLAKE_PRIOR_RATE",
    value: SUITE_FLAKE_PRIOR_RATE,
    unit: "share of runs",
    setBy: "chosen",
    why:
      "Up when too many suites count as flake-prone and their new items are " +
      "repeated needlessly; down when new tests in a noisy suite land " +
      "unrepeated and then flake.",
  },
  {
    name: "COVERAGE_COMMENT_LINES",
    value: COVERAGE_COMMENT_LINES,
    unit: "lines",
    setBy: "chosen",
    why:
      "Up when coverage comments are too noisy; down when debt is climbing " +
      "unnoticed.",
  },
  {
    name: "LOCAL_COVERAGE_MAX_SECONDS",
    value: LOCAL_COVERAGE_MAX_SECONDS,
    unit: "seconds",
    setBy: "chosen",
    why:
      "Up when too many sets are reported as expensive for the report to be " +
      "worth reading; down when one is quietly eating a lane. Nothing is " +
      "excluded either way; it only decides what the summary mentions.",
  },
  {
    name: "LOCAL_COVERAGE_MAX_SETS",
    value: LOCAL_COVERAGE_MAX_SETS,
    unit: "measured sets",
    setBy: "chosen",
    why:
      "Up when broader changes should still be gated and the run can afford " +
      "those sets' whole unit lists; down when sweeping changes are crowding " +
      "lanes.",
  },
  {
    name: "EXCLUDED_FROM_COVERAGE_GATE",
    value: EXCLUDED_FROM_COVERAGE_GATE.size,
    unit: "workspace members",
    setBy: "chosen",
    why:
      "Not a quantity. A line comes off when a package fits the run's budget " +
      "or gains a Deno-only half, which gives it a measured set. A line goes " +
      "on when a package's own tests stop being what covers it.",
  },
  {
    name: "LOCAL_COVERAGE_BASELINE_DAYS",
    value: LOCAL_COVERAGE_BASELINE_DAYS,
    unit: "days",
    setBy: "chosen",
    why:
      "Up when branches based further back are being reported for want of a " +
      "baseline they contain; down when the manifest carries more history " +
      "than anybody reads.",
  },
  {
    name: "COVERAGE_TREND_WEEKS",
    value: COVERAGE_TREND_WEEKS,
    unit: "weeks",
    setBy: "chosen",
    why:
      "Up when the tile goes amber too readily; down when debt climbs for a " +
      "month before anybody is told.",
  },
  {
    name: "CATCH_BREADTH_WINDOW_DAYS",
    value: CATCH_BREADTH_WINDOW_DAYS,
    unit: "days",
    setBy: "chosen",
    why:
      "Up when a broken runner's failures are being counted as catches; down " +
      "when genuine breadth is being written off as environmental.",
  },
  {
    name: "SAME_COMMIT_REACH_DAYS",
    value: SAME_COMMIT_REACH_DAYS,
    unit: "days",
    setBy: "chosen",
    why: "How far back the fold remembers a commit's outcomes, so that a " +
      "rerun landing in a later batch than the run it repeats is still read " +
      "as the test disagreeing with itself. Up when reruns land far enough " +
      "behind that their disagreement is being counted as a catch; down " +
      "when the fold's memory is the thing that will not fit. It costs the " +
      "number of identities that have failed times the number of commits, " +
      "so it is the dial to check first when a run runs out of memory.",
  },
  {
    name: "FLAKE_COMMIT_REACH",
    value: FLAKE_COMMIT_REACH,
    unit: "commits",
    setBy: "chosen",
    why: "How many of the most recently observed commits the fold keeps " +
      "every identity's outcomes at. Past that a commit keeps only the " +
      "identities that have already failed, so this bounds a test's first " +
      "failure: up when one lands more commits after the pass it disagrees " +
      "with than this and is counted as a catch; down when the fold's " +
      "memory is the thing that will not fit.",
  },
  {
    name: "RENAME_SIMILARITY",
    value: RENAME_SIMILARITY,
    unit: "share of the longer name's own part",
    setBy: "chosen",
    why: "Up when the run report offers rename pairings nobody meant; down " +
      "when a rename that discarded history goes unoffered. It only " +
      "decides what is suggested — nothing is written to the alias file " +
      "without somebody appending it.",
  },
  {
    name: "RENAME_MARGIN",
    value: RENAME_MARGIN,
    unit: "share of the longer name's own part",
    setBy: "chosen",
    why:
      "Up when the run report pairs a deletion with an unrelated addition; " +
      "down when a rename made alongside another rename in the same area " +
      "goes unoffered.",
  },
  {
    name: "RENAME_SUGGESTIONS",
    value: RENAME_SUGGESTIONS,
    unit: "suggestions in one comment",
    setBy: "chosen",
    why: "Up when a change that renamed many tests has its later suggestions " +
      "cut off; down when a comment carrying this many is one nobody reads.",
  },
  {
    name: "ALIAS_GATE_MIN_CATCHES",
    value: ALIAS_GATE_MIN_CATCHES,
    unit: "catches",
    setBy: "chosen",
    why: "Off by default. Turn it on at a catch count to fail a pull request " +
      "that discards that much history in a rename without an alias line, " +
      "and lower the count as the alias file becomes routine.",
  },
];
