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
 * Usage: check-baselines-append-only.ts [base-ref]   (default: origin/main)
 */

import { patternPath, PATTERNS_DIR } from "./pattern-files.ts";

const BASELINES_PREFIX = `${PATTERNS_DIR}/baselines/`;

async function git(...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
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
 * `deletedPatterns` are both repo-relative paths from the same diff.
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

async function main() {
  const base = Deno.args[0] ?? "origin/main";
  let mergeBase: string;
  try {
    mergeBase = (await git("merge-base", base, "HEAD")).trim();
  } catch {
    console.error(
      `Could not resolve a merge base against ${base}. This check needs real ` +
        `history — CI must check out with fetch-depth: 0.`,
    );
    Deno.exit(2);
  }

  const deleted = (await git(
    "diff",
    "--diff-filter=D",
    "--name-only",
    `${mergeBase}...HEAD`,
  )).split("\n").filter((line) => line.length > 0);

  const deletedPatterns = new Set(
    deleted.filter((path) => path.endsWith(".ts") || path.endsWith(".tsx")),
  );

  const offenders = unjustifiedDeletions(deleted, deletedPatterns);
  if (offenders.length === 0) {
    console.log("Pattern baselines are append-only against this base.");
    return;
  }

  console.error(
    `${offenders.length} pattern baseline(s) deleted without retiring the ` +
      `pattern:\n`,
  );
  for (const { path, key } of offenders) {
    console.error(`  ${path}\n    ${patternPath(key)} still exists.`);
  }
  console.error(
    `\nA baseline records a contract that WAS deployed. Deleting one drops the ` +
      `proof that pieces pinned to it can still roll forward, which is exactly ` +
      `how an incompatible change gets laundered past the gate.` +
      `\n\nIf you are retiring the pattern, delete the pattern file in the same ` +
      `change. If you are accepting a deliberate break, keep the baseline and ` +
      `say so in review — do not delete the evidence.`,
  );
  Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
