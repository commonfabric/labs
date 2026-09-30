#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

/**
 * The reader-side reports over the record store: name collisions,
 * high-churn identities, and tests over the sixty-second rule. Reads only
 * the decision-grade ci/ prefix, whose writer credential never leaves
 * Google-managed federation, and needs no credential itself — the store is
 * public.
 *
 *   deno run -A tasks/test-records-report.ts [--days N] [--gate]
 *
 * --gate turns the over-60-seconds report into an exit status, the ratchet
 * the design document describes; it stays advisory until the violator list
 * is short enough for someone to flip the flag in CI. It exits 3 rather
 * than 1 for a window that was not read in full, which is a ratchet that
 * could not check rather than one that failed.
 *
 * A day of the store holds tens of thousands of objects, so a whole-day
 * read is tens of thousands of requests and a transient network failure
 * among them is ordinary. One object that cannot be read is named, counted,
 * and left out; the report covers the rest.
 */

import { pooledMap } from "@std/async/pool";

import {
  type AliasResolver,
  datePartition,
  listObjects,
  loadAliasResolver,
  readObject,
  type StoredReport,
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import { isLaneMeasurement } from "./lane-measurement.ts";
import { ciSubmissionsPrefix, storeBucket } from "./test-records-config.ts";

/** A test's aggregate over the report window. */
export interface IdentityAggregate {
  key: string;
  runs: number;
  failures: number;
  skips: number;

  /** The worst duration among the identity's passing executions. */
  maxDurationMs: number;
}

export function identityKey(test: TestIdentity): string {
  return testIdentityKey(test);
}

export function formatIdentity(key: string): string {
  const [k, s, n, variant] = JSON.parse(key) as [
    string,
    string,
    string,
    string?,
  ];
  const suffix = variant === undefined ? "" : ` (variant: ${variant})`;
  return `[${k}] ${s}: ${n}${suffix}`;
}

/**
 * Aggregates every record of a run by identity, leaving out the lane's
 * measurements of itself. Identities are resolved through the alias file
 * as of each report's own start day, so a renamed test's history
 * aggregates under its current name.
 *
 * A lane's own measurements are not test surfaces: nothing enumerates
 * them and no lane can be asked to run one, so an aggregate over them
 * counts runs of nothing. Their figures are not durations either — one
 * sums what a batch's own tests took and another counts the units it
 * opened — so summing them alongside a test's duration reports a number
 * that means nothing.
 *
 * The duration is taken from passing executions alone. A failure ended
 * where the failure was reached, and where a wait's safety net ended it,
 * the figure is that net's bound rather than anything about the test.
 * The run, failure and skip counts read every record, which is what
 * those counters are for.
 */
export function aggregate(
  reports: readonly StoredReport[],
  aliases?: AliasResolver,
): Map<string, IdentityAggregate> {
  const byIdentity = new Map<string, IdentityAggregate>();
  for (const report of reports) {
    const day = report.context !== undefined
      ? datePartition(report.context.startedAt)
      : undefined;
    for (const record of report.records) {
      if (isLaneMeasurement(record.test)) continue;
      const test = aliases !== undefined && day !== undefined
        ? aliases.resolve(record.test, day)
        : record.test;
      const key = identityKey(test);
      let entry = byIdentity.get(key);
      if (entry === undefined) {
        entry = { key, runs: 0, failures: 0, skips: 0, maxDurationMs: 0 };
        byIdentity.set(key, entry);
      }
      entry.runs++;
      if (record.outcome === "fail") entry.failures++;
      if (record.outcome === "skip") entry.skips++;
      if (record.outcome !== "pass") continue;
      entry.maxDurationMs = Math.max(entry.maxDurationMs, record.durationMs);
    }
  }
  return byIdentity;
}

/**
 * Collisions: one identity reported more than once inside a single
 * uploaded object — two records of one test in one job.
 */
export function collisions(
  reports: readonly StoredReport[],
): { objectName: string; key: string; count: number }[] {
  const found: { objectName: string; key: string; count: number }[] = [];
  for (const report of reports) {
    const counts = new Map<string, number>();
    for (const record of report.records) {
      const key = identityKey(record.test);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) {
        found.push({ objectName: report.objectName, key, count });
      }
    }
  }
  return found;
}

/**
 * High-churn identity families: identities that appear in only one run of
 * the window, grouped by their name with digit runs collapsed. A family
 * with several one-run members is a name built from a counter, a position,
 * or an interpolated value — the shapes the design document tells authors
 * to avoid.
 */
export function churnFamilies(
  byIdentity: ReadonlyMap<string, IdentityAggregate>,
  windowRuns: number,
): { family: string; members: number }[] {
  if (windowRuns < 2) return [];
  const families = new Map<string, number>();
  for (const entry of byIdentity.values()) {
    if (entry.runs > 1) continue;
    const family = entry.key.replaceAll(/\d+/g, "#");
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  return [...families.entries()]
    .filter(([, members]) => members >= 3)
    .map(([family, members]) => ({ family, members }))
    .sort((a, b) => b.members - a.members);
}

/**
 * Identities whose worst passing CI duration crossed the sixty-second
 * rule.
 */
export function overSixtySeconds(
  byIdentity: ReadonlyMap<string, IdentityAggregate>,
): IdentityAggregate[] {
  return [...byIdentity.values()]
    .filter((entry) => entry.maxDurationMs > 60_000)
    .sort((a, b) => b.maxDurationMs - a.maxDurationMs);
}

/** The report window's partitions, newest first. */
export function recentDatePrefixes(
  days: number,
  now: number = Date.now(),
): string[] {
  const prefixes: string[] = [];
  for (let back = 0; back < days; back++) {
    const day = new Date(now - back * 24 * 60 * 60 * 1000);
    prefixes.push(datePartition(day.toISOString()));
  }
  return prefixes;
}

export interface ReportOptions {
  days: number;
  gate: boolean;
  bucket: string;
  prefix: string;
  fetchImpl?: typeof fetch;
  aliases?: AliasResolver;
  now?: number;
}

/** How many objects are read at once. */
const READ_CONCURRENCY = 16;

/** How many of the objects that could not be read are named. */
const NAMED_FAILURES = 50;

/**
 * Reads the window, prints the reports, and returns the status the
 * command exits with.
 *
 * Without `--gate` that is always 0. With it, 1 says the ratchet failed,
 * because a test crossed the sixty-second rule and there is work to do.
 * 3 says the ratchet could not check, because the window was read without
 * some of its objects; a run that is both exits 1, since a violation
 * found is work to do whatever else went unread. 2 belongs to a malformed
 * command line, which `parseReportArgs` reports.
 *
 * A day that cannot be listed and an object that cannot be read are each
 * left out rather than ending the run. Every such day is named on the
 * standard error stream, as are the first `NAMED_FAILURES` such objects,
 * after which one line says the rest are not named. The printed report
 * counts the objects it could not read, however many were named, and the
 * days it could not list, whose objects it has no count of. Every figure
 * under those counts is over the objects that were read.
 */
export async function runReport(options: ReportOptions): Promise<number> {
  const { bucket, prefix, days } = options;
  const names: string[] = [];
  let unlistedDays = 0;
  for (const day of recentDatePrefixes(days, options.now)) {
    const listOptions: Parameters<typeof listObjects>[0] = {
      bucket,
      prefix: `${prefix}/v1/${day}/`,
    };
    if (options.fetchImpl !== undefined) listOptions.fetch = options.fetchImpl;
    try {
      // Appended rather than spread: `push(...names)` makes every name
      // of a day's listing a separate argument, and V8 caps how many
      // arguments one call takes where nothing caps a day's partition.
      for (const name of await listObjects(listOptions)) names.push(name);
    } catch (error) {
      unlistedDays++;
      console.warn(`listing \`${day}\` failed: ${error}`);
    }
  }
  console.log(
    `${names.length} object(s) under ${prefix} in the last ${days} day(s).`,
  );
  if (unlistedDays > 0) {
    console.log(
      `${unlistedDays} day(s) could not be listed, so an unknown number of ` +
        "objects are missing from that count.",
    );
  }
  let unread = 0;
  const readOne = async (
    objectName: string,
  ): Promise<StoredReport | undefined> => {
    const readOptions: Parameters<typeof readObject>[0] = {
      bucket,
      objectName,
    };
    if (options.fetchImpl !== undefined) readOptions.fetch = options.fetchImpl;
    try {
      return await readObject(readOptions);
    } catch (error) {
      unread++;
      if (unread <= NAMED_FAILURES) {
        console.warn(`leaving \`${objectName}\` out: ${error}`);
      } else if (unread === NAMED_FAILURES + 1) {
        console.warn(
          `objects left out past the first ${NAMED_FAILURES} are not named.`,
        );
      }
      return undefined;
    }
  };
  const reports =
    (await Array.fromAsync(pooledMap(READ_CONCURRENCY, names, readOne)))
      .filter((report) => report !== undefined);
  const incomplete = unread > 0 || unlistedDays > 0;
  console.log(
    `${reports.length} object(s) read, ${unread} could not be read.`,
  );
  if (incomplete) {
    console.log(
      "Every figure below is over the objects that were read. A collision " +
        "or a slow test in an object that was left out is missing from " +
        "them, and an identity whose other runs were left out reads as a " +
        "one-run member of a churn family.",
    );
  }
  const runs = new Set(
    reports.map((report) => report.context?.ci?.workflowRunId ?? ""),
  ).size;
  const byIdentity = aggregate(
    reports,
    options.aliases ?? await loadAliasResolver(),
  );
  console.log(
    `${byIdentity.size} distinct identities across ${runs} workflow run(s).`,
  );

  const collided = collisions(reports);
  console.log(`\nCollisions (${collided.length}):`);
  for (const collision of collided.slice(0, 50)) {
    console.log(
      `  ${collision.count}x ${formatIdentity(collision.key)} in ${
        collision.objectName.split("/").at(-1)
      }`,
    );
  }

  const churny = churnFamilies(byIdentity, runs);
  console.log(`\nHigh-churn identity families (${churny.length}):`);
  for (const family of churny.slice(0, 50)) {
    console.log(`  ${family.members} one-run members: ${family.family}`);
  }

  const slow = overSixtySeconds(byIdentity);
  console.log(`\nOver sixty seconds (${slow.length}):`);
  for (const entry of slow.slice(0, 50)) {
    console.log(
      `  ${(entry.maxDurationMs / 1000).toFixed(1)}s  ${
        formatIdentity(entry.key)
      }`,
    );
  }

  if (!options.gate) return 0;
  if (slow.length > 0) {
    console.error(
      `\n${slow.length} test(s) exceed the sixty-second rule; the ratchet ` +
        "fails.",
    );
  }
  if (incomplete) {
    console.error(
      "\nThe window was not read in full, so nothing here says whether the " +
        "part that was left out is under sixty seconds; the ratchet could " +
        "not check it.",
    );
  }
  if (slow.length > 0) return 1;
  return incomplete ? 3 : 0;
}

/** Parses the command line; undefined means a malformed one. */
export function parseReportArgs(
  argsIn: readonly string[],
): { days: number; gate: boolean } | undefined {
  let days = 7;
  let gate = false;
  const args = [...argsIn];
  while (args.length > 0) {
    const flag = args.shift()!;
    if (flag === "--gate") {
      gate = true;
    } else if (flag === "--days") {
      days = Number(args.shift());
      if (!Number.isInteger(days) || days < 1) {
        console.error("--days takes a positive integer");
        return undefined;
      }
    } else {
      console.error(`unknown flag ${flag}`);
      return undefined;
    }
  }
  return { days, gate };
}

async function main(): Promise<void> {
  const parsed = parseReportArgs(Deno.args);
  if (parsed === undefined) Deno.exit(2);
  const status = await runReport({
    days: parsed.days,
    gate: parsed.gate,
    bucket: storeBucket(),
    prefix: ciSubmissionsPrefix(),
  });
  if (status !== 0) Deno.exit(status);
}

if (import.meta.main) {
  await main();
}
