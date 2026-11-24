/**
 * `cf pattern share`: compile a pattern on disk, ask the index's privacy
 * question about it locally, rewrite it into a generalized version when the
 * answer is no, record it in the index, and share it anonymously under its
 * lineage's pseudonym: on beta, reachable by its link only, until
 * `cf pattern stable` makes it findable. `cf pattern publish` runs the same
 * steps on stable, findable once checked, before naming its author.
 *
 * The person rarely reads this output; their agent does. So every step says
 * what it did in a line, the `--json` report carries the same, and nothing
 * printed ever quotes a value a finding is about: findings and rewrite
 * changes are reported by category, file and line.
 *
 * A rewrite reaches disk only when it compiled and every file it changes is
 * committed as it stands (`--allow-dirty` overrides), so `git diff` shows the
 * person exactly what changed and `git checkout` takes it back, or when the
 * source as it stood is kept first as a private version, which
 * `cf pattern rollback` restores. Otherwise nothing is shared, and the
 * report says why the rewrite was not applied.
 */

import { common, dirname, join, relative, resolve } from "@std/path";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type PatternIndexChannel,
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexFinding,
  type PatternIndexListing,
  type PatternIndexProgramFile,
} from "@commonfabric/pattern-index/client";
import {
  GARDENER_INPUT_FORMAT,
  type GardenerInput,
  type ObjectGenerator,
  type RewriteChange,
  runPrivacyCheck,
} from "@commonfabric/pattern-index/privacy";
import {
  type CompiledPattern,
  normalizeHashtags,
  patternDocMetadata,
  publishRequestFor,
} from "@commonfabric/pattern-index/publish";
import type { PatternIndexStore } from "@commonfabric/pattern-index/store";

/** What the person asked for. */
export interface PublishOptions {
  /** The entry file. */
  entry: string;

  /**
   * The program root its files are named against; by default the common
   * directory of the entry, the tests and the data files, as for
   * `cf piece new`.
   */
  root?: string;

  /** Test entries packaged with it, as `cf piece new --test` packages them. */
  testPaths?: readonly string[];

  /** Data files attached to it, as `cf piece new --datafile` attaches them. */
  dataFilePaths?: readonly string[];

  /** The export the program runs, as `cf piece new --main-export` names it. */
  mainExport?: string;

  description?: string;
  hashtags?: readonly string[];
  keywords?: readonly string[];

  /** Write a rewrite back over files with uncommitted edits. */
  allowDirty?: boolean;

  /** Skip the local check, saying so. */
  skipLocalCheck?: boolean;

  /** Credit this published pattern as the source, overriding the local record. */
  remixedFrom?: string;

  /**
   * Whether it is offered to a person choosing what to place (`true`) or
   * only as a part (`false`). Absent leaves the index to decide: the version
   * it follows keeps its answer, and a first version stands alone when its
   * entry file is `main.tsx`.
   */
  standalone?: boolean;

  /**
   * The lineage slot the entry's private versions are kept under
   * (`entrySlot`). With it, what is shared becomes a version of that
   * lineage, and a rewrite may go over files git cannot take back: the
   * source as it was is kept as a private version first, which
   * `cf pattern rollback` restores.
   */
  slot?: string;

  /**
   * The channel to share on: `beta` is reachable by link only, `stable` is
   * findable once checked. Needs a version (a slot) to name. Without one,
   * `beta` shares nothing and says so; `stable`, or no channel, asks for a
   * listing, which is stable.
   */
  channel?: PatternIndexChannel;
}

/** What publishing reaches the world through, so a test can stand in for it. */
export interface PublishDeps {
  /**
   * Compiles the program on disk at `entry` under `program.root`, packaged
   * as `cf piece new` packages it, so the id is the one a deploy computes.
   */
  compileEntry: (
    entry: string,
    program: {
      root: string;
      testPaths: readonly string[];
      dataFilePaths: readonly string[];
      mainExport?: string;
    },
  ) => Promise<CompiledPattern>;

  /** Compiles a program whose files were rewritten. */
  compileProgram: (program: RuntimeProgram) => Promise<CompiledPattern>;

  client: Pick<
    PatternIndexClient,
    | "getGardenerPrompt"
    | "publishPattern"
    | "requestListing"
    | "shareVersion"
    | "getPattern"
    | "whoami"
    | "listLineages"
  >;

  /** The model, or `undefined` when none is configured. */
  generate: ObjectGenerator | undefined;

  /** Where the model answers, for a report that names it. */
  modelLabel: string;

  /**
   * The paths among `paths` with uncommitted edits, or `undefined` when they
   * are not in a git working tree.
   */
  uncommitted: (paths: readonly string[]) => Promise<string[] | undefined>;

  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
  store: PatternIndexStore;
}

/** How the local privacy check went. */
export type LocalCheckReport =
  | { status: "passed" }
  | { status: "skipped"; reason: string }
  | {
    status: "rewritten";

    /** Whether the rewrite was written over the files on disk. */
    applied: boolean;

    /** Why it was not, when it was not. */
    notApplied?: string;

    /**
     * The private version the source was kept as before the rewrite went
     * over files git cannot take back.
     */
    originalVersion?: number;

    /** What the check found before the rewrite. */
    findings: PatternIndexFinding[];

    changes: RewriteChange[];

    /** The files the rewrite changed, relative to the working directory. */
    paths: string[];
  }
  | {
    status: "held";
    findings: PatternIndexFinding[];

    /** How each rewrite attempt failed. */
    reasons: string[];
  };

/** How the listing request went. */
export type ListingReport =
  | {
    status: "requested";
    /** Absent when the index answered none, as for one already shared. */
    listing?: PatternIndexListing;

    /** The channel it was shared on, when one was asked for. */
    channel?: PatternIndexChannel;

    /**
     * False when the index moved nothing: the source was shared already on
     * that channel or a later one, or by another of your patterns.
     */
    changed?: boolean;
  }
  | { status: "capped"; resetsAt?: string }
  | { status: "failed"; reason: string };

/**
 * What `cf pattern share` did, as `--json` prints it. `outcome` says
 * whether anything reached the index: `blocked` means the local check found
 * personal details and a rewrite that removes them which could not be
 * applied, so nothing was shared.
 */
export type PublishReport =
  | {
    outcome: "shared";
    patternId: string;

    /** False when the index already held this id: nothing was written. */
    created: boolean;

    /** The author's pseudonym, as the index shows it. */
    handle?: string;

    /** The version of the entry's lineage it was kept as. */
    version?: number;

    /** The lineage it was kept in; the person's own view only. */
    lineageId?: string;

    priorPatternId?: string;
    remixedFrom?: string;

    /**
     * Whether the index stored it as standalone; absent from an index that
     * does not say.
     */
    standalone?: boolean;

    /**
     * Set when it was published `--standalone` and the index stored it as a
     * part anyway, as it does for a required input with no default.
     */
    storedAsPart?: true;

    localCheck: LocalCheckReport;
    listing: ListingReport;

    /** What to do next, in one line. */
    next: string;
  }
  | {
    outcome: "blocked";
    localCheck: LocalCheckReport;
    next: string;
  };

/** A refusal before anything was published, phrased for the person. */
export class PublishError extends Error {
  override name = "PublishError";
}

/** A model call that failed, told apart from an answer of the wrong shape. */
class ModelUnavailable extends Error {
  override name = "ModelUnavailable";
}

/** The gardener input a compiled pattern and its metadata make. */
const gardenerInput = (
  compiled: CompiledPattern,
  meta: {
    description: string;
    hashtags: readonly string[];
    keywords: readonly string[];
  },
): GardenerInput => ({
  description: meta.description,
  hashtags: meta.hashtags,
  keywords: meta.keywords,
  ...(compiled.argumentSchema !== undefined
    ? { argumentSchema: compiled.argumentSchema }
    : {}),
  ...(compiled.resultSchema !== undefined
    ? { resultSchema: compiled.resultSchema }
    : {}),
  files: compiled.program.files.map((file) => ({
    name: file.name,
    contents: file.contents,
  })),
});

/**
 * The description and tags: the flags, else the entry file's doc comment.
 *
 * @throws PublishError when neither gives a description.
 */
const metadataFor = (
  options: PublishOptions,
  entrySource: string,
): { description: string; hashtags: string[]; keywords: string[] } => {
  const doc = patternDocMetadata(entrySource);
  const description = options.description?.trim() || doc.description;
  if (description === undefined) {
    throw new PublishError(
      `${options.entry} has no doc comment to describe it: open the file with a /** ... */ comment whose first paragraph says what the pattern does (with @hashtags and @keywords lines), or pass --description.`,
    );
  }
  return {
    description,
    hashtags: normalizeHashtags(options.hashtags ?? doc.hashtags),
    keywords: [...(options.keywords ?? doc.keywords)],
  };
};

/** The program with `files` in place of the files of the same name. */
const withFiles = (
  program: RuntimeProgram,
  files: readonly PatternIndexProgramFile[],
): RuntimeProgram => {
  const replaced = new Map(files.map((file) => [file.name, file.contents]));
  return {
    ...program,
    files: program.files.map((file) =>
      replaced.has(file.name)
        ? { ...file, contents: replaced.get(file.name)! }
        : file
    ),
  };
};

/** Publishes the pattern at `options.entry`. */
export async function publishPatternFromDisk(
  options: PublishOptions,
  deps: PublishDeps,
): Promise<PublishReport> {
  const entry = resolve(options.entry);
  const testPaths = (options.testPaths ?? []).map((path) => resolve(path));
  const dataFilePaths = (options.dataFilePaths ?? []).map((path) =>
    resolve(path)
  );
  // The rule `resolveLocalProgram` applies, stated here because the rewrite
  // maps program names back to disk under the same root.
  const root = resolve(
    options.root ??
      common([entry, ...testPaths, ...dataFilePaths].map((p) => dirname(p))),
  );
  const meta = metadataFor(options, await deps.readTextFile(entry));
  await requireMembership(deps);
  const original = await deps.compileEntry(entry, {
    root,
    testPaths,
    dataFilePaths,
    ...(options.mainExport === undefined
      ? {}
      : { mainExport: options.mainExport }),
  });
  if (original.patternId === undefined) {
    throw new PublishError(
      `${options.entry} compiled to no durable pattern id, so it cannot be published`,
    );
  }
  let published = original;
  let publishedMeta = meta;
  const slot = options.slot;
  const standalone = options.standalone === undefined
    ? {}
    : { standalone: options.standalone };
  const lineage = slot === undefined ? {} : { slot, origin: "self" as const };
  // The index takes a remix credit beside a slot only on the version that
  // starts the slot's lineage, so it is owed until one is sent.
  let creditOwed = slot === undefined ||
    !(await lineageSlots(deps)).includes(slot);
  let creditSent: string | undefined;
  // Keeps the source as it stands as a version of the lineage, so a rewrite
  // over files git cannot take back can be with `cf pattern rollback`. Like
  // every version it is private; it was deployed to no piece, so opening one
  // in a loom never shares it.
  const keepOriginal = slot === undefined
    ? undefined
    : async (): Promise<number | undefined> => {
      const credit = creditOwed
        ? (await remixOf(options, deps, entry, original.patternId!)).remixedFrom
        : undefined;
      const kept = await deps.client.publishPattern({
        ...publishRequestFor({
          patternId: original.patternId!,
          program: original.program,
          ...meta,
          ...(original.argumentSchema !== undefined
            ? { argumentSchema: original.argumentSchema }
            : {}),
          ...(original.resultSchema !== undefined
            ? { resultSchema: original.resultSchema }
            : {}),
          ...(credit === undefined ? {} : { remixedFrom: credit }),
          ...standalone,
        }),
        ...lineage,
      });
      creditOwed = false;
      creditSent = credit;
      return kept.seq;
    };
  const localCheck = await checkLocally(
    options,
    deps,
    original,
    meta,
    root,
    (rewritten, rewrittenMeta) => {
      published = rewritten;
      publishedMeta = rewrittenMeta;
    },
    keepOriginal,
  );
  if (localCheck.status === "rewritten" && !localCheck.applied) {
    // A rewrite that removes what was found exists, and committing is one
    // step away; publishing the source as it stands would send the index
    // exactly what the check found.
    return {
      outcome: "blocked",
      localCheck,
      next:
        `Commit your edits (or pass --allow-dirty), then run cf pattern share ${options.entry} again`,
    };
  }
  const patternId = published.patternId!;

  const lastPublished = await deps.store.lastPublished(entry);
  const remix = await remixOf(options, deps, entry, patternId);
  let priorPatternId =
    (lastPublished !== patternId ? lastPublished : undefined) ??
      remix.priorPatternId;
  // Beside a slot, a lineage already started keeps the credit its first
  // version carried, and refuses another.
  const remixedFrom = slot === undefined || creditOwed
    ? remix.remixedFrom
    : undefined;

  const response = await deps.client.publishPattern({
    ...publishRequestFor({
      patternId,
      program: published.program,
      ...publishedMeta,
      ...(published.argumentSchema !== undefined
        ? { argumentSchema: published.argumentSchema }
        : {}),
      ...(published.resultSchema !== undefined
        ? { resultSchema: published.resultSchema }
        : {}),
      ...(priorPatternId !== undefined ? { priorPatternId } : {}),
      ...(remixedFrom !== undefined ? { remixedFrom } : {}),
      ...standalone,
    }),
    ...(slot === undefined ? {} : { slot, origin: "self" as const }),
  });
  const stored = await deps.client.getPattern({
    patternId: response.patternId,
  }).catch(() => undefined);
  // Only one's own publication is a version later ones continue: an
  // unchanged copy of someone else's pattern is theirs, and the index would
  // refuse it as a predecessor.
  if (response.created || stored?.mine === true) {
    await deps.store.recordPublished(entry, response.patternId);
  }
  if (!response.created) priorPatternId = undefined;
  const versionId = response.versionId;
  const channel = options.channel;
  const listing: ListingReport = channel !== undefined &&
      versionId !== undefined
    ? await requestShare(async () => {
      const answer = await deps.client.shareVersion({ versionId, channel });
      return {
        status: "requested",
        ...(answer.listing === undefined ? {} : { listing: answer.listing }),
        channel,
        changed: answer.changed,
      };
    })
    // A listing request shares on stable, so a beta share never falls back
    // to one: it says it shared nothing instead.
    : channel === "beta"
    ? {
      status: "failed",
      reason: "the index kept no version of it to share on beta",
    }
    : await requestShare(async () => ({
      status: "requested",
      listing: (await deps.client.requestListing({
        patternId: response.patternId,
      })).listing,
    }));
  const handle = stored?.author?.pseudonym ?? stored?.handle;
  return {
    outcome: "shared",
    patternId: response.patternId,
    created: response.created,
    ...(handle !== undefined ? { handle } : {}),
    ...(response.seq !== undefined ? { version: response.seq } : {}),
    ...(response.lineageId !== undefined
      ? { lineageId: response.lineageId }
      : {}),
    ...(priorPatternId !== undefined ? { priorPatternId } : {}),
    ...((remixedFrom ?? creditSent) !== undefined
      ? { remixedFrom: remixedFrom ?? creditSent }
      : {}),
    ...(response.standalone !== undefined
      ? { standalone: response.standalone }
      : {}),
    ...(options.standalone === true && response.standalone === false
      ? { storedAsPart: true }
      : {}),
    localCheck,
    listing,
    next: listing.status === "capped"
      ? `Run the same command again once the limit resets to share it. Meanwhile ${
        tryIt(response.patternId)
      }`
      : tryIt(response.patternId),
  };
}

/**
 * The slots of the caller's lineages; none from an index that keeps no
 * lineages, which answers 404, so sharing there works as it did before.
 */
async function lineageSlots(deps: PublishDeps): Promise<string[]> {
  try {
    const { lineages } = await deps.client.listLineages();
    return lineages.flatMap((lineage) =>
      lineage.slot === undefined ? [] : [lineage.slot]
    );
  } catch (error) {
    if (error instanceof PatternIndexError && error.status === 404) return [];
    throw error;
  }
}

/**
 * Whose pattern `entry` builds on: someone else's it was fetched from, as
 * `remixedFrom`, or the person's own, as the predecessor it continues.
 * Neither for source identical to what it was fetched from.
 */
async function remixOf(
  options: PublishOptions,
  deps: PublishDeps,
  entry: string,
  patternId: string,
): Promise<{ remixedFrom?: string; priorPatternId?: string }> {
  if (options.remixedFrom !== undefined) {
    return options.remixedFrom === patternId
      ? {}
      : { remixedFrom: options.remixedFrom };
  }
  const source = await deps.store.sourceOf(entry);
  if (source === undefined || source === patternId) return {};
  // Source fetched from one's own pattern continues it; only someone
  // else's is a remix, which the index refuses as a predecessor.
  const stored = await deps.client.getPattern({ patternId: source })
    .catch(() => undefined);
  return stored?.mine === true
    ? { priorPatternId: source }
    : { remixedFrom: source };
}

/** How to use a published pattern: from cf, or in a loom. */
const tryIt = (patternId: string): string =>
  `deploy it with cf piece new --from-index ${patternId}, or open it in a loom with /deploy index:${patternId}`;

/**
 * Stops before anything is compiled when the identity acts for no member,
 * which is what a builder who has not joined yet hits first.
 *
 * @throws PublishError naming `cf index join` on a 401 or 403.
 */
async function requireMembership(deps: PublishDeps): Promise<void> {
  try {
    await deps.client.whoami();
  } catch (error) {
    if (
      error instanceof PatternIndexError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new PublishError(
        "This identity is not a member of the pattern index: join with your invite link first (pipe it to cf index join), or, if you joined on another machine, adopt a chain from it with cf index join --chain <file>.",
      );
    }
    throw error;
  }
}

/** The local check, and the rewrite applied when it is safe to. */
async function checkLocally(
  options: PublishOptions,
  deps: PublishDeps,
  original: CompiledPattern,
  meta: { description: string; hashtags: string[]; keywords: string[] },
  root: string,
  usePublished: (
    compiled: CompiledPattern,
    meta: { description: string; hashtags: string[]; keywords: string[] },
  ) => void,
  keepOriginal?: () => Promise<number | undefined>,
): Promise<LocalCheckReport> {
  if (options.skipLocalCheck) {
    return { status: "skipped", reason: "--skip-local-check" };
  }
  const generate = deps.generate;
  if (generate === undefined) {
    return { status: "skipped", reason: "no LLM is configured for cf" };
  }
  let gardener;
  try {
    gardener = await deps.client.getGardenerPrompt({ name: "privacy" });
  } catch (error) {
    return {
      status: "skipped",
      reason: `the index served no privacy prompt (${describeFailure(error)})`,
    };
  }
  if (
    gardener.inputFormat !== undefined &&
    gardener.inputFormat !== GARDENER_INPUT_FORMAT
  ) {
    return {
      status: "skipped",
      reason:
        `the index's privacy check reads input this cf does not write (${gardener.inputFormat}); update cf`,
    };
  }
  const entryName = `/${relative(root, resolve(options.entry))}`;
  const rewrittenMeta = new Map<CompiledPattern, typeof meta>();
  let outcome;
  try {
    outcome = await runPrivacyCheck<CompiledPattern>({
      gardener,
      entry: entryName,
      input: gardenerInput(original, meta),
      generate: async (request) => {
        try {
          return await generate(request);
        } catch (error) {
          throw new ModelUnavailable(describeFailure(error));
        }
      },
      recompile: async (files) => {
        const compiled = await deps.compileProgram(
          withFiles(original.program, files),
        );
        if (compiled.patternId === undefined) {
          throw new Error("the rewrite compiled to no durable id");
        }
        const entryFile = files.find((file) => file.name === entryName);
        const nextMeta = entryFile === undefined
          ? meta
          : metadataFor(options, entryFile.contents);
        rewrittenMeta.set(compiled, nextMeta);
        return { input: gardenerInput(compiled, nextMeta), compiled };
      },
    });
  } catch (error) {
    if (error instanceof ModelUnavailable) {
      return {
        status: "skipped",
        reason:
          `the LLM at ${deps.modelLabel} did not answer (${error.message})`,
      };
    }
    return {
      status: "skipped",
      reason: `the local check could not finish (${describeFailure(error)})`,
    };
  }
  if (outcome.status === "passed") return { status: "passed" };
  if (outcome.status === "held") {
    return {
      status: "held",
      findings: outcome.verdict.findings,
      reasons: outcome.reasons,
    };
  }

  // A rewrite passed. Only files it changed are written, each over the file
  // its program name grounds at under `root`.
  const before = new Map(
    original.program.files.map((file) => [file.name, file.contents]),
  );
  const changed = outcome.files.filter((file) =>
    before.get(file.name) !== file.contents
  );
  const diskPaths = changed.map((file) => join(root, file.name));
  const shown = diskPaths.map((path) => relative(Deno.cwd(), path));
  const base = {
    status: "rewritten" as const,
    findings: outcome.original.findings,
    changes: outcome.changes,
    paths: shown,
  };
  let originalVersion: number | undefined;
  const dirty = options.allowDirty ? [] : await deps.uncommitted(diskPaths);
  if (
    (options.allowDirty || dirty === undefined || dirty.length > 0) &&
    keepOriginal !== undefined
  ) {
    // Git cannot take the rewrite back, but a kept version can.
    originalVersion = await keepOriginal();
  }
  if (originalVersion === undefined) {
    if (dirty === undefined) {
      return {
        ...base,
        applied: false,
        notApplied:
          "the files are not in a git working tree, so the change could not be reviewed with git diff; pass --allow-dirty to apply it anyway",
      };
    }
    if (dirty.length > 0) {
      return {
        ...base,
        applied: false,
        notApplied: `these files have uncommitted edits: ${
          dirty.map((path) => relative(Deno.cwd(), path)).join(", ")
        }; commit them and publish again, or pass --allow-dirty`,
      };
    }
  }
  // The check takes as long as the model does; a file edited meanwhile is
  // not the file the rewrite was made from, so none is written over it.
  for (const [i, file] of changed.entries()) {
    const now = await deps.readTextFile(diskPaths[i]).catch(() => undefined);
    if (now !== before.get(file.name)) {
      return {
        ...base,
        applied: false,
        notApplied: `${
          shown[i]
        } changed on disk while it was being checked; publish again`,
      };
    }
  }
  for (const [i, file] of changed.entries()) {
    await deps.writeTextFile(diskPaths[i], file.contents);
  }
  usePublished(outcome.compiled, rewrittenMeta.get(outcome.compiled) ?? meta);
  return {
    ...base,
    applied: true,
    ...(originalVersion === undefined ? {} : { originalVersion }),
  };
}

/** Asks the index to share, reading the daily cap as what it is. */
async function requestShare(
  ask: () => Promise<ListingReport>,
): Promise<ListingReport> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof PatternIndexError && error.status === 429) {
      return {
        status: "capped",
        ...(error.retryAt !== undefined ? { resetsAt: error.retryAt } : {}),
      };
    }
    return { status: "failed", reason: describeFailure(error) };
  }
}

/** What a share to beta stands at, to the author, in a clause. */
const betaMeaning = (listing: PatternIndexListing | undefined): string => {
  switch (listing) {
    case "passed":
      return "reachable by its link (cf pattern link --beta); nobody finds it until cf pattern stable";
    case "held":
      return "held: the index found something identifying; see cf pattern mine";
    case "error":
      return "error: the check failed to run and waits for an admin re-run";
    default:
      return "once the index's privacy check passes, it is reachable by its link (cf pattern link --beta); nobody finds it until cf pattern stable";
  }
};

/** What a listing state means to the author, in a clause. */
const listingMeaning = (
  listing: PatternIndexListing | undefined,
): string => {
  switch (listing) {
    case undefined:
      return "shared";
    case "pending":
      return "checking: the index's privacy check is reading it";
    case "passed":
      return "listed: others can find it";
    case "held":
      return "held: the index found something identifying; see cf pattern mine";
    case "error":
      return "error: the check failed to run and waits for an admin re-run";
    case "not_requested":
      return "unlisted";
    default:
      return String(listing);
  }
};

/** The local check's outcome as lines for a person. */
const checkLines = (check: LocalCheckReport): string[] => {
  const lines: string[] = [];
  switch (check.status) {
    case "passed":
      lines.push("Local privacy check: passed.");
      break;
    case "skipped":
      lines.push(
        `Skipped the local privacy check: ${check.reason}. The index still checks it before listing it.`,
      );
      break;
    case "rewritten": {
      const kinds = [...new Set(check.changes.map((c) => c.category))];
      if (check.applied) {
        lines.push(
          `Rewrote it to keep personal details out (${
            kinds.join(", ") || "changes"
          }) in ${check.paths.join(", ")}. ${
            check.originalVersion === undefined
              ? "Review with `git diff`."
              : `Your source as it was is kept as v${check.originalVersion}; cf pattern rollback restores it.`
          }`,
        );
      } else {
        lines.push(
          `Found personal details, and a rewrite that removes them, not applied: ${check.notApplied}.`,
        );
        for (const line of findingLines(check.findings)) lines.push(line);
      }
      break;
    }
    case "held":
      lines.push(
        "Found personal details the rewrites could not remove. Sharing it as it is; the index checks it too and keeps it out of search until these are fixed:",
      );
      for (const line of findingLines(check.findings)) lines.push(line);
      break;
  }
  return lines;
};

/** The report as lines for a person. */
export const publishReportLines = (report: PublishReport): string[] => {
  const lines: string[] = [];
  for (const line of checkLines(report.localCheck)) lines.push(line);
  if (report.outcome === "blocked") {
    lines.push(`Nothing was shared. Next: ${report.next}.`);
    return lines;
  }
  lines.push(
    `${report.created ? "Shared" : "Already shared"} ${report.patternId}${
      report.handle !== undefined ? ` as ${report.handle}` : ""
    }${report.version !== undefined ? ` (v${report.version})` : ""}${
      report.priorPatternId !== undefined
        ? `, a new version of ${report.priorPatternId}`
        : ""
    }${
      report.remixedFrom !== undefined ? `, built on ${report.remixedFrom}` : ""
    }.`,
  );
  if (report.storedAsPart === true) {
    lines.push(
      "The index stored it as a part, not standalone. A pattern with a required input that has no default is always a part; give each input a default to offer it on its own.",
    );
  }
  const listing = report.listing;
  switch (listing.status) {
    case "requested":
      lines.push(
        listing.changed === false
          ? listing.listing === "pending"
            ? "Already being checked: where it goes did not change."
            : "Already shared: where it is did not change (cf pattern link says where)."
          : listing.channel === "beta"
          ? `Beta: ${betaMeaning(listing.listing)}.`
          : `Listing: ${listingMeaning(listing.listing)}.`,
      );
      break;
    case "capped":
      lines.push(
        `Not shared yet: you reached today's limit on shares${
          listing.resetsAt !== undefined
            ? `; it resets at ${listing.resetsAt}`
            : ""
        }.`,
      );
      break;
    case "failed":
      lines.push(`Not shared: ${listing.reason}.`);
      break;
  }
  lines.push(`Next: ${report.next}.`);
  return lines;
};

const findingLines = (findings: readonly PatternIndexFinding[]): string[] =>
  findings.map((finding) =>
    `  - ${finding.category}${
      finding.file !== undefined
        ? ` in ${finding.file}${
          finding.line !== undefined ? `:${finding.line}` : ""
        }`
        : " in the metadata"
    }: ${finding.why}`
  );
