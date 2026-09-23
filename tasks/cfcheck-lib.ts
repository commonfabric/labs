/**
 * Deciding which patterns one `cfcheck` invocation takes: the command line
 * it was given, the shard the environment names, and the corpus those two
 * cut down to.
 *
 * Separate from `cfcheck.ts` so a test can drive it. That script runs a
 * compiler over the whole pattern corpus and cannot be imported for the
 * sake of its argument handling, which is where the decisions that a lane
 * depends on are made: a lane is charged for the units it asked for, and
 * every way of widening what runs beyond them starts here.
 */

import { readOnlyArguments } from "./only-arguments.ts";
import { matchesPatternFilter } from "./pattern-files.ts";
import { parseShard as parseShardSpec } from "./shard-utils.ts";

/** What an error says, for a reader who has no stack to read. */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a caller who gave a command line this cannot read is told. */
export const USAGE = [
  "usage: deno task cfcheck [--only <pattern>]...",
  'CFCHECK_SHARD names a share as "i/n", counting from one.',
].join("\n");

/** Which of a corpus one invocation takes, as a zero-based share. */
export interface Shard {
  index: number;
  count: number;
}

/** The whole corpus, which is what an invocation naming no shard takes. */
export const WHOLE: Shard = { index: 0, count: 1 };

/**
 * The `--only` terms a command line carries.
 *
 * Throws on anything else, and on a `--only` carrying nothing: a term
 * dropped for being empty would leave the run looking unfiltered, so it
 * would check the whole corpus while its caller was charged for one
 * pattern. A value opening with `--` is the caller's next flag read as a
 * filter, which matches no pattern and would check nothing.
 */
export function parseOnly(argv: readonly string[]): string[] {
  const read = readOnlyArguments(argv);
  if ("error" in read) throw new Error(read.error);
  const { only, rest } = read;
  if (rest.length > 0) throw new Error(`Unknown argument: ${rest[0]}`);
  return only;
}

/**
 * The share `CFCHECK_SHARD` names, as `"i/n"` counting from one, or the
 * whole corpus where it names nothing. Throws on a spelling it cannot
 * read, so an invocation never silently takes a share nobody asked for.
 */
export function parseShard(raw: string | undefined): Shard {
  if (raw === undefined || raw.length === 0) return WHOLE;
  const { index, total } = parseShardSpec(raw);
  return { index: index - 1, count: total };
}

/**
 * The patterns one invocation checks: those any `--only` term matches, cut
 * to the shard's share. An invocation given no term takes the whole
 * corpus, which is what makes a lane asking for every pattern the same run
 * as a person typing the task with no arguments.
 *
 * The shard is applied after the filter rather than before, so that two
 * shards of a filtered run divide the patterns that were asked for rather
 * than dividing the corpus and then discarding most of both shares.
 */
export function patternsToCheck(
  files: readonly string[],
  only: readonly string[],
  shard: Shard = WHOLE,
): string[] {
  const selected = only.length === 0
    ? [...files]
    : files.filter((file) =>
      only.some((match) => matchesPatternFilter(file, match))
    );
  return selected.filter((_file, i) => i % shard.count === shard.index);
}

/**
 * The patterns one invocation checks, read from the command line it was
 * given and the share its environment names.
 *
 * Throws where either cannot be read, so that a spelling nobody intended
 * stops the run rather than widening it: every way of misreading these
 * ends with more patterns checked than the caller asked for.
 */
export function selectionFor(
  files: readonly string[],
  argv: readonly string[],
  shardSpec: string | undefined,
): { files: string[]; shard: Shard } {
  const shard = parseShard(shardSpec);
  return { files: patternsToCheck(files, parseOnly(argv), shard), shard };
}

/** How a run says which share of the corpus it took, where it took one. */
export function shardLabel(shard: Shard): string {
  return shard.count > 1 ? ` [shard ${shard.index + 1}/${shard.count}]` : "";
}
