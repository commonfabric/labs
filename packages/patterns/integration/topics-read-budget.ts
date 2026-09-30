/**
 * The rules of the Topics read budget: which probe cases it gates, grouped by
 * the test file that runs them; the five counts it gates in each measured
 * phase, read from the probe's phase records; how a limit follows from the
 * counts observed; which regression variant each limit is assigned to; and the
 * checks the read-budget test and `--derive-limits` make against the limits
 * table. The "Topics read budget" section of `docs/development/BENCHMARKS.md`
 * documents them.
 */

import type {
  MeasuredPhaseRecord,
  PhaseRecord,
  ProbeCase,
  Workload,
} from "./topics-cost-cases.ts";
import { TOPICS_READ_BUDGET_LIMITS } from "./topics-read-budget-limits.ts";
import type { ReadBudgetVariantName } from "./topics-read-budget-variants.ts";

//
// The gated cases and counts
//

/**
 * The probe cases the read budget gates, by group. Each group runs in a test
 * file of its own, `topics-read-budget-<group>.test.ts`, which is what keeps
 * each file small enough for a lane to take on its own.
 */
export const TOPICS_READ_BUDGET_GROUPS = {
  "small-and-threads": [
    "pivot/low-degree/mentions-3/topics-4/topic-open",
    "pivot/low-degree/mentions-3/topics-4/all-backlinks",
    "thread/comments-1/links-1/aggregates",
    "thread/comments-100/links-3/aggregates",
    "thread/comments-3/links-100/aggregates",
  ],
  "single-bucket": [
    "pivot/single-bucket/mentions-4/topics-32/topic-open",
    "pivot/single-bucket/mentions-4/topics-32/all-backlinks",
  ],
  "high-degree": [
    "pivot/high-degree/mentions-4/topics-32/topic-open",
    "pivot/high-degree/mentions-4/topics-32/all-backlinks",
  ],
  "mentions-16": [
    "pivot/low-degree/mentions-16/topics-32/topic-open",
    "pivot/low-degree/mentions-16/topics-32/all-backlinks",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** A group of read-budget cases, which one test file runs. */
export type ReadBudgetGroup = keyof typeof TOPICS_READ_BUDGET_GROUPS;

/** Returns the name of the test file that runs the cases of `group`. */
export function readBudgetTestFile(group: ReadBudgetGroup): string {
  return `topics-read-budget-${group}.test.ts`;
}

/** Returns the name of the test file of each read-budget group, sorted. */
export function readBudgetTestFiles(): string[] {
  return readBudgetGroups().map(readBudgetTestFile).toSorted();
}

/** Returns every read-budget group, sorted. */
export function readBudgetGroups(): ReadBudgetGroup[] {
  return (Object.keys(TOPICS_READ_BUDGET_GROUPS) as ReadBudgetGroup[])
    .toSorted();
}

/**
 * Returns the statement that makes a test file run the cases of `group`, as one
 * whole line. A file holding no such statement registers no test, so its own
 * tests cannot report that it runs nothing; the other groups' files read its
 * source for a line that is this statement and nothing else, which a commented
 * out registration is not.
 */
export function readBudgetRegistration(group: ReadBudgetGroup): string {
  return `describeReadBudgetGroup("${group}", import.meta.url);`;
}

/** The counts a read-budget limit gates, in the order the table lists them. */
export const GATED_MEASURES = [
  "attemptTotal",
  "bodyTotal",
  "bodyPerRun",
  "graphNodes",
  "graphEdges",
] as const;

/** One count a read-budget limit gates. */
export type GatedMeasure = typeof GATED_MEASURES[number];

/**
 * Returns the gated counts of one measured phase, each read from its record:
 *
 * - `attemptTotal` is `attempts.total.proxyAccesses`, the proxy accesses of
 *   every transaction attempt from the start of the phase through settlement,
 *   each counted through its commit or abort.
 * - `bodyTotal` is `bodies.total.proxyAccesses`, the proxy accesses of every
 *   reactive body that completed in the phase, each counted from the start of
 *   the body to its end.
 * - `bodyPerRun` is `bodies.total.maxRunProxyAccesses`, the most proxy
 *   accesses any one of those bodies made.
 * - `graphNodes` and `graphEdges` are `graph.nodes` and `graph.edges`, the size
 *   of the scheduler's graph once the phase settled.
 *
 * `docs/features/read-accounting.md` defines the two read boundaries.
 */
export function gatedMeasuresOf(
  record: MeasuredPhaseRecord,
): Record<GatedMeasure, number> {
  return {
    attemptTotal: record.attempts.total.proxyAccesses,
    bodyTotal: record.bodies.total.proxyAccesses,
    bodyPerRun: record.bodies.total.maxRunProxyAccesses,
    graphNodes: record.graph.nodes,
    graphEdges: record.graph.edges,
  };
}

/**
 * Returns the limit a count gets when `largest` is the largest value it took:
 * that value plus 10%, rounded up to an integer. A count that stayed at zero
 * gets a limit of zero.
 */
export function limitFor(largest: number): number {
  return Math.ceil((largest * 11) / 10);
}

//
// The limits table
//

/**
 * The limit on one count: a number the count may reach and not exceed, or,
 * for a count that differed between the rounds its limit was derived from, the
 * values those rounds observed, which gate nothing.
 */
export type ReadBudgetLimit = number | { readonly ungated: readonly number[] };

/** Read-budget limits, by case ID, then by phase, then by gated count. */
export type ReadBudgetLimits = Readonly<
  Record<
    string,
    Readonly<Record<string, Readonly<Record<GatedMeasure, ReadBudgetLimit>>>>
  >
>;

/**
 * Returns the source of the limits module, `topics-read-budget-limits.ts`,
 * holding `limits`, formatted as `deno fmt` leaves it.
 */
export function limitsModuleSource(limits: ReadBudgetLimits): string {
  const key = (name: string) =>
    /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  const lines = [
    "/**",
    " * The Topics read-budget limits, by case, phase, and gated count: the",
    " * largest count five rounds observed, plus 10% and rounded up, or the",
    " * counts observed where they differed between rounds.",
    " * `deno run -A --frozen scripts/topics-computation-cost.ts --derive-limits`",
    " * prints this module, and `topics-read-budget.ts` says what each count is.",
    " */",
    "export const TOPICS_READ_BUDGET_LIMITS: ReadBudgetLimits = {",
  ];
  for (const [id, phases] of Object.entries(limits)) {
    lines.push(`  ${key(id)}: {`);
    for (const [phase, measures] of Object.entries(phases)) {
      lines.push(`    ${key(phase)}: {`);
      for (const measure of GATED_MEASURES) {
        const limit = measures[measure];
        const written = typeof limit === "number"
          ? `${limit}`
          : `{ ungated: [${limit.ungated.join(", ")}] }`;
        lines.push(`      ${measure}: ${written},`);
      }
      lines.push("    },");
    }
    lines.push("  },");
  }
  lines.push("};");
  return [
    'import type { ReadBudgetLimits } from "./topics-read-budget.ts";',
    "",
    ...lines,
  ].join("\n");
}

//
// The checks
//

/** The workloads the probe measures, which are the ones a limit can name. */
type MeasuredWorkload = Exclude<Workload, "board">;

/**
 * The regression variant each gated count is assigned to, by workload. Under
 * its variant, every limit on the count must be exceeded: a scan for the read
 * counts, and for the graph counts a growth in actions, which duplicates the
 * demanded lifts on a board and starts a lift per record on a thread.
 */
const ASSIGNED_VARIANTS = {
  "topic-open": {
    attemptTotal: "scan",
    bodyTotal: "scan",
    bodyPerRun: "scan",
    graphNodes: "duplicate-demand",
    graphEdges: "duplicate-demand",
  },
  "all-backlinks": {
    attemptTotal: "scan",
    bodyTotal: "scan",
    bodyPerRun: "scan",
    graphNodes: "duplicate-demand",
    graphEdges: "duplicate-demand",
  },
  aggregates: {
    attemptTotal: "scan",
    bodyTotal: "scan",
    bodyPerRun: "scan",
    graphNodes: "per-record",
    graphEdges: "per-record",
  },
} as const satisfies Record<
  MeasuredWorkload,
  Record<GatedMeasure, ReadBudgetVariantName>
>;

/** One count checked against its limit, as a failed check reports it. */
export interface LimitCheck {
  /** The case's demand workload. */
  readonly workload: string;

  /** The case's ID. */
  readonly case: string;

  /** The phase that recorded the count. */
  readonly phase: string;

  /** Which count it is. */
  readonly measure: GatedMeasure;

  /**
   * The count, or `null` where the measurement recorded no such phase, or
   * recorded the phase without a count for this measure.
   */
  readonly observed: number | null;

  /** The limit, or `null` where the table holds none for the count. */
  readonly limit: number | null;
}

/**
 * Returns the variants the limits of `probeCase` are assigned to, each once.
 *
 * @throws Error for a `board` case, which has no limits.
 */
export function variantsAssignedTo(
  probeCase: ProbeCase,
): ReadBudgetVariantName[] {
  return [...new Set(Object.values(assignedVariantsOf(probeCase)))];
}

/**
 * Returns each count of `phases`, measured for `probeCase`, that exceeds its
 * limit in `limits`, with each measured count `limits` holds no limit for, each
 * gated count a measured phase lacks, and each limit on a phase `phases` does
 * not record. An ungated count is not checked. Empty when every limit holds.
 *
 * @throws Error when `limits` holds no limits for `probeCase`.
 */
export function limitsExceeded(
  probeCase: ProbeCase,
  phases: readonly PhaseRecord[],
  limits: ReadBudgetLimits = TOPICS_READ_BUDGET_LIMITS,
): LimitCheck[] {
  const table = limitsOf(probeCase, limits);
  const recorded = measuredPhasesOf(phases);
  const found: LimitCheck[] = [];
  const check = (phase: string, measure: GatedMeasure) => ({
    workload: probeCase.workload,
    case: probeCase.id,
    phase,
    measure,
  });
  for (const [phase, record] of recorded) {
    const counts = gatedMeasuresOf(record);
    for (const measure of GATED_MEASURES) {
      const limit = table[phase]?.[measure];
      const observed = counts[measure];
      if (!Number.isSafeInteger(observed)) {
        found.push({
          ...check(phase, measure),
          observed: null,
          limit: typeof limit === "number" ? limit : null,
        });
      } else if (limit === undefined) {
        found.push({ ...check(phase, measure), observed, limit: null });
      } else if (typeof limit === "number" && observed > limit) {
        found.push({ ...check(phase, measure), observed, limit });
      }
    }
  }
  for (const [phase, measures] of Object.entries(table)) {
    if (recorded.has(phase)) continue;
    for (const measure of GATED_MEASURES) {
      const limit = measures[measure];
      if (typeof limit !== "number") continue;
      found.push({ ...check(phase, measure), observed: null, limit });
    }
  }
  return found;
}

/**
 * Returns each limit of `probeCase` in `limits` assigned to `variant` that
 * `phases`, measured under that variant, does not exceed, including each
 * whose phase `phases` does not record or records without the count. An
 * ungated count is not checked. Empty when the variant exceeds every limit
 * assigned to it.
 *
 * @throws Error when `limits` holds no limits for `probeCase`.
 */
export function assignedLimitsNotExceeded(
  probeCase: ProbeCase,
  variant: ReadBudgetVariantName,
  phases: readonly PhaseRecord[],
  limits: ReadBudgetLimits = TOPICS_READ_BUDGET_LIMITS,
): LimitCheck[] {
  const table = limitsOf(probeCase, limits);
  const assigned = assignedVariantsOf(probeCase);
  const recorded = measuredPhasesOf(phases);
  const found: LimitCheck[] = [];
  for (const [phase, measures] of Object.entries(table)) {
    const record = recorded.get(phase);
    const counts = record === undefined ? undefined : gatedMeasuresOf(record);
    for (const measure of GATED_MEASURES) {
      const limit = measures[measure];
      if (assigned[measure] !== variant || typeof limit !== "number") continue;
      const counted = counts?.[measure];
      const observed = Number.isSafeInteger(counted) ? counted! : null;
      if (observed === null || observed <= limit) {
        found.push({
          workload: probeCase.workload,
          case: probeCase.id,
          phase,
          measure,
          observed,
          limit,
        });
      }
    }
  }
  return found;
}

/**
 * Helper for the checks above, which returns the limits `limits` holds for
 * `probeCase`.
 *
 * @throws Error when it holds none.
 */
function limitsOf(
  probeCase: ProbeCase,
  limits: ReadBudgetLimits,
): ReadBudgetLimits[string] {
  const table = limits[probeCase.id];
  if (table === undefined) {
    throw new Error(`The read budget holds no limits for \`${probeCase.id}\`.`);
  }
  return table;
}

/**
 * Helper for the checks above, which returns the variant each count of
 * `probeCase` is assigned to.
 *
 * @throws Error for a `board` case, which has no limits.
 */
function assignedVariantsOf(
  probeCase: ProbeCase,
): Record<GatedMeasure, ReadBudgetVariantName> {
  if (probeCase.workload === "board") {
    throw new Error(
      `Case \`${probeCase.id}\` is not measured, so has no limits.`,
    );
  }
  return ASSIGNED_VARIANTS[probeCase.workload];
}

/** Helper for the checks above, which returns the measured phases by name. */
function measuredPhasesOf(
  phases: readonly PhaseRecord[],
): Map<string, MeasuredPhaseRecord> {
  return new Map(
    phases.flatMap((record) =>
      record.measured ? [[record.phase, record] as const] : []
    ),
  );
}
