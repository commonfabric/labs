#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-write

/**
 * The publisher: reads the record store, folds what is new into a rolling
 * aggregate, scores everything, and creates one manifest object.
 *
 *   deno run -A tasks/test-selection-publish.ts [--days N] [--bootstrap]
 *     [--out <dir>] [--dry-run] [--concurrency N]
 *
 * A run folds what the newest aggregate it can read does not already
 * hold, which in the steady state is about two thousand objects. A cold
 * start has no aggregate to read and cannot fold three weeks of raw
 * history in one job either, so `--bootstrap` is the one-off that starts
 * from an empty one over a wider window, run by hand.
 *
 * A store with no aggregate under the area at all is the whole of what
 * asks for it. Nothing that happens to a stored aggregate does: the area
 * they are written under is named rather than numbered and does not
 * move, a body written in a shape under this publisher's is read
 * forward, and one this publisher cannot read is passed over for the
 * newest one behind it that it can. A bootstrap in any of those cases
 * would publish from an empty aggregate and throw away the catches the
 * stored ones hold, which accumulate over unbounded history and which no
 * window of records rebuilds.
 *
 * That is the whole of what the flag does. What to read is `inputChoice`
 * asked of each source and date the window covers, and both modes ask it
 * alike; their answers differ because their aggregates differ, and not
 * because one of them chooses inputs a second way.
 *
 * When the publisher fails nothing breaks: the previous manifest is still
 * the newest one and lanes keep using it. A manifest going stale degrades
 * selection slowly rather than failing anything, which is the right
 * direction for a system nothing should gate on.
 */

import { duration } from "./test-selection/duration.ts";
import { join } from "@std/path";
import { ulid } from "@std/ulid";
import {
  createObject,
  gzipText,
  listObjects,
  loadAliasResolver,
  objectUrl,
  readObject,
  type StoredReport,
  testIdentityKey,
  testIdentityOfKey,
} from "@commonfabric/test-support/records";
import {
  ciSubmissionsPrefix,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";
import { rollupShards } from "./test-records-compact.ts";
import { calibrate, laneObservations } from "./test-selection/calibrate.ts";
import {
  type AggregateState,
  buildManifest,
  CI_SOURCE,
  dayOf,
  departed,
  emptyAggregate,
  Fold,
  locateSurfaces,
  parseAggregate,
  partitionOf,
  surfaceName,
  type Unplaced,
} from "./test-selection/build.ts";
import {
  capabilitiesBySuite,
  loadTopology,
  wholeUnits,
} from "./test-topology.ts";
import { baselinesOf, mergeBaselines } from "./test-selection/baselines.ts";
import { measuredCostLines } from "./test-selection/coverage.ts";
import type { Suite } from "./test-topology/suite.ts";
import {
  fetchManifest,
  manifestBody,
  manifestObjectName,
  manifestPrefix,
  newestAtOrBefore,
  stateDayOf,
  stateObjectName,
  statePrefix,
} from "./test-selection/store.ts";
import {
  type CoverageBaseline,
  declaredSchema,
  MANIFEST_SCHEMA_VERSION,
  serializeManifest,
  writtenAhead,
} from "./test-selection/manifest.ts";
import { costliestUnschedulable, plan } from "./test-selection/plan.ts";
import {
  COST_WINDOW_DAYS,
  LANE_BUDGET_SECONDS,
  LANES,
} from "./test-selection/policy.ts";

/**
 * Everything this reaches the world through. The default is the real
 * store; a test supplies its own and exercises the whole publish without
 * a network, which is the only way the path that actually runs in
 * production gets tested at all.
 */
export interface StoreAccess {
  list(prefix: string): Promise<string[]>;
  read(objectName: string): Promise<StoredReport>;
  readText(objectName: string): Promise<string>;
  create(name: string, body: Uint8Array): Promise<void>;

  /**
   * The objects a day's rollup was written as, when the day has a
   * complete one. A day is compacted into shards sized so that a reader
   * can hold what one decompresses to, and the day's manifest — written
   * after every shard it names — is what says the rollup is finished and
   * which shards it holds. Reading those replaces reading the day's
   * thousands of raw objects.
   *
   * Neither mode asks for one because of the flag it was given: the rule
   * asks wherever a source and date is one nothing has been folded from
   * yet. In the steady state the incremental path never reaches such a
   * day, because compaction waits a week for late arrivals and that path
   * reads two days, so in practice this answers a bootstrap and a run
   * catching up after an outage or a widened window.
   *
   * A rollup is a read optimization rather than the record of its day —
   * an object arriving after its shard is written stays in the raw area
   * alone — so a pair taken this way keeps only what the rollup held.
   * That is also what makes a rollup safe to give up on: a day whose
   * shards will not read is read from its raw objects instead, which is
   * how a day with no rollup at all is read, and no record of that day
   * is lost by it. What it costs is in
   * `docs/development/test-selection.md`.
   */
  rollupShards(day: string): Promise<string[] | undefined>;

  /** The credential for creating an object, when one is reachable. */
  token(): string | undefined;
}

/** The store as it really is. */
export function liveStore(bucket: string): StoreAccess {
  return {
    list: (prefix) => listObjects({ bucket, prefix }),
    read: (objectName) => readObject({ bucket, objectName }),
    readText: async (objectName) => {
      const response = await fetch(objectUrl(bucket, objectName));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Transcoded on the way out, so this is already the JSON.
      return await response.text();
    },
    create: async (name, body) => {
      const token = writeToken();
      if (token === undefined) throw new Error("no write credential");
      await createObject({
        bucket,
        name,
        body,
        contentType: "application/json",
        contentEncoding: "gzip",
        token,
      });
    },
    rollupShards: async (day) => {
      try {
        return await rollupShards({ bucket, day });
      } catch {
        return undefined;
      }
    },
    token: writeToken,
  };
}

/**
 * What a run says where it has read part of its window and will not
 * publish from that. A manifest going stale degrades selection slowly,
 * where one built from part of a window scores every identity in the
 * part it missed as though it had not run.
 */
const PARTIAL_WINDOW =
  "test selection: refusing to publish from part of the window. The " +
  "previous manifest is still the newest one.";

/** How many objects are fetched at once. */
const DEFAULT_CONCURRENCY = 24;

/** Days the incremental path looks back over for unfolded objects. */
const DEFAULT_DAYS = 2;

/** Days a bootstrap reads, when no window was asked for. */
const BOOTSTRAP_DAYS = 60;

/** Objects read and folded before the next batch is fetched. */
const CHUNK = 200;

/**
 * Rollup shards read and spooled before the next batch is fetched.
 * Each shard targets eight mebibytes compressed.
 */
export const SHARD_CHUNK = 4;

/** What the command line asked for. */
export interface Options {
  days: number;
  bootstrap: boolean;
  dryRun: boolean;
  out?: string;
  concurrency: number;
}

export function parseArgs(args: readonly string[]): Options | undefined {
  const options: Options = {
    days: DEFAULT_DAYS,
    bootstrap: false,
    dryRun: false,
    concurrency: DEFAULT_CONCURRENCY,
  };
  // A window somebody asked for wins over the one a bootstrap implies,
  // whichever order the two were typed in.
  let daysGiven = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    switch (flag) {
      case "--bootstrap":
        options.bootstrap = true;
        if (!daysGiven) options.days = BOOTSTRAP_DAYS;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--days": {
        const days = Number(args[++i]);
        if (!Number.isInteger(days) || days < 1) return undefined;
        options.days = days;
        daysGiven = true;
        break;
      }
      case "--concurrency": {
        const concurrency = Number(args[++i]);
        if (!Number.isInteger(concurrency) || concurrency < 1) return undefined;
        options.concurrency = concurrency;
        break;
      }
      case "--out": {
        const out = args[++i];
        if (out === undefined) return undefined;
        options.out = out;
        break;
      }
      default:
        return undefined;
    }
  }
  return options;
}

/** The day partitions to list, newest last. */
export function dayPartitions(today: Date, days: number): string[] {
  const partitions: string[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = new Date(today.getTime() - back * 86_400_000);
    partitions.push(day.toISOString().slice(0, 10).replaceAll("-", "/"));
  }
  return partitions;
}

/** Runs a mapper over items, at most `limit` of them at a time. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await map(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Every submission object of the days each area was asked for. A
 * continuous-integration object's day is a path segment, so its day is a
 * prefix and one listing per day is exact. A local object's path puts the
 * reporting person ahead of the day, so that area is listed once and
 * filtered.
 *
 * The two areas are asked for different days because the rule answers
 * differently for them. A continuous-integration day whose rollup is
 * folded owes nothing more; no local day is ever in that position, since
 * rollups cover the continuous-integration area alone.
 */
async function listSubmissions(
  store: StoreAccess,
  ciDays: readonly string[],
  localDays: readonly string[],
): Promise<string[]> {
  const wanted = new Set(localDays);
  const names: string[] = [];
  // A listing that fails is not an empty day. Folding what did list and
  // publishing from it would score every identity in the missing day as
  // though it had not run, and the manifest saying so would become the
  // one every lane obeys. The run ends instead, and the previous manifest
  // stays newest.
  for (const day of ciDays) {
    names.push(...await store.list(`${ciSubmissionsPrefix()}/v1/${day}/`));
  }
  const local = `${storePrefix()}/submissions/local/`;
  for (const name of await store.list(local)) {
    const day = partitionOf(name);
    if (day.length > 0 && wanted.has(day)) names.push(name);
  }
  return [...new Set(names)].sort(byDayThenName);
}

/** What one source and date still owes the aggregate. */
export type InputChoice = "settled" | "rollup" | "raw";

/**
 * What one source and date still has to give, which is the whole of how
 * this program chooses what to read.
 *
 * A bootstrap and an ordinary run apply it alike. A bootstrap is
 * permission to start from an empty aggregate and, by default, a wider
 * window; it is not a second way to choose inputs. Both then ask this of
 * each source and date the window covers, and the answers differ only
 * because the aggregates differ.
 *
 * `settled` — a receipt says this pair's rollup is folded. Rollups of
 * this format carry no record of which arrivals they cover, so nothing
 * can say how much a raw object of that pair would repeat. The pair is
 * closed rather than combined with objects whose overlap is unknown.
 *
 * `rollup` — nothing of this pair is folded and a rollup covers it, so
 * the rollup is the baseline and a receipt is written for it. One object
 * stands in for the day's thousands, which is what makes a cold start
 * over a wide window affordable at all.
 *
 * `raw` — everything else, and two different things reach it. A pair
 * with raw contributions already stays raw, because a rollup written
 * afterwards would overlap them. A pair no rollup covers is raw because
 * there is nothing else to read, which is every local source: rollups
 * cover the continuous-integration area alone.
 */
export function inputChoice(
  known: { settled: boolean; foldedRaw: boolean; rollup: boolean },
): InputChoice {
  if (known.settled) return "settled";
  if (known.foldedRaw || !known.rollup) return "raw";
  return "rollup";
}

/**
 * Orders submission objects the way the fold needs them: by the day they
 * were recorded, then by name. Sorting by name alone would put every
 * local object after every continuous-integration one, because their
 * areas sort that way, and the fold's backward-looking rules would then
 * judge a workstation's failure against a state from days later. Within
 * one day the order between the two areas is arbitrary, which is as fine
 * a grain as the per-day counters have anyway.
 */
export function byDayThenName(left: string, right: string): number {
  const day = partitionOf(left).localeCompare(partitionOf(right));
  return day !== 0 ? day : left.localeCompare(right);
}

/** One state object a run could not read, and what stopped it. */
interface PassedOver {
  /** The object's name, so a reader can go and look at it. */
  name: string;

  /**
   * The shape it declares, for the one fault that names its own remedy:
   * a body written further ahead than this publisher. Undefined for
   * every other fault, which is a body that is not an aggregate at all.
   */
  ahead?: number;
}

/** Why a state was passed over, as a sentence fragment. */
function faultOf({ ahead }: PassedOver): string {
  return ahead === undefined
    ? "it is not an aggregate this publisher understands"
    : `it is written in shape ${ahead}, and this publisher reads shape ` +
      `${MANIFEST_SCHEMA_VERSION}`;
}

/** What reading the rolling aggregate found. */
type AggregateRead =

  /** The state to fold onto, and what was passed over to reach it. */
  | { state: AggregateState; name: string; passedOver: readonly PassedOver[] }
  /** The area holds no state at all, so this would be a first run. */
  | { absent: true }
  /** Nothing to fold onto, with the lines saying what stopped it. */
  | { failed: readonly string[] };

/**
 * Reads the aggregate to fold onto, which is the newest state object
 * this publisher can read.
 *
 * The three outcomes are kept apart because folding into an empty
 * aggregate while a real one exists is the worst thing this program can
 * do. `catches` accumulates over unbounded history and is the whole of
 * what makes a test worth running, and the state object is where that
 * history lives. A run that lost it and carried on would publish a
 * manifest scoring every test at the floor, and because it succeeded that
 * manifest would become the one every lane obeys. Failing is the designed
 * outcome — the previous manifest stays newest and selection decays
 * slowly — so an unreadable state is told apart from an absent one rather
 * than both becoming an empty one.
 *
 * Passing over a state this publisher cannot read is what keeps one from
 * stopping it for good. Nothing but the publisher creates a state, and it
 * creates one only where it folded, so a newest state it cannot read is
 * one every later run comes to in the same condition: a body written in
 * a shape from further ahead, which is what a lowered shape leaves
 * behind, and a body that arrives and is not an aggregate, which the
 * store's create-only credentials mean nothing can replace.
 *
 * A read that does not arrive is neither of those and is refused, as a
 * listing that fails is. It says nothing about the object, so a run that
 * passed over on it would be reading a fault of its own as a fact about
 * the store, and the state it then wrote would supersede the one it
 * skipped for good.
 *
 * `from` is the first day this run reads, and it bounds how far back a
 * state may be passed over. What a passed-over state folded and the one
 * behind it did not comes back from the records, so the walk reaches
 * back over the days this run reads and no further. That bound is the
 * one this run can state rather than an exact account of the gap: the
 * runs that wrote the passed-over states read windows of their own,
 * reaching a day earlier than their own day for as many days as their
 * window held, and a record that arrived for one of those earlier days
 * after the state behind it was written is outside what this run reads.
 * A run that passes over says which state it passed over and which it
 * folded onto, rather than reporting the gap as closed. The newest state
 * is read whatever day it carries, since taking it is not a choice
 * between two aggregates.
 */
async function readAggregate(
  store: StoreAccess,
  from: string,
): Promise<AggregateRead> {
  const prefix = statePrefix();
  let names: string[];
  try {
    // Trailing slash for the reason the manifest listing carries one: a
    // bare prefix matches a longer sibling too.
    names = await store.list(`${prefix}/`);
  } catch (error) {
    return { failed: [`listing ${prefix} failed: ${error}`] };
  }
  // Newest first, which for these names is by the day they carry and
  // then by the identifier the run that created them drew. An object
  // under the prefix named some other way is not one of the publisher's
  // states, so it is neither read as an aggregate nor counted as one.
  const states = names.filter((name) => stateDayOf(name) !== undefined)
    .sort().reverse();
  if (states.length === 0) return { absent: true };
  const passedOver: PassedOver[] = [];
  let cutOff = false;
  for (const [index, name] of states.entries()) {
    if (index > 0 && stateDayOf(name)! < from) {
      cutOff = true;
      break;
    }
    let text: string;
    try {
      text = await store.readText(name);
    } catch (error) {
      return { failed: [`reading ${name} failed: ${error}`] };
    }
    // Parsed here rather than inside each reader, so that one body is
    // parsed once however many questions are asked of it.
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const state = parseAggregate(body);
    if (state !== undefined) return { state, name, passedOver };
    const ahead = writtenAhead(body) ? declaredSchema(body) : undefined;
    passedOver.push({ name, ...(ahead === undefined ? {} : { ahead }) });
  }
  return { failed: refusal(passedOver, cutOff ? from : undefined) };
}

/**
 * What a run says when every state it looked at was one it could not
 * read: each object and its fault, then where there are more states to
 * reach and what reaches them, then the thing not to do.
 *
 * `cutOffAt` is the first day the run reads, given where the day bound
 * is what stopped the walk and absent where the walk ran out of states.
 * Only in the first case are there states behind these at all, and what
 * is said of them is that they are there, since whether one of them
 * reads is what the run that reaches them finds out.
 */
function refusal(
  passedOver: readonly PassedOver[],
  cutOffAt: string | undefined,
): readonly string[] {
  const lines = passedOver.map((entry) => `${entry.name}: ${faultOf(entry)}`);
  const shapes = passedOver.flatMap(({ ahead }) =>
    ahead === undefined ? [] : [ahead]
  );
  if (shapes.length > 0) {
    lines.push(
      `deploy a publisher that reads shape ${Math.max(...shapes)} or ` +
        `above, which is the highest shape any of these is written in`,
    );
  }
  if (cutOffAt !== undefined) {
    lines.push(
      `the states behind these are named for days before ${cutOffAt}, ` +
        `which is the first day this run reads, and --days is what ` +
        `reaches them`,
    );
  }
  lines.push(
    `do not bootstrap before establishing that no stored state reads at ` +
      `all: it starts from an empty aggregate, and the catches the stored ` +
      `states hold accumulate over unbounded history and are not in the ` +
      `records any window reads`,
  );
  return lines;
}

/**
 * The coverage baselines the newest manifest holds, which the next one
 * brings forward. The objects a run folds are the ones no earlier run
 * folded, so the baselines they hold are added to these rather than
 * standing in for them.
 *
 * Throws where the store could not be asked. The objects those baselines
 * came from are ones no later run folds again, so a manifest published
 * without them would hold none of them, and neither would any manifest
 * after it. Where the store answers that it holds no manifest this
 * publisher can read, the baselines start empty, and the ones in objects
 * earlier runs folded come back only from a `--bootstrap`, which folds the
 * window again.
 */
export async function liveBaselines(
  now: Date,
  fetch?: typeof globalThis.fetch,
): Promise<CoverageBaseline[]> {
  const previous = await fetchManifest({
    at: now.toISOString(),
    ...(fetch === undefined ? {} : { fetch }),
  });
  if (previous.unreachable) {
    throw new Error(`reading the previous manifest failed: ${previous.absent}`);
  }
  return previous.manifest?.coverageBaselines ?? [];
}

/**
 * An access token for creating a manifest, when one is reachable. Only
 * the workflow has one: the publisher's identity is federated and pinned
 * to that workflow file, and it is the sole principal holding create on
 * the selection area. A person's own reporting key is scoped to their
 * `submissions/local/<username>/` folder and cannot write a manifest, so
 * there is no fallback to offer — `--dry-run --out` is how a person sees
 * what a run would produce.
 */
export function writeToken(): string | undefined {
  const federated = Deno.env.get("TEST_RECORDS_GCS_TOKEN");
  return federated !== undefined && federated.length > 0
    ? federated
    : undefined;
}

export async function publish(
  args: readonly string[],
  store: StoreAccess = liveStore(storeBucket()),
  now: Date = new Date(),
  topology: () => Promise<readonly Suite[]> = () => loadTopology(),
  baselines: (now: Date) => Promise<CoverageBaseline[]> = liveBaselines,
): Promise<number> {
  const options = parseArgs(args);
  if (options === undefined) {
    console.error(
      "usage: test-selection-publish.ts [--days N] [--bootstrap] " +
        "[--out <dir>] [--dry-run] [--concurrency N]",
    );
    return 2;
  }

  const startedAt = now;
  const today = startedAt.toISOString().slice(0, 10);
  const partitions = dayPartitions(startedAt, options.days);
  let carried: CoverageBaseline[];
  try {
    carried = await baselines(startedAt);
  } catch (error) {
    console.warn(`test selection: ${error}`);
    console.warn(
      "test selection: refusing to publish without the coverage baselines " +
        "the previous manifest carries. The previous manifest is still the " +
        "newest one.",
    );
    return 1;
  }
  let aggregate: AggregateState;
  if (options.bootstrap) {
    aggregate = emptyAggregate(today);
  } else {
    // The first day this run reads, written the way a state object's name
    // writes a day, which is how far back a state may be passed over.
    const read = await readAggregate(
      store,
      partitions[0]!.replaceAll("/", "-"),
    );
    if ("failed" in read) {
      for (const line of read.failed) console.warn(`test selection: ${line}`);
      console.warn(
        "test selection: refusing to publish from an empty aggregate, " +
          "which would score every test at the floor. The previous " +
          "manifest is still the newest one.",
      );
      return 1;
    }
    if ("absent" in read) {
      console.warn(
        "test selection: no aggregate exists yet. A first run reads the " +
          "whole window and is asked for deliberately, with --bootstrap.",
      );
      return 1;
    }
    for (const entry of read.passedOver) {
      console.log(
        `test selection: passing over ${entry.name}: ${faultOf(entry)}`,
      );
    }
    if (read.passedOver.length > 0) {
      console.log(
        `test selection: folding onto ${read.name}, the newest aggregate ` +
          `this publisher can read. What the states above it folded from ` +
          `days this run does not read is not counted.`,
      );
    }
    aggregate = read.state;
  }
  const resolver = await loadAliasResolver();
  const fold = new Fold(aggregate, resolver, today);
  const runs = new Set<string>();
  const found: { attempt: number; baseline: CoverageBaseline }[] = [];
  let commit = "unknown";

  const noteReport = (report: StoredReport): void => {
    for (const group of report.reports) {
      const id = group.context?.ci?.workflowRunId;
      if (id !== undefined) runs.add(id);
      if (group.context?.branch === "main") commit = group.context.commit;
      const attempt = group.context?.ci?.runAttempt ?? 0;
      for (const baseline of baselinesOf(group)) {
        found.push({ attempt, baseline });
      }
    }
  };

  // What each source and date still owes, from the one rule both modes
  // apply. Only the continuous-integration area can answer anything but
  // `raw`, because it is the only one rollups cover, so it is the only
  // one the store is asked about — and it is asked only where the answer
  // could be a rollup, so a run over days it has already read raw asks
  // nothing.
  const rollups = new Map<string, readonly string[]>();
  const ciDays: string[] = [];
  for (const date of partitions) {
    const settled = fold.settled(CI_SOURCE, date);
    const foldedRaw = fold.hasRaw(CI_SOURCE, date);
    const shards = settled || foldedRaw
      ? undefined
      : await store.rollupShards(date);
    switch (
      inputChoice({ settled, foldedRaw, rollup: shards !== undefined })
    ) {
      case "rollup":
        rollups.set(date, shards!);
        break;
      case "raw":
        ciDays.push(date);
        break;
      case "settled":
        break;
    }
  }

  /** Reads and consumes each batch before fetching the next shards. */
  async function* readRollup(shards: readonly string[], concurrency: number) {
    for (let at = 0; at < shards.length; at += SHARD_CHUNK) {
      const reports = await mapConcurrent(
        shards.slice(at, at + SHARD_CHUNK),
        concurrency,
        (objectName) => store.read(objectName),
      );
      for (const report of reports) {
        noteReport(report);
        yield report;
      }
    }
  }

  let settled = 0;
  for (const [date, shards] of rollups) {
    try {
      await fold.addUnordered(readRollup(shards, options.concurrency));
    } catch (error) {
      console.warn(
        `test selection: reading the rollup of ${date} failed: ${error}`,
      );
      // A failure that left part of the day in the fold is the one this
      // cannot read its way out of: reading the day again, by any route,
      // would count that part twice.
      if (!fold.intact) {
        console.warn(PARTIAL_WINDOW);
        return 1;
      }
      // Ending the run here would end every later one the same way: the
      // store holds create and nothing else, so a shard that will not
      // read stays where it is, and the day is never recorded as folded.
      // The day's raw objects are all still there, so it is read the long
      // way instead. The pair is left open rather than settled, so later
      // runs read the day the same way.
      console.warn(
        `test selection: reading ${date} from its raw objects instead, ` +
          `as a day with no rollup is read`,
      );
      ciDays.push(date);
      continue;
    }
    fold.markSettled(CI_SOURCE, date);
    settled++;
  }
  if (rollups.size > 0) {
    console.log(
      `test selection: folded ${settled} of ${rollups.size} day(s) from ` +
        `their rollups`,
    );
  }

  let listed: string[];
  try {
    // Every day of the window for the local area: no local pair is ever
    // settled, so the rule answers `raw` for each of them.
    listed = await listSubmissions(store, ciDays, partitions);
  } catch (error) {
    console.warn(`test selection: listing the submissions failed: ${error}`);
    console.warn(PARTIAL_WINDOW);
    return 1;
  }
  const fresh = listed.filter((name) => !fold.knows(name));
  console.log(
    `test selection: ${listed.length} object(s) under ${ciDays.length} ` +
      `open day(s), ${fresh.length} not yet folded`,
  );

  // Read and fold in chunks rather than all at once. A bootstrap reads
  // tens of thousands of objects, each holding hundreds of executions,
  // and holding them all would be bounded by the number of runs rather
  // than by the number of tests.
  try {
    for (let at = 0; at < fresh.length; at += CHUNK) {
      const chunk = fresh.slice(at, at + CHUNK);
      const reports = await mapConcurrent(
        chunk,
        options.concurrency,
        // A read that fails is not an object with no records, so it is not
        // swallowed: the same partial-history argument as the listing.
        (objectName) => store.read(objectName),
      );
      for (const report of reports) noteReport(report);
      fold.add(reports);
      console.log(
        `test selection: folded ${at + chunk.length} of ${fresh.length} ` +
          `object(s)`,
      );
    }
  } catch (error) {
    console.warn(`test selection: reading a submission failed: ${error}`);
    console.warn(PARTIAL_WINDOW);
    return 1;
  }
  const folded = fold.finish();

  // The topology is what says where an identity runs. Its suite
  // identifiers and units are what a lane looks a suite up by and what
  // the packer charges overheads and capabilities against, so a manifest
  // built without it names surfaces nothing in the tree answers to.
  const suites = await topology();
  const { placed, unplaced } = locateSurfaces(suites, folded.surfaces);
  // A test the tree no longer holds leaves the aggregate here rather
  // than being carried and rescored for the rest of the store's life.
  // The state written below is the one the next run reads, so dropping
  // the entries from it is the whole of what forgetting an identity is.
  const left = departed(suites, unplaced, folded);
  for (const key of left) {
    delete folded.aggregate.states[key];
    delete folded.aggregate.files[key];
    folded.states.delete(key);
  }
  const states = new Map(
    [...folded.states].filter(([key]) => placed.has(key)),
  );

  const manifest = buildManifest({
    states,
    surfaces: placed,
    today,
    generatedAt: startedAt.toISOString(),
    seed: ulid(),
    commit,
    runs: runs.size,
    // What a lane costs beyond the tests it runs, from what lanes have
    // spent. Without it the packer charges nothing for opening a
    // capability, starting a runner, or loading a module, and a lane
    // packed to its budget runs past the bound it is packed to finish
    // inside.
    calibration: calibrate(
      laneObservations(folded.aggregate.lanes ?? []),
    ),
  });
  // What the coverage gate compares a pull request against. The full run on
  // `main` writes the counts as measurements, which the fold passes over,
  // so they are collected beside it.
  // Ordered by attempt, stably, so that of two attempts stamped with one
  // start the later is the one kept.
  manifest.coverageBaselines = mergeBaselines(
    carried,
    found.sort((a, b) => a.attempt - b.attempt).map(({ baseline }) => baseline),
    startedAt,
  );
  manifest.unavailable = suites.flatMap((suite) =>
    suite.unavailable.map((entry) => ({
      suite: suite.id,
      ...(suite.variant === undefined ? {} : { variant: suite.variant }),
      unit: entry.unit,
      ...(entry.leafName === undefined ? {} : { leafName: entry.leafName }),
      ...(entry.phase === undefined ? {} : { phase: entry.phase }),
      reason: entry.reason,
    }))
  );
  const reference = plan({
    manifest,
    mandatory: new Map(),
    capabilities: capabilitiesBySuite(suites),
    wholeUnits: wholeUnits(suites),
  });
  // What the packer refused, from the packer, carrying the cost the bound
  // was compared against rather than a raw one that leaves out every
  // overhead the lane would have paid.
  manifest.unschedulable = reference.unschedulable;
  manifest.lanes = reference.lanes.map((lane) => ({
    lane: lane.lane,
    projectedSeconds: Math.round(lane.projectedSeconds * 10) / 10,
    batches: [...new Set(lane.selections.map((s) => s.entry.suite))].sort()
      .map((suite) => ({
        suite,
        identities: lane.selections
          .filter((s) => s.entry.suite === suite)
          .map((s) => JSON.stringify(s.entry.test)),
      })),
  }));

  summarize(
    manifest,
    suites,
    reference,
    folded.observations,
    unplaced,
    left,
    fold.declined,
  );

  if (options.out !== undefined) {
    await Deno.mkdir(options.out, { recursive: true });
    await Deno.writeTextFile(
      join(options.out, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    await Deno.writeTextFile(
      join(options.out, "state.json"),
      JSON.stringify(folded.aggregate),
    );
    console.log(`test selection: wrote ${options.out}/manifest.json`);
  }
  if (options.dryRun) return 0;

  const token = store.token();
  if (token === undefined) {
    console.warn(
      "test selection: no write credential, so nothing was created. The " +
        "previous manifest is still the newest one.",
    );
    return 0;
  }
  // The manifest first and the state after it. A run that died between
  // the two leaves a manifest whose aggregate is a cycle behind, which
  // the next run folds forward; the other order would leave a state
  // claiming objects no manifest was built from.
  const id = ulid();
  const name = manifestObjectName(manifest.generatedAt, id);
  await store.create(name, await manifestBody(manifest));
  console.log(`test selection: created ${name}`);
  await store.create(
    stateObjectName(today, id),
    await gzipText(JSON.stringify(folded.aggregate)),
  );
  return 0;
}

/** How many of the worst surfaces a summary line names. */
const NAMED_SURFACES = 5;

/**
 * The record surfaces that wrote a set of identities, worst first, as one
 * phrase. The count says how much there is to fix, and the surface says
 * which part of the tree it is in.
 */
export function namingSurfaces(keys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const test = testIdentityOfKey(key);
    if (test === undefined) continue;
    const surface = surfaceName(test);
    counts.set(surface, (counts.get(surface) ?? 0) + 1);
  }
  // By count and then by name, so that two surfaces of the same size come
  // out in the same order every run.
  const ordered = [...counts].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0])
  );
  const named = ordered.slice(0, NAMED_SURFACES).map(([surface, count]) =>
    `${surface} ${count}`
  );
  const rest = ordered.length - named.length;
  return `${ordered.length} surface(s): ${named.join(", ")}` +
    (rest > 0 ? `, and ${rest} more` : "");
}

/** What the job summary says: the shape of what this run decided. */
function summarize(
  manifest: ReturnType<typeof buildManifest>,
  topology: readonly Suite[],
  reference: ReturnType<typeof plan>,
  observations: number,
  unplaced: Unplaced,
  left: readonly string[],
  declined: number,
): void {
  console.log(
    `test selection: folded ${observations} execution(s); the manifest ` +
      `holds ${manifest.entries.length} identities`,
  );
  // Said every run, so that a model nobody measured is as visible as one
  // somebody did. The two halves are counted apart because they come
  // from different records: a lane writes one per capability it opens,
  // and a pair per batch, and a lane killed part way through a batch
  // leaves the pair unmatched and contributes a setup cost alone.
  const withCoverage = Object.keys(
    manifest.calibration.suitesWithCoverage ?? {},
  );
  const suites = new Set([
    ...Object.keys(manifest.calibration.suites),
    ...withCoverage,
  ]).size;
  const measured = withCoverage.length;
  console.log(
    `test selection: the cost model holds ${suites} suite(s) and ` +
      `${Object.keys(manifest.calibration.setupCost).length} ` +
      `capability setup(s), and ${measured} of those suite(s) have a ` +
      `cost with coverage on`,
  );
  // A suite's own figures are what a lane is charged for holding the suite and
  // for opening each of its units, so a model with no suite in it charges
  // nothing for either and a lane packed to its budget runs past the bound it
  // is packed to finish inside. A capability setup is measured from a lane's
  // own records and is unaffected, and the prologue is a fixed dial rather than
  // a measurement, so it is there either way; this names the suites rather than
  // everything a lane is charged. Four things end here — no lane has run, none
  // recorded what it measured, the fold declines the records of the ones that
  // did, or the fold stopped reading a figure it used to read — and the empty
  // map alone says none of them.
  if (suites === 0) {
    console.log(
      `test selection: no suite has a measured cost in the last ` +
        `${COST_WINDOW_DAYS} day(s), so a lane is charged nothing for ` +
        `holding one or for opening its units, and a lane packed against ` +
        `this manifest overruns. See docs/development/test-selection.md.`,
    );
    // Said only where there is a figure to say, so that a run with
    // nothing to report claims nothing. A lane that ran and whose
    // measurement cannot be read is a different thing from a lane that
    // has not run, and it is the one an operator can act on.
    if (declined > 0) {
      console.log(
        `test selection: ${declined} lane measurement(s) this run read ` +
          `came from a run the fold could not place, so the model was ` +
          `fitted without them.`,
      );
    }
  }
  for (const line of measuredCostLines(manifest, topology)) {
    console.log(`test selection: ${line}`);
  }
  if (unplaced.suiteLevel.length > 0) {
    console.log(
      `test selection: ${unplaced.suiteLevel.length} identities measure a ` +
        `whole invocation rather than one unit, so they are left out. The ` +
        `steps inside the invocation are measured separately, so nothing ` +
        `is missing and there is nothing to act on.`,
    );
  }
  if (left.length > 0) {
    console.log(
      `test selection: ${left.length} identities have left the tree: no ` +
        `suite claims them and no run of them has been recorded inside ` +
        `the window a state keeps counters for. Their states are dropped ` +
        `from the aggregate.`,
    );
    console.log(
      `test selection: those ${left.length} were recorded by ` +
        `${namingSurfaces(left)}`,
    );
  }
  const gone = new Set(left);
  const unclaimed = unplaced.unclaimed.filter((key) => !gone.has(key));
  if (unclaimed.length > 0) {
    console.log(
      `test selection: no suite claims ${unclaimed.length} identities the ` +
        `aggregate still carries, so no lane can be asked to run one. ` +
        `Each has run inside the window a state keeps counters for, or a ` +
        `configuration declares its unit unavailable. What puts an ` +
        `identity here, and what takes it out again, is in ` +
        `docs/development/test-selection.md.`,
    );
    console.log(
      `test selection: those ${unclaimed.length} were recorded ` +
        `by ${namingSurfaces(unclaimed)}`,
    );
  }
  if (unplaced.contested.length > 0) {
    console.log(
      `test selection: ${unplaced.contested.length} identities are ` +
        `claimed by more than one suite, which is a topology defect the ` +
        `drift guard fails on. They are left out rather than placed in ` +
        `whichever suite came first.`,
    );
    console.log(
      `test selection: those ${unplaced.contested.length} were recorded ` +
        `by ${namingSurfaces(unplaced.contested)}`,
    );
  }
  const held = new Map<string, number>();
  for (const entry of manifest.withheld) {
    held.set(entry.reason, (held.get(entry.reason) ?? 0) + 1);
  }
  for (const [reason, count] of [...held].sort()) {
    console.log(`test selection: ${count} withheld as ${reason}`);
  }
  const times = reference.lanes.map((lane) => lane.projectedSeconds);
  for (const lane of reference.lanes) {
    console.log(
      `test selection: lane ${lane.lane} would run ` +
        `${lane.selections.length} test(s) in ` +
        `${duration(lane.projectedSeconds)} of ${
          duration(LANE_BUDGET_SECONDS)
        }`,
    );
  }
  if (times.length > 0) {
    const spread = Math.max(...times) - Math.min(...times);
    console.log(
      `test selection: ${LANES} lanes, spread ${duration(spread)}`,
    );
  }
  const selected = reference.lanes.reduce(
    (total, lane) => total + lane.selections.length,
    0,
  );
  console.log(
    `test selection: ${selected} of ${manifest.entries.length} identities ` +
      `fit the budget`,
  );
  // The count and the surfaces say how much there is and where.
  const { named, rest } = costliestUnschedulable(reference.unschedulable);
  for (const entry of named) {
    console.log(
      `test selection: unschedulable, ${duration(entry.cost)}: ` +
        JSON.stringify(entry.test),
    );
  }
  if (rest.length > 0) {
    console.log(
      `test selection: ${rest.length} further identities cost more than a ` +
        `lane can hold, recorded by ` +
        `${namingSurfaces(rest.map((entry) => testIdentityKey(entry.test)))}`,
    );
  }
}

// Re-exported so an offline check can build the same day list.
export {
  dayOf,
  manifestPrefix,
  newestAtOrBefore,
  partitionOf,
  serializeManifest,
};

if (import.meta.main) {
  Deno.exit(await publish(Deno.args));
}
