/**
 * `cf pattern publish`: compile a pattern on disk, ask the index's privacy
 * question about it locally, rewrite it into a generalized version when the
 * answer is no, publish it, and ask for it to be listed.
 *
 * The person rarely reads this output; their agent does. So every step says
 * what it did in a line, the `--json` report carries the same, and nothing
 * printed ever quotes a value a finding is about: findings and rewrite
 * changes are reported by category, file and line.
 *
 * A rewrite reaches disk only when it compiled and every file it changes is
 * committed as it stands (`--allow-dirty` overrides), so `git diff` shows the
 * person exactly what changed and `git checkout` takes it back. Otherwise
 * the pattern is published as it is on disk, and the report says why the
 * rewrite was not applied.
 */

import { dirname, join, relative, resolve } from "@std/path";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexFinding,
  type PatternIndexListing,
  type PatternIndexProgramFile,
} from "@commonfabric/pattern-index/client";
import {
  type GardenerInput,
  type ObjectGenerator,
  type RewriteChange,
  runPrivacyCheck,
} from "@commonfabric/pattern-index/privacy";
import {
  type CompiledPattern,
  patternDocMetadata,
  publishRequestFor,
} from "@commonfabric/pattern-index/publish";
import type { PatternIndexStore } from "@commonfabric/pattern-index/store";

/** What the person asked for. */
export interface PublishOptions {
  /** The entry file. */
  entry: string;

  /** The program root its files are named against; the entry's directory by default. */
  root?: string;

  description?: string;
  hashtags?: readonly string[];
  keywords?: readonly string[];

  /** Write a rewrite back over files with uncommitted edits. */
  allowDirty?: boolean;

  /** Skip the local check, saying so. */
  skipLocalCheck?: boolean;

  /** Credit this published pattern as the source, overriding the local record. */
  remixedFrom?: string;
}

/** What publishing reaches the world through, so a test can stand in for it. */
export interface PublishDeps {
  /** Compiles the program on disk at `entry` under `root`. */
  compileEntry: (entry: string, root: string) => Promise<CompiledPattern>;

  /** Compiles a program whose files were rewritten. */
  compileProgram: (program: RuntimeProgram) => Promise<CompiledPattern>;

  client: Pick<
    PatternIndexClient,
    "getGardenerPrompt" | "publishPattern" | "requestListing" | "getPattern"
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
  | { status: "requested"; listing: PatternIndexListing }
  | { status: "capped"; resetsAt?: string }
  | { status: "failed"; reason: string };

/** What `cf pattern publish` did, as `--json` prints it. */
export interface PublishReport {
  patternId: string;

  /** False when the index already held this id: nothing was written. */
  created: boolean;

  /** The author's pseudonym, as the index shows it. */
  handle?: string;

  priorPatternId?: string;
  remixedFrom?: string;
  localCheck: LocalCheckReport;
  listing: ListingReport;

  /** What to do next, in one line. */
  next: string;
}

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
    hashtags: [...(options.hashtags ?? doc.hashtags)].map((tag) =>
      tag.replace(/^#/, "").toLowerCase()
    ),
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
  const root = resolve(options.root ?? dirname(entry));
  const meta = metadataFor(options, await deps.readTextFile(entry));
  const original = await deps.compileEntry(entry, root);
  if (original.patternId === undefined) {
    throw new PublishError(
      `${options.entry} compiled to no durable pattern id, so it cannot be published`,
    );
  }
  let published = original;
  let publishedMeta = meta;
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
  );
  const patternId = published.patternId!;

  const lastPublished = await deps.store.lastPublished(entry);
  let priorPatternId = lastPublished !== patternId ? lastPublished : undefined;
  let remixedFrom = options.remixedFrom ?? await deps.store.sourceOf(entry);
  if (remixedFrom === patternId) remixedFrom = undefined;
  if (remixedFrom !== undefined && options.remixedFrom === undefined) {
    // Source fetched from one's own pattern continues it; only someone
    // else's is a remix, which the index refuses as a predecessor.
    const source = await deps.client.getPattern({ patternId: remixedFrom })
      .catch(() => undefined);
    if (source?.mine === true) {
      priorPatternId ??= remixedFrom;
      remixedFrom = undefined;
    }
  }

  const response = await deps.client.publishPattern(publishRequestFor({
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
  }));
  await deps.store.recordPublished(entry, response.patternId);

  const listing = await requestListing(deps, response.patternId);
  const handle = await deps.client.getPattern({ patternId: response.patternId })
    .then((pattern) => pattern.handle, () => undefined);
  return {
    patternId: response.patternId,
    created: response.created,
    ...(handle !== undefined ? { handle } : {}),
    ...(priorPatternId !== undefined ? { priorPatternId } : {}),
    ...(remixedFrom !== undefined ? { remixedFrom } : {}),
    localCheck,
    listing,
    next: listing.status === "capped"
      ? `Run cf pattern publish ${options.entry} again once the cap resets to request the listing; meanwhile open it in a loom with \`/deploy index:${response.patternId}\``
      : `Open it in a loom with \`/deploy index:${response.patternId}\``,
  };
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
  const entryName = `/${relative(root, resolve(options.entry))}`;
  const rewrittenMeta = new Map<CompiledPattern, typeof meta>();
  let outcome;
  try {
    outcome = await runPrivacyCheck<CompiledPattern>({
      gardener,
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
    if (error instanceof PublishError) throw error;
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
  if (!options.allowDirty) {
    const dirty = await deps.uncommitted(diskPaths);
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
  for (const [i, file] of changed.entries()) {
    await deps.writeTextFile(diskPaths[i], file.contents);
  }
  usePublished(outcome.compiled, rewrittenMeta.get(outcome.compiled) ?? meta);
  return { ...base, applied: true };
}

/** Asks for the listing, reading the daily cap as what it is. */
async function requestListing(
  deps: PublishDeps,
  patternId: string,
): Promise<ListingReport> {
  try {
    const answer = await deps.client.requestListing({ patternId });
    return { status: "requested", listing: answer.listing };
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

/** What a listing state means to the author, in a clause. */
const listingMeaning = (listing: PatternIndexListing): string => {
  switch (listing) {
    case "pending":
      return "checking: the index's privacy gardener is reading it";
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

/** The report as lines for a person. */
export const publishReportLines = (report: PublishReport): string[] => {
  const lines: string[] = [];
  const check = report.localCheck;
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
          }) in ${check.paths.join(", ")}. Review with \`git diff\`.`,
        );
      } else {
        lines.push(
          `Found personal details and a rewrite that removes them, not applied: ${check.notApplied}. Published as it is on disk.`,
        );
        lines.push(...findingLines(check.findings));
      }
      break;
    }
    case "held":
      lines.push(
        "Found personal details the rewrites could not remove; publishing it unlisted. Fix these and publish again:",
      );
      lines.push(...findingLines(check.findings));
      break;
  }
  lines.push(
    `${report.created ? "Published" : "Already published"} ${report.patternId}${
      report.handle !== undefined ? ` by ${report.handle}` : ""
    }${
      report.priorPatternId !== undefined
        ? `, a new version of ${report.priorPatternId}`
        : ""
    }${
      report.remixedFrom !== undefined ? `, built on ${report.remixedFrom}` : ""
    }.`,
  );
  const listing = report.listing;
  switch (listing.status) {
    case "requested":
      lines.push(`Listing: ${listingMeaning(listing.listing)}.`);
      break;
    case "capped":
      lines.push(
        `Listing not requested: you reached today's limit on listing requests${
          listing.resetsAt !== undefined
            ? `; it resets at ${listing.resetsAt}`
            : ""
        }.`,
      );
      break;
    case "failed":
      lines.push(`Listing not requested: ${listing.reason}.`);
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
