#!/usr/bin/env -S deno run --allow-read

/**
 * Count what console runs did with the pattern index.
 *
 * The console writes each run to `<artifact-root>/<run-id>/`, and a
 * `delegate_task` child to `<run-id>.subagent.<n>/`. This walks that tree and
 * counts, per run family: the searches issued and what the index answered
 * them with, the `run_pattern` calls split by whether they named a published
 * pattern or carried source, the `cf:pattern:` specifiers that source
 * imported, the delegations, and the slugs assigned.
 *
 * What the count establishes and what it does not is the subject of
 * [the measurement protocol](../docs/pattern-index-measurement.md). In short:
 * these are counts of what a run *did*. Nothing here reads a rendered piece,
 * so nothing here says whether what the run built works.
 *
 * Usage:
 *   deno task measure-runs                       # every family under the root
 *   deno task measure-runs <run-id> [<run-id>…]  # named families only
 *   deno task measure-runs --json                # machine-readable
 *   deno task measure-runs --artifact-root=DIR   # a root other than the default
 */

import { parseArgs } from "@std/cli/parse-args";
import { basename, join } from "@std/path";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type { HarnessRunReport } from "../src/contracts/run-report.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import type { HarnessResearchRecord } from "../src/research/runner.ts";
import { isCollapsedRunPatternSource } from "../src/run-pattern-source-collapse.ts";

/** Where the console writes its runs, relative to its working directory. */
export const DEFAULT_ARTIFACT_ROOT = ".cf-harness-console/runs";

/** The suffix the harness gives a `delegate_task` child's run directory. */
const SUBAGENT_MARKER = ".subagent.";

/**
 * A JSON payload lifted out of a transcript, or the reason it could not be
 * read. Nothing here collapses an unreadable payload into a zero: a search
 * whose answer is missing is a search nobody can say the index answered,
 * which is a different reading from a search the index answered with nothing.
 * The two are counted apart the whole way to the rendered report.
 */
export type TranscriptJson<Value> =
  | { kind: "read"; value: Value }
  | { kind: "unread"; reason: string };

/**
 * What went wrong, as a line for a report.
 *
 * One helper rather than the same ternary at every catch: a thrown value is
 * not always an `Error`, and a reader of a report should not be able to tell
 * which catch site produced a reading from how the message is shaped.
 */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const read = <Value>(value: Value): TranscriptJson<Value> => ({
  kind: "read",
  value,
});

const unread = <Value>(reason: string): TranscriptJson<Value> => ({
  kind: "unread",
  reason,
});

const parseJson = <Value>(
  text: string,
  what: string,
): TranscriptJson<Value> => {
  try {
    return read(JSON.parse(text) as Value);
  } catch (error) {
    return unread(
      `${what} is not JSON: ${describeError(error)}`,
    );
  }
};

/** What a `search_patterns` call asked the index for. */
export interface SearchQuery {
  tags: readonly string[];
  text?: string;
}

/** What the index answered a `search_patterns` call with. */
export type SearchAnswer =
  | { status: "ok"; hits: number }
  | { status: "error"; message: string };

export interface MeasuredSearch {
  query: TranscriptJson<SearchQuery>;
  answer: TranscriptJson<SearchAnswer>;
}

/**
 * What source carrying a `cf:pattern:` import does with it.
 *
 * A bare re-export — `import P from "cf:pattern:x"; export default P` — imports
 * a published pattern and composes nothing. It is indistinguishable from real
 * composition by import count alone, and the live index holds entries that are
 * exactly this, one of them ranked third overall. Counting the two together
 * would inflate the reuse reading with the behavior the measurement exists to
 * tell apart, so they are counted separately the whole way to the report.
 */
export type SourceComposition =
  | "no-imports"
  | "bare-import"
  | "re-export"
  | "composition";

/** What a `run_pattern` call was pointed at. */
export type RunPatternTarget =
  | { kind: "pattern-id"; patternId: string }
  | {
    kind: "source";

    /** The source's size in UTF-8 bytes, which is what the report prints. */
    sourceBytes: number;

    importedPatternIds: readonly string[];
    composition: SourceComposition;
  };

export interface MeasuredRunPattern {
  target: TranscriptJson<RunPatternTarget>;
  outcome: TranscriptJson<{ status: string }>;
}

export interface MeasuredDelegation {
  profile: TranscriptJson<string>;
}

export interface MeasuredSlug {
  slug: TranscriptJson<string>;

  /**
   * What the tool answered, and what it said. A slug the tool refused was
   * requested and not assigned, so counting the request as an assignment would
   * report a name nothing answers to — and the message is what separates a
   * name already taken in this space, which is a fact about the space, from a
   * tool that failed, which is a fact about the run.
   */
  outcome: TranscriptJson<{ status: string; message?: string }>;
}

/**
 * How a tool call ended, read off the result the run recorded.
 *
 * Derived here from the raw result rather than taken from any classified
 * field, so what the report says a surface did is what that surface's own
 * results say. A denial is kept apart from a failure: a tool the run was not
 * allowed to use and a tool that ran and failed are different facts about what
 * was available, and collapsing them reads as a model that chose not to use a
 * surface that was in fact withheld.
 */
export type ToolOutcome = "ok" | "denied" | "error" | "unread";

const DENIED_RESULT_TYPES: ReadonlySet<string> = new Set([
  "cf-harness.observation-denied",
  "cf-harness.tool-denied",
]);

/**
 * The result the harness synthesizes for a call it recorded and never got an
 * answer for. It carries a `reason` and no `status`, which is the shape of a
 * denial, so it is recognized by type before that heuristic runs — otherwise
 * an interrupted run reports its tools as withheld, which is a claim about
 * what was allowed rather than about what was interrupted.
 */
const UNKNOWN_OUTCOME_RESULT_TYPE = "cf-harness.tool-outcome-unknown";

/** How one recorded tool result reads. */
export const toolOutcomeOf = (
  output: TranscriptJson<Record<string, unknown>>,
): ToolOutcome => {
  if (output.kind === "unread") return "unread";
  const value = output.value;
  if (value.type === UNKNOWN_OUTCOME_RESULT_TYPE) return "unread";
  if (
    typeof value.type === "string" && DENIED_RESULT_TYPES.has(value.type)
  ) {
    return "denied";
  }
  if (value.status === undefined && typeof value.reason === "string") {
    return "denied";
  }
  if (typeof value.status === "string") {
    return value.status === "ok" ? "ok" : "error";
  }
  if (value.ok === false || value.error !== undefined) return "error";
  return "ok";
};

/** One run directory's calls against the index, and whether it was read. */
export interface RunMeasurement {
  runId: string;
  role: "parent" | "subagent";
  transcript: TranscriptJson<{ messages: number }>;
  searches: readonly MeasuredSearch[];
  runPatterns: readonly MeasuredRunPattern[];
  delegations: readonly MeasuredDelegation[];
  slugs: readonly MeasuredSlug[];

  /** Every tool the run called, and how each call ended. */
  toolOutcomes: Readonly<Record<string, Readonly<Record<string, number>>>>;

  /** Private research work from this run's own tool artifacts, not inheritance. */
  research?: TranscriptJson<readonly MeasuredResearch[]>;
}

/** A research invocation and the bounded work its artifact records. */
export interface MeasuredResearch {
  outputId: string;
  origin: "model" | "opening-research";
  wallMs: number;
  work: TranscriptJson<{
    modelTurns: number;
    toolCalls: number;
    readChars: number;
    sourceReads: number;
  }>;
}

/**
 * The counts a report adds up.
 *
 * Every field is an algebra rather than a judgement: a sum, a union of
 * identifiers, or a record merged by summing its counts. So `mergeTotals` is
 * commutative and associative, and the order runs are walked in cannot change
 * a total. Nothing here is a choice between two readings, which is what would
 * destroy that property.
 *
 * The four search fields partition `searches`, and the three `runPattern`
 * target fields partition `runPatterns`: an unreadable payload lands in the
 * `Unread` field rather than in the majority one.
 */
export interface MeasurementTotals {
  runs: number;
  runsUnread: number;
  searches: number;
  searchesWithHits: number;
  searchesEmpty: number;
  searchesRefused: number;
  searchesUnread: number;
  runPatterns: number;
  runPatternsByPatternId: number;
  runPatternsFromSource: number;
  runPatternsUnreadTarget: number;

  /**
   * Source importing a published pattern. The three counts below partition
   * this one; a single figure over them would read as composition and count
   * bare re-exports and bare imports towards it.
   */
  runPatternsImportingPatterns: number;

  /** Of those, the ones whose import a composing call put to work. */
  runPatternsComposing: number;

  /** Of those, the ones that only re-export what they import. */
  runPatternsReexporting: number;

  /** Of those, the ones that import without composing or re-exporting. */
  runPatternsBareImporting: number;

  runPatternOutcomes: Readonly<Record<string, number>>;
  runPatternOutcomesUnread: number;

  /** Every published pattern the source referenced, however it referenced it. */
  importedPatternIds: readonly string[];

  /**
   * Only those a composing call put to work. A bare import or a bare
   * re-export references a pattern and composes nothing, so presenting the
   * union as "what composed what" would report a reference as a composition.
   */
  composedPatternIds: readonly string[];

  delegations: number;
  delegationProfiles: Readonly<Record<string, number>>;
  delegationProfilesUnread: number;

  /** `assign_slug` calls. The three counts below partition this one. */
  slugs: number;

  /** Of those, the ones the tool assigned a slug for. */
  slugsAssigned: number;

  /** Of those, the ones it refused. */
  slugsRefused: number;

  /** Of those, the ones whose outcome could not be read. */
  slugsUnread: number;

  /**
   * The slug names themselves, from the assigned calls alone: a refused or
   * unread call contributes none, and neither does an assigned call whose name
   * could not be read.
   */
  slugNames: readonly string[];

  /**
   * Tool name to outcome to count, over every tool the runs called. This is
   * what says which surfaces were available during a batch: a surface whose
   * every call was denied was withheld, not declined.
   */
  toolOutcomes: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** One run family: a parent run and the `delegate_task` children under it. */
export interface RunFamilyMeasurement {
  familyId: string;
  runs: readonly RunMeasurement[];
  totals: MeasurementTotals;
}

export interface MeasurementReport {
  artifactRoot: string;
  families: readonly RunFamilyMeasurement[];
  totals: MeasurementTotals;
}

export const emptyTotals = (): MeasurementTotals => ({
  runs: 0,
  runsUnread: 0,
  searches: 0,
  searchesWithHits: 0,
  searchesEmpty: 0,
  searchesRefused: 0,
  searchesUnread: 0,
  runPatterns: 0,
  runPatternsByPatternId: 0,
  runPatternsFromSource: 0,
  runPatternsUnreadTarget: 0,
  runPatternsImportingPatterns: 0,
  runPatternsComposing: 0,
  runPatternsReexporting: 0,
  runPatternsBareImporting: 0,
  runPatternOutcomes: {},
  runPatternOutcomesUnread: 0,
  importedPatternIds: [],
  composedPatternIds: [],
  delegations: 0,
  delegationProfiles: {},
  delegationProfilesUnread: 0,
  slugs: 0,
  slugsAssigned: 0,
  slugsRefused: 0,
  slugsUnread: 0,
  slugNames: [],
  toolOutcomes: {},
});

const mergeCounts = (
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> => {
  const merged: Record<string, number> = { ...left };
  for (const [key, count] of Object.entries(right)) {
    merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
};

const mergeToolOutcomes = (
  left: Readonly<Record<string, Readonly<Record<string, number>>>>,
  right: Readonly<Record<string, Readonly<Record<string, number>>>>,
): Readonly<Record<string, Readonly<Record<string, number>>>> => {
  const merged: Record<string, Readonly<Record<string, number>>> = {
    ...left,
  };
  for (const [tool, outcomes] of Object.entries(right)) {
    merged[tool] = mergeCounts(merged[tool] ?? {}, outcomes);
  }
  return merged;
};

const mergeNames = (
  left: readonly string[],
  right: readonly string[],
): readonly string[] => [...new Set([...left, ...right])].sort();

/** Adds two totals. Commutative and associative over every field. */
export const mergeTotals = (
  left: MeasurementTotals,
  right: MeasurementTotals,
): MeasurementTotals => ({
  runs: left.runs + right.runs,
  runsUnread: left.runsUnread + right.runsUnread,
  searches: left.searches + right.searches,
  searchesWithHits: left.searchesWithHits + right.searchesWithHits,
  searchesEmpty: left.searchesEmpty + right.searchesEmpty,
  searchesRefused: left.searchesRefused + right.searchesRefused,
  searchesUnread: left.searchesUnread + right.searchesUnread,
  runPatterns: left.runPatterns + right.runPatterns,
  runPatternsByPatternId: left.runPatternsByPatternId +
    right.runPatternsByPatternId,
  runPatternsFromSource: left.runPatternsFromSource +
    right.runPatternsFromSource,
  runPatternsUnreadTarget: left.runPatternsUnreadTarget +
    right.runPatternsUnreadTarget,
  runPatternsImportingPatterns: left.runPatternsImportingPatterns +
    right.runPatternsImportingPatterns,
  runPatternsComposing: left.runPatternsComposing + right.runPatternsComposing,
  runPatternsReexporting: left.runPatternsReexporting +
    right.runPatternsReexporting,
  runPatternsBareImporting: left.runPatternsBareImporting +
    right.runPatternsBareImporting,
  runPatternOutcomes: mergeCounts(
    left.runPatternOutcomes,
    right.runPatternOutcomes,
  ),
  runPatternOutcomesUnread: left.runPatternOutcomesUnread +
    right.runPatternOutcomesUnread,
  importedPatternIds: mergeNames(
    left.importedPatternIds,
    right.importedPatternIds,
  ),
  composedPatternIds: mergeNames(
    left.composedPatternIds,
    right.composedPatternIds,
  ),
  delegations: left.delegations + right.delegations,
  delegationProfiles: mergeCounts(
    left.delegationProfiles,
    right.delegationProfiles,
  ),
  delegationProfilesUnread: left.delegationProfilesUnread +
    right.delegationProfilesUnread,
  slugs: left.slugs + right.slugs,
  slugsAssigned: left.slugsAssigned + right.slugsAssigned,
  slugsRefused: left.slugsRefused + right.slugsRefused,
  slugsUnread: left.slugsUnread + right.slugsUnread,
  slugNames: mergeNames(left.slugNames, right.slugNames),
  toolOutcomes: mergeToolOutcomes(left.toolOutcomes, right.toolOutcomes),
});

export const foldTotals = (
  totals: readonly MeasurementTotals[],
): MeasurementTotals => totals.reduce(mergeTotals, emptyTotals());

/** The counts one run contributes. */
export const totalsOf = (run: RunMeasurement): MeasurementTotals => {
  const totals = emptyTotals();
  const runPatternOutcomes: Record<string, number> = {};
  const delegationProfiles: Record<string, number> = {};
  const importedPatternIds = new Set<string>();
  const composedPatternIds = new Set<string>();
  const slugNames = new Set<string>();
  let searchesWithHits = 0;
  let searchesEmpty = 0;
  let searchesRefused = 0;
  let searchesUnread = 0;
  let byPatternId = 0;
  let fromSource = 0;
  let unreadTarget = 0;
  let importing = 0;
  let composing = 0;
  let reexporting = 0;
  let bareImporting = 0;
  let outcomesUnread = 0;
  let profilesUnread = 0;

  for (const search of run.searches) {
    if (search.answer.kind === "unread") {
      searchesUnread += 1;
    } else if (search.answer.value.status === "error") {
      searchesRefused += 1;
    } else if (search.answer.value.hits > 0) {
      searchesWithHits += 1;
    } else {
      searchesEmpty += 1;
    }
  }
  for (const call of run.runPatterns) {
    if (call.target.kind === "unread") {
      unreadTarget += 1;
    } else if (call.target.value.kind === "pattern-id") {
      byPatternId += 1;
    } else {
      fromSource += 1;
      if (call.target.value.importedPatternIds.length > 0) {
        importing += 1;
        if (call.target.value.composition === "re-export") reexporting += 1;
        else if (call.target.value.composition === "bare-import") {
          bareImporting += 1;
        } else composing += 1;
      }
      for (const id of call.target.value.importedPatternIds) {
        importedPatternIds.add(id);
        if (call.target.value.composition === "composition") {
          composedPatternIds.add(id);
        }
      }
    }
    if (call.outcome.kind === "unread") {
      outcomesUnread += 1;
    } else {
      const status = call.outcome.value.status;
      runPatternOutcomes[status] = (runPatternOutcomes[status] ?? 0) + 1;
    }
  }
  for (const delegation of run.delegations) {
    if (delegation.profile.kind === "unread") {
      profilesUnread += 1;
    } else {
      const profile = delegation.profile.value;
      delegationProfiles[profile] = (delegationProfiles[profile] ?? 0) + 1;
    }
  }
  let slugsAssigned = 0;
  let slugsRefused = 0;
  let slugsUnread = 0;
  for (const slug of run.slugs) {
    if (slug.outcome.kind === "unread") {
      slugsUnread += 1;
      continue;
    }
    if (slug.outcome.value.status !== "ok") {
      slugsRefused += 1;
      continue;
    }
    slugsAssigned += 1;
    if (slug.slug.kind === "read") slugNames.add(slug.slug.value);
  }

  return {
    ...totals,
    runs: 1,
    runsUnread: run.transcript.kind === "unread" ? 1 : 0,
    searches: run.searches.length,
    searchesWithHits,
    searchesEmpty,
    searchesRefused,
    searchesUnread,
    runPatterns: run.runPatterns.length,
    runPatternsByPatternId: byPatternId,
    runPatternsFromSource: fromSource,
    runPatternsUnreadTarget: unreadTarget,
    runPatternsImportingPatterns: importing,
    runPatternsComposing: composing,
    runPatternsReexporting: reexporting,
    runPatternsBareImporting: bareImporting,
    runPatternOutcomes,
    runPatternOutcomesUnread: outcomesUnread,
    importedPatternIds: [...importedPatternIds].sort(),
    composedPatternIds: [...composedPatternIds].sort(),
    delegations: run.delegations.length,
    delegationProfiles,
    delegationProfilesUnread: profilesUnread,
    slugs: run.slugs.length,
    slugsAssigned,
    slugsRefused,
    slugsUnread,
    slugNames: [...slugNames].sort(),
    toolOutcomes: run.toolOutcomes,
  };
};

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;
const IMPORT_STATEMENT = /\bimport\s+[\s\S]*?\s+from\s*(['"])([^'"]+)\1\s*;?/g;

/** `import "cf:pattern:…"`, which binds nothing and so carries no `from`. */
const BARE_IMPORT_STATEMENT = /\bimport\s*(['"])([^'"]+)\1\s*;?/g;

const EXPORT_FROM_STATEMENT =
  /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s*(['"])([^'"]+)\1\s*;?/g;
const DEFAULT_IMPORT =
  /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,[\s\S]*?)?\s+from\s*(['"])([^'"]+)\2\s*;?/g;
const EXPORT_DEFAULT_IDENT = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g;

const PATTERN_SPECIFIER_PREFIX = "cf:pattern:";

const isPatternSpecifier = (specifier: string): boolean =>
  specifier.startsWith(PATTERN_SPECIFIER_PREFIX);

const stripComments = (sourceText: string): string =>
  sourceText.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, "$1");

/**
 * Whether pattern source composes the patterns it imports or merely re-exports
 * one of them.
 *
 * The test is that nothing survives: strip the comments, the imports, the
 * `export … from` re-exports and an `export default <imported binding>`, and a
 * bare re-export has nothing left. Anything with a body left over is composing,
 * which is the conservative direction — source written unusually is reported as
 * composition rather than quietly discounted, and the two counts are reported
 * apart so a reader can see which is which rather than trust the split.
 */
export const classifyPatternSource = (
  sourceText: string,
): SourceComposition => {
  if (importedPatternIdsOf(sourceText).length === 0) return "no-imports";
  const stripped = stripComments(sourceText);
  // A bare `import "cf:pattern:…"` binds nothing, so source whose only
  // reference to a published pattern is one cannot be putting it to work. It
  // is a reference and not a composition, and counting it as composition
  // would inflate the one figure this split exists to isolate.
  if (
    [...stripped.matchAll(IMPORT_STATEMENT)].every(([, , specifier]) =>
      !isPatternSpecifier(specifier)
    ) &&
    [...stripped.matchAll(EXPORT_FROM_STATEMENT)].every(([, , specifier]) =>
      !isPatternSpecifier(specifier)
    )
  ) {
    return "bare-import";
  }
  const defaultBindings = new Set(
    [...stripped.matchAll(DEFAULT_IMPORT)]
      .filter(([, , , specifier]) => isPatternSpecifier(specifier))
      .map(([, binding]) => binding),
  );
  const reexportsFromPattern = [...stripped.matchAll(EXPORT_FROM_STATEMENT)]
    .some(([, , specifier]) => isPatternSpecifier(specifier));
  const reexportsBinding = [...stripped.matchAll(EXPORT_DEFAULT_IDENT)]
    .some(([, binding]) => defaultBindings.has(binding));
  if (!reexportsFromPattern && !reexportsBinding) return "composition";
  const remainder = stripped
    .replace(IMPORT_STATEMENT, " ")
    .replace(EXPORT_FROM_STATEMENT, " ")
    .replace(EXPORT_DEFAULT_IDENT, " ");
  return remainder.trim() === "" ? "re-export" : "composition";
};

/**
 * The `cf:pattern:` specifiers a piece of pattern source imports.
 *
 * Read from import and `export … from` declarations rather than from anywhere
 * the text says `cf:pattern:`. A specifier named in a comment or quoted in a
 * message imports nothing, and counting it would inflate the reuse reading
 * with source that composes nothing — the same error a bare re-export makes,
 * arrived at from the other direction.
 */
export const importedPatternIdsOf = (
  sourceText: string,
): readonly string[] => {
  const stripped = stripComments(sourceText);
  const specifiers = [
    ...[...stripped.matchAll(IMPORT_STATEMENT)].map(([, , specifier]) =>
      specifier
    ),
    ...[...stripped.matchAll(BARE_IMPORT_STATEMENT)].map(([, , specifier]) =>
      specifier
    ),
    ...[...stripped.matchAll(EXPORT_FROM_STATEMENT)].map(([, , specifier]) =>
      specifier
    ),
  ];
  return [
    ...new Set(
      specifiers.filter(isPatternSpecifier).map((specifier) =>
        specifier.slice(PATTERN_SPECIFIER_PREFIX.length)
      ),
    ),
  ].sort();
};

const searchQueryOf = (
  args: TranscriptJson<Record<string, unknown>>,
): TranscriptJson<SearchQuery> => {
  if (args.kind === "unread") return args;
  const tags = Array.isArray(args.value.tags)
    ? args.value.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const text = args.value.text;
  return read({
    tags,
    ...(typeof text === "string" ? { text } : {}),
  });
};

const searchAnswerOf = (
  output: TranscriptJson<Record<string, unknown>>,
): TranscriptJson<SearchAnswer> => {
  if (output.kind === "unread") return output;
  const { status, results, message } = output.value;
  if (status === "ok") {
    return Array.isArray(results)
      ? read({ status: "ok", hits: results.length })
      : unread("a search reported `ok` and carried no results array");
  }
  if (status === "error") {
    return read({
      status: "error",
      message: typeof message === "string" ? message : "(no message)",
    });
  }
  return unread(
    `a search reported no status this reader knows: ${String(status)}`,
  );
};

const runPatternTargetOf = (
  args: TranscriptJson<Record<string, unknown>>,
): TranscriptJson<RunPatternTarget> => {
  if (args.kind === "unread") return args;
  const { patternId, sourceText } = args.value;
  if (typeof patternId === "string") {
    return read({ kind: "pattern-id", patternId });
  }
  if (typeof sourceText === "string") {
    if (isCollapsedRunPatternSource(sourceText)) {
      return unread("collapsed source requires its saved source artifact");
    }
    return read({
      kind: "source",
      sourceBytes: new TextEncoder().encode(sourceText).length,
      importedPatternIds: importedPatternIdsOf(sourceText),
      composition: classifyPatternSource(sourceText),
    });
  }
  return unread("a run_pattern call named neither patternId nor sourceText");
};

/** A tool's status together with whatever it said about a non-`ok` one. */
const statusAndMessageOf = (
  output: TranscriptJson<Record<string, unknown>>,
): TranscriptJson<{ status: string; message?: string }> => {
  const status = statusOf(output);
  if (status.kind === "unread" || output.kind === "unread") return status;
  const message = output.value.message;
  return read({
    status: status.value.status,
    ...(typeof message === "string" ? { message } : {}),
  });
};

const statusOf = (
  output: TranscriptJson<Record<string, unknown>>,
): TranscriptJson<{ status: string }> => {
  if (output.kind === "unread") return output;
  const status = output.value.status;
  return typeof status === "string"
    ? read({ status })
    : unread("a tool result carried no status");
};

const stringFieldOf = (
  args: TranscriptJson<Record<string, unknown>>,
  field: string,
): TranscriptJson<string> => {
  if (args.kind === "unread") return args;
  const value = args.value[field];
  return typeof value === "string"
    ? read(value)
    : unread(`a tool call carried no ${field}`);
};

/**
 * Reads a transcript's tool calls and pairs each with its result.
 *
 * Pairing is by `toolCallId` rather than by the order the two kinds of message
 * happen to appear in. A turn abandoned mid-call leaves a call with no result,
 * and a positional pairing would then answer every later call with the
 * previous call's result — silently, and for the rest of the run.
 */
export const measureTranscript = (
  runId: string,
  role: RunMeasurement["role"],
  transcript: readonly HarnessTranscriptMessage[],
  sourceArtifacts: ReadonlyMap<string, TranscriptJson<string>> = new Map(),
): RunMeasurement => {
  const results = new Map<string, TranscriptJson<Record<string, unknown>>>();
  // A transcript that parsed as an array may still hold something that is not
  // a message. Skipping a non-object entry keeps a malformed artifact to one
  // unreadable run rather than aborting the whole report.
  const messages = transcript.filter((
    message,
  ): message is typeof transcript[number] => isObjectOrArray(message));
  for (const message of messages) {
    if (message.role === "tool") {
      if (typeof message.toolCallId !== "string") continue;
      results.set(
        message.toolCallId,
        parseJson<Record<string, unknown>>(
          message.content,
          `the ${message.toolName} result`,
        ),
      );
    }
  }
  const outputFor = (
    toolCallId: string,
  ): TranscriptJson<Record<string, unknown>> =>
    results.get(toolCallId) ??
      unread("the run recorded no result for this call");

  const toolOutcomes: Record<string, Record<string, number>> = {};
  const searches: MeasuredSearch[] = [];
  const runPatterns: MeasuredRunPattern[] = [];
  const delegations: MeasuredDelegation[] = [];
  const slugs: MeasuredSlug[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      let args = parseJson<Record<string, unknown>>(
        call.function.arguments,
        `the ${call.function.name} arguments`,
      );
      const outcomes = toolOutcomes[call.function.name] ?? {};
      const outcome = toolOutcomeOf(outputFor(call.id));
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      toolOutcomes[call.function.name] = outcomes;
      switch (call.function.name) {
        case "search_patterns":
          searches.push({
            query: searchQueryOf(args),
            answer: searchAnswerOf(outputFor(call.id)),
          });
          break;
        case "run_pattern":
          if (
            args.kind === "read" && typeof args.value.sourceText === "string"
          ) {
            const output = outputFor(call.id);
            const source = output.kind === "read" &&
                typeof output.value.outputId === "string"
              ? sourceArtifacts.get(output.value.outputId)
              : undefined;
            if (source?.kind === "read") {
              args = read({ ...args.value, sourceText: source.value });
            } else if (source?.kind === "unread") {
              args = source;
            }
          }
          runPatterns.push({
            target: runPatternTargetOf(args),
            outcome: statusOf(outputFor(call.id)),
          });
          break;
        case "delegate_task":
          delegations.push({ profile: stringFieldOf(args, "profile") });
          break;
        case "assign_slug":
          slugs.push({
            slug: stringFieldOf(args, "slug"),
            outcome: statusAndMessageOf(outputFor(call.id)),
          });
          break;
      }
    }
  }

  return {
    runId,
    role,
    transcript: read({ messages: messages.length }),
    searches,
    runPatterns,
    delegations,
    slugs,
    toolOutcomes,
  };
};

/** A run whose transcript could not be read, recorded as exactly that. */
export const unreadRun = (
  runId: string,
  role: RunMeasurement["role"],
  reason: string,
): RunMeasurement => ({
  runId,
  role,
  transcript: unread(reason),
  searches: [],
  runPatterns: [],
  delegations: [],
  slugs: [],
  toolOutcomes: {},
});

/** Which family a run directory belongs to, by the name the harness gave it. */
export const familyIdOf = (runId: string): string => {
  const marker = runId.indexOf(SUBAGENT_MARKER);
  return marker === -1 ? runId : runId.slice(0, marker);
};

/**
 * Groups run directory names into families, each family's runs sorted with
 * the parent first and the children in the order the harness numbered them.
 *
 * A child whose parent directory is not in the listing still forms a family
 * under the parent's id: the child's work happened, and dropping it would
 * make the report quieter than the tree it read.
 */
export const runFamiliesOf = (
  runIds: readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const families = new Map<string, string[]>();
  for (const runId of [...runIds].sort()) {
    const familyId = familyIdOf(runId);
    const members = families.get(familyId) ?? [];
    members.push(runId);
    families.set(familyId, members);
  }
  return families;
};

const roleOf = (runId: string, familyId: string): RunMeasurement["role"] =>
  runId === familyId ? "parent" : "subagent";

const readTranscript = async (
  path: string,
): Promise<TranscriptJson<readonly HarnessTranscriptMessage[]>> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    return unread(
      error instanceof Deno.errors.NotFound
        ? "the run directory holds no transcript.json"
        : `transcript.json could not be read: ${describeError(error)}`,
    );
  }
  const parsed = parseJson<unknown>(text, "transcript.json");
  if (parsed.kind === "unread") return parsed;
  return Array.isArray(parsed.value)
    ? read(parsed.value as readonly HarnessTranscriptMessage[])
    : unread("transcript.json is not an array of messages");
};

/** Reads source sidecars by their stored output identity, including old drafts. */
const readSourceArtifacts = async (
  runRoot: string,
): Promise<ReadonlyMap<string, TranscriptJson<string>>> => {
  const sources = new Map<string, TranscriptJson<string>>();
  try {
    for await (const entry of Deno.readDir(join(runRoot, "tool-outputs"))) {
      if (!entry.isFile || !entry.name.endsWith("-run-pattern-source.json")) {
        continue;
      }
      const artifact = await readJsonObject(
        join(runRoot, "tool-outputs", entry.name),
      );
      if (artifact.kind === "unread") continue;
      const { outputId, sourceText, type } = artifact.value;
      if (typeof outputId !== "string") continue;
      sources.set(
        outputId,
        sources.has(outputId)
          ? unread(`multiple source artifacts claim ${outputId}`)
          : type === "cf-harness.run-pattern-source" &&
              typeof sourceText === "string"
          ? read(sourceText)
          : unread(`the source artifact for ${outputId} is malformed`),
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return sources;
};

/** Parses an artifact without treating an unread value as an empty object. */
const readJsonObject = async (
  path: string,
): Promise<TranscriptJson<Record<string, unknown>>> => {
  try {
    const parsed = parseJson<unknown>(
      await Deno.readTextFile(path),
      basename(path),
    );
    if (parsed.kind === "unread") return parsed;
    return isObjectNotArray(parsed.value)
      ? read(parsed.value as Record<string, unknown>)
      : unread(`${basename(path)} is not an object`);
  } catch (error) {
    return unread(
      `${basename(path)} could not be read: ${describeError(error)}`,
    );
  }
};

/** Research activity normalized to only the fields measurement consumes. */
type ResearchActivityReading =
  & Pick<MeasuredResearch, "origin" | "outputId" | "wallMs">
  & {
    /** Path of the raw result artifact, when the activity retained one. */
    artifactPath?: string;
  };

/**
 * Reads and normalizes research activity. Other fields may be absent from
 * historical reports, but no row can be dropped merely because its tool
 * identity is unreadable.
 */
const readResearchActivity = (
  value: unknown,
): TranscriptJson<readonly ResearchActivityReading[]> => {
  if (!Array.isArray(value)) {
    return unread("`run-report.json` has no activity list");
  }
  const research: ResearchActivityReading[] = [];
  for (const [index, activity] of value.entries()) {
    if (
      typeof activity !== "object" || activity === null ||
      Array.isArray(activity) || typeof activity.toolId !== "string" ||
      activity.toolId.length === 0
    ) {
      return unread(
        `\`run-report.json\` has malformed \`.toolActivity[${index}]\``,
      );
    }
    if (activity.toolId !== "research") continue;
    if (
      typeof activity.toolCallId !== "string" ||
      activity.toolCallId.length === 0 ||
      typeof activity.startedAt !== "string" ||
      !Number.isFinite(Date.parse(activity.startedAt)) ||
      typeof activity.endedAt !== "string" ||
      !Number.isFinite(Date.parse(activity.endedAt)) ||
      (activity.origin !== undefined && activity.origin !== "model" &&
        activity.origin !== "opening-research")
    ) {
      return unread(
        `\`run-report.json\` has malformed \`.toolActivity[${index}]\``,
      );
    }
    const resultRef = activity.resultRef;
    if (
      resultRef !== undefined &&
      (typeof resultRef !== "object" || resultRef === null ||
        Array.isArray(resultRef) || typeof resultRef.outputId !== "string" ||
        (resultRef.artifactPath !== undefined &&
          typeof resultRef.artifactPath !== "string"))
    ) {
      return unread(
        `\`run-report.json\` has malformed \`.toolActivity[${index}]\``,
      );
    }
    research.push({
      outputId: resultRef?.outputId ?? activity.toolCallId,
      origin: activity.origin ?? "model",
      wallMs: Date.parse(activity.endedAt) - Date.parse(activity.startedAt),
      ...(resultRef?.artifactPath !== undefined
        ? { artifactPath: resultRef.artifactPath }
        : {}),
    });
  }
  return read(research);
};

/** Adds host opening calls and private work without counting inherited kits. */
const measureResearchArtifacts = async (
  runRoot: string,
  measurement: RunMeasurement,
): Promise<RunMeasurement> => {
  let reportText: string;
  try {
    reportText = await Deno.readTextFile(join(runRoot, "run-report.json"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return measurement;
    return { ...measurement, research: unread(describeError(error)) };
  }
  const parsed = parseJson<HarnessRunReport>(reportText, "run-report.json");
  if (parsed.kind === "unread") return { ...measurement, research: parsed };
  if (parsed.value?.runId !== measurement.runId) {
    return {
      ...measurement,
      research: unread(
        "run-report.json has no matching run identity and activity list",
      ),
    };
  }
  const activity = readResearchActivity(parsed.value.toolActivity);
  if (activity.kind === "unread") {
    return { ...measurement, research: activity };
  }
  const calls = activity.value;
  if (calls.length === 0) return measurement;
  const research: MeasuredResearch[] = [];
  const toolOutcomes = { ...measurement.toolOutcomes };
  for (const call of calls) {
    const outputId = call.outputId;
    const artifact = call.artifactPath === undefined
      ? unread<Record<string, unknown>>("research has no output artifact")
      : await readJsonObject(
        join(runRoot, "tool-outputs", basename(call.artifactPath)),
      );
    const matched =
      artifact.kind === "read" && artifact.value.outputId !== outputId
        ? unread<Record<string, unknown>>(
          "research artifact output identity does not match its activity",
        )
        : artifact;
    if (call.origin === "opening-research") {
      const counts = { ...toolOutcomes.research };
      const outcome = toolOutcomeOf(matched);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      toolOutcomes.research = counts;
    }
    const record = matched.kind === "read"
      ? matched.value.researchRecord as HarnessResearchRecord | undefined
      : undefined;
    research.push({
      outputId,
      origin: call.origin,
      wallMs: call.wallMs,
      work: record?.researchRunId === outputId &&
          record.budgets !== undefined && Array.isArray(record.sourceReads) &&
          [
            record.budgets.modelTurns,
            record.budgets.toolCalls,
            record.budgets.readChars,
          ].every((n) => Number.isSafeInteger(n) && n >= 0)
        ? read({ ...record.budgets, sourceReads: record.sourceReads.length })
        : unread(
          matched.kind === "unread"
            ? matched.reason
            : "research has no matching private work record",
        ),
    });
  }
  return { ...measurement, toolOutcomes, research: read(research) };
};

/** Measures one run directory, read or not. */
export const measureRun = async (
  artifactRoot: string,
  runId: string,
  role: RunMeasurement["role"],
): Promise<RunMeasurement> => {
  const transcript = await readTranscript(
    join(artifactRoot, runId, "transcript.json"),
  );
  if (transcript.kind === "unread") {
    return unreadRun(runId, role, transcript.reason);
  }
  const runRoot = join(artifactRoot, runId);
  return await measureResearchArtifacts(
    runRoot,
    measureTranscript(
      runId,
      role,
      transcript.value,
      await readSourceArtifacts(runRoot),
    ),
  );
};

/** Every run directory name under an artifact root. */
export const listRunIds = async (
  artifactRoot: string,
): Promise<readonly string[]> => {
  const runIds: string[] = [];
  for await (const entry of Deno.readDir(artifactRoot)) {
    if (entry.isDirectory) runIds.push(entry.name);
  }
  return runIds.sort();
};

export const measureRunFamily = async (
  artifactRoot: string,
  familyId: string,
  members: readonly string[],
): Promise<RunFamilyMeasurement> => {
  const runs = members.length === 0
    ? [
      unreadRun(
        familyId,
        "parent",
        "no run directory of this name is under the artifact root",
      ),
    ]
    : await Promise.all(
      members.map((runId) =>
        measureRun(artifactRoot, runId, roleOf(runId, familyId))
      ),
    );
  return { familyId, runs, totals: foldTotals(runs.map(totalsOf)) };
};

/**
 * Measures the named families, or every family under the root when none are
 * named. A named family with no directory is reported as unread rather than
 * skipped.
 */
export const measureArtifactRoot = async (
  artifactRoot: string,
  familyIds: readonly string[] = [],
): Promise<MeasurementReport> => {
  const present = runFamiliesOf(await listRunIds(artifactRoot));
  const wanted = familyIds.length === 0
    ? [...present.keys()].sort()
    : [...familyIds];
  const families = await Promise.all(
    wanted.map((familyId) =>
      measureRunFamily(artifactRoot, familyId, present.get(familyId) ?? [])
    ),
  );
  return {
    artifactRoot,
    families,
    totals: foldTotals(families.map((family) => family.totals)),
  };
};

const formatSearchQuery = (query: TranscriptJson<SearchQuery>): string => {
  if (query.kind === "unread") return `(unread: ${singleLine(query.reason)})`;
  const parts: string[] = [];
  if (query.value.tags.length > 0) {
    parts.push(`tags=${query.value.tags.join(",")}`);
  }
  if (query.value.text !== undefined) {
    parts.push(JSON.stringify(query.value.text));
  }
  return parts.length === 0 ? "(no query)" : parts.join(" ");
};

const formatSearchAnswer = (
  answer: TranscriptJson<SearchAnswer>,
): string =>
  answer.kind === "unread"
    ? `NOT READ (${singleLine(answer.reason)})`
    : answer.value.status === "error"
    ? `refused (${answer.value.message})`
    : `${answer.value.hits} hits`;

const formatCounts = (counts: Readonly<Record<string, number>>): string => {
  const entries = Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return entries.length === 0
    ? "none"
    : entries.map(([key, count]) => `${key}=${count}`).join(" ");
};

/**
 * One reading, on one line.
 *
 * A reason can carry a newline — an engine's parse error quotes the offending
 * text, which may itself span lines — and the text report's contract is one
 * reading per line. A reason left unfolded silently becomes two readings, one
 * of which names nothing.
 */
const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The per-call lines one run contributes to the rendered report. */
export const renderRunLines = (run: RunMeasurement): readonly string[] => {
  const label = run.role === "parent" ? "parent" : run.runId;
  const lines: string[] = [];
  if (run.transcript.kind === "unread") {
    return [`  [${label}] NOT READ: ${singleLine(run.transcript.reason)}`];
  }
  if (run.research?.kind === "unread") {
    lines.push(
      `  [${label}] research NOT READ (${singleLine(run.research.reason)})`,
    );
  } else {
    for (const call of run.research?.value ?? []) {
      const work = call.work.kind === "unread"
        ? `NOT READ (${singleLine(call.work.reason)})`
        : `${call.work.value.modelTurns} turns, ${call.work.value.toolCalls} private calls, ${call.work.value.sourceReads} reads, ${call.work.value.readChars} characters`;
      lines.push(
        `  [${label}] research ${call.origin}: ${work}; ${call.wallMs} ms`,
      );
    }
  }
  for (const search of run.searches) {
    lines.push(
      `  [${label}] search ${formatSearchQuery(search.query)} -> ${
        formatSearchAnswer(search.answer)
      }`,
    );
  }
  for (const call of run.runPatterns) {
    const outcome = call.outcome.kind === "unread"
      ? `NOT READ (${singleLine(call.outcome.reason)})`
      : call.outcome.value.status;
    const target = call.target.kind === "unread"
      ? `NOT READ (${singleLine(call.target.reason)})`
      : call.target.value.kind === "pattern-id"
      ? `by id ${call.target.value.patternId}`
      : `source ${call.target.value.sourceBytes}B${
        call.target.value.importedPatternIds.length === 0
          ? ""
          : `${
            call.target.value.composition === "re-export"
              ? " BARE RE-EXPORT of"
              : call.target.value.composition === "bare-import"
              ? " bare-imports"
              : " composes"
          } ${call.target.value.importedPatternIds.join(",")}`
      }`;
    lines.push(`  [${label}] run_pattern ${target} -> ${outcome}`);
  }
  for (const delegation of run.delegations) {
    lines.push(
      `  [${label}] delegate -> ${
        delegation.profile.kind === "read"
          ? delegation.profile.value
          : `NOT READ (${singleLine(delegation.profile.reason)})`
      }`,
    );
  }
  for (const slug of run.slugs) {
    lines.push(
      `  [${label}] assign_slug ${
        slug.slug.kind === "read"
          ? slug.slug.value
          : `NOT READ (${singleLine(slug.slug.reason)})`
      } -> ${
        slug.outcome.kind === "read"
          ? `${slug.outcome.value.status}${
            slug.outcome.value.message === undefined
              ? ""
              : ` (${slug.outcome.value.message})`
          }`
          : `NOT READ (${singleLine(slug.outcome.reason)})`
      }`,
    );
  }
  return lines;
};

/** The totals block, as lines. */
export const renderTotalsLines = (
  totals: MeasurementTotals,
): readonly string[] => [
  `  runs: ${totals.runs} (${totals.runsUnread} not read)`,
  `  searches: ${totals.searches} = ${totals.searchesWithHits} with hits + ${totals.searchesEmpty} empty + ${totals.searchesRefused} refused + ${totals.searchesUnread} not read`,
  `  run_pattern: ${totals.runPatterns} = ${totals.runPatternsByPatternId} by id + ${totals.runPatternsFromSource} from source + ${totals.runPatternsUnreadTarget} not read`,
  `  run_pattern source importing a published pattern: ${totals.runPatternsImportingPatterns} = ${totals.runPatternsComposing} composing + ${totals.runPatternsReexporting} bare re-export + ${totals.runPatternsBareImporting} bare import`,
  `  run_pattern outcomes: ${
    formatCounts(totals.runPatternOutcomes)
  } (${totals.runPatternOutcomesUnread} not read)`,
  `  referenced patterns: ${
    totals.importedPatternIds.length === 0
      ? "none"
      : totals.importedPatternIds.join(" ")
  }`,
  `  composed patterns: ${
    totals.composedPatternIds.length === 0
      ? "none"
      : totals.composedPatternIds.join(" ")
  }`,
  `  delegations: ${totals.delegations} by profile ${
    formatCounts(totals.delegationProfiles)
  } (${totals.delegationProfilesUnread} not read)`,
  `  slugs: ${totals.slugs} = ${totals.slugsAssigned} assigned + ${totals.slugsRefused} refused + ${totals.slugsUnread} not read${
    totals.slugNames.length === 0 ? "" : ` — ${totals.slugNames.join(" ")}`
  }`,
  ...renderToolSurfaceLines(totals.toolOutcomes),
];

/**
 * What each tool surface did, so a surface that was withheld is not read as a
 * surface the model chose not to use. A tool whose every call was denied is
 * marked, because that is the reading a report must not leave to inference.
 */
export const renderToolSurfaceLines = (
  toolOutcomes: Readonly<Record<string, Readonly<Record<string, number>>>>,
): readonly string[] => {
  const tools = Object.entries(toolOutcomes).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (tools.length === 0) return ["  tool surfaces: none called"];
  return [
    "  tool surfaces:",
    ...tools.map(([tool, outcomes]) => {
      const total = Object.values(outcomes).reduce(
        (sum, count) => sum + count,
        0,
      );
      const denied = outcomes.denied ?? 0;
      const ok = outcomes.ok ?? 0;
      const note = denied === total
        ? " — WITHHELD: every call denied"
        : ok === 0
        ? " — never once succeeded"
        : "";
      return `    ${tool}: ${formatCounts(outcomes)}${note}`;
    }),
  ];
};

/** The whole report, as lines. */
export const renderReportLines = (
  report: MeasurementReport,
): readonly string[] => {
  const lines: string[] = [`artifact root: ${report.artifactRoot}`];
  for (const family of report.families) {
    lines.push("", `===== RUN ${family.familyId} (${family.runs.length} runs)`);
    for (const run of family.runs) lines.push(...renderRunLines(run));
    lines.push(...renderTotalsLines(family.totals));
  }
  lines.push("", `===== ALL ${report.families.length} FAMILIES`);
  lines.push(...renderTotalsLines(report.totals));
  return lines;
};

export const main = async (
  args: readonly string[],
  log: (line: string) => void = console.log,
): Promise<number> => {
  const flags = parseArgs([...args], {
    boolean: ["json"],
    string: ["artifact-root"],
    default: { "artifact-root": DEFAULT_ARTIFACT_ROOT },
  });
  const report = await measureArtifactRoot(
    flags["artifact-root"],
    flags._.map(String),
  );
  if (flags.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    for (const line of renderReportLines(report)) log(line);
  }
  return 0;
};

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) Deno.exit(await main(Deno.args));
// deno-coverage-ignore-stop
