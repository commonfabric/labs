/**
 * Holds the job and step timings for one CI workflow attempt on disk rather
 * than in memory. A single labs CI attempt has around fifty jobs and seven
 * hundred steps, which is roughly forty times the size of the per-job
 * durations the CI duration history needs. One file holds one attempt, so a
 * chart reads only the attempts it draws and a duration refresh reads none of
 * them.
 *
 * Each file is gzipped. An attempt's steps repeat the same few names and the
 * same timestamp prefixes over and over, which compresses about eighteen
 * times: a 114 KB attempt is stored in around 6 KB. At that size every attempt
 * the run index retains can keep its detail, so nothing is discarded that
 * GitHub would have to serve again.
 *
 * Which attempts to retain is the run index's decision, since it is the index
 * that knows when each attempt ran; prune is told the set to keep, and keeps
 * exactly what the index still holds.
 *
 * An attempt that cannot be read back — a format this version does not
 * recognize, or a damaged file — is reported as absent rather than as empty,
 * so the collector treats it exactly like an attempt that was never stored and
 * collects it again.
 */

import { dirname, join } from "@std/path";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  type CachedCiGanttJob,
  type CachedCiRunReference,
  isCachedGanttJob,
} from "./ci-job-cache.ts";
import { dashboardCacheFile } from "./history-files.ts";

export const CI_GANTT_DETAIL_DIRNAME = "fabric-wall-ci-gantt";

const DETAIL_VERSION = 1;

// The detail sits beside the run index that names it, so one dashboard cache
// directory holds one set of CI history.
export const ganttDetailDirectory = (indexFile: string): string =>
  join(dirname(indexFile), CI_GANTT_DETAIL_DIRNAME);

export interface CiGanttDetailSource {
  repo: string;
  workflow: string;
}

interface StoredCiGanttDetail {
  version: number;
  jobs: CachedCiGanttJob[];
}

const defaultDirectory = (): string =>
  dashboardCacheFile(CI_GANTT_DETAIL_DIRNAME);

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

// Percent-escape everything a repository or workflow name can hold except the
// characters that are already safe in a file name, so that a "." only ever
// appears between the parts of a name and the encoding is one-to-one.
const encodeSegment = (value: string): string =>
  encodeURIComponent(value).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const sourcePrefix = (source: CiGanttDetailSource): string =>
  `${encodeSegment(source.repo)}.${encodeSegment(source.workflow)}`;

const detailName = (
  source: CiGanttDetailSource,
  runId: number,
  runAttempt: number,
): string => `${sourcePrefix(source)}.${runId}.${runAttempt}.json`;

interface ParsedName {
  prefix: string;
  runId: number;
  runAttempt: number;
}

function parseDetailName(name: string): ParsedName | null {
  const parts = name.split(".");
  if (parts.length !== 5 || parts[4] !== "json") return null;
  const runId = Number(parts[2]);
  const runAttempt = Number(parts[3]);
  if (
    !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3]) ||
    !Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt)
  ) return null;
  return { prefix: `${parts[0]}.${parts[1]}`, runId, runAttempt };
}

export class CiGanttDetailStore {
  /**
   * The dashboard cache directory, a function returning it, or `undefined`
   * for the default. A function defers reading the directory until the first
   * request, the way the run index defers reading its own file name.
   */
  #directory: string | (() => string) | undefined;

  #temporaries = new Set<string>();

  constructor(directory?: string | (() => string)) {
    this.#directory = directory;
  }

  get directory(): string {
    const current = this.#directory;
    if (typeof current === "string") return current;
    return this.#directory = current ? current() : defaultDirectory();
  }

  #path(
    source: CiGanttDetailSource,
    runId: number,
    runAttempt: number,
  ): string {
    return join(this.directory, detailName(source, runId, runAttempt));
  }

  async read(
    source: CiGanttDetailSource,
    runId: number,
    runAttempt: number,
  ): Promise<CachedCiGanttJob[] | null> {
    let compressed: Uint8Array;
    try {
      compressed = await Deno.readFile(this.#path(source, runId, runAttempt));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await gunzip(compressed));
    } catch {
      return null;
    }
    if (!isObjectOrArray(parsed)) return null;
    const value = parsed as Partial<StoredCiGanttDetail>;
    if (value.version !== DETAIL_VERSION || !Array.isArray(value.jobs)) {
      return null;
    }
    return value.jobs.every(isCachedGanttJob) ? value.jobs : null;
  }

  async write(
    source: CiGanttDetailSource,
    runId: number,
    runAttempt: number,
    jobs: CachedCiGanttJob[],
  ): Promise<void> {
    const target = this.#path(source, runId, runAttempt);
    // Only the detail directory itself, so a missing dashboard cache directory
    // reports itself here the way it does for the run index.
    try {
      await Deno.mkdir(this.directory);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    const value: StoredCiGanttDetail = { version: DETAIL_VERSION, jobs };
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    this.#temporaries.add(temporary);
    try {
      await Deno.writeFile(temporary, await gzip(JSON.stringify(value)));
      await Deno.rename(temporary, target);
    } catch (error) {
      try {
        await Deno.remove(temporary);
      } catch {
        // Ignore cleanup when no temporary file remains.
      }
      throw error;
    } finally {
      this.#temporaries.delete(temporary);
    }
  }

  /**
   * Drops the attempts of one repository and workflow that `keep` does not
   * name, and removes temporary files a crashed write left behind. Attempts of
   * other repositories are left alone, so pruning one source can never take
   * another's detail. A temporary this process is still writing is left alone.
   */
  async prune(
    source: CiGanttDetailSource,
    keep: Iterable<CachedCiRunReference>,
  ): Promise<void> {
    const wanted = new Set<string>();
    for (const { runId, runAttempt } of keep) {
      wanted.add(`${runId}.${runAttempt}`);
    }
    const prefix = sourcePrefix(source);
    const removals: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.directory)) {
        if (!entry.isFile) continue;
        const parsed = parseDetailName(entry.name);
        if (!parsed) {
          if (
            entry.name.endsWith(".tmp") &&
            !this.#temporaries.has(join(this.directory, entry.name))
          ) removals.push(join(this.directory, entry.name));
          continue;
        }
        if (
          parsed.prefix === prefix &&
          !wanted.has(`${parsed.runId}.${parsed.runAttempt}`)
        ) removals.push(join(this.directory, entry.name));
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const path of removals) {
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
}
