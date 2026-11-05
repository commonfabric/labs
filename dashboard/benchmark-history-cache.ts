/**
 * Keeps the completed runtime benchmark artifacts across dashboard restarts.
 * One workflow run attempt is immutable, including the absence of a usable
 * artifact.
 *
 * The store is a directory holding one file per run attempt, named
 * `<runId>-<runAttempt>.run`, and a `state.json` holding the refresh manifest.
 * A run file is a 32-bit little-endian byte count, that many bytes of UTF-8
 * JSON naming the run, its processor, its benchmarks (`keys`) and the
 * statistics recorded for each (`stats`), and then one little-endian 64-bit
 * float for each statistic of each benchmark, benchmark by benchmark. Readers
 * pick the statistics they know by name and ignore header fields they do not.
 *
 * Processes that share the cache directory hold `<directory>.json.lock` while
 * they read or write the store. The store can also find its history in one
 * JSON file at `<directory>.json`. That file is read one run at a time, and
 * the next save moves its runs into the directory and removes it.
 *
 * In memory, a run keeps its measurements in one `Float64Array`, and runs that
 * measured the same benchmarks share one list of their names.
 */

import { dirname, join } from "@std/path";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { currentBenchKey } from "./bench-report.ts";
import { CacheFile, dashboardCacheFile, replaceFile } from "./history-files.ts";

export const BENCHMARK_HISTORY_CACHE_DAYS = 60;
export const BENCHMARK_HISTORY_SAMPLING_VERSION = 1;

const DAY_MS = 86_400_000;
const LEGACY_VERSION = 1;
const STATE_FILE = "state.json";
const RUN_FILE = /^([1-9]\d*)-([1-9]\d*)\.run$/;
const STATS = ["min", "avg", "max", "p75", "p99", "p995", "p999"] as const;

/** One benchmark's timings in one run, in nanoseconds. */
export interface BenchmarkStats {
  /** The fastest sample. */
  min: number;
  /** The mean of the samples. */
  avg: number;
  /** The slowest sample. */
  max: number;
  /** The 75th percentile. */
  p75: number;
  /** The 99th percentile. */
  p99: number;
  /** The 99.5th percentile. */
  p995: number;
  /** The 99.9th percentile. */
  p999: number;
}

/** One attempt of one benchmark workflow run and what it measured. */
export interface CachedBenchmarkRun {
  /** The workflow run. */
  readonly runId: number;
  /** The attempt of that run. */
  readonly runAttempt: number;
  /** When the run was created, in milliseconds since the epoch. */
  readonly at: number;
  /**
   * The processor the benchmarks ran on. Entries written before
   * processor-specific charts are fetched again.
   */
  readonly cpu?: string;
  /** Each benchmark's statistics, by name. */
  readonly metrics: ReadonlyMap<string, BenchmarkStats>;
}

/** A run as the store holds it. */
interface StoredBenchmarkRun extends CachedBenchmarkRun {
  /** The run's measurements, packed. */
  readonly metrics: StoredMetrics;
}

/** Names one attempt of one workflow run. */
interface BenchmarkRunReference {
  /** The workflow run. */
  runId: number;
  /** The attempt of that run. */
  runAttempt: number;
}

/** The run attempts behind the last completed refresh. */
export interface BenchmarkRefreshManifest {
  /** When the refresh completed. */
  refreshedAt: number;
  /** How the refresh chose its runs, when it says. */
  samplingVersion?: number;
  /** The run attempts it chose. */
  runs: BenchmarkRunReference[];
  /** What the refresh found. */
  result: BenchmarkRefreshResult;
}

const REFRESH_RESULTS = [
  "data",
  "no-runs",
  "data-unavailable",
  "no-metric",
] as const;

export type BenchmarkRefreshResult = typeof REFRESH_RESULTS[number];

/** What `state.json` holds, before it is checked. */
interface StoredState {
  /** The manifest of the last completed refresh. */
  refresh?: unknown;
  /** When the store last learned that the manifest is out of date. */
  invalidatedAt?: unknown;
}

/** What one source on disk holds, checked. */
interface BenchmarkHistoryContents {
  /** The refresh manifest, when it checks out. */
  refresh: BenchmarkRefreshManifest | null;
  /** When the manifest was last found out of date, or 0. */
  invalidatedAt: number;
  /** Whether the source holds a time in the future. */
  futureState: boolean;
  /** The runs that decoded and checked out. */
  runs: StoredBenchmarkRun[];
}

/** What a read of the store found on disk. */
interface DiskListing {
  /** The keys of the run files that decoded. */
  runs: Set<string>;
  /** Whether a legacy JSON file was there. */
  legacy: boolean;
}

/**
 * The names of the benchmarks one or more runs measured, in order. Runs that
 * measured the same benchmarks share one list.
 */
interface MetricNames {
  /** The names, in the order the run recorded them. */
  keys: readonly string[];
  /** The position of each name in `keys`. */
  rows: ReadonlyMap<string, number>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * One benchmark's statistics, read from its run's measurements. Each lookup
 * makes a new one, which holds only the measurements and an offset into them.
 */
class StoredStats implements BenchmarkStats {
  readonly #values: Float64Array;
  readonly #offset: number;

  /**
   * Constructs an instance that reads row `row` of `values`, which holds a row
   * of `STATS` for each benchmark.
   */
  constructor(values: Float64Array, row: number) {
    this.#values = values;
    this.#offset = row * STATS.length;
  }

  /** @inheritDoc */
  get min(): number {
    return this.#values[this.#offset];
  }

  /** @inheritDoc */
  get avg(): number {
    return this.#values[this.#offset + 1];
  }

  /** @inheritDoc */
  get max(): number {
    return this.#values[this.#offset + 2];
  }

  /** @inheritDoc */
  get p75(): number {
    return this.#values[this.#offset + 3];
  }

  /** @inheritDoc */
  get p99(): number {
    return this.#values[this.#offset + 4];
  }

  /** @inheritDoc */
  get p995(): number {
    return this.#values[this.#offset + 5];
  }

  /** @inheritDoc */
  get p999(): number {
    return this.#values[this.#offset + 6];
  }

  /** The statistics as a plain object. */
  toJSON(): BenchmarkStats {
    const { min, avg, max, p75, p99, p995, p999 } = this;
    return { min, avg, max, p75, p99, p995, p999 };
  }
}

/** One run's measurements: a row of `STATS` for each benchmark it names. */
class StoredMetrics implements ReadonlyMap<string, BenchmarkStats> {
  readonly #names: MetricNames;
  readonly #measurements: Float64Array;

  /**
   * Constructs an instance holding `measurements`, a row of `STATS` for each
   * of `names`.
   */
  constructor(names: MetricNames, measurements: Float64Array) {
    this.#names = names;
    this.#measurements = measurements;
  }

  /** The names of the benchmarks, which other runs may share. */
  get names(): MetricNames {
    return this.#names;
  }

  /** A row of `STATS` for each benchmark in `names`. */
  get measurements(): Float64Array {
    return this.#measurements;
  }

  /** @inheritDoc */
  get size(): number {
    return this.#names.keys.length;
  }

  /** @inheritDoc */
  has(key: string): boolean {
    return this.#names.rows.has(key);
  }

  /** @inheritDoc */
  get(key: string): BenchmarkStats | undefined {
    const row = this.#names.rows.get(key);
    return row === undefined
      ? undefined
      : new StoredStats(this.#measurements, row);
  }

  /** @inheritDoc */
  *entries(): MapIterator<[string, BenchmarkStats]> {
    for (const [row, key] of this.#names.keys.entries()) {
      yield [key, new StoredStats(this.#measurements, row)];
    }
  }

  /** @inheritDoc */
  keys(): MapIterator<string> {
    return this.#names.keys.values();
  }

  /** @inheritDoc */
  *values(): MapIterator<BenchmarkStats> {
    for (const [, stats] of this.entries()) yield stats;
  }

  /** @inheritDoc */
  [Symbol.iterator](): MapIterator<[string, BenchmarkStats]> {
    return this.entries();
  }

  /** @inheritDoc */
  forEach(
    callback: (
      value: BenchmarkStats,
      key: string,
      map: ReadonlyMap<string, BenchmarkStats>,
    ) => void,
  ): void {
    for (const [key, stats] of this.entries()) callback(stats, key, this);
  }
}

const defaultDirectory = (): string =>
  dashboardCacheFile("fabric-wall-benchmark-history");

const isRunIdentity = (
  value: unknown,
): value is Omit<CachedBenchmarkRun, "metrics"> => {
  if (!isObjectNotArray(value)) return false;
  const { runId, runAttempt, at, cpu } = value;
  return Number.isInteger(runId) && Number(runId) > 0 &&
    Number.isInteger(runAttempt) && Number(runAttempt) > 0 &&
    Number.isFinite(at) &&
    (cpu === undefined || (typeof cpu === "string" && cpu.trim().length > 0));
};

const isStats = (value: unknown): value is BenchmarkStats =>
  isObjectNotArray(value) &&
  STATS.every((name) => Number.isFinite(value[name]));

const isLegacyRun = (
  value: unknown,
): value is
  & Omit<CachedBenchmarkRun, "metrics">
  & { metrics: Record<string, BenchmarkStats> } => {
  if (!isObjectNotArray(value)) return false;
  const { metrics } = value;
  return isRunIdentity(value) && isObjectNotArray(metrics) &&
    Object.values(metrics).every(isStats);
};

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isRunReference = (value: unknown): value is BenchmarkRunReference => {
  if (!isObjectNotArray(value)) return false;
  const { runId, runAttempt } = value;
  return Number.isInteger(runId) && Number(runId) > 0 &&
    Number.isInteger(runAttempt) && Number(runAttempt) > 0;
};

const isRefreshManifest = (
  value: unknown,
): value is BenchmarkRefreshManifest => {
  if (!isObjectNotArray(value)) return false;
  const { refreshedAt, samplingVersion, runs, result } = value;
  return Number.isFinite(refreshedAt) && Number(refreshedAt) >= 0 &&
    (samplingVersion === undefined ||
      Number.isInteger(samplingVersion) && Number(samplingVersion) > 0) &&
    Array.isArray(runs) && runs.every(isRunReference) &&
    (result === undefined || REFRESH_RESULTS.some((known) => known === result));
};

/**
 * Orders runs by creation time, and runs created together by run and attempt.
 */
const byTime = (a: CachedBenchmarkRun, b: CachedBenchmarkRun): number =>
  a.at - b.at || a.runId - b.runId || a.runAttempt - b.runAttempt;

const runKey = (runId: number, runAttempt: number): string =>
  `${runId}-${runAttempt}`;

const runFile = (run: BenchmarkRunReference): string =>
  `${runKey(run.runId, run.runAttempt)}.run`;

const isNotFound = (error: unknown): boolean =>
  error instanceof Deno.errors.NotFound;

/**
 * Decodes `bytes` as UTF-8, continuing a sequence `textDecoder` began
 * when `stream` is set. Throws a `SyntaxError` when they are not UTF-8.
 */
function decodeText(
  bytes: Uint8Array,
  textDecoder = decoder,
  stream = false,
): string {
  try {
    return textDecoder.decode(bytes, { stream });
  } catch {
    throw new SyntaxError("Runtime benchmark history file is not UTF-8.");
  }
}

/** The contents of `run`'s file, laid out as the module header describes. */
function encodeRun(run: StoredBenchmarkRun): Uint8Array<ArrayBuffer> {
  const { names, measurements: values } = run.metrics;
  const header = encoder.encode(JSON.stringify({
    runId: run.runId,
    runAttempt: run.runAttempt,
    at: run.at,
    cpu: run.cpu,
    stats: STATS,
    keys: names.keys,
  }));
  const bytes = new Uint8Array(4 + header.length + values.length * 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.length, true);
  bytes.set(header, 4);
  values.forEach((value, index) =>
    view.setFloat64(4 + header.length + index * 8, value, true)
  );
  return bytes;
}

/**
 * The run a file holds, as its identity, its benchmarks' names, and a row of
 * `STATS` for each benchmark. Throws a `SyntaxError` when the file is not a
 * valid run.
 */
function decodeRun(bytes: Uint8Array<ArrayBuffer>): {
  run: Omit<CachedBenchmarkRun, "metrics">;
  keys: string[];
  values: Float64Array;
} {
  const invalid = () =>
    new SyntaxError("Invalid runtime benchmark history cache entry.");
  if (bytes.length < 4) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  if (4 + headerLength > bytes.length) throw invalid();
  const header: unknown = JSON.parse(
    decodeText(bytes.subarray(4, 4 + headerLength)),
  );
  if (!isObjectNotArray(header)) throw invalid();
  const { stats, keys } = header;
  if (
    !isRunIdentity(header) || !isStrings(stats) || !isStrings(keys)
  ) throw invalid();
  const columns = STATS.map((name) => stats.indexOf(name));
  if (
    columns.includes(-1) ||
    4 + headerLength + keys.length * stats.length * 8 !== bytes.length
  ) throw invalid();
  const values = new Float64Array(keys.length * STATS.length);
  for (let row = 0; row < keys.length; row++) {
    for (const [column, source] of columns.entries()) {
      values[row * STATS.length + column] = view.getFloat64(
        4 + headerLength + (row * stats.length + source) * 8,
        true,
      );
    }
  }
  return {
    run: {
      runId: header.runId,
      runAttempt: header.runAttempt,
      at: header.at,
      cpu: header.cpu,
    },
    keys,
    values,
  };
}

/**
 * Reads the JSON value in `path`, handing the text of each element of its
 * top-level `runs` array to `onRun` as soon as that element is complete, and
 * returns the rest of the value with `runs` empty. Only one run's text is in
 * memory at a time.
 */
async function readLegacyFile(
  path: string,
  onRun: (text: string) => void,
): Promise<unknown> {
  const outside: string[] = [];
  let outsideLength = 0;
  let element: string[] = [];
  let elements = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let inRuns = false;
  // Where, in the text outside the runs, the latest string at depth 1 lies.
  let keyStart = 0;
  let keyEnd = 0;
  const emit = (last: boolean) => {
    const text = element.join("").trim();
    element = [];
    if (text) {
      elements++;
      onRun(text);
    } else if (!last || elements > 0) {
      throw new SyntaxError("Empty element in runtime benchmark history.");
    }
  };
  const streamDecoder = new TextDecoder("utf-8", { fatal: true });
  const scan = (chunk: string) => {
    let from = 0;
    const flush = (to: number) => {
      const piece = chunk.slice(from, to);
      if (inRuns) element.push(piece);
      else {
        outside.push(piece);
        outsideLength += piece.length;
      }
      from = to;
    };
    for (let index = 0; index < chunk.length; index++) {
      const code = chunk.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 0x5c) escaped = true;
        else if (code === 0x22) {
          inString = false;
          if (depth === 1) keyEnd = outsideLength + index + 1 - from;
        }
      } else if (code === 0x22) {
        inString = true;
        if (depth === 1) keyStart = outsideLength + index - from;
      } else if (code === 0x7b || code === 0x5b) {
        depth++;
        if (depth === 2 && code === 0x5b) {
          const before = outside.join("") + chunk.slice(from, index);
          if (
            keyEnd > keyStart &&
            JSON.parse(before.slice(keyStart, keyEnd)) === "runs"
          ) {
            flush(index + 1);
            inRuns = true;
          }
        }
      } else if (code === 0x7d || code === 0x5d) {
        if (inRuns && depth === 2) {
          flush(index);
          emit(true);
          inRuns = false;
        }
        depth--;
      } else if (code === 0x2c && inRuns && depth === 2) {
        flush(index);
        emit(false);
        from = index + 1;
      }
    }
    flush(chunk.length);
  };
  const file = await Deno.open(path);
  for await (const bytes of file.readable) {
    scan(decodeText(bytes, streamDecoder, true));
  }
  scan(decodeText(new Uint8Array(), streamDecoder));
  return JSON.parse(outside.join(""));
}

/**
 * The runtime benchmark history, kept in memory and in a directory that
 * several dashboard processes may share.
 */
export class BenchmarkHistoryStore {
  #directory: string | undefined;
  #legacy: CacheFile | undefined;
  #loadRequest: Promise<void> | null = null;
  #runs = new Map<string, StoredBenchmarkRun>();
  #names = new Set<MetricNames>();
  #unsaved = new Set<StoredBenchmarkRun>();
  #refresh: BenchmarkRefreshManifest | null = null;
  #invalidatedAt = 0;
  #allowFutureCleanup = false;
  #write: Promise<void> = Promise.resolve();
  #revision = 0;
  #persistedRevision = 0;

  /**
   * Constructs an instance kept in `directory`, by default the
   * `fabric-wall-benchmark-history` directory in the dashboard cache directory.
   */
  constructor(directory?: string) {
    this.#directory = directory;
  }

  /** The directory that holds the store. */
  get directory(): string {
    return this.#directory ??= defaultDirectory();
  }

  /**
   * When the last completed refresh happened, or 0 when it is out of date,
   * was sampled differently, or lies in the future.
   */
  get refreshedAt(): number {
    return this.#refresh && this.#refresh.refreshedAt > this.#invalidatedAt &&
        this.#refresh.samplingVersion ===
          BENCHMARK_HISTORY_SAMPLING_VERSION &&
        this.#refresh.refreshedAt <= Date.now()
      ? this.#refresh.refreshedAt
      : 0;
  }

  /** A copy of the last completed refresh, while all its runs are held. */
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

  /** Whether the store holds changes that no save has written. */
  get dirty(): boolean {
    return this.#revision > this.#persistedRevision;
  }

  /** How many distinct lists of benchmark names the runs held share. */
  get accessForTestingOnly(): { readonly nameLists: number } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get nameLists() {
        return outerThis.#names.size;
      },
    };
  }

  /**
   * Reads what is on disk, once. A load that fails is tried again by the next
   * call.
   */
  load(): Promise<void> {
    this.#loadRequest ??= this.#locked(async () => {
      if ((await this.#sync(false)).legacy) this.#revision++;
    }).catch((error) => {
      this.#loadRequest = null;
      throw error;
    });
    return this.#loadRequest;
  }

  /** The run `runId`, at `runAttempt` or else at its latest attempt. */
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

  /** The runs behind the last completed refresh, oldest first. */
  refreshedRuns(): CachedBenchmarkRun[] | null {
    return this.#refresh ? this.#resolve(this.#refresh) : null;
  }

  /**
   * Records a refresh completed at `at` from `runs`, and returns the refresh
   * it replaces. A refresh older than the current one changes nothing.
   */
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

  /** Puts back a refresh that `markRefreshed` returned. */
  restoreRefresh(refresh: BenchmarkRefreshManifest | null): void {
    this.#refresh = refresh && this.#resolve(refresh) ? refresh : null;
    this.#revision++;
  }

  /**
   * Drops a refresh or invalidation time later than `now`, and lets the next
   * save replace such times on disk. Returns whether there were any.
   */
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

  /** Records that the last completed refresh was out of date at `at`. */
  invalidateRefresh(at = Date.now()): void {
    if (!Number.isFinite(at) || at <= this.#invalidatedAt) return;
    this.#invalidatedAt = at;
    this.#revision++;
  }

  /**
   * Holds `run`, unless the store already holds that attempt with a processor
   * or `run` names none, and returns the run the store holds.
   */
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
      metrics: this.#packMap(run.metrics),
    };
    this.#runs.set(key, stored);
    this.#unsaved.add(stored);
    this.#invalidateSupersededRefresh(Date.now());
    this.#revision++;
    return stored;
  }

  /**
   * The latest attempt of each run created at `cutoff` or later, oldest first.
   */
  list(cutoff = -Infinity): CachedBenchmarkRun[] {
    const latest = new Map<number, CachedBenchmarkRun>();
    for (const run of this.#runs.values()) {
      if (run.at < cutoff) continue;
      const current = latest.get(run.runId);
      if (!current || current.runAttempt < run.runAttempt) {
        latest.set(run.runId, run);
      }
    }
    return [...latest.values()].sort(byTime);
  }

  /**
   * Drops runs older than the retention window before `now`, merges what
   * other processes wrote, and writes what is missing on disk.
   */
  async save(now = Date.now()): Promise<void> {
    this.#prune(now);
    if (!this.dirty) return;
    const write = () => {
      if (!this.dirty) return Promise.resolve();
      return this.#locked(async () => {
        const disk = await this.#sync(true);
        this.#prune(now);
        const revision = this.#revision;
        const written = [...this.#runs].flatMap(([key, run]) =>
          disk.runs.has(key) && !this.#unsaved.has(run) ? [] : [run]
        );
        const state = encoder.encode(JSON.stringify({
          refresh: this.refresh ?? undefined,
          invalidatedAt: this.#invalidatedAt || undefined,
        }));
        await Deno.mkdir(this.directory, { recursive: true });
        for (const run of written) {
          await replaceFile(join(this.directory, runFile(run)), encodeRun(run));
        }
        await replaceFile(join(this.directory, STATE_FILE), state);
        for (const key of disk.runs) {
          if (!this.#runs.has(key)) {
            await Deno.remove(join(this.directory, `${key}.run`));
          }
        }
        if (disk.legacy) await Deno.remove(this.#legacyFile.path);
        for (const run of this.#unsaved) {
          if (
            written.includes(run) ||
            this.#runs.get(runKey(run.runId, run.runAttempt)) !== run
          ) this.#unsaved.delete(run);
        }
        this.#persistedRevision = Math.max(
          this.#persistedRevision,
          revision,
        );
        this.#allowFutureCleanup = false;
      });
    };
    this.#write = this.#write.then(write, write);
    await this.#write;
  }

  get #legacyFile(): CacheFile {
    return this.#legacy ??= new CacheFile(`${this.directory}.json`);
  }

  /** Runs `body` holding the lock every process sharing the store takes. */
  async #locked(body: () => Promise<void>): Promise<void> {
    await Deno.mkdir(dirname(this.directory), { recursive: true });
    await this.#legacyFile.locked(body);
  }

  /**
   * Packs one run's measurements, `values` holding a row of `STATS` for each
   * of `keys`. Benchmarks are kept under their current names, and when two
   * names become one, the later row wins.
   */
  #pack(keys: readonly string[], values: Float64Array): StoredMetrics {
    const current = keys.map(currentBenchKey);
    const rows = new Map<string, number>();
    current.forEach((key, row) => rows.set(key, row));
    if (rows.size < current.length) {
      const packed = new Float64Array(rows.size * STATS.length);
      [...rows.values()].forEach((row, index) =>
        packed.set(
          values.subarray(row * STATS.length, (row + 1) * STATS.length),
          index * STATS.length,
        )
      );
      return this.#pack([...rows.keys()], packed);
    }
    for (const names of this.#names) {
      if (
        names.keys.length === current.length &&
        names.keys.every((key, index) => key === current[index])
      ) return new StoredMetrics(names, values);
    }
    const names = { keys: current, rows };
    this.#names.add(names);
    return new StoredMetrics(names, values);
  }

  /** Packs measurements held in a map. */
  #packMap(metrics: ReadonlyMap<string, BenchmarkStats>): StoredMetrics {
    const values = new Float64Array(metrics.size * STATS.length);
    let index = 0;
    for (const stats of metrics.values()) {
      for (const name of STATS) values[index++] = stats[name];
    }
    return this.#pack([...metrics.keys()], values);
  }

  /**
   * The refresh manifest and invalidation time `state` holds, checked against
   * the runs `available` on disk. What does not check out is left out, except
   * that while `saving`, an invalidation time in the future throws unless the
   * store is clearing such state.
   */
  #state(
    state: StoredState,
    available: Set<string>,
    saving: boolean,
  ): Omit<BenchmarkHistoryContents, "runs"> {
    const { invalidatedAt, refresh } = state;
    const validInvalidation = typeof invalidatedAt === "number" &&
      Number.isFinite(invalidatedAt) && invalidatedAt >= 0;
    const futureInvalidation = validInvalidation && invalidatedAt > Date.now();
    if (saving && futureInvalidation && !this.#allowFutureCleanup) {
      throw new Error("Invalid runtime benchmark refresh invalidation.");
    }
    const manifest = isRefreshManifest(refresh) ? refresh : null;
    const futureRefresh = manifest !== null &&
      manifest.refreshedAt > Date.now();
    const usable = manifest !== null && !futureRefresh &&
      (invalidatedAt === undefined ||
        validInvalidation && !futureInvalidation) &&
      manifest.runs.every((run) =>
        available.has(runKey(run.runId, run.runAttempt))
      );
    return {
      refresh: usable
        ? {
          refreshedAt: manifest.refreshedAt,
          ...(manifest.samplingVersion === undefined
            ? {}
            : { samplingVersion: manifest.samplingVersion }),
          runs: manifest.runs.map((run) => ({ ...run })),
          result: manifest.result ??
            (manifest.runs.length ? "data" : "no-runs"),
        }
        : null,
      invalidatedAt: validInvalidation && !futureInvalidation
        ? invalidatedAt
        : 0,
      futureState: futureInvalidation || futureRefresh,
    };
  }

  /**
   * The legacy JSON file's contents, or null when there is none. Runs that do
   * not decode or check out are left out. When the file as a whole does not
   * decode, the runs read before the fault are kept and nothing else is.
   */
  async #readLegacy(saving: boolean): Promise<BenchmarkHistoryContents | null> {
    const runs: StoredBenchmarkRun[] = [];
    let value: unknown;
    try {
      value = await readLegacyFile(this.#legacyFile.path, (text) => {
        let run: unknown;
        try {
          run = JSON.parse(text);
        } catch (error) {
          if (error instanceof SyntaxError) return;
          throw error;
        }
        if (!isLegacyRun(run)) return;
        runs.push({
          runId: run.runId,
          runAttempt: run.runAttempt,
          at: run.at,
          cpu: run.cpu,
          metrics: this.#packMap(new Map(Object.entries(run.metrics))),
        });
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      if (!(error instanceof SyntaxError)) throw error;
      return { refresh: null, invalidatedAt: 0, futureState: false, runs };
    }
    if (
      !isObjectNotArray(value) || value.version !== LEGACY_VERSION ||
      !Array.isArray(value.runs)
    ) {
      return { refresh: null, invalidatedAt: 0, futureState: false, runs: [] };
    }
    const available = new Set(
      runs.map((run) => runKey(run.runId, run.runAttempt)),
    );
    return { ...this.#state(value, available, saving), runs };
  }

  /**
   * Merges what the directory and any legacy file hold, and removes the
   * temporary files that writes cut short left behind. The caller holds the
   * lock, so no write is in progress. A run file that does not decode is
   * skipped, and while `saving` it is removed; the tile fetches that run
   * again. A `state.json` that does not decode reads as empty.
   */
  async #sync(saving: boolean): Promise<DiskListing> {
    const legacy = await this.#readLegacy(saving);
    if (legacy) this.#merge(legacy);

    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.directory)) {
        names.push(entry.name);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const available = new Set<string>();
    const runs: StoredBenchmarkRun[] = [];
    let state: StoredState = {};
    for (const name of names) {
      const path = join(this.directory, name);
      if (name.endsWith(".tmp")) {
        await Deno.remove(path);
        continue;
      }
      if (name === STATE_FILE) {
        const bytes = await Deno.readFile(path);
        try {
          const value: unknown = JSON.parse(decodeText(bytes));
          if (isObjectNotArray(value)) state = value;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        continue;
      }
      const match = name.match(RUN_FILE);
      if (!match) continue;
      const key = runKey(Number(match[1]), Number(match[2]));
      if (this.#runs.get(key)?.cpu !== undefined) {
        available.add(key);
        continue;
      }
      let decoded: ReturnType<typeof decodeRun>;
      try {
        decoded = decodeRun(await Deno.readFile(path));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (saving) await Deno.remove(path);
        continue;
      }
      const { run, keys, values } = decoded;
      if (runKey(run.runId, run.runAttempt) !== key) {
        if (saving) await Deno.remove(path);
        continue;
      }
      runs.push({ ...run, metrics: this.#pack(keys, values) });
      available.add(key);
    }
    this.#merge({ ...this.#state(state, available, saving), runs });
    this.#collectNames();
    return { runs: available, legacy: legacy !== null };
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
    return runs.sort(byTime);
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
    if (pruned) {
      this.#collectNames();
      this.#revision++;
    }
  }

  /** Keeps only the name lists that runs still use. */
  #collectNames(): void {
    this.#names = new Set(
      [...this.#runs.values()].map((run) => run.metrics.names),
    );
  }
}
