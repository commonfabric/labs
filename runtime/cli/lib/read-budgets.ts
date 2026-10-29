/** Validates opt-in read limits and compares completed interval measurements. */

import type { RuntimeTelemetryMarker } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** Keeps attempt totals separate from reactive-body maxima. */
export class ReadBudgetMeasurement {
  #total = 0;
  #perRun = 0;
  readonly #contributors = new Map<
    string,
    { label: string; total: number; perRun: number }
  >();

  /** Sum of completed attempt accesses in the current interval. */
  get total(): number {
    return this.#total;
  }

  /** Largest completed reactive-body access count in the current interval. */
  get perRun(): number {
    return this.#perRun;
  }

  /** Records a completed attempt or body without adding a body twice. */
  record(marker: RuntimeTelemetryMarker): void {
    if (marker.type === "scheduler.read-attempt") {
      this.#total += marker.reads.proxyAccesses;
      const key = marker.actionId === undefined
        ? `attempt:${marker.kind}`
        : `action:${marker.actionId}`;
      const row = this.#contributors.get(key) ??
        {
          label: `${marker.kind}: ${marker.actionId ?? marker.kind}`,
          total: 0,
          perRun: 0,
        };
      row.total += marker.reads.proxyAccesses;
      this.#contributors.set(key, row);
    } else if (marker.type === "scheduler.run.complete" && marker.reads) {
      this.#perRun = Math.max(this.#perRun, marker.reads.proxyAccesses);
      const row = this.#contributors.get(`action:${marker.actionId}`) ??
        { label: marker.actionId, total: 0, perRun: 0 };
      row.label = marker.src ?? marker.actionInfo?.moduleName ??
        marker.actionId;
      row.perRun = Math.max(row.perRun, marker.reads.proxyAccesses);
      this.#contributors.set(`action:${marker.actionId}`, row);
    }
  }

  /** Starts a new interval after all work in the preceding one has settled. */
  clear(): void {
    this.#total = 0;
    this.#perRun = 0;
    this.#contributors.clear();
  }

  /** Names the largest measured contributors without truncating enforcement. */
  contributors(kind: "total" | "perRun", limit = 5): string[] {
    const grouped = new Map<
      string,
      { label: string; total: number; perRun: number }
    >();
    for (const row of this.#contributors.values()) {
      const group = grouped.get(row.label) ??
        { label: row.label, total: 0, perRun: 0 };
      group.total += row.total;
      group.perRun = Math.max(group.perRun, row.perRun);
      grouped.set(row.label, group);
    }
    return [...grouped.values()].sort((a, b) => b[kind] - a[kind])
      .filter((row) => row[kind] > 0).slice(0, limit)
      .map((row) => `${row[kind]} accesses — ${row.label}`);
  }
}

/** Proxy-access ceilings for one initialization or settled step interval. */
export type ReadBudget = {
  readonly total?: number;
  readonly perRun?: number;
};

/** Test-module limits, available before the test pattern is instantiated. */
export type ReadBudgets = {
  readonly initialization?: ReadBudget;
  readonly steps?: ReadBudget;
};

/** A limit exceeded by a completed, fully measured interval. */
export type ReadBudgetViolation = {
  readonly kind: "total" | "perRun";
  readonly limit: number;
  readonly actual: number;
};

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isObjectNotArray(value)) {
    throw new Error(`\`${where}\` must be an object`);
  }
  return value as Record<string, unknown>;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown read budget field \`${where}.${key}\``);
    }
  }
}

function limit(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`\`${where}\` must be a nonnegative safe integer`);
  }
  return value;
}

/** Reads one interval's declaration without coercing numbers or ignoring typos. */
export function parseReadBudget(value: unknown, where: string): ReadBudget {
  const fields = record(value, where);
  checkKeys(fields, ["total", "perRun"], where);
  const total = limit(fields.total, `${where}.total`);
  const perRun = limit(fields.perRun, `${where}.perRun`);
  return {
    ...(total === undefined ? {} : { total }),
    ...(perRun === undefined ? {} : { perRun }),
  };
}

/** Reads the named opt-in export; an absent export leaves accounting unchanged. */
export function parseReadBudgets(value: unknown): ReadBudgets | undefined {
  if (value === undefined) return undefined;
  const fields = record(value, "readBudgets");
  checkKeys(fields, ["initialization", "steps"], "readBudgets");
  return {
    ...(fields.initialization === undefined ? {} : {
      initialization: parseReadBudget(
        fields.initialization,
        "readBudgets.initialization",
      ),
    }),
    ...(fields.steps === undefined ? {} : {
      steps: parseReadBudget(fields.steps, "readBudgets.steps"),
    }),
  };
}

/**
 * Resolves a step override as a complete replacement for the default. An empty
 * override removes limits while retaining the test's accounting and settlement.
 */
export function readBudgetForStep(
  budgets: ReadBudgets | undefined,
  override: unknown,
  step: number,
): ReadBudget | undefined {
  if (override === undefined) return budgets?.steps;
  if (budgets === undefined) {
    throw new Error(
      `Step ${step} declares \`readBudget\` without a module-level \`readBudgets\` export`,
    );
  }
  return parseReadBudget(override, `step ${step}.readBudget`);
}

/** Returns every exceeded limit; equality passes and absent limits do not apply. */
export function evaluateReadBudget(
  budget: ReadBudget | undefined,
  measured: { readonly total: number; readonly perRun: number },
): ReadBudgetViolation[] {
  const violations: ReadBudgetViolation[] = [];
  for (const kind of ["total", "perRun"] as const) {
    const maximum = budget?.[kind];
    if (maximum !== undefined && measured[kind] > maximum) {
      violations.push({ kind, limit: maximum, actual: measured[kind] });
    }
  }
  return violations;
}
