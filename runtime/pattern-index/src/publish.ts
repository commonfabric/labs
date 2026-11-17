/**
 * Turning a pattern on disk into what the index stores: its description and
 * tags, read from the entry file's doc comment, and its compiled program,
 * whose content-addressed entry identity is the id it publishes under.
 *
 * Two callers publish this way and have to agree, or the same source would
 * publish under two ids: `cf pattern publish`, for a person's pattern, and
 * cf-harness's `seed-pattern-index` script, for the building blocks the team
 * seeds.
 *
 * The compile runs in a runtime connected to a fabric deployment rather than
 * one built beside it. A runtime takes its experimental flags from the
 * deployment, and at least one of them (`contentAddressedSchemas`) bears on
 * content hashing, so a runtime with default options could compute an
 * identity no deploying run would recompute.
 */

import {
  compileAndSavePattern,
  type MemorySpace,
  PatternManager,
  type Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { JSONSchema } from "@commonfabric/api";
import type { PatternIndexPublishRequest } from "./client.ts";
import { patternIndexDependencies } from "./deploy.ts";

/** What an entry file's doc comment says about the pattern. */
export interface PatternDocMetadata {
  /** The comment's first paragraph, or `undefined` for none. */
  description?: string;

  /** The values of its `@hashtags` line, comma-separated. */
  hashtags: readonly string[];

  /** The values of its `@keywords` line, comma-separated. */
  keywords: readonly string[];
}

/**
 * What may come before a pattern's doc comment: blank lines, `//` and `///`
 * comments (a tier marker, a compiler directive), and import statements.
 */
const PREAMBLE =
  /^(?:\s+|\/\/[^\n]*(?:\n|$)|import\s[^;]*?from\s*["'][^"']*["']\s*;?|import\s*["'][^"']*["']\s*;?)*/;

/**
 * A doc comment's text with its leading `/**`, ` * ` and `*\/` removed: the
 * first one, where only {@link PREAMBLE} comes before it.
 */
const docCommentBody = (source: string): string | undefined => {
  const preamble = source.match(PREAMBLE)?.[0] ?? "";
  const match = source.slice(preamble.length).match(/^\/\*\*([\s\S]*?)\*\//);
  if (match === null) return undefined;
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
};

/** The comma-separated values of an `@tag` line, folded onto one line. */
const tagValues = (body: string, tag: string): readonly string[] => {
  const match = body.match(
    new RegExp(`@${tag}\\s+([\\s\\S]*?)(?=\\n\\s*@|$)`),
  );
  if (match === null) return [];
  return match[1]
    .split(",")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0);
};

/**
 * What the leading doc comment of `source` says: its first paragraph as
 * the description, and its `@hashtags` and `@keywords` lines. Answers what
 * is there and nothing more; a caller decides what is missing.
 */
export const patternDocMetadata = (source: string): PatternDocMetadata => {
  const body = docCommentBody(source);
  if (body === undefined) return { hashtags: [], keywords: [] };
  // Anchored at a line start including the first, so a comment that opens
  // straight into a tag yields no prose rather than the tag's own text.
  const prose = body.split(/(?:^|\n)\s*@/)[0];
  const description = prose.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return {
    ...(description === "" ? {} : { description }),
    hashtags: tagValues(body, "hashtags"),
    keywords: tagValues(body, "keywords"),
  };
};

/**
 * The identity an entry may be published under, or `undefined` for one that
 * could never be loaded by anything else. A keyless identity names a pattern
 * only within the session that minted it — the same refusal `run_pattern`
 * makes on its own publish path.
 */
export const durableEntryIdentity = (
  identity: string | undefined,
): string | undefined =>
  identity !== undefined && !PatternManager.isKeylessPatternIdentity(identity)
    ? identity
    : undefined;

/**
 * Hashtags as the index stores them: without a leading `#`, lower case. A
 * doc comment's `@hashtags #Math` and a flag's `math` are the same tag.
 */
export const normalizeHashtags = (tags: readonly string[]): string[] =>
  tags.map((tag) => tag.replace(/^#/, "").toLowerCase());

/** One compiled pattern, in the terms the index stores it under. */
export interface CompiledPattern {
  /** Absent when the compile produced no durable identity. */
  patternId?: string;

  program: RuntimeProgram;
  argumentSchema?: unknown;
  resultSchema?: unknown;
}

/** The part of a `Runtime` a publish compile uses. */
export type PublishRuntime = Pick<Runtime, "harness" | "patternManager">;

export interface CompileLocalPatternOptions {
  /** The entry module's path. */
  main: string;

  /** The program root its files are named against; the entry's directory by default. */
  root?: string;

  /** Test entries packaged with it. */
  testPaths?: readonly string[];

  /** Data files attached to it. */
  dataFilePaths?: readonly string[];

  /** The export the program runs; `default` by default. */
  mainExport?: string;
}

/**
 * Assembles the program `main` and its relative imports make, and compiles
 * it in `space`. A source that imports a published pattern
 * (`cf:pattern:<id>`) does not assemble: local resolution finds no file
 * behind the import.
 *
 * @throws whatever the assembly or the compile throws, quoting the caller's
 *   own source.
 */
export const compileLocalPattern = async (
  runtime: PublishRuntime,
  space: MemorySpace,
  options: CompileLocalPatternOptions,
): Promise<CompiledPattern> => {
  const program = await resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    {
      main: options.main,
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.testPaths === undefined
        ? {}
        : { testPaths: options.testPaths }),
      ...(options.dataFilePaths === undefined
        ? {}
        : { dataFilePaths: options.dataFilePaths }),
      ...(options.mainExport === undefined
        ? {}
        : { mainExport: options.mainExport }),
    },
  );
  return await compileProgram(runtime, space, program);
};

/**
 * Compiles an already assembled `program` in `space`, as
 * {@link compileLocalPattern} does after assembling one. A caller that
 * rewrote a program's files compiles the rewrite this way.
 */
export const compileProgram = async (
  runtime: PublishRuntime,
  space: MemorySpace,
  program: RuntimeProgram,
): Promise<CompiledPattern> => {
  const pattern = await compileAndSavePattern(runtime as Runtime, program, {
    space,
  });
  const identity = runtime.patternManager.getArtifactEntryRef(pattern)
    ?.identity;
  const patternId = durableEntryIdentity(identity);
  return {
    ...(patternId !== undefined ? { patternId } : {}),
    program,
    argumentSchema: pattern.argumentSchema,
    resultSchema: pattern.resultSchema,
  };
};

/** What a publication says about a compiled pattern. */
export interface PublicationFields {
  patternId: string;
  program: RuntimeProgram;
  description: string;
  hashtags: readonly string[];
  keywords: readonly string[];
  argumentSchema?: unknown;
  resultSchema?: unknown;
  priorPatternId?: string;
  remixedFrom?: string;
}

/**
 * The publish request for a compiled pattern. It carries no task text
 * (`directQuery`) and asks for no discovery: a listing is requested
 * separately, and the index's gardeners decide it.
 */
export const publishRequestFor = (
  fields: PublicationFields,
): PatternIndexPublishRequest => ({
  patternId: fields.patternId,
  program: {
    main: fields.program.main,
    files: fields.program.files.map((file) => ({
      name: file.name,
      contents: file.contents,
    })),
    ...(fields.program.mainExport !== undefined
      ? { mainExport: fields.program.mainExport }
      : {}),
    // Test roots and data files are part of the package a deploy compiles,
    // and of the id; a program fetched without them reads no data.
    ...(fields.program.sourceRoots !== undefined
      ? { sourceRoots: [...fields.program.sourceRoots] }
      : {}),
    ...(fields.program.dataFiles !== undefined
      ? { dataFiles: [...fields.program.dataFiles] }
      : {}),
  },
  description: fields.description,
  hashtags: fields.hashtags,
  keywords: fields.keywords,
  ...(fields.argumentSchema !== undefined
    ? { argumentSchema: fields.argumentSchema as JSONSchema }
    : {}),
  ...(fields.resultSchema !== undefined
    ? { resultSchema: fields.resultSchema as JSONSchema }
    : {}),
  ...(fields.priorPatternId !== undefined
    ? { priorPatternId: fields.priorPatternId }
    : {}),
  ...(fields.remixedFrom !== undefined
    ? { remixedFrom: fields.remixedFrom }
    : {}),
  dependencies: patternIndexDependencies(sourceFiles(fields.program)),
});

/** The program's source files: everything but its data files, never parsed. */
const sourceFiles = (program: RuntimeProgram): RuntimeProgram["files"] => {
  const data = new Set(program.dataFiles ?? []);
  return program.files.filter((file) => !data.has(file.name));
};
