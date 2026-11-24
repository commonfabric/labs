#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * The pattern-update gate's safety argument is that `--update` can only ADD a
 * baseline — a command that could remove one could remove the very baseline
 * that would have caught a break. That argument is worth nothing unless the
 * store is actually append-only, and `rm` is not `--update`. Two commands
 * launder an incompatible change:
 *
 *     rm patterns/baselines/system/home/home.tsx/2026...-<hash>.json
 *     deno task pattern-compat --update      # now green
 *
 * In a diff that already carries tens of thousands of lines of recorded JSON,
 * one deleted file is not something review reliably catches. So CI checks it.
 *
 * The one legitimate deletion is retirement: a pattern that no longer exists
 * has no pieces to roll forward, so its baselines may go WITH it. That is
 * accepted only when the pattern file is deleted in the same change — which is
 * also exactly what the gate's own `retired` message instructs.
 *
 * Usage: check-baselines-append-only.ts [base-ref]
 *        (default: upstream/main where that exists, and origin/main otherwise)
 */

import { type CommandOutput, emit } from "./command-output.ts";
import { patternPath, PATTERNS_DIR } from "./pattern-files.ts";
import { defaultBase, type Git, git } from "./repository-files.ts";

const BASELINES_PREFIX = `${PATTERNS_DIR}/baselines/`;

/**
 * The paths the repository `run` runs git in deleted since `mergeBase`. A
 * file it moved counts as deleted at the path it left where `moves` is
 * `"deleted"`, as a baseline moved out of the store is as gone from it as one
 * removed, and as kept where `moves` is `"kept"`, as a pattern moved
 * elsewhere still exists.
 */
export async function deletedSince(
  run: Git,
  mergeBase: string,
  moves: "deleted" | "kept",
): Promise<string[]> {
  return (await run(
    "diff",
    moves === "deleted" ? "--no-renames" : "--find-renames",
    "--diff-filter=D",
    "--name-only",
    `${mergeBase}...HEAD`,
  )).split("\n").filter((line) => line.length > 0);
}

/** The pattern key a baseline path belongs to: `<key>/<file>.json`. */
export function baselineKeyOf(path: string): string | undefined {
  if (!path.startsWith(BASELINES_PREFIX) || !path.endsWith(".json")) {
    return undefined;
  }
  const rest = path.slice(BASELINES_PREFIX.length);
  const cut = rest.lastIndexOf("/");
  return cut === -1 ? undefined : rest.slice(0, cut);
}

/**
 * Deleted baselines whose pattern was NOT also deleted. `deleted` and
 * `deletedPatterns` are both repo-relative paths.
 */
export function unjustifiedDeletions(
  deleted: readonly string[],
  deletedPatterns: ReadonlySet<string>,
): { path: string; key: string }[] {
  const offenders: { path: string; key: string }[] = [];
  for (const path of deleted) {
    const key = baselineKeyOf(path);
    if (key === undefined) continue;
    if (deletedPatterns.has(patternPath(key))) continue;
    offenders.push({ path, key });
  }
  return offenders;
}

/**
 * Checks the change from the merge base of `base`, or of the default base
 * where it is undefined, and `HEAD` in the repository `run` runs git in, and
 * returns what to say: exit code 0 where no baseline was deleted without its
 * pattern, 1 where one was, and 2 where git finds no merge base.
 */
export async function main(
  named: string | undefined,
  run: Git = git,
): Promise<CommandOutput> {
  const base = named ?? await defaultBase(run);
  let mergeBase: string;
  try {
    mergeBase = (await run("merge-base", base, "HEAD")).trim();
  } catch {
    return {
      err: `Could not resolve a merge base against ${base}. This check needs ` +
        `real history — CI must check out with fetch-depth: 0.`,
      code: 2,
    };
  }

  const deleted = await deletedSince(run, mergeBase, "deleted");

  // A pattern the change moved still exists, so it retires nothing.
  const deletedPatterns = new Set(
    (await deletedSince(run, mergeBase, "kept")).filter((path) =>
      path.endsWith(".ts") || path.endsWith(".tsx")
    ),
  );

  const offenders = unjustifiedDeletions(deleted, deletedPatterns);
  if (offenders.length === 0) {
    return {
      out: "Pattern baselines are append-only against this base.",
      code: 0,
    };
  }

  return {
    err: [
      `${offenders.length} pattern baseline(s) deleted without retiring the ` +
      `pattern:\n`,
      ...offenders.map(({ path, key }) =>
        `  ${path}\n    ${patternPath(key)} still exists.`
      ),
      `\nA baseline records a contract that WAS deployed. Deleting one drops ` +
      `the proof that pieces pinned to it can still roll forward, which is ` +
      `exactly how an incompatible change gets laundered past the gate.` +
      `\n\nIf you are retiring the pattern, delete the pattern file in the ` +
      `same change. If you are accepting a deliberate break, keep the ` +
      `baseline and say so in review — do not delete the evidence.`,
    ].join("\n"),
    code: 1,
  };
}

if (import.meta.main) emit(await main(Deno.args[0]));
