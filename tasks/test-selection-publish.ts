#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-write

/**
 * The publisher: reads the record store, folds what is new into a rolling
 * aggregate, scores everything, and creates one manifest object.
 *
 *   deno run -A tasks/test-selection-publish.ts [--days N] [--bootstrap]
 *     [--out <dir>] [--dry-run] [--concurrency N]
 *   deno run -A tasks/test-selection-publish.ts --create <dir>
 *
 * `--create <dir>` creates the manifest and the aggregate a
 * `--dry-run --out <dir>` run wrote, and reads nothing else. The fold
 * needs no credential, so it can finish, however long it takes, before
 * the credential for creating is obtained.
 *
 * A run folds what the newest aggregate it can read does not already
 * hold, from the last day that aggregate read. A cold start has no
 * aggregate to read, so `--bootstrap` starts from nothing over a wider
 * window, run by hand. It refuses over a store holding an aggregate any
 * publisher can read. Its new real test failures accumulate over
 * unbounded history, and no window of records rebuilds them.
 *
 * A store with no aggregate under the area at all is what asks for it.
 * Nothing that happens to a stored aggregate does: the area they are
 * written under is named rather than numbered and does not move, a body
 * written in a shape under this publisher's is read forward, and one this
 * publisher cannot read is passed over for the newest one behind it that
 * it can.
 *
 * A stored aggregate whose new real test failures were credited under
 * rules other than these (see `NEW_REAL_TEST_FAILURE_RULE`) is the one an
 * ordinary run does not fold onto. It folds every day that aggregate's
 * history holds again instead, into an empty one, since a new real test
 * failure is held as a count that cannot be judged again by itself, and
 * every record behind it is still in the store.
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
import { maxOf, minOf } from "@commonfabric/utils/math";
import {
  ciSubmissionsPrefix,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";
import { rollupShards } from "./test-records-compact.ts";
import { calibrate, laneObservations } from "./test-selection/calibrate.ts";
import { calibrationHealth, healthLines } from "./test-selection/health.ts";
import {
  type AggregateState,
  buildManifest,
  CI_SOURCE,
  coldStart,
  dayOf,
  departed,
  emptyAggregate,
  firstDay,
  Fold,
  lastReadDay,
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
import {
  daysBetween,
  NEW_REAL_TEST_FAILURE_RULE,
} from "./test-selection/score.ts";
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
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
  writtenAhead,
} from "./test-selection/manifest.ts";
import { costliestUnschedulable, plan } from "./test-selection/plan.ts";
import { gatesOf } from "./test-selection/census.ts";
import {
  COST_WINDOW_DAYS,
  LANE_BUDGET_SECONDS,
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
   * catching up after an outage.
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

/**
 * The shortest window the incremental path reads, and how far back it
 * passes over a stored state it cannot read. It reads from the last day
 * its aggregate read where that reaches further.
 */
const DEFAULT_DAYS = 2;

/** Days a bootstrap reads, when no window was asked for. */
const BOOTSTRAP_DAYS = 60;

/** Raw objects read before the next batch is fetched. */
export const CHUNK = 200;

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
  /** A directory a `--dry-run --out` run wrote, to create from. */
  create?: string;
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
      case "--create": {
        const create = args[++i];
        if (create === undefined) return undefined;
        options.create = create;
        break;
      }
      default:
        return undefined;
    }
  }
  // Creating reads nothing but the directory, so every other flag
  // alongside it is one it would ignore.
  if (options.create !== undefined && args.length !== 2) return undefined;
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
 * Every local submission object of the days given. A local object's path
 * puts the reporting person ahead of the day, so that area is listed once
 * and filtered.
 */
async function listLocal(
  store: StoreAccess,
  days: readonly string[],
): Promise<string[]> {
  const wanted = new Set(days);
  const names: string[] = [];
  for (const name of await store.list(`${storePrefix()}/submissions/local/`)) {
    const day = partitionOf(name);
    if (day.length > 0 && wanted.has(day)) names.push(name);
  }
  return names;
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
  /** The store did not answer, with the line saying what it was asked. */
  | { unreachable: string }
  /**
   * Every state looked at was one this cannot read. `cutOffAt` is the
   * first day the run reads, given where the day bound is what stopped
   * the walk and absent where the walk ran out of states.
   */
  | { unreadable: readonly PassedOver[]; cutOffAt?: string };

/**
 * Reads the aggregate to fold onto, which is the newest state object
 * this publisher can read.
 *
 * The outcomes are kept apart because folding into an empty aggregate while a
 * real one exists is the worst thing this program can do. `catches` accumulates
 * over unbounded history and is the whole of what makes a test worth running,
 * and the state object is where that history lives. A run that lost it and
 * carried on would publish a manifest scoring every test at the floor, and
 * because it succeeded that manifest would become the one every lane obeys.
 * Failing is the designed outcome — the previous manifest stays newest and
 * selection decays slowly — so an unreadable state is told apart from an absent
 * one rather than both becoming an empty one.
 *
 * A run starts from an empty aggregate while a state exists in two cases.
 * An incremental run folds every day of a state's history into one when
 * the state's new real test failures were credited under other rules (see
 * `NEW_REAL_TEST_FAILURE_RULE`), which reads every record those came from,
 * so none of them is lost. A bootstrap starts from one where this publisher
 * can read no state and none is written in a shape from further ahead,
 * which a publisher at that shape would read.
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
 * `from` is the first day of the window an incremental run was asked for, and
 * it bounds how far back a state may be passed over; the run then reads further
 * back where the state it folds onto last read a day before that. A bootstrap
 * gives none, since a state of any day it can read is one it refuses over. What
 * a passed-over state folded and the one behind it did not comes back from the
 * records, so the walk reaches back over the days this run reads and no
 * further. That bound is the one this run can state rather than an exact
 * account of the gap: the runs that wrote the passed-over states read windows
 * of their own, reaching a day earlier than their own day for as many days as
 * their window held, and a record that arrived for one of those earlier days
 * after the state behind it was written is outside what this run reads. A run
 * that passes over says which state it passed over and which it folded onto,
 * rather than reporting the gap as closed. The newest state is read whatever
 * day it carries, since taking it is not a choice between two aggregates.
 */
async function readAggregate(
  store: StoreAccess,
  from: string | undefined,
): Promise<AggregateRead> {
  const prefix = statePrefix();
  let names: string[];
  try {
    // Trailing slash for the reason the manifest listing carries one: a
    // bare prefix matches a longer sibling too.
    names = await store.list(`${prefix}/`);
  } catch (error) {
    return { unreachable: `listing ${prefix} failed: ${error}` };
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
    if (index > 0 && from !== undefined && stateDayOf(name)! < from) {
      cutOff = true;
      break;
    }
    let text: string;
    try {
      text = await store.readText(name);
    } catch (error) {
      return { unreachable: `reading ${name} failed: ${error}` };
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
  return {
    unreadable: passedOver,
    ...(cutOff && from !== undefined ? { cutOffAt: from } : {}),
  };
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
    const highest = maxOf(shapes);
    lines.push(
      `deploy a publisher that reads shape ${highest} or ` +
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
    `a bootstrap reads every stored state, of any day, and refuses where ` +
      `one reads or one is written in a shape from further ahead; it ` +
      `starts from nothing only where none is either`,
  );
  return lines;
}

/**
 * The newest manifest, which the one this run creates follows. Its
 * coverage baselines are brought forward, and its charges are what this
 * run's are compared with. The objects a run folds are the ones no
 * earlier run folded, so the baselines they hold are added to its
 * baselines rather than standing in for them.
 *
 * Throws where the store could not be asked. The objects those baselines
 * came from are ones no later run folds again, so a manifest published
 * without them would hold none of them, and neither would any manifest
 * after it. Where the store answers that it holds no manifest this
 * publisher can read, there is nothing to follow: the baselines start
 * empty, and the ones in objects earlier runs folded do not come back.
 */
export async function livePrevious(
  now: Date,
  fetch?: typeof globalThis.fetch,
): Promise<Manifest | undefined> {
  const previous = await fetchManifest({
    at: now.toISOString(),
    ...(fetch === undefined ? {} : { fetch }),
  });
  if (previous.unreachable) {
    throw new Error(`reading the previous manifest failed: ${previous.absent}`);
  }
  return previous.manifest;
}

/**
 * The aggregate a run folds into, with the name of the stored state it
 * came from, or undefined where the run must stop, having said why.
 *
 * An incremental run folds onto the newest state it can read and stops
 * where there is none. A bootstrap is the run for a store holding no
 * aggregate any publisher can read: it starts from nothing, and refuses
 * over a store holding one, since a run folding onto that aggregate
 * keeps every new real test failure it holds and starting from nothing
 * keeps none. A state written in a shape from further ahead is history a
 * publisher can read once it is deployed, so a bootstrap stops at one of
 * those too.
 */
async function aggregateToFold(
  store: StoreAccess,
  options: Options,
  partitions: readonly string[],
  today: string,
): Promise<{ aggregate: AggregateState; name?: string } | undefined> {
  // The first day this run reads, written the way a state object's name
  // writes a day, which is how far back an incremental run may pass a
  // state over.
  const from = partitions[0]!.replaceAll("/", "-");
  const read = await readAggregate(
    store,
    options.bootstrap ? undefined : from,
  );
  if ("unreachable" in read) {
    console.warn(`test selection: ${read.unreachable}`);
    console.warn(
      "test selection: refusing to publish without reading the stored " +
        "aggregates. The previous manifest is still the newest one.",
    );
    return undefined;
  }
  if ("state" in read && options.bootstrap) {
    // An incremental run reads the newest state whatever its day, and
    // passes over a later one only inside its window.
    const reach = daysBetween(stateDayOf(read.name)!, today) + 1;
    const widen = read.passedOver.length > 0 && reach > DEFAULT_DAYS;
    console.warn(
      `test selection: ${read.name} is an aggregate this publisher can ` +
        `read, and a bootstrap would throw away every new real test ` +
        `failure it holds. Run without --bootstrap to fold onto it` +
        (widen ? `, with --days ${reach} to reach it.` : "."),
    );
    return undefined;
  }
  if ("unreadable" in read) {
    const ahead = read.unreadable.some(({ ahead }) => ahead !== undefined);
    if (!options.bootstrap || ahead) {
      for (const line of refusal(read.unreadable, read.cutOffAt)) {
        console.warn(`test selection: ${line}`);
      }
      console.warn(
        "test selection: refusing to publish from an empty aggregate, " +
          "which would score every test at the floor. The previous " +
          "manifest is still the newest one.",
      );
      return undefined;
    }
  }
  if ("absent" in read && !options.bootstrap) {
    console.warn(
      "test selection: no aggregate exists yet. A first run reads the " +
        "whole window and is asked for deliberately, with --bootstrap.",
    );
    return undefined;
  }
  if (!("state" in read)) {
    for (const entry of "unreadable" in read ? read.unreadable : []) {
      console.log(
        `test selection: passing over ${entry.name}: ${faultOf(entry)}`,
      );
    }
    console.log(
      "absent" in read
        ? "test selection: the store holds no aggregate, so this bootstrap " +
          "starts from nothing"
        : "test selection: no stored aggregate can be read by any " +
          "publisher, so this bootstrap starts from nothing",
    );
    return { aggregate: coldStart(partitions[0]!, today) };
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
  return { aggregate: read.state, name: read.name };
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
  previousManifest: (now: Date) => Promise<Manifest | undefined> = livePrevious,
): Promise<number> {
  const options = parseArgs(args);
  if (options === undefined) {
    console.error(
      "usage: test-selection-publish.ts [--days N] [--bootstrap] " +
        "[--out <dir>] [--dry-run] [--concurrency N] | --create <dir>",
    );
    return 2;
  }
  if (options.create !== undefined) {
    return await createFrom(options.create, store);
  }

  const startedAt = now;
  const today = startedAt.toISOString().slice(0, 10);
  const asked = dayPartitions(startedAt, options.days);
  let previous: Manifest | undefined;
  try {
    previous = await previousManifest(startedAt);
  } catch (error) {
    console.warn(`test selection: ${error}`);
    console.warn(
      "test selection: refusing to publish without the coverage baselines " +
        "the previous manifest carries. The previous manifest is still the " +
        "newest one.",
    );
    return 1;
  }
  const chosen = await aggregateToFold(store, options, asked, today);
  if (chosen === undefined) return 1;
  let aggregate = chosen.aggregate;
  // An incremental run reads from the last day its aggregate read, however
  // far back that is, so that a stopped publisher catches up on its own
  // and no day is left unread behind the days it folds. That day is read
  // again because the run that read it read it before it was over; what
  // that run folded is passed over.
  let from = lastReadDay(aggregate);
  if (
    !options.bootstrap && aggregate.catchRule !== NEW_REAL_TEST_FAILURE_RULE
  ) {
    // Its new real test failures were credited under other rules and are
    // held as counts, which cannot be judged again by themselves. Every
    // record behind them is still in the store, so all of them are folded
    // again into an empty aggregate.
    const since = firstDay(aggregate) ?? today;
    console.log(
      `test selection: ${chosen.name} credited its new real test failures ` +
        `under other rules, so this run folds every day from ${since} again`,
    );
    from = since.replaceAll("-", "/");
    aggregate = emptyAggregate(today);
  }
  const partitions = options.bootstrap || from >= asked[0]!
    ? asked
    : dayPartitions(
      startedAt,
      daysBetween(from.replaceAll("/", "-"), today) + 1,
    );
  if (partitions !== asked && aggregate === chosen.aggregate) {
    console.log(
      `test selection: reading from ${from}, the last day the aggregate ` +
        `read`,
    );
  }
  const resolver = await loadAliasResolver();
  const fold = new Fold(aggregate, resolver, today);
  if (fold.resolved > 0) {
    console.log(
      `test selection: moved the history of ${fold.resolved} identities ` +
        `to the names the alias file gives them`,
    );
  }
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
  // Every day of the window for the local area: no local pair is ever
  // settled, so the rule answers `raw` for each of them.
  let local: string[];
  try {
    local = await listLocal(store, partitions);
  } catch (error) {
    console.warn(`test selection: listing the submissions failed: ${error}`);
    console.warn(PARTIAL_WINDOW);
    return 1;
  }

  const concurrency = options.concurrency;

  /**
   * Reads a day's rollup, consuming each batch before fetching the next
   * shards, and then the day's local submissions.
   */
  async function* readRollup(
    shards: readonly string[],
    locals: readonly string[],
  ) {
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
    const reports = await mapConcurrent(
      locals,
      concurrency,
      (objectName) => store.read(objectName),
    );
    for (const report of reports) {
      noteReport(report);
      yield report;
    }
  }

  /**
   * Reads a day's raw objects a chunk at a time, consuming each before
   * fetching the next. A day holds thousands of objects, each holding
   * hundreds of executions, and holding them all would be bounded by the
   * number of runs rather than by the number of tests.
   */
  async function* readRaw(names: readonly string[]) {
    for (let at = 0; at < names.length; at += CHUNK) {
      const reports = await mapConcurrent(
        names.slice(at, at + CHUNK),
        concurrency,
        // A read that fails is not an object with no records, so it is
        // not swallowed: the same partial-history argument as the
        // listing.
        (objectName) => store.read(objectName),
      );
      for (const report of reports) {
        noteReport(report);
        yield report;
      }
    }
  }

  // The window is folded one day at a time, oldest first, whichever way each
  // day is read. The rules that decide whether a failure is a new real test
  // failure look a day or two either side of it, and back at what the default
  // branch last said, so a day folded after a later one would be judged against
  // what happened after it.
  //
  // How each day is read is settled for the whole window before any of it
  // is folded, so a rollup the compactor writes while this run is folding
  // is left for a later run rather than taken part way through.
  const choices: Array<{
    date: string;
    choice: InputChoice;
    shards?: readonly string[];
  }> = [];
  for (const date of partitions) {
    const settled = fold.settled(CI_SOURCE, date);
    const foldedRaw = fold.hasRaw(CI_SOURCE, date);
    const shards = settled || foldedRaw
      ? undefined
      : await store.rollupShards(date);
    const choice = inputChoice({
      settled,
      foldedRaw,
      rollup: shards !== undefined,
    });
    choices.push({ date, choice, ...(shards === undefined ? {} : { shards }) });
  }
  let rollupDays = 0;
  let fromRollups = 0;
  for (const { date, choice, shards } of choices) {
    const locals = local.filter((name) => partitionOf(name) === date);
    if (choice === "rollup" && shards !== undefined) {
      rollupDays++;
      try {
        // The day's local submissions go into the same batch, which the
        // fold replays in time order.
        await fold.addUnordered(readRollup(shards, locals));
        fold.markSettled(CI_SOURCE, date);
        fromRollups++;
        continue;
      } catch (error) {
        console.warn(
          `test selection: reading the rollup of ${date} failed: ${error}`,
        );
        // A failure that left part of the day in the fold is the one this
        // cannot read its way out of: reading the day again, by any
        // route, would count that part twice.
        if (!fold.intact) {
          console.warn(PARTIAL_WINDOW);
          return 1;
        }
        // Ending the run here would end every later one the same way:
        // the store holds create and nothing else, so a shard that will
        // not read stays where it is, and the day is never recorded as
        // folded. The day's raw objects are all still there, so it is
        // read the long way instead. The pair is left open rather than
        // settled, so later runs read the day the same way.
        console.warn(
          `test selection: reading ${date} from its raw objects instead, ` +
            `as a day with no rollup is read`,
        );
      }
    }

    let names: string[];
    try {
      // A listing that fails is not an empty day. Folding what did list
      // and publishing from it would score every identity in the missing
      // day as though it had not run, and the manifest saying so would
      // become the one every lane obeys. The run ends instead, and the
      // previous manifest stays newest.
      names = choice === "settled"
        ? locals
        : (await store.list(`${ciSubmissionsPrefix()}/v1/${date}/`))
          .concat(locals);
    } catch (error) {
      console.warn(`test selection: listing the submissions failed: ${error}`);
      console.warn(PARTIAL_WINDOW);
      return 1;
    }
    const fresh = [...new Set(names)]
      .filter((name) => !fold.knows(name))
      .sort();
    // Folded as one batch, which the fold replays in time order as it does
    // a rollup's day, since the names sort by area before time.
    try {
      await fold.addUnordered(readRaw(fresh));
    } catch (error) {
      console.warn(`test selection: reading a submission failed: ${error}`);
      console.warn(PARTIAL_WINDOW);
      return 1;
    }
    if (fresh.length > 0) {
      console.log(
        `test selection: folded ${fresh.length} object(s) of ${date}`,
      );
    }
  }
  if (rollupDays > 0) {
    console.log(
      `test selection: folded ${fromRollups} of ${rollupDays} day(s) from ` +
        `their rollups`,
    );
  }
  const folded = fold.finish({
    from: partitions[0]!,
    through: partitions.at(-1)!,
  });

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
  const observed = laneObservations(folded.aggregate.lanes ?? []);

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
    calibration: calibrate(observed, folded.aggregate.hooks),
  });
  // What the coverage gate compares a pull request against. The full run on
  // `main` writes the counts as measurements, which the fold passes over,
  // so they are collected beside it.
  // Ordered by attempt, stably, so that of two attempts stamped with one
  // start the later is the one kept.
  manifest.coverageBaselines = mergeBaselines(
    previous?.coverageBaselines ?? [],
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
  const capabilities = capabilitiesBySuite(suites);
  const reference = plan({
    manifest,
    mandatory: new Map(),
    capabilities,
    wholeUnits: wholeUnits(suites),
    // The gates of no change, so that none is packed as a lane's work and
    // none is chosen.
    gates: gatesOf(suites, manifest.entries, manifest.entries, new Set()),
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
  // Whether the model this manifest carries still describes the lanes.
  // Nothing obeys it, so the manifest is published whatever it says, and
  // the dashboard's test selection tile is what shows it.
  manifest.health = calibrationHealth({
    manifest,
    previous,
    capabilities,
    observations: observed,
  });

  for (const line of healthLines(manifest.health)) {
    console.log(`test selection: ${line}`);
  }
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
  return await create(store, manifest, JSON.stringify(folded.aggregate));
}

/**
 * Creates the manifest and the aggregate a `--dry-run --out` run wrote
 * to a directory. Both are read back and checked before anything is
 * created, so a directory holding anything else creates nothing.
 */
async function createFrom(dir: string, store: StoreAccess): Promise<number> {
  const manifest = parseManifest(
    await Deno.readTextFile(join(dir, "manifest.json")),
  );
  const state = await Deno.readTextFile(join(dir, "state.json"));
  if (manifest === undefined || parseAggregate(state) === undefined) {
    console.error(
      `test selection: ${dir} does not hold a manifest and an aggregate ` +
        "this publisher wrote, so nothing was created. The previous " +
        "manifest is still the newest one.",
    );
    return 1;
  }
  return await create(store, manifest, state);
}

/** Creates one manifest and the aggregate it was built from. */
async function create(
  store: StoreAccess,
  manifest: Manifest,
  state: string,
): Promise<number> {
  if (store.token() === undefined) {
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
    stateObjectName(manifest.generatedAt.slice(0, 10), id),
    await gzipText(state),
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
    const spread = maxOf(times) - minOf(times);
    console.log(
      `test selection: ${reference.lanes.length} lanes, spread ` +
        duration(spread),
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
