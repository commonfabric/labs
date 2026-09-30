/**
 * Keeps the completed runtime benchmark artifacts across dashboard restarts.
 * One workflow run attempt is immutable, including the absence of a usable
 * artifact.
 */

import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { dashboardCacheFile } from "./history-files.ts";

export const BENCHMARK_HISTORY_CACHE_DAYS = 60;
export const BENCHMARK_HISTORY_SAMPLING_VERSION = 1;

const DAY_MS = 86_400_000;
const STORE_VERSION = 1;

export interface BenchmarkStats {
  min: number;
  avg: number;
  max: number;
  p75: number;
  p99: number;
  p995: number;
  p999: number;
}

export interface CachedBenchmarkRun {
  runId: number;
  runAttempt: number;
  at: number;
  // Entries written before processor-specific charts are fetched again.
  cpu?: string;
  metrics: Map<string, BenchmarkStats>;
}

interface StoredBenchmarkRun {
  runId: number;
  runAttempt: number;
  at: number;
  cpu?: string;
  metrics: Record<string, BenchmarkStats>;
}

interface BenchmarkRunReference {
  runId: number;
  runAttempt: number;
}

export interface BenchmarkRefreshManifest {
  refreshedAt: number;
  samplingVersion?: number;
  runs: BenchmarkRunReference[];
  result: BenchmarkRefreshResult;
}

export type BenchmarkRefreshResult =
  | "data"
  | "no-runs"
  | "data-unavailable"
  | "no-metric";

interface StoredBenchmarkHistory {
  version: number;
  refresh?: BenchmarkRefreshManifest;
  invalidatedAt?: number;
  runs: StoredBenchmarkRun[];
}

interface BenchmarkHistoryContents {
  refresh: BenchmarkRefreshManifest | null;
  invalidatedAt: number;
  futureState: boolean;
  runs: CachedBenchmarkRun[];
}

const defaultFile = (): string =>
  dashboardCacheFile("fabric-wall-benchmark-history.json");

const isStats = (value: unknown): value is BenchmarkStats => {
  if (typeof value !== "object" || value === null) return false;
  const stats = value as BenchmarkStats;
  return [
    stats.min,
    stats.avg,
    stats.max,
    stats.p75,
    stats.p99,
    stats.p995,
    stats.p999,
  ].every((number) => Number.isFinite(number));
};

const isStoredRun = (value: unknown): value is StoredBenchmarkRun => {
  if (typeof value !== "object" || value === null) return false;
  const run = value as StoredBenchmarkRun;
  return Number.isInteger(run.runId) && run.runId > 0 &&
    Number.isInteger(run.runAttempt) && run.runAttempt > 0 &&
    Number.isFinite(run.at) &&
    (run.cpu === undefined ||
      (typeof run.cpu === "string" && run.cpu.trim().length > 0)) &&
    isObjectNotArray(run.metrics) &&
    Object.values(run.metrics).every(isStats);
};

const isRunReference = (value: unknown): value is BenchmarkRunReference => {
  if (typeof value !== "object" || value === null) return false;
  const run = value as BenchmarkRunReference;
  return Number.isInteger(run.runId) && run.runId > 0 &&
    Number.isInteger(run.runAttempt) && run.runAttempt > 0;
};

const isRefreshManifest = (
  value: unknown,
): value is BenchmarkRefreshManifest => {
  if (typeof value !== "object" || value === null) return false;
  const refresh = value as BenchmarkRefreshManifest;
  return Number.isFinite(refresh.refreshedAt) && refresh.refreshedAt >= 0 &&
    (refresh.samplingVersion === undefined ||
      Number.isInteger(refresh.samplingVersion) &&
        refresh.samplingVersion > 0) &&
    Array.isArray(refresh.runs) && refresh.runs.every(isRunReference) &&
    (refresh.result === undefined ||
      ["data", "no-runs", "data-unavailable", "no-metric"].includes(
        refresh.result,
      ));
};

const runKey = (runId: number, runAttempt: number): string =>
  `${runId}:${runAttempt}`;

export class BenchmarkHistoryStore {
  #file: string | undefined;
  #loadRequest: Promise<void> | null = null;
  #runs = new Map<string, CachedBenchmarkRun>();
  #refresh: BenchmarkRefreshManifest | null = null;
  #invalidatedAt = 0;
  #allowFutureCleanup = false;
  #write: Promise<void> = Promise.resolve();
  #revision = 0;
  #persistedRevision = 0;

  constructor(file?: string) {
    this.#file = file;
  }

  async #read(strict = false): Promise<BenchmarkHistoryContents> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(this.file));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound || !strict) {
        return {
          refresh: null,
          invalidatedAt: 0,
          futureState: false,
          runs: [],
        };
      }
      throw error;
    }
    if (!isObjectOrArray(parsed)) {
      if (strict) throw new Error("Invalid runtime benchmark history cache.");
      return {
        refresh: null,
        invalidatedAt: 0,
        futureState: false,
        runs: [],
      };
    }
    const value = parsed as Partial<StoredBenchmarkHistory>;
    if (value.version !== STORE_VERSION || !Array.isArray(value.runs)) {
      if (strict) {
        throw new Error("Unsupported runtime benchmark history cache format.");
      }
      return {
        refresh: null,
        invalidatedAt: 0,
        futureState: false,
        runs: [],
      };
    }
    const invalidInvalidation = value.invalidatedAt !== undefined &&
      (!Number.isFinite(value.invalidatedAt) || value.invalidatedAt < 0);
    const futureInvalidation = value.invalidatedAt !== undefined &&
      Number.isFinite(value.invalidatedAt) && value.invalidatedAt >= 0 &&
      value.invalidatedAt > Date.now();
    const rejectedInvalidation = invalidInvalidation || futureInvalidation;
    const futureRefresh = value.refresh !== undefined &&
      isRefreshManifest(value.refresh) &&
      value.refresh.refreshedAt > Date.now();
    const futureState = futureInvalidation || futureRefresh;
    if (
      strict &&
      (invalidInvalidation ||
        (futureInvalidation && !this.#allowFutureCleanup))
    ) {
      throw new Error("Invalid runtime benchmark refresh invalidation.");
    }
    const runs: CachedBenchmarkRun[] = [];
    let rejectedRun = false;
    for (const run of value.runs) {
      if (!isStoredRun(run)) {
        if (strict) {
          throw new Error("Invalid runtime benchmark history cache entry.");
        }
        rejectedRun = true;
        continue;
      }
      runs.push({
        runId: run.runId,
        runAttempt: run.runAttempt,
        at: run.at,
        cpu: run.cpu,
        metrics: new Map(Object.entries(run.metrics)),
      });
    }
    let refresh: BenchmarkRefreshManifest | null = null;
    if (value.refresh !== undefined) {
      if (!isRefreshManifest(value.refresh)) {
        if (strict) {
          throw new Error("Invalid runtime benchmark refresh manifest.");
        }
      } else if (
        !rejectedRun && !rejectedInvalidation &&
        value.refresh.refreshedAt <= Date.now()
      ) {
        const available = new Set(
          runs.map((run) => `${run.runId}:${run.runAttempt}`),
        );
        if (
          value.refresh.runs.every((run) =>
            available.has(`${run.runId}:${run.runAttempt}`)
          )
        ) {
          refresh = {
            refreshedAt: value.refresh.refreshedAt,
            ...(value.refresh.samplingVersion === undefined
              ? {}
              : { samplingVersion: value.refresh.samplingVersion }),
            runs: value.refresh.runs.map((run) => ({ ...run })),
            result: value.refresh.result ??
              (value.refresh.runs.length ? "data" : "no-runs"),
          };
        } else if (strict) {
          throw new Error(
            "Runtime benchmark refresh manifest references a missing run.",
          );
        }
      }
    }
    return {
      refresh,
      invalidatedAt: !rejectedInvalidation &&
          Number.isFinite(value.invalidatedAt)
        ? value.invalidatedAt!
        : 0,
      futureState,
      runs,
    };
  }

  #merge(contents: BenchmarkHistoryContents): void {
    for (const run of contents.runs) {
      const key = runKey(run.runId, run.runAttempt);
      const current = this.#runs.get(key);
      if (!current || (current.cpu === undefined && run.cpu !== undefined)) {
        this.#runs.set(key, run);
      }
    }
    this.#invalidatedAt = Math.max(
      this.#invalidatedAt,
      contents.invalidatedAt,
    );
    if (contents.futureState && !this.#allowFutureCleanup) {
      this.#allowFutureCleanup = true;
      this.#revision++;
    }
    if (
      contents.refresh &&
      (!this.#refresh ||
        this.#refresh.refreshedAt < contents.refresh.refreshedAt)
    ) {
      this.#refresh = contents.refresh;
    }
    this.#invalidateSupersededRefresh();
  }

  #invalidateSupersededRefresh(at?: number): void {
    if (!this.#refresh) return;
    const superseded = this.#refresh.runs.some((reference) => {
      const latest = this.get(reference.runId);
      return latest && latest.runAttempt > reference.runAttempt;
    });
    if (superseded) {
      this.#invalidatedAt = Math.max(
        this.#invalidatedAt,
        at ?? this.#refresh.refreshedAt,
      );
    }
  }

  #resolve(refresh: BenchmarkRefreshManifest): CachedBenchmarkRun[] | null {
    const runs: CachedBenchmarkRun[] = [];
    for (const reference of refresh.runs) {
      const run = this.#runs.get(runKey(reference.runId, reference.runAttempt));
      if (!run) return null;
      runs.push(run);
    }
    return runs.sort((a, b) => a.at - b.at);
  }

  #prune(now: number): void {
    const cutoff = now - BENCHMARK_HISTORY_CACHE_DAYS * DAY_MS;
    let pruned = false;
    for (const [key, run] of this.#runs) {
      if (run.at < cutoff) {
        this.#runs.delete(key);
        pruned = true;
      }
    }
    if (this.#refresh && !this.#resolve(this.#refresh)) {
      this.#refresh = null;
      pruned = true;
    }
    if (pruned) this.#revision++;
  }

  get file(): string {
    return this.#file ??= defaultFile();
  }

  load(): Promise<void> {
    if (!this.#loadRequest) {
      this.#loadRequest = (async () => {
        this.#merge(await this.#read());
      })();
    }
    return this.#loadRequest;
  }

  get(runId: number, runAttempt?: number): CachedBenchmarkRun | undefined {
    if (runAttempt !== undefined) {
      return this.#runs.get(runKey(runId, runAttempt));
    }
    let latest: CachedBenchmarkRun | undefined;
    for (const run of this.#runs.values()) {
      if (
        run.runId === runId &&
        (!latest || latest.runAttempt < run.runAttempt)
      ) latest = run;
    }
    return latest;
  }

  get refreshedAt(): number {
    return this.#refresh && this.#refresh.refreshedAt > this.#invalidatedAt &&
        this.#refresh.samplingVersion ===
          BENCHMARK_HISTORY_SAMPLING_VERSION &&
        this.#refresh.refreshedAt <= Date.now()
      ? this.#refresh.refreshedAt
      : 0;
  }

  get refresh(): BenchmarkRefreshManifest | null {
    if (!this.#refresh || !this.#resolve(this.#refresh)) return null;
    return {
      refreshedAt: this.#refresh.refreshedAt,
      ...(this.#refresh.samplingVersion === undefined
        ? {}
        : { samplingVersion: this.#refresh.samplingVersion }),
      runs: this.#refresh.runs.map((run) => ({ ...run })),
      result: this.#refresh.result,
    };
  }

  refreshedRuns(): CachedBenchmarkRun[] | null {
    return this.#refresh ? this.#resolve(this.#refresh) : null;
  }

  markRefreshed(
    at: number,
    runs: CachedBenchmarkRun[],
    result: BenchmarkRefreshResult = runs.length ? "data" : "no-runs",
  ): BenchmarkRefreshManifest | null {
    const previous = this.refresh;
    if (!Number.isFinite(at) || at < (this.#refresh?.refreshedAt ?? 0)) {
      return previous;
    }
    const references = runs.map((run) => ({
      runId: run.runId,
      runAttempt: run.runAttempt,
    }));
    const refresh = {
      refreshedAt: at,
      samplingVersion: BENCHMARK_HISTORY_SAMPLING_VERSION,
      runs: references,
      result,
    };
    if (!this.#resolve(refresh)) {
      throw new Error("Runtime benchmark refresh contains an uncached run.");
    }
    this.#refresh = refresh;
    this.#revision++;
    return previous;
  }

  restoreRefresh(refresh: BenchmarkRefreshManifest | null): void {
    this.#refresh = refresh && this.#resolve(refresh) ? refresh : null;
    this.#revision++;
  }

  quarantineFuture(now = Date.now()): boolean {
    let changed = this.#allowFutureCleanup;
    if (this.#refresh && this.#refresh.refreshedAt > now) {
      this.#refresh = null;
      changed = true;
    }
    if (this.#invalidatedAt > now) {
      this.#invalidatedAt = 0;
      changed = true;
    }
    if (changed && !this.#allowFutureCleanup) this.#revision++;
    this.#allowFutureCleanup = changed;
    return changed;
  }

  invalidateRefresh(at = Date.now()): void {
    if (!Number.isFinite(at) || at <= this.#invalidatedAt) return;
    this.#invalidatedAt = at;
    this.#revision++;
  }

  set(run: CachedBenchmarkRun): CachedBenchmarkRun {
    const key = runKey(run.runId, run.runAttempt);
    const current = this.#runs.get(key);
    if (current && (current.cpu !== undefined || run.cpu === undefined)) {
      return current;
    }
    const stored = {
      runId: run.runId,
      runAttempt: run.runAttempt,
      at: run.at,
      cpu: run.cpu,
      metrics: new Map(run.metrics),
    };
    this.#runs.set(key, stored);
    this.#invalidateSupersededRefresh(Date.now());
    this.#revision++;
    return stored;
  }

  list(cutoff = -Infinity): CachedBenchmarkRun[] {
    const latest = new Map<number, CachedBenchmarkRun>();
    for (const run of this.#runs.values()) {
      if (run.at < cutoff) continue;
      const current = latest.get(run.runId);
      if (!current || current.runAttempt < run.runAttempt) {
        latest.set(run.runId, run);
      }
    }
    return [...latest.values()].sort((a, b) => a.at - b.at);
  }

  get dirty(): boolean {
    return this.#revision > this.#persistedRevision;
  }

  async save(now = Date.now()): Promise<void> {
    this.#prune(now);
    if (!this.dirty) return;
    const write = async () => {
      if (!this.dirty) return;
      const lock = await Deno.open(`${this.file}.lock`, {
        create: true,
        write: true,
      });
      let locked = false;
      try {
        await lock.lock(true);
        locked = true;
        this.#merge(await this.#read(true));
        this.#prune(now);

        const revision = this.#revision;
        const value: StoredBenchmarkHistory = {
          version: STORE_VERSION,
          refresh: this.refresh ?? undefined,
          invalidatedAt: this.#invalidatedAt || undefined,
          runs: [...this.#runs.values()].sort((a, b) => a.at - b.at).map((
            run,
          ) => ({
            runId: run.runId,
            runAttempt: run.runAttempt,
            at: run.at,
            cpu: run.cpu,
            metrics: Object.fromEntries(run.metrics),
          })),
        };
        const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
        try {
          await Deno.writeTextFile(temporary, JSON.stringify(value));
          await Deno.rename(temporary, this.file);
        } catch (error) {
          try {
            await Deno.remove(temporary);
          } catch {
            // Ignore cleanup when no temporary file remains.
          }
          throw error;
        }
        this.#persistedRevision = Math.max(
          this.#persistedRevision,
          revision,
        );
        this.#allowFutureCleanup = false;
      } finally {
        if (locked) await lock.unlock();
        lock.close();
      }
    };
    this.#write = this.#write.then(write, write);
    await this.#write;
  }
}
