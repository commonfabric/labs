/**
 * Deploying a published pattern: fetching its program from the index,
 * making the published patterns it imports resolvable, and compiling it into
 * a space, without any of the fetched source reaching the caller's output.
 *
 * Two callers deploy this way and have to agree: cf-harness's `run_pattern`,
 * when a model names an indexed pattern, and `cf piece new --from-index`, when
 * an operator or a deployer does. The steps and their failures live here so
 * the two cannot drift.
 *
 * A program composes a published pattern by naming it —
 * `import Sub from "cf:pattern:<patternId>"`, exactly the specifier a search
 * hands back. The compiler resolves that specifier from the source-document
 * closure the space holds under `pattern:<identity>`, and for a pattern this
 * space has never run there is no such closure. This module is what puts one
 * there: it reads the imported ids off the program, fetches each one from the
 * index on the trusted host side, and compiles it into the space so its
 * closure is durable by the time the importer's own compile asks for it.
 *
 * Everything here runs host-side. A fetched program reaches the compiler and
 * stops; the errors raised for it name ids and never quote source.
 */

import {
  compileAndSavePattern,
  type MemorySpace,
  type Pattern,
  type Runtime,
  type RuntimeProgram,
  sourceDocKey,
} from "@commonfabric/runner";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexProgram,
} from "./client.ts";

/**
 * Supplies the index client a deploy reads through. A factory rather than a
 * client, so a caller that may never touch the index builds one only when a
 * program actually names a published pattern.
 */
export type PatternIndexClientFactory = () => Promise<PatternIndexClient>;

/**
 * The `RuntimeProgram` a published program compiles as. Every field the index
 * carries is copied across: an entry point that names the wrong export, a
 * missing source root, or a dropped data file each compiles or runs into a
 * failure whose cause is nowhere near the omission.
 */
export const runtimeProgramFromIndex = (
  program: PatternIndexProgram,
): RuntimeProgram => ({
  main: program.main,
  files: program.files.map((file) => ({
    name: file.name,
    contents: file.contents,
  })),
  ...(program.mainExport !== undefined
    ? { mainExport: program.mainExport }
    : {}),
  ...(program.sourceRoots !== undefined
    ? { sourceRoots: [...program.sourceRoots] }
    : {}),
  ...(program.dataFiles !== undefined
    ? { dataFiles: [...program.dataFiles] }
    : {}),
});

/**
 * The published patterns a program composes, read off the `cf:pattern:<id>`
 * specifiers its files import. The index derives the same set from the
 * program it is given, so this is what the publisher knows rather than the
 * authority on it.
 */
export const patternIndexDependencies = (
  files: readonly { contents: string }[],
): readonly string[] => [
  ...new Set(
    files.flatMap((file) =>
      // Only IMPORT positions count: a static `from "cf:pattern:<id>"` (or a
      // bare `import "..."` / dynamic `import("...")`). The id also appears
      // in comments and prose — a search hint quoting the specifier, a
      // description — and a mention is not a dependency: fetching it wastes
      // a mount, and refusing over it rejects valid source.
      [
        ...file.contents.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']cf:pattern:([A-Za-z0-9_-]+)["']/g,
        ),
      ].map((match) => match[1])
    ),
  ),
];

/**
 * Every published pattern a program draws in: the ones its own source imports,
 * plus the ones the index recorded for it. The two normally agree, and where
 * they do not the union is the safe side — a recorded dependency the source no
 * longer names costs one fetch, while an imported one left out is a compile
 * that cannot resolve.
 */
export const composedPatternIds = (
  program: RuntimeProgram,
  recorded: readonly string[] = [],
): readonly string[] => [
  ...new Set([...patternIndexDependencies(program.files), ...recorded]),
];

/**
 * Published patterns one composed program may draw in, counting what it
 * imports directly and everything those import in turn. The resolver bounds
 * the mounts a single compile may make for the same reason a fetcher bounds
 * what it fetches: past some width the graph is a mistake repeating itself
 * rather than a composition.
 */
export const MAX_COMPOSED_PATTERNS = 16;

/**
 * A composition that could not be made available. The message is model-facing
 * and names ids only.
 */
export class PatternCompositionError extends Error {
  override name = "PatternCompositionError";

  /**
   * The underlying text, when there is one the model must not read: a compile
   * diagnostic quotes the source it failed on, and an imported pattern's
   * source is exactly what composition withholds. The caller keeps it in the
   * run artifact and out of the model-facing message.
   */
  readonly rawCauseMessage?: string;

  constructor(message: string, rawCauseMessage?: string) {
    super(message);
    if (rawCauseMessage !== undefined) {
      this.rawCauseMessage = rawCauseMessage;
    }
  }
}

/**
 * The service body a failed index call carried, for the artifact-side
 * `rawCauseMessage`. `PatternIndexError.message` is stable by construction;
 * the body it withheld is the part that can quote indexed source.
 */
const patternIndexErrorDetail = (error: unknown): string | undefined =>
  error instanceof PatternIndexError ? error.detail : undefined;

const quoteList = (ids: readonly string[]): string =>
  ids.map((id) => `"${id}"`).join(", ");

/**
 * Whether `space` already holds the source closure `identity` resolves from.
 * `writeSourceDocs` writes a closure and its entry document together, so the
 * entry document being here means the modules it imports are here as well,
 * and nothing below it needs fetching.
 */
const sourceClosurePresent = async (
  runtime: Runtime,
  space: MemorySpace,
  identity: string,
): Promise<boolean> => {
  const tx = runtime.edit();
  try {
    const cell = runtime.getCell<unknown>(
      space,
      sourceDocKey(identity),
      undefined,
      tx,
    );
    await cell.sync();
    return isObjectNotArray(cell.get());
  } finally {
    tx.abort?.("pattern composition presence check complete");
  }
};

export interface MaterializeComposedPatternsOptions {
  runtime: Runtime;

  /** The space the composing program compiles into, and reads its imports from. */
  space: MemorySpace;

  /** The published patterns the composing program names. */
  patternIds: readonly string[];

  /** The run's index client, or `undefined` when the run has no index. */
  getClient: PatternIndexClientFactory | undefined;
}

/**
 * Draws every published pattern in `patternIds`, and everything those import
 * in turn, into `space`, so a program naming them by `cf:pattern:` compiles.
 * Answers the ids this call made durable, dependencies before their importers;
 * an id the space already held is not among them.
 *
 * Materialization is a full `compileAndSavePattern` of each fetched program
 * rather than a bare source-document write. Two things follow from compiling
 * that a write cannot give: the compile is the only thing that reports the
 * program's content-addressed entry identity, which is what the id the index
 * stores it under has to equal for the importer's specifier to resolve at all;
 * and a pattern that itself composes others compiles through the same
 * fabric-import resolution, so a nested `cf:pattern:` is resolved rather than
 * silently persisted unresolvable. The write-only path would also mean
 * reaching past the pattern manager into the compile cache's own document
 * writer, which is runtime-internal bookkeeping this layer has no business
 * performing by hand.
 *
 * @throws PatternCompositionError for every failure, so a caller has one type
 * to catch and one message shape to relay.
 */
export const materializeComposedPatterns = async (
  options: MaterializeComposedPatternsOptions,
): Promise<readonly string[]> => {
  const { runtime, space, patternIds, getClient } = options;
  if (patternIds.length === 0) {
    return [];
  }
  if (getClient === undefined) {
    throw new PatternCompositionError(
      `this source composes the published pattern(s) ${
        quoteList(patternIds)
      } through a "cf:pattern:" import, which requires a pattern index; configure --pattern-index-url, or write source that composes nothing published`,
    );
  }
  // The imported closure is read back out of the space's content-addressed
  // source cache, and that cache is only written — and only trusted on read —
  // by a runtime that enforces CFC. With enforcement disabled there is nowhere
  // for a composed import to resolve from, which is a fact about the run
  // rather than about the source.
  if (runtime.cfcEnforcementMode === "disabled") {
    throw new PatternCompositionError(
      'composing a published pattern through a "cf:pattern:" import requires a CFC-enabled runtime: an imported pattern resolves from the space\'s content-addressed source cache, which a runtime with CFC enforcement disabled neither writes nor trusts on read',
    );
  }
  let client: PatternIndexClient;
  try {
    client = await getClient();
  } catch (error) {
    throw new PatternCompositionError(
      `pattern index unavailable: ${describeFailure(error)}`,
      patternIndexErrorDetail(error),
    );
  }

  /** Ids made durable by this call, dependencies first. */
  const materialized: string[] = [];

  /** Ids on the path currently being resolved, which is the cycle test. */
  const resolving = new Set<string>();

  /** Ids known durable in `space`, whether this call put them there or not. */
  const present = new Set<string>();

  /**
   * Patterns this call has begun drawing in, which is what the cap counts.
   * Counting the finished ones instead would let a chain descend to any depth
   * before the first of them compiled and the count moved off zero.
   */
  let drawn = 0;

  const materialize = async (
    patternId: string,
    path: readonly string[],
  ): Promise<void> => {
    if (present.has(patternId)) {
      return;
    }
    if (resolving.has(patternId)) {
      throw new PatternCompositionError(
        `the published patterns ${
          quoteList([...path, patternId])
        } import one another in a cycle; a composed pattern's imports have to bottom out`,
      );
    }
    if (await sourceClosurePresent(runtime, space, patternId)) {
      present.add(patternId);
      return;
    }
    if (drawn >= MAX_COMPOSED_PATTERNS) {
      throw new PatternCompositionError(
        `this source composes more than ${MAX_COMPOSED_PATTERNS} published patterns once their own imports are counted; compose fewer, or fold the ones that only exist to be imported into the source that imports them`,
      );
    }
    drawn += 1;
    resolving.add(patternId);
    let record;
    try {
      record = await client.getPattern({ patternId, includeSource: true });
    } catch (error) {
      throw new PatternCompositionError(
        `the imported pattern "${patternId}" could not be read from the pattern index: ${
          describeFailure(error)
        }`,
        patternIndexErrorDetail(error),
      );
    }
    if (record.program === undefined) {
      throw new PatternCompositionError(
        `the pattern index returned no program for the imported pattern "${patternId}"`,
      );
    }
    const program = runtimeProgramFromIndex(record.program);
    // Depth first: what this pattern imports has to be durable in the space
    // before it compiles, because its compile is what resolves those imports.
    for (const dependency of composedPatternIds(program, record.dependencies)) {
      await materialize(dependency, [...path, patternId]);
    }
    let compiled;
    try {
      compiled = await compileAndSavePattern(runtime, program, { space });
    } catch (error) {
      throw new PatternCompositionError(
        `the imported pattern "${patternId}" did not compile; the diagnostic is retained in the run artifact and withheld here, since it quotes source you did not author`,
        describeFailure(error),
      );
    }
    const identity = runtime.patternManager.getArtifactEntryRef(compiled)
      ?.identity;
    if (identity !== patternId) {
      throw new PatternCompositionError(
        `the pattern index stores the imported pattern under "${patternId}", but the program it answered with compiles to ${
          identity === undefined ? "no durable identity" : `"${identity}"`
        }; a "cf:pattern:" import addresses a program by the identity of its own source, so the import cannot resolve`,
      );
    }
    resolving.delete(patternId);
    present.add(patternId);
    materialized.push(patternId);
  };

  for (const patternId of patternIds) {
    await materialize(patternId, []);
  }
  if (materialized.length > 0) {
    // Each compile awaits its own closure write, but a warm load queues a
    // repair write-back it does not await, and the importer's resolver reads
    // what is durable. Flushing is what makes "materialized" mean "visible to
    // the compile that comes next".
    await runtime.patternManager.flushCompileCacheWrites();
  }
  return materialized;
};

/** The step of a deploy a failure belongs to. */
export type IndexedPatternFailureStage = "lookup" | "compose" | "compile";

/**
 * A deploy that failed. The message names ids and never quotes source, so a
 * caller may show it to whoever asked for the deploy, a model included. A
 * compile diagnostic, or a service body that can quote indexed source, is kept
 * apart as `rawCauseMessage`, for a run artifact or an operator's log.
 */
export class IndexedPatternError extends Error {
  #stage: IndexedPatternFailureStage;
  #rawCauseMessage: string | undefined;

  constructor(
    stage: IndexedPatternFailureStage,
    message: string,
    rawCauseMessage?: string,
  ) {
    super(message);
    this.#stage = stage;
    this.#rawCauseMessage = rawCauseMessage;
  }

  override get name(): string {
    return "IndexedPatternError";
  }

  /** Which step failed: reading the index, composing, or compiling. */
  get stage(): IndexedPatternFailureStage {
    return this.#stage;
  }

  /** The underlying text, which can quote source the caller did not write. */
  get rawCauseMessage(): string | undefined {
    return this.#rawCauseMessage;
  }
}

export interface ComposeProgramOptions {
  runtime: Runtime;

  /** The space the program compiles into, and reads its imports from. */
  space: MemorySpace;

  program: RuntimeProgram;

  /** What the index recorded the program composes, when it came from one. */
  recordedDependencies?: readonly string[];

  /** The index client, or `undefined` when there is no index to read. */
  getClient: PatternIndexClientFactory | undefined;
}

/**
 * Makes every published pattern `program` draws in durable in `space`, so
 * that its compile resolves them.
 *
 * @throws IndexedPatternError at the `compose` stage, for every failure.
 */
export const composeProgram = async (
  options: ComposeProgramOptions,
): Promise<void> => {
  const { runtime, space, program, recordedDependencies, getClient } = options;
  try {
    await materializeComposedPatterns({
      runtime,
      space,
      patternIds: composedPatternIds(program, recordedDependencies),
      getClient,
    });
  } catch (error) {
    if (error instanceof PatternCompositionError) {
      throw new IndexedPatternError(
        "compose",
        error.message,
        error.rawCauseMessage,
      );
    }
    throw new IndexedPatternError(
      "compose",
      "the published patterns this source composes could not be made available; the failure text is retained in the run artifact and withheld here, since it can quote source you did not author",
      describeFailure(error),
    );
  }
};

export interface IndexedPatternOptions {
  runtime: Runtime;

  /** The space the pattern and everything it imports compile into. */
  space: MemorySpace;

  /** The published pattern to deploy. */
  patternId: string;

  getClient: PatternIndexClientFactory;
}

/** A published pattern's program, ready to compile, and what names it. */
export interface IndexedProgram {
  program: RuntimeProgram;

  /** The index's display name for the pattern, when it holds one. */
  name?: string;
}

/**
 * Reads `patternId`'s program from the index and makes the published patterns
 * it imports durable in `space`. Answers the program ready to compile, or to
 * hand to something that compiles it, such as a piece creation, with the
 * index's display name for it.
 *
 * @throws IndexedPatternError at the `lookup` or `compose` stage.
 */
export const prepareIndexedProgram = async (
  options: IndexedPatternOptions,
): Promise<IndexedProgram> => {
  const { runtime, space, patternId, getClient } = options;
  let indexed;
  try {
    const client = await getClient();
    indexed = await client.getPattern({ patternId, includeSource: true });
  } catch (error) {
    // `PatternIndexError.message` is stable by construction; the service
    // body it withheld can quote indexed source, so it goes only to
    // `rawCauseMessage`.
    throw new IndexedPatternError(
      "lookup",
      `pattern index lookup failed for "${patternId}": ${
        describeFailure(error)
      }`,
      patternIndexErrorDetail(error),
    );
  }
  if (indexed.program === undefined) {
    throw new IndexedPatternError(
      "lookup",
      `the pattern index returned no program for "${patternId}"`,
    );
  }
  const program = runtimeProgramFromIndex(indexed.program);
  await composeProgram({
    runtime,
    space,
    program,
    recordedDependencies: indexed.dependencies,
    getClient,
  });
  return {
    program,
    ...(indexed.name === undefined ? {} : { name: indexed.name }),
  };
};

/**
 * Deploys `patternId` into `space`: {@link prepareIndexedProgram}, then a
 * compile. Answers the program, the pattern it compiled to, and the index's
 * display name for it.
 *
 * @throws IndexedPatternError at any stage. A compile failure's diagnostic is
 * withheld from the message, since it quotes source the caller did not write.
 */
export const compileIndexedPattern = async (
  options: IndexedPatternOptions,
): Promise<IndexedProgram & { pattern: Pattern }> => {
  const indexed = await prepareIndexedProgram(options);
  try {
    const pattern = await compileAndSavePattern(
      options.runtime,
      indexed.program,
      { space: options.space },
    );
    return { ...indexed, pattern };
  } catch (error) {
    throw new IndexedPatternError(
      "compile",
      `the indexed pattern "${options.patternId}" did not compile; the diagnostic is retained in the run artifact and withheld here, since it quotes source you did not author`,
      describeFailure(error),
    );
  }
};
