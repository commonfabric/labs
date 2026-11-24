/**
 * The serving loop's record of which actions cost the most wall time, so that
 * an operator can read which action in which space holds a serving worker,
 * and an author can read where that action is written and how often a change
 * to its inputs runs it again (docs/plans/slow-action-resilience.md, stage
 * 1). A host keeps one {@link ActionCostTable} over every space it serves,
 * fed from the scheduler's `scheduler.run.complete` marker, and reports every
 * row it tracks as the `actions` block of the serving-loop counters;
 * {@link mergeActionCosts} combines the blocks of several hosts and bounds the
 * list once, for the whole process.
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

/** How many actions the counters of a process list. */
export const ACTION_COSTS_LISTED = 50;

/**
 * A run at least this long, in milliseconds, is logged, once for each action
 * among the most recent {@link SLOW_ACTIONS_REMEMBERED} actions logged.
 */
export const SLOW_ACTION_LOG_MS = 1000;

/** How many logged actions a host remembers, so as not to log them again. */
export const SLOW_ACTIONS_REMEMBERED = 4096;

/**
 * The actions one host's serving runtimes have spent the most wall time on.
 *
 * A host tracks at most `tracked` actions. A run of an action with no row
 * takes a row while there is room. Once there is none, it takes the row of
 * the action with the least total time if it alone took longer than that
 * action's total, and otherwise is counted only in `droppedMs`, so an action
 * the table holds is never displaced by one that has cost less. An action
 * that loses its row and runs again starts a new one, from that run.
 */
export class ActionCostTable {
  #tracked: number;
  #rows = new Map<string, ServingActionCost>();
  #dropped = 0;
  #droppedMs = 0;
  #logged = new Set<string>();
  #observed = new WeakSet<RuntimeTelemetry>();

  /**
   * Constructs a table that tracks at most `tracked` actions.
   *
   * @throws If `tracked` is not a positive integer.
   */
  constructor({ tracked = ACTION_COSTS_TRACKED }: { tracked?: number } = {}) {
    this.#tracked = positiveInteger("tracked", tracked);
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
        this.#logSlowRun(key, space, run);
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
      };
      this.#rows.set(key, row);
    }
    row.runs += 1;
    if (run.inputDriven === true) row.inputRuns += 1;
    row.totalMs += ms;
    row.longestMs = Math.max(row.longestMs, ms);
    row.lastMs = ms;
    this.#logSlowRun(key, space, run);
  }

  /**
   * Returns every tracked action, most expensive first, with the rows the
   * table has given up counted in `dropped`, and their time and that of every
   * run no row took in `droppedMs`. The list is not bounded below `tracked`:
   * {@link mergeActionCosts} bounds it, once the rows of every host are
   * together. The result shares nothing with the table.
   */
  costs(): ServingActionCosts {
    return {
      entries: [...this.#rows.values()].sort(byTotalDescending).map((row) => ({
        ...row,
      })),
      dropped: this.#dropped,
      droppedMs: this.#droppedMs,
    };
  }

  /**
   * Helper for `record()`, which removes the row with the least total time if
   * that total is less than `ms`, counting it as dropped, and returns whether
   * it removed one.
   */
  #evictCheaperThan(ms: number): boolean {
    let cheapest: [string, ServingActionCost] | undefined;
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

  /**
   * Helper for `record()`, which logs `run`, a run of the action `key` names,
   * if it was slow and the action is not among those already logged.
   */
  #logSlowRun(key: string, space: string, run: ActionRun): void {
    if (run.durationMs < SLOW_ACTION_LOG_MS || this.#logged.has(key)) return;
    this.#logged.add(key);
    // Insertion order is the order the actions were logged in, so the first
    // is the one logged longest ago.
    for (const oldest of this.#logged) {
      if (this.#logged.size <= SLOW_ACTIONS_REMEMBERED) break;
      this.#logged.delete(oldest);
    }
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
