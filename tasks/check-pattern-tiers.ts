#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Holds every pattern source in a "do not copy" tier to carrying a marker that
 * says so, and every marker to naming the tier the tables give that file.
 *
 * `patterns` is example code whose examples carry unequal authority.
 * A legacy or fixture pattern is indistinguishable from an exemplar in a
 * directory listing, and copying one is the failure this guards: the wrong
 * idiom propagates into new patterns, and from there into the next thing that
 * copies those. `patterns/index.md` explains the tiers; the marker is
 * what puts the answer in front of a reader who never opened the index.
 *
 * The check runs in both directions. A file the tables place in a marked tier
 * and that carries no marker fails, so a pattern added to `dev/gideon-tests/`
 * cannot arrive unmarked. A marker on a file the tables do not place fails
 * too, so a marker cannot outlive the reason for it. A table entry matching no
 * file fails last, which is what catches a directory renamed out from under
 * the tables.
 *
 *   deno task check-pattern-tiers    # check (what CI runs; cannot write)
 *   deno task fix-pattern-tiers      # add or correct the markers
 *
 * Applying a marker can change a pattern's update contract, so run
 * `deno task pattern-compat` afterwards. A pattern carrying information-flow
 * labels derives part of its schema from its own source, and the two lines a
 * marker adds are enough to move that: the gate then reports the new contract
 * as unrecorded, and the answer is to record it with
 * `deno task pattern-compat --update`. The marker changes no behavior, and a
 * marker on an imported module moves the importing pattern's contract too.
 */

import { PATTERNS_DIR } from "./pattern-files.ts";
import {
  collectTierTargets,
  declaredTier,
  hasMarkerLine,
  type MarkedTier,
  TIER_DIRECTORIES,
  TIER_FILES,
  withMarker,
} from "./pattern-tiers.ts";

interface Problem {
  key: string;
  detail: string;
}

/**
 * Whether `--write` may rewrite this file's marker.
 *
 * It may when the file carries no marker, and when it carries one this tool
 * recognizes — `withMarker` replaces a recognized marker by its own line
 * count, so moving a directory from one tier to the other in the tables is a
 * mechanical edit. It may not when the file opens with marker-shaped text that
 * matches nothing, because `stripMarker` cannot tell where that text ends and
 * the file's own comments begin. That case is reported for a person to fix.
 */
export function isWritable(
  source: string,
  tier: MarkedTier | undefined,
): tier is MarkedTier {
  if (tier === undefined) return false;
  return !hasMarkerLine(source) || declaredTier(source) !== undefined;
}

/** The two membership tables, injectable so their guards can be tested. */
export interface TierTables {
  directories: Readonly<Record<string, MarkedTier>>;
  files: Readonly<Record<string, MarkedTier>>;
}

const LIVE_TABLES: TierTables = {
  directories: TIER_DIRECTORIES,
  files: TIER_FILES,
};

/** Table entries that match nothing under `keys`, and so have gone stale. */
export function staleTableEntries(
  keys: readonly string[],
  tables: TierTables = LIVE_TABLES,
): string[] {
  const { directories: TIER_DIRECTORIES, files: TIER_FILES } = tables;
  const stale: string[] = [];
  for (const prefix of Object.keys(TIER_DIRECTORIES)) {
    // Without the trailing slash the prefix match spills into any sibling
    // whose name merely starts the same way, which tiers files silently.
    if (!prefix.endsWith("/")) {
      stale.push(`TIER_DIRECTORIES["${prefix}"] needs a trailing slash.`);
      continue;
    }
    if (!keys.some((key) => key.startsWith(prefix))) {
      stale.push(`TIER_DIRECTORIES["${prefix}"] matches no pattern source.`);
    }
  }
  for (const file of Object.keys(TIER_FILES)) {
    if (!keys.includes(file)) {
      stale.push(`TIER_FILES["${file}"] is not a pattern source.`);
    }
  }
  return stale;
}

/** What is wrong with one file's marker, or undefined when nothing is. */
export function problemWith(
  source: string,
  expected: MarkedTier | undefined,
): string | undefined {
  const declared = declaredTier(source);
  if (declared === expected) {
    // A file claiming no tier and expected to claim none may still open with
    // text shaped like a marker; that text is a marker nobody will maintain.
    if (expected === undefined && hasMarkerLine(source)) {
      return "opens with a tier marker the tables do not place.";
    }
    return undefined;
  }
  if (expected === undefined) {
    return `is marked ${declared}, but no table places it in a marked tier.`;
  }
  if (declared === undefined) {
    return hasMarkerLine(source)
      ? `should carry the ${expected} marker; its opening lines are not it.`
      : `should open with the ${expected} marker and does not.`;
  }
  return `is marked ${declared} but the tables place it in ${expected}.`;
}

/** What one pass over a patterns tree found, and what it changed. */
export interface TierReport {
  /** Every pattern source examined. */
  examined: number;
  /** How many of those the tables place in a marked tier. */
  marked: number;
  /** Keys whose marker `--write` applied or corrected, in walk order. */
  written: string[];
  /** Files whose marker disagrees with the tables. */
  problems: Problem[];
  /** Table entries that match nothing under this tree. */
  stale: string[];
}

/**
 * Check `dir`, optionally writing markers, and report what was found.
 *
 * Separated from `main` so the walk, the per-file verdict and the write are
 * reachable from a test against a temporary tree; `main` adds only argument
 * reading, the report, and the exit status.
 */
export async function runTierCheck(
  dir: string,
  write: boolean,
): Promise<TierReport> {
  const targets = await collectTierTargets(dir);
  const problems: Problem[] = [];
  const written: string[] = [];

  for (const { path, key, tier } of targets) {
    const source = await Deno.readTextFile(path);
    const detail = problemWith(source, tier);
    if (detail === undefined) continue;
    if (write && isWritable(source, tier)) {
      await Deno.writeTextFile(path, withMarker(source, tier));
      written.push(key);
      continue;
    }
    problems.push({ key, detail });
  }

  return {
    examined: targets.length,
    marked: targets.filter((target) => target.tier !== undefined).length,
    written,
    problems,
    stale: staleTableEntries(targets.map((target) => target.key)),
  };
}

/**
 * Check `dir`, report to the console, and answer with the exit status.
 *
 * Returns the code rather than exiting so a test can call it; only the
 * `import.meta.main` line below turns the answer into an exit.
 */
export async function main(
  dir: string = PATTERNS_DIR,
  write: boolean = Deno.args.includes("--write"),
): Promise<number> {
  const { examined, marked, written, problems, stale } = await runTierCheck(
    dir,
    write,
  );

  if (written.length > 0) {
    console.log(`Marked ${written.length} pattern source(s):`);
    for (const key of written) console.log(`  ${key}`);
  }

  if (problems.length === 0 && stale.length === 0) {
    console.log(
      `Pattern tier markers agree with the tables (${marked} marked of ` +
        `${examined} pattern sources).`,
    );
    return 0;
  }

  for (const { key, detail } of problems) {
    console.error(`  ${dir}/${key}\n    ${detail}`);
  }
  for (const detail of stale) console.error(`  ${detail}`);
  console.error(
    `\nA legacy or fixture pattern says so in its own opening lines, because a ` +
      `reader who arrived from a directory listing never sees the index. The ` +
      `tiers and their members are in tasks/pattern-tiers.ts; run ` +
      `\`deno task fix-pattern-tiers\` to apply or correct a marker.`,
  );
  return 1;
}

if (import.meta.main) Deno.exit(await main());
