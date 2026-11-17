/**
 * Keeping the patterns a repository holds current in the pattern index: each
 * entry file on the default branch is one lineage, and a sync publishes a new
 * version of a lineage when, and only when, that entry's source changed.
 *
 * "Changed" is decided by hashing the program the entry resolves to (its own
 * file and every file it imports), not by a git diff. The index keeps that
 * hash on each lineage's newest version and returns it from
 * `listRepoHeads`, so a sync compiles only the entries whose hash moved. A
 * sync that failed partway leaves the index behind, and the next one, from
 * whatever commit, catches it up; nothing about past runs is kept anywhere
 * but the index.
 *
 * Gardener verdicts are reported and never block: the index gardens a new
 * version after it is published, so a sync shows the verdicts the heads carry
 * when it starts, which includes those that arrived since the last sync.
 */

import { globToRegExp, join, resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { RuntimeProgram } from "@commonfabric/runner";
import type {
  PatternIndexClient,
  PatternIndexFinding,
  PatternIndexRepoHead,
} from "./client.ts";
import {
  type CompiledPattern,
  patternDocMetadata,
  publishRequestFor,
} from "./publish.ts";

/** What a sync is asked to do. */
export interface RepoSyncOptions {
  /** `owner/name`. */
  repository: string;

  /** The commit the working tree holds. */
  commit: string;

  /** The working tree's root, absolute. */
  repoRoot: string;

  /**
   * The directory, relative to `repoRoot`, that program file names are
   * written against. Every file an entry imports must lie inside it.
   */
  programRoot: string;

  /** Globs, relative to `repoRoot`, naming the files that may be entries. */
  include: readonly string[];

  /** Globs, relative to `repoRoot`, removing files `include` named. */
  exclude: readonly string[];
}

/** What a sync reaches the world through, so a test can stand in for it. */
export interface RepoSyncDeps {
  /** The repository's tracked files, relative to its root. */
  trackedFiles: () => Promise<readonly string[]>;

  readTextFile: (path: string) => Promise<string>;

  /** Assembles the program an entry and its imports make, without compiling. */
  resolveProgram: (entry: string, root: string) => Promise<RuntimeProgram>;

  /** Compiles an assembled program. */
  compileProgram: (program: RuntimeProgram) => Promise<CompiledPattern>;

  client: Pick<
    PatternIndexClient,
    "listRepoHeads" | "publishPattern" | "requestListing"
  >;
}

/** What happened to one entry. */
export type EntryOutcome =
  | { path: string; status: "published"; patternId: string }
  | { path: string; status: "unchanged"; patternId: string }
  | { path: string; status: "undescribed" }
  | { path: string; status: "failed"; reason: string };

/** A gate verdict with findings, as the newest version of a path carries it. */
export interface GardenerReport {
  path: string;
  gardener: string;
  status: string;
  findings: readonly PatternIndexFinding[];
}

/** What a sync did, in the order of the entries it found. */
export interface RepoSyncReport {
  repository: string;
  commit: string;
  entries: readonly EntryOutcome[];

  /** Listing requests that failed after a successful publish. */
  listingFailures: readonly { path: string; reason: string }[];

  /** Paths the index holds a lineage for that are no longer entries here. */
  gone: readonly string[];

  gardeners: readonly GardenerReport[];
}

/** Whether a repository-relative path is a test module rather than an entry. */
const isTestModule = (path: string): boolean =>
  /(?:\.test|_test)\.tsx?$/.test(path);

/**
 * A top-level default export: what makes a module a pattern entry rather
 * than a helper it imports. It is the same set of files the pattern type
 * check gives a recorded baseline.
 */
const DEFAULT_EXPORT = /^export\s+default\b/m;

/** The globs as one test on a repository-relative path. */
const globMatcher = (globs: readonly string[]): (path: string) => boolean => {
  const patterns = globs.map((glob) =>
    globToRegExp(glob, { extended: true, globstar: true })
  );
  return (path) => patterns.some((pattern) => pattern.test(path));
};

/**
 * The repository-relative entry files `options` names: tracked TypeScript
 * modules that `include` matches and `exclude` does not, that are not tests,
 * and that have a default export. Sorted, so reports read the same each run.
 */
export const findEntries = async (
  options: Pick<RepoSyncOptions, "repoRoot" | "include" | "exclude">,
  deps: Pick<RepoSyncDeps, "trackedFiles" | "readTextFile">,
): Promise<string[]> => {
  const included = globMatcher(options.include);
  const excluded = globMatcher(options.exclude);
  const entries: string[] = [];
  for (const path of await deps.trackedFiles()) {
    if (!/\.tsx?$/.test(path) || isTestModule(path)) continue;
    if (!included(path) || excluded(path)) continue;
    const source = await deps.readTextFile(join(options.repoRoot, path));
    if (DEFAULT_EXPORT.test(source)) entries.push(path);
  }
  return entries.sort();
};

/**
 * A hash of everything in `program` that a compile reads: the entry, the
 * export it runs, and each file's name and contents. File order does not
 * count, since the resolver's walk order is not part of the source.
 */
export const programSourceHash = async (
  program: RuntimeProgram,
): Promise<string> => {
  const canonical = JSON.stringify({
    main: program.main,
    mainExport: program.mainExport ?? null,
    files: [...program.files]
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map((file) => [file.name, file.contents]),
    sourceRoots: [...(program.sourceRoots ?? [])].sort(),
    dataFiles: [...(program.dataFiles ?? [])].sort(),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return encodeHex(new Uint8Array(digest));
};

/** A failure's message, for a report. */
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Syncs one entry whose head is `head`, or that has none yet. */
const syncEntry = async (
  path: string,
  head: PatternIndexRepoHead | undefined,
  options: RepoSyncOptions,
  deps: RepoSyncDeps,
): Promise<EntryOutcome> => {
  const entry = join(options.repoRoot, path);
  const root = resolve(options.repoRoot, options.programRoot);
  const program = await deps.resolveProgram(entry, root);
  const sourceHash = await programSourceHash(program);
  if (head?.sourceHash === sourceHash) {
    return { path, status: "unchanged", patternId: head.patternId };
  }
  const doc = patternDocMetadata(await deps.readTextFile(entry));
  // The index finds patterns by what their description says, so one with
  // none would be found by nothing; the report asks for the doc comment.
  if (doc.description === undefined) return { path, status: "undescribed" };
  const compiled = await deps.compileProgram(program);
  if (compiled.patternId === undefined) {
    throw new Error("the compile produced no durable pattern id");
  }
  const response = await deps.client.publishPattern({
    ...publishRequestFor({
      patternId: compiled.patternId,
      program: compiled.program,
      description: doc.description,
      hashtags: doc.hashtags.map((tag) => tag.replace(/^#/, "").toLowerCase()),
      keywords: doc.keywords,
      argumentSchema: compiled.argumentSchema,
      resultSchema: compiled.resultSchema,
    }),
    source: {
      repository: options.repository,
      path,
      commit: options.commit,
      sourceHash,
    },
  });
  return response.unchanged === true
    ? { path, status: "unchanged", patternId: response.patternId }
    : { path, status: "published", patternId: response.patternId };
};

/** The gate verdicts with findings that `heads` carry. */
const gardenerReports = (
  heads: readonly PatternIndexRepoHead[],
): GardenerReport[] =>
  heads.flatMap((head) =>
    Object.entries(head.gates ?? {})
      .filter(([, verdict]) => (verdict.findings?.length ?? 0) > 0)
      .map(([gardener, verdict]) => ({
        path: head.path,
        gardener,
        status: verdict.status,
        findings: verdict.findings ?? [],
      }))
  );

/**
 * Publishes a new version of every entry whose source changed, and asks for
 * each new version to be listed.
 *
 * An entry that fails to resolve, compile or publish is recorded and the
 * others still run, so one broken pattern does not hold the rest back; the
 * caller fails the job when any did. A failed listing request is reported
 * but is not a failure: the version is published either way.
 *
 * @throws PatternIndexError when the index refuses `listRepoHeads`, before
 *   anything is published.
 */
export const syncRepo = async (
  options: RepoSyncOptions,
  deps: RepoSyncDeps,
): Promise<RepoSyncReport> => {
  const entries = await findEntries(options, deps);
  const { heads } = await deps.client.listRepoHeads({
    repository: options.repository,
  });
  const headOf = new Map(heads.map((head) => [head.path, head]));
  const outcomes: EntryOutcome[] = [];
  const listingFailures: { path: string; reason: string }[] = [];
  for (const path of entries) {
    let outcome: EntryOutcome;
    try {
      outcome = await syncEntry(path, headOf.get(path), options, deps);
    } catch (error) {
      outcome = { path, status: "failed", reason: reasonOf(error) };
    }
    outcomes.push(outcome);
    if (outcome.status !== "published") continue;
    try {
      await deps.client.requestListing({ patternId: outcome.patternId });
    } catch (error) {
      listingFailures.push({ path, reason: reasonOf(error) });
    }
  }
  const current = new Set(entries);
  return {
    repository: options.repository,
    commit: options.commit,
    entries: outcomes,
    listingFailures,
    gone: heads.map((head) => head.path).filter((path) => !current.has(path))
      .sort(),
    gardeners: gardenerReports(heads),
  };
};

/** Whether the job should fail: some entry could not be synced. */
export const syncFailed = (report: RepoSyncReport): boolean =>
  report.entries.some((entry) => entry.status === "failed");

/** Text safe inside a Markdown table cell. */
const cell = (text: string): string =>
  text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/**
 * The report as Markdown, for a GitHub job summary. Findings are reported by
 * category, file and line, as the index records them; their `why` is the
 * gardener's own wording about the source, which is public in this
 * repository already.
 */
export const reportMarkdown = (report: RepoSyncReport): string => {
  const count = (status: EntryOutcome["status"]) =>
    report.entries.filter((entry) => entry.status === status);
  const published = count("published");
  const failed = count("failed");
  const undescribed = count("undescribed");
  const lines = [
    `## Pattern index sync: ${report.repository}`,
    "",
    `At \`${report.commit.slice(0, 12)}\`: ${report.entries.length} entries, ` +
    `${published.length} published, ${count("unchanged").length} unchanged, ` +
    `${undescribed.length} without a description, ${failed.length} failed.`,
  ];
  if (failed.length > 0) {
    lines.push("", "### Failed", "", "| Entry | Reason |", "| --- | --- |");
    for (const entry of failed) {
      if (entry.status !== "failed") continue;
      lines.push(`| \`${entry.path}\` | ${cell(entry.reason)} |`);
    }
  }
  if (published.length > 0) {
    lines.push("", "### Published", "", "| Entry | Pattern |", "| --- | --- |");
    for (const entry of published) {
      if (entry.status !== "published") continue;
      lines.push(`| \`${entry.path}\` | \`${entry.patternId}\` |`);
    }
  }
  if (report.listingFailures.length > 0) {
    lines.push(
      "",
      "### Listing requests that failed",
      "",
      "Published, but not yet asked to be listed; the next change asks again.",
      "",
      "| Entry | Reason |",
      "| --- | --- |",
    );
    for (const failure of report.listingFailures) {
      lines.push(`| \`${failure.path}\` | ${cell(failure.reason)} |`);
    }
  }
  if (report.gardeners.length > 0) {
    lines.push(
      "",
      "### Gardener findings",
      "",
      "Reported, not enforced. Each is on the newest version the index held when this sync started.",
      "",
      "| Entry | Gardener | Status | Category | Where | Why |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const report_ of report.gardeners) {
      for (const finding of report_.findings) {
        const where = finding.file === undefined
          ? ""
          : `\`${finding.file}${
            finding.line === undefined ? "" : `:${finding.line}`
          }\``;
        lines.push(
          `| \`${report_.path}\` | ${report_.gardener} | ${report_.status} | ` +
            `${cell(finding.category)} | ${where} | ${cell(finding.why)} |`,
        );
      }
    }
  }
  if (undescribed.length > 0) {
    lines.push(
      "",
      "### Not published: no description",
      "",
      "Open each with a `/** ... */` doc comment whose first paragraph says what the pattern does.",
      "",
    );
    for (const entry of undescribed) lines.push(`- \`${entry.path}\``);
  }
  if (report.gone.length > 0) {
    lines.push(
      "",
      "### No longer entries here",
      "",
      "The index keeps their versions; nothing was retracted.",
      "",
    );
    for (const path of report.gone) lines.push(`- \`${path}\``);
  }
  return lines.join("\n") + "\n";
};
