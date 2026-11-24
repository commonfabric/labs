#!/usr/bin/env -S deno run -A

/**
 * Tier 1 pattern-update gate. Compiles every authored pattern, then proves its
 * argument/result contract can still be applied over every contract recorded
 * for it under `patterns/baselines/`.
 *
 * The rule this enforces is the one `cf piece setsrc` enforces
 * (`assertPatternSchemasBackwardCompatible`); the automatic updater applies a
 * new pattern with no structural check at all, so nothing but CI stands between
 * an incompatible schema and every running piece. See `pattern-compat-lib.ts`.
 *
 *   deno task pattern-compat             # check (what CI runs)
 *   deno task pattern-compat --update    # record contracts that have no baseline
 *   deno task pattern-compat --only home # restrict to matching paths
 *
 * Baselines are never pruned. They are small, most patterns never change
 * contract, and — decisively — an author-run `--update` that could *remove* a
 * baseline could remove the very one that would have caught the break. `--update`
 * can only add.
 *
 * A break the repository decides to ship — a surface removed on purpose, its
 * held state an accepted casualty — cannot be recorded away and must not be
 * deleted away. It is declared in `pattern-compat-accepted-breaks.ts`, which
 * forgives the paths it names over the `(pattern, baseline)` pairs it names,
 * and nothing else.
 *
 * `runPatternCompat()` reads the tree and builds the runtime that evaluates
 * each pattern; `judgeCompatibility()` decides what those facts mean and what
 * the run prints, so a test can state the facts and read the verdict.
 */

import { basename } from "@std/path/basename";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { FragmentWriter } from "@commonfabric/test-support/records";
import { createRuntime } from "../runtime/cli/lib/dev.ts";
import {
  baselineKeysByPattern,
  BASELINES_DIR,
  collectAllPatternFiles,
  collectCompatibilityPaths,
  patternKey,
  PATTERNS_DIR,
  REPO_ROOT,
} from "./pattern-files.ts";
import { UNEVALUABLE_PATTERNS } from "./pattern-compat-unevaluable.ts";
import {
  ACCEPTED_CONTRACT_BREAKS,
  type AcceptedContractBreak,
} from "./pattern-compat-accepted-breaks.ts";
import { judgeBreakRegistries } from "./pattern-break-registry-guards.ts";
import { type CommandOutput, emit } from "./command-output.ts";
import {
  acceptedBreakKey,
  checkPattern,
  checkRunsAlone,
  type Finding,
  parseArgs,
  partitionAcceptedBreaks,
  type PatternContract,
  PENDING_STANDALONE_RENAMES,
  readBaselines,
  selectItems,
  shouldRecord,
  unusedAcceptances,
  writeBaseline,
} from "./pattern-compat-lib.ts";

/** What one run of the gate reads from outside itself. */
export interface CompatGateInput {
  /** Whether to record contracts that have no baseline. */
  update: boolean;

  /** The `--only` filters; empty judges every pattern. */
  only: readonly string[];

  /** Every authored pattern file in the tree, repository-relative. */
  files: readonly string[];

  /** The directory baselines are read from and recorded under. */
  baselinesDir: string;

  /** The breaks the repository decided to ship, which the run forgives. */
  acceptedBreaks: readonly AcceptedContractBreak[];

  /** Patterns known to fail evaluation, keyed as `patternKey()` keys them. */
  unevaluable: ReadonlySet<string>;

  /** `main.tsx` entries known not to run alone while their rename waits. */
  pendingStandaloneRenames: ReadonlySet<string>;

  /** Compiles and evaluates one pattern file, returning its module's exports. */
  evaluate(file: string): Promise<unknown>;

  /**
   * Set to report where the run spent its time: the slowest compiles, and each
   * check that took longer than this many milliseconds.
   */
  slowCheckMs?: number;

  /** Prints a line while the run goes on, ahead of the verdict. */
  say(line: string): void;

  /** Where one gate-kind record per judged pattern goes, if anywhere. */
  records?: Pick<FragmentWriter, "append">;

  /** The time a baseline this run records is stamped with. */
  recordedAt: Date;
}

/**
 * Judge every pattern `input.only` selects against its baselines, recording
 * new ones under `--update`, and say what the run found.
 */
export async function judgeCompatibility(
  input: CompatGateInput,
): Promise<CommandOutput> {
  const out: string[] = [];
  const err: string[] = [];
  const { acceptedBreaks, unevaluable } = input;
  const items = selectItems(
    await collectCompatibilityPaths(
      input.files,
      input.baselinesDir,
      acceptedBreaks.map((accepted) => accepted.pattern),
    ),
    input.only,
  );
  const recordedUnder = await baselineKeysByPattern(input.baselinesDir);
  // An item with no file is a pattern that is gone. It has no contract, and
  // is judged below on its baselines and accepted breaks alone.
  const present = new Set(input.files);
  const goneKeys = new Set(
    items.filter((item) => !present.has(item)).map((item) => patternKey(item)),
  );

  input.say(`Checking update compatibility for ${items.length} patterns.`);

  const contracts = new Map<string, PatternContract>();

  /**
   * Files that yielded no contract, and why. Most of `patterns` is not
   * a pattern entry — `schemas.tsx`, `auth-types.ts`, client helpers — and a
   * module with no pattern default export has no update contract to check, so
   * it is skipped rather than failed. It only becomes a finding if baselines
   * exist for it, which means it USED to be a pattern: pieces are pinned to it
   * and can no longer roll forward. That case is `checkPattern`'s `retired`.
   */
  const unavailable = new Map<string, string>();

  /** Skips that are an evaluation error rather than "not a pattern entry". */
  const evaluationErrors: { pattern: string; error: string }[] = [];

  const timings: { key: string; ms: number }[] = [];

  const findings: Finding[] = [];

  const recorded: string[] = [];
  // Every `(pattern, baseline)` pair a deliberate break is allowed to fail
  // against, mapped to the schema paths it may blame. What none of them turned
  // out to need fails the run, below.
  const forgivableByPair = new Map<string, ReadonlySet<string>>(
    acceptedBreaks.flatMap((accepted) =>
      accepted.baselines.map((baseline) =>
        [
          acceptedBreakKey(accepted.pattern, baseline),
          new Set(accepted.paths),
        ] as const
      )
    ),
  );
  const forgivenBreaks: Finding[] = [];
  // An accepted break naming a gone pattern forgives nothing, so it fails
  // that pattern's record.
  const orphanedBreaks = acceptedBreaks
    .map((accepted) => accepted.pattern)
    .filter((pattern) => goneKeys.has(pattern));

  // Each pattern is compiled and then checked before the next one starts, in
  // key order, under a counted line naming it, so the last line of a run that
  // stops making progress names the pattern it stopped on. Its gate-kind
  // record, named "pattern-compat <key>", is appended the moment its verdict is
  // known, so a killed run keeps every finished pattern's record.
  const judged = items
    .map((item) => ({ item, key: patternKey(item) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const [index, { item, key }] of judged.entries()) {
    input.say(`[${index + 1}/${judged.length}] ${key}`);
    let compileMs = 0;
    let newlyUnevaluable = false;
    if (present.has(item)) {
      const started = performance.now();
      try {
        const exports = await input.evaluate(item);
        const pattern = (exports as Record<string, unknown>)?.default as
          | PatternContract
          | undefined;
        if (
          pattern?.argumentSchema === undefined ||
          pattern?.resultSchema === undefined
        ) {
          unavailable.set(key, "no pattern default export");
        } else {
          contracts.set(key, {
            argumentSchema: pattern.argumentSchema,
            resultSchema: pattern.resultSchema,
          });
        }
      } catch (error) {
        const reason = describeFailure(error);
        unavailable.set(key, reason);
        evaluationErrors.push({ pattern: key, error: reason });
        newlyUnevaluable = !unevaluable.has(key);
      }
      compileMs = performance.now() - started;
      timings.push({ key, ms: compileMs });
    }

    // A file with no contract goes through the same check, so a file that
    // USED to export a pattern, or is gone, has its baselines reported.
    const current = contracts.get(key);
    const baselines = await readBaselines(
      input.baselinesDir,
      key,
      recordedUnder.get(key) ?? [key],
    );
    const checkStarted = performance.now();
    const allFindings = [
      ...checkPattern(key, current, baselines),
      ...checkRunsAlone(
        key,
        item.startsWith(`${PATTERNS_DIR}/`) && basename(item) === "main.tsx",
        current,
        input.pendingStandaloneRenames,
      ),
    ];
    const checkMs = performance.now() - checkStarted;
    const ms = Math.round(checkMs);
    // A slow check means validating an unrecorded contract, or proving the
    // contract against one of the baselines, is expensive — the schema
    // machinery blows up combinatorially on some shapes.
    if (input.slowCheckMs !== undefined && ms > input.slowCheckMs) {
      input.say(`  check ${ms}ms  ${key}`);
    }

    // An accepted break stops being a finding here, BEFORE `shouldRecord` sees
    // the list — which is the whole point. The contract that ships a decided
    // removal has to reach a baseline, or the next change to that pattern has
    // nothing to prove itself against.
    const { standing: patternFindings, forgiven } = partitionAcceptedBreaks(
      allFindings,
      forgivableByPair,
    );
    for (const forgivenBreak of forgiven) forgivenBreaks.push(forgivenBreak);

    let standing = patternFindings;
    if (input.update && current !== undefined) {
      if (shouldRecord(patternFindings)) {
        const name = await writeBaseline(
          input.baselinesDir,
          key,
          current,
          input.recordedAt,
        );
        recorded.push(`${key}/${name}`);
      }
      // A recorded contract still has to survive the incompatibility check
      // below — `--update` adds evidence, it never clears a finding.
      standing = patternFindings.filter((f) => f.kind !== "missing-baseline");
    }
    for (const finding of standing) findings.push(finding);

    const failed = standing.length > 0 || newlyUnevaluable ||
      orphanedBreaks.includes(key);
    input.records?.append({
      line: "record",
      test: { k: "gate", s: "repo", n: `pattern-compat ${key}` },
      outcome: failed ? "fail" : "pass",
      durationMs: Math.round(compileMs + checkMs),
    });
  }
  if (input.slowCheckMs !== undefined) {
    input.say("\nSlowest compiles:");
    for (
      const timing of [...timings].sort((a, b) => b.ms - a.ms).slice(0, 10)
    ) {
      input.say(`  ${Math.round(timing.ms)}ms  ${timing.key}`);
    }
  }

  if (recorded.length > 0) {
    out.push(`\nRecorded ${recorded.length} contract(s):`);
    for (const name of recorded) out.push(`  ${name}`);
  }

  if (forgivenBreaks.length > 0) {
    // One line per pair: an old baseline of a much-changed pattern can carry
    // hundreds of forgiven issues, and the registry lists them all.
    const forgivenByPair = Map.groupBy(
      forgivenBreaks.flatMap((finding) =>
        finding.kind === "incompatible" ? [finding] : []
      ),
      (finding) => `${finding.pattern} over ${finding.baseline}`,
    );
    out.push(
      `\nForgave ${forgivenBreaks.length} issue(s) over ` +
        `${forgivenByPair.size} pair(s) as accepted contract breaks ` +
        `(tasks/pattern-compat-accepted-breaks.ts):`,
    );
    for (const [pair, pairFindings] of forgivenByPair) {
      out.push(`  ${pair}: ${pairFindings.length} issue(s)`);
    }
  }
  // Asked per pattern rather than of the whole list, because a lane runs only
  // the patterns `--only` gave it, so a check gated on a run of the whole list
  // would not execute where the patterns are divided between lanes. The run
  // that examined a pattern can say whether its pairs and paths were needed,
  // and the runs between them cover every entry.
  //
  // An entry whose pattern file is gone is left out: with no contract, its
  // pairs are never used, and it is reported as orphaned instead. Retiring a
  // pattern deletes its baselines with it, which is exactly when an acceptance
  // stops meaning anything, so such an entry makes its pattern an item of its
  // own, and the run given that item reports it.
  const { pairs: staleBreaks, paths: stalePaths } = unusedAcceptances(
    acceptedBreaks,
    new Set([...contracts.keys(), ...unavailable.keys()]),
    forgivenBreaks,
  );

  if (unavailable.size > 0) {
    out.push(
      `\nSkipped ${unavailable.size} file(s) with no pattern contract ` +
        `(${evaluationErrors.length} from an evaluation error).`,
    );
  }
  // An evaluation error is a pattern the gate CANNOT protect: no contract means
  // no baseline means no check, forever. Allowlisted ones are known debt; a new
  // one fails the run, so the list can only shrink.
  const unexpectedFailures = evaluationErrors.filter(
    (failure) => !unevaluable.has(failure.pattern),
  );
  for (const failure of evaluationErrors) {
    const known = unevaluable.has(failure.pattern) ? "known" : "NEW";
    out.push(
      `  [${known}] ${failure.pattern}: ${failure.error.split("\n")[0]}`,
    );
  }
  // A listed pattern that evaluates again must leave the list, or its exemption
  // outlives the breakage it was granted for.
  const recovered = [...contracts.keys()].filter((key) => unevaluable.has(key));

  if (findings.length > 0) {
    err.push("\nPattern update compatibility failures:");
    let lastPair: string | undefined;
    for (const finding of findings) {
      if (finding.kind === "incompatible") {
        // Each issue is a finding of its own, and a pair's issues arrive
        // together, so the pair is named once above them.
        const pair = acceptedBreakKey(finding.pattern, finding.baseline);
        if (pair !== lastPair) {
          err.push(
            `\n${finding.pattern}\n  cannot be applied over baseline ` +
              `${finding.baseline}:`,
          );
        }
        lastPair = pair;
        err.push(`- ${finding.detail}`);
        continue;
      }
      lastPair = undefined;
      if (finding.kind === "missing-baseline") {
        err.push(
          `\n${finding.pattern}\n  contract ${finding.hash} is not recorded.` +
            `\n  Run: deno task pattern-compat --update`,
        );
      } else if (finding.kind === "not-standalone") {
        err.push(
          `\n${finding.pattern}\n  is a main.tsx entry, which is offered as ` +
            `standalone, but requires ${finding.inputs.join(", ")} with no ` +
            `default, so it cannot run alone.` +
            `\n  Give each a default (an input a host fills in is optional), ` +
            `or rename the file: main.tsx is kept for a pattern that stands ` +
            `alone.`,
        );
      } else if (finding.kind === "stale-pending-rename") {
        err.push(
          `\n${finding.pattern}\n  runs alone now. Remove it from ` +
            `PENDING_STANDALONE_RENAMES in tasks/pattern-compat-lib.ts.`,
        );
      } else if (finding.kind === "invalid-schema") {
        err.push(
          `\n${finding.pattern}\n  ${finding.role} schema is not valid on its ` +
            `own terms: ${finding.detail}`,
        );
      } else {
        err.push(
          `\n${finding.pattern}\n  has ${finding.baselines.length} baseline(s) ` +
            `but yields no contract now: ` +
            `${unavailable.get(finding.pattern) ?? "file is gone"}.` +
            `\n  Every piece tracking this path is pinned to its current ` +
            `pattern forever — the updater's ?identity probe simply fails and ` +
            `nothing surfaces on the piece.` +
            `\n  Restore it, or delete its baseline directory to record the ` +
            `retirement deliberately.`,
        );
      }
    }
  }

  if (unexpectedFailures.length > 0) {
    err.push(
      `\n${unexpectedFailures.length} pattern(s) newly fail to evaluate. A ` +
        `pattern that cannot evaluate gets no baseline and is exempt from this ` +
        `gate forever — fix it, or add it to ` +
        `tasks/pattern-compat-unevaluable.ts with the reason.`,
    );
  }
  if (recovered.length > 0) {
    err.push(
      `\n${recovered.length} pattern(s) listed in ` +
        `tasks/pattern-compat-unevaluable.ts now evaluate: ` +
        `${
          recovered.join(", ")
        }. Remove them from that list so they are gated.`,
    );
  }
  if (staleBreaks.length > 0) {
    err.push(
      `\n${staleBreaks.length} accepted contract break(s) in ` +
        `tasks/pattern-compat-accepted-breaks.ts forgive nothing: ` +
        `${
          staleBreaks.join(", ")
        }. The pair applies cleanly now, or blames only paths the entry does ` +
        `not name, so the exemption outlives its break — remove it.`,
    );
  }
  for (const stale of stalePaths) {
    err.push(
      `\nAn accepted contract break for ${stale.pattern} in ` +
        `tasks/pattern-compat-accepted-breaks.ts (${stale.record}) names ` +
        `${stale.paths.length} path(s) that none of its pairs blames: ` +
        `${stale.paths.join(", ")}. The entry forgives exactly the paths it ` +
        `names, so a path no issue blames is an exemption outliving its ` +
        `break, and would forgive a later one at that path — remove it.`,
    );
  }
  if (orphanedBreaks.length > 0) {
    err.push(
      `\n${orphanedBreaks.length} accepted contract break(s) in ` +
        `tasks/pattern-compat-accepted-breaks.ts name a pattern that no ` +
        `longer exists: ${orphanedBreaks.join(", ")}. Retiring a pattern ` +
        `takes its baselines with it, so the acceptance forgives nothing and ` +
        `nothing will ever notice — remove it.`,
    );
  }

  if (err.length === 0) {
    out.push(
      `\n${contracts.size} pattern(s) can be updated from every recorded ` +
        `contract.`,
    );
  }
  return {
    ...(out.length > 0 ? { out: out.join("\n") } : {}),
    ...(err.length > 0 ? { err: err.join("\n") } : {}),
    code: err.length > 0 ? 1 : 0,
  };
}

/**
 * Run the gate over this checkout with the command-line `args`.
 *
 * The registries are judged before any pattern is: an entry that names a
 * required pattern or points at no decision record is wrong regardless of what
 * this run's findings turn out to be. `systemPatternUrls` are the patterns
 * that auto-update, which the required set is derived from. `recordResults`
 * writes one gate-kind record per judged pattern into the run's spool, and
 * `say` prints progress, standard output by default.
 */
export async function runPatternCompat(
  args: readonly string[],
  options: {
    systemPatternUrls?: readonly string[];
    recordResults?: boolean;
    say?: (line: string) => void;
  } = {},
): Promise<CommandOutput> {
  let update: boolean;
  let only: string[];
  try {
    ({ update, only } = parseArgs(args));
  } catch (error) {
    return { err: describeFailure(error), code: 2 };
  }

  const registries = judgeBreakRegistries({
    systemPatternUrls: options.systemPatternUrls,
    // Tier 1 owns the unevaluable list, so Tier 1 is where it is judged: a
    // required pattern listed there escapes this gate altogether.
    unevaluable: UNEVALUABLE_PATTERNS,
  });
  if ("error" in registries) return { err: registries.error, code: 1 };

  const runtime = await createRuntime();
  const engine = runtime.harness;
  // Inert without `CF_TEST_RECORDS_DIR`.
  const recordsFragment = options.recordResults
    ? FragmentWriter.openForRun()
    : undefined;
  try {
    return await judgeCompatibility({
      update,
      only,
      files: await collectAllPatternFiles(REPO_ROOT),
      baselinesDir: `${REPO_ROOT}/${BASELINES_DIR}`,
      acceptedBreaks: ACCEPTED_CONTRACT_BREAKS,
      unevaluable: UNEVALUABLE_PATTERNS,
      pendingStandaloneRenames: PENDING_STANDALONE_RENAMES,
      evaluate: async (file) => {
        const program = await resolveLocalProgram(
          (resolver) => engine.resolve(resolver),
          { main: `${REPO_ROOT}/${file}`, root: REPO_ROOT },
        );
        // `noCheck`: cfcheck already type-checks this tree in its own job.
        // Here the compile exists only to reach the pattern object's schemas.
        const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
          program,
          { noCheck: true },
        );
        return (await engine.evaluateRecordGraph(
          id,
          graph,
          mainSpecifier,
          program,
        )).main;
      },
      // `PATTERN_COMPAT_TIMING=1` reports where the run spent its time: this
      // job's cost is dominated by a few pathological schemas rather than by
      // pattern count, so a cost regression is not visible from the total.
      slowCheckMs: Deno.env.get("PATTERN_COMPAT_TIMING") === undefined
        ? undefined
        : 200,
      say: options.say ?? console.log,
      records: recordsFragment,
      recordedAt: new Date(),
    });
  } finally {
    await runtime.dispose();
    recordsFragment?.close();
  }
}

if (import.meta.main) {
  emit(await runPatternCompat(Deno.args, { recordResults: true }));
}
