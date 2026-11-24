/**
 * The serving loop's record of which actions cost the most wall time, so that
 * an operator can read which action in which space holds a serving worker,
 * and an author can read where that action is written and how often a change
 * to its inputs runs it again (docs/plans/slow-action-resilience.md, stage
 * 1). A host keeps one {@link ActionCostTable} over every space it serves,
 * fed from the scheduler's `scheduler.run.complete` marker, and reports it as
 * the `actions` block of the serving-loop counters; {@link mergeActionCosts}
 * combines the blocks of several hosts.
 *
 * A run is counted when it ends. A run that is still going, however long, is
 * in no row.
 */

import { getLogger } from "@commonfabric/logger";
import {
  type RuntimeTelemetry,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
} from "../telemetry.ts";
import type { ServingActionCost, ServingLoopStats } from "./stats.ts";

const logger = getLogger("action-costs", { enabled: true, level: "warn" });

/** What the scheduler reports when an action's run ends. */
export type ActionRun = Extract<
  RuntimeTelemetryMarker,
  { type: "scheduler.run.complete" }
>;

/** The `actions` block of the serving-loop counters. */
export type ServingActionCosts = ServingLoopStats["actions"];

/** How many actions a host tracks at once. */
export const ACTION_COSTS_TRACKED = 512;

/** How many actions the counters list, of a host and of a process. */
export const ACTION_COSTS_LISTED = 50;

/**
 * A run at least this long, in milliseconds, is logged, once for each row an
 * action holds.
 */
export const SLOW_ACTION_LOG_MS = 1000;

/** A tracked action's cost, and whether its slow run has been logged. */
type Row = ServingActionCost & { logged: boolean };

/**
 * The actions one host's serving runtimes have spent the most wall time on.
 *
 * A host tracks at most `tracked` actions. A run of an action with no row
 * takes a row while there is room. Once there is none, it takes the row of
 * the action with the least total time if it alone took longer than that
 * action's total, and otherwise is counted only in `droppedMs`, so an action
 * the table holds is never displaced by one that has cost less.
 */
export class ActionCostTable {
  #tracked: number;
  #listed: number;
  #rows = new Map<string, Row>();
  #dropped = 0;
  #droppedMs = 0;
  #observed = new WeakSet<RuntimeTelemetry>();

  /**
   * Constructs a table that tracks at most `tracked` actions and lists the
   * `listed` most expensive of them.
   *
   * @throws If either bound is not a positive integer.
   */
  constructor(
    { tracked = ACTION_COSTS_TRACKED, listed = ACTION_COSTS_LISTED }: {
      tracked?: number;
      listed?: number;
    } = {},
  ) {
    this.#tracked = positiveInteger("tracked", tracked);
    this.#listed = positiveInteger("listed", listed);
  }

  /**
   * Counts every action run `telemetry` reports from now on as a run of an
   * action of `space`. A telemetry source already observed is left as it is,
   * so a runtime a space's next tenure reuses is counted once.
   */
  observe(space: string, telemetry: RuntimeTelemetry): void {
    if (this.#observed.has(telemetry)) return;
    this.#observed.add(telemetry);
    telemetry.addEventListener("telemetry", (event) => {
      if (!(event instanceof RuntimeTelemetryEvent)) return;
      const { marker } = event;
      if (marker.type === "scheduler.run.complete") this.record(space, marker);
    });
  }

  /** Counts `run` as a run of an action of `space`. */
  record(space: string, run: ActionRun): void {
    const key = `${space} ${run.actionId}`;
    const ms = run.durationMs;
    let row = this.#rows.get(key);
    if (row === undefined) {
      if (this.#rows.size >= this.#tracked && !this.#evictCheaperThan(ms)) {
        this.#droppedMs += ms;
        this.#logSlowRun(space, run);
        return;
      }
      row = {
        space,
        action: run.actionId,
        ...(run.piece === undefined ? {} : { piece: run.piece }),
        ...(run.actionInfo?.patternName === undefined
          ? {}
          : { pattern: run.actionInfo.patternName }),
        ...(run.actionInfo?.moduleName === undefined
          ? {}
          : { module: run.actionInfo.moduleName }),
        ...(run.src === undefined ? {} : { src: run.src }),
        runs: 0,
        inputRuns: 0,
        totalMs: 0,
        longestMs: 0,
        lastMs: 0,
        logged: false,
      };
      this.#rows.set(key, row);
    }
    row.runs += 1;
    if (run.inputDriven === true) row.inputRuns += 1;
    row.totalMs += ms;
    row.longestMs = Math.max(row.longestMs, ms);
    row.lastMs = ms;
    if (!row.logged && ms >= SLOW_ACTION_LOG_MS) {
      row.logged = true;
      this.#logSlowRun(space, run);
    }
  }

  /**
   * Returns the `listed` most expensive actions, most expensive first, with
   * every other action and every run no row took counted in `dropped` and
   * `droppedMs`. The result shares nothing with the table.
   */
  costs(): ServingActionCosts {
    const ranked = [...this.#rows.values()].sort(byTotalDescending);
    const unlisted = ranked.slice(this.#listed);
    return {
      entries: ranked.slice(0, this.#listed).map(
        ({ logged: _logged, ...cost }) => cost,
      ),
      dropped: this.#dropped + unlisted.length,
      droppedMs: this.#droppedMs +
        unlisted.reduce((sum, row) => sum + row.totalMs, 0),
    };
  }

  /**
   * Helper for `record()`, which removes the row with the least total time if
   * that total is less than `ms`, counting it as dropped, and returns whether
   * it removed one.
   */
  #evictCheaperThan(ms: number): boolean {
    let cheapest: [string, Row] | undefined;
    for (const entry of this.#rows) {
      if (cheapest === undefined || entry[1].totalMs < cheapest[1].totalMs) {
        cheapest = entry;
      }
    }
    if (cheapest === undefined || cheapest[1].totalMs >= ms) return false;
    this.#rows.delete(cheapest[0]);
    this.#dropped += 1;
    this.#droppedMs += cheapest[1].totalMs;
    return true;
  }

  /** Helper for `record()`, which logs `run` if it was slow. */
  #logSlowRun(space: string, run: ActionRun): void {
    if (run.durationMs < SLOW_ACTION_LOG_MS) return;
    logger.warn("slow-action", () => [
      `action \`${run.actionId}\` of space \`${space}\` ran for ` +
      `${Math.round(run.durationMs)} ms` +
      (run.piece === undefined ? "" : `, piece \`${run.piece}\``) +
      (run.src === undefined ? "" : `, authored at \`${run.src}\``) +
      (run.inputDriven === true ? ", after a change to its inputs" : ""),
    ]);
  }
}

/**
 * Returns `costs` with the rows of one action of one space taken together and
 * bounded to the {@link ACTION_COSTS_LISTED} most expensive, the rest counted
 * in `dropped` and `droppedMs`. Rows of one action add their runs and times
 * and keep the longest run; the last run and the action's names are those of
 * the last of its rows that has them. The result shares nothing with `costs`.
 */
export function mergeActionCosts(
  costs: ServingActionCosts,
): ServingActionCosts {
  const byAction = new Map<string, ServingActionCost>();
  for (const entry of costs.entries) {
    const key = `${entry.space} ${entry.action}`;
    const seen = byAction.get(key);
    byAction.set(
      key,
      seen === undefined ? { ...entry } : {
        ...seen,
        ...entry,
        runs: seen.runs + entry.runs,
        inputRuns: seen.inputRuns + entry.inputRuns,
        totalMs: seen.totalMs + entry.totalMs,
        longestMs: Math.max(seen.longestMs, entry.longestMs),
      },
    );
  }
  const ranked = [...byAction.values()].sort(byTotalDescending);
  const unlisted = ranked.slice(ACTION_COSTS_LISTED);
  return {
    entries: ranked.slice(0, ACTION_COSTS_LISTED),
    dropped: costs.dropped + unlisted.length,
    droppedMs: costs.droppedMs +
      unlisted.reduce((sum, row) => sum + row.totalMs, 0),
  };
}

/**
 * Returns `value`, the bound named `name`.
 *
 * @throws If `value` is not a positive integer.
 */
function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `\`${name}\` must be a positive integer, not ${value}`,
    );
  }
  return value;
}

/** Orders action costs from the most total time to the least. */
function byTotalDescending(
  a: Pick<ServingActionCost, "totalMs">,
  b: Pick<ServingActionCost, "totalMs">,
): number {
  return b.totalMs - a.totalMs;
}
