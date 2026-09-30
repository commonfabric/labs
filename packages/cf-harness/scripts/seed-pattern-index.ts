/**
 * Publishes the composable atoms under `packages/patterns/primitives` to the
 * pattern index, so a harness run has parameterized parts to find rather than
 * only whole applications that take no inputs.
 *
 * Everything the index stores about an atom is derived from the atom's own
 * source. The description is the first paragraph of its doc comment, and the
 * tags come from `@hashtags` and `@keywords` lines in the same comment, so the
 * claim the index advertises sits beside the code that has to honour it and
 * moves when that code moves. An atom whose doc comment carries neither tag
 * line is refused rather than published under a guess.
 *
 * The identity an atom is published under is its compiled entry identity —
 * the content-addressed value `run_pattern` publishes under, read back off the
 * compiled artifact through `getArtifactEntryRef`. It is stable across runs of
 * this script for unchanged source, which is what makes re-running idempotent:
 * `publishPattern` answers `created: false` for an identity the index already
 * holds.
 *
 * The compile runs inside the harness's own Fabric session rather than a
 * runtime built beside it. That is load-bearing rather than convenient: a
 * `PiecesController` pulls its experimental flags from the deployment it
 * connects to, and at least one of them (`contentAddressedSchemas`) bears on
 * content hashing. A runtime constructed here with default options could
 * compute an identity no composing run would ever recompute, and a
 * `cf:pattern:` import of that identity is refused outright rather than
 * silently degraded. So a dry run connects to the fabric too — it compiles
 * exactly what a real run compiles, and only the index writes are withheld.
 */

import { basename, fromFileUrl, join } from "@std/path";
import {
  compileAndSavePattern,
  type MemorySpace,
  PatternManager,
  type Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  createHarnessPatternIndexClientFactory,
  type PatternIndexClient,
  type PatternIndexPublishRequest,
} from "../src/pattern-index/client.ts";
import { createHarnessFabricSessionFactory } from "../src/fabric-session.ts";
import { patternIndexDependencies } from "../src/pattern-index/composition.ts";
import { patternIndexDeclaredType } from "../src/tools/search-patterns.ts";

/** The text of a thrown value, for a message that names what went wrong. */
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Where the atoms live, relative to the repository root. */
export const SEED_DIRECTORY = "packages/patterns/primitives";

/** What one atom's doc comment says about it, for the index to advertise. */
export interface SeedMetadata {
  /**
   * The first paragraph of the doc comment: what the program does, in terms a
   * reader can check against the source beside it.
   */
  description: string;

  hashtags: readonly string[];
  keywords: readonly string[];
}

/** An atom, its derived metadata, and the identity it publishes under. */
export interface SeedEntry {
  /** File name without extension, used to name the atom in output. */
  name: string;

  /** Absolute path to the atom's entry module. */
  path: string;

  metadata: SeedMetadata;
  patternId: string;
  program: RuntimeProgram;
  argumentSchema?: unknown;
  resultSchema?: unknown;

  /**
   * The generation this one supersedes, absent for an atom the index holds
   * under no other identity. Publication is create-only for the metadata of an
   * identity the index already has, so an entry the seeder can still describe
   * is a new identity, and this is what links it to the one it displaces.
   */
  priorPatternId?: string;
}

/** A doc comment's text with its leading `/**`, ` * ` and `*\/` removed. */
const docCommentBody = (source: string): string | undefined => {
  const match = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
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
 * What the index should advertise about the atom in `source`.
 *
 * @throws Error when the doc comment is missing, carries no prose before its
 * first tag, or declares no hashtags or keywords. A seed entry the index
 * cannot be searched for is worth less than no entry, and an entry described
 * by a guess is worse than either.
 */
export const seedMetadataFromSource = (
  name: string,
  source: string,
): SeedMetadata => {
  const body = docCommentBody(source);
  if (body === undefined) {
    throw new Error(`${name} has no leading doc comment to describe it`);
  }
  // Anchored at a line start including the first, so a comment that opens
  // straight into a tag yields no prose rather than the tag's own text.
  const prose = body.split(/(?:^|\n)\s*@/)[0];
  const description = prose.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  if (description === "") {
    throw new Error(`${name}'s doc comment opens with no description`);
  }
  const hashtags = tagValues(body, "hashtags");
  const keywords = tagValues(body, "keywords");
  if (hashtags.length === 0) {
    throw new Error(`${name}'s doc comment declares no @hashtags`);
  }
  if (keywords.length === 0) {
    throw new Error(`${name}'s doc comment declares no @keywords`);
  }
  return { description, hashtags, keywords };
};

/** The atom entry modules under `directory`, in a stable order. */
export const seedSourcePaths = async (
  directory: string,
): Promise<readonly string[]> => {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.endsWith(".test.tsx")) continue;
    paths.push(join(directory, entry.name));
  }
  return paths.sort();
};

/** The publish request an entry produces, so a dry run prints the real thing. */
export const publishRequestFor = (
  entry: SeedEntry,
): PatternIndexPublishRequest => ({
  patternId: entry.patternId,
  program: {
    main: entry.program.main,
    files: entry.program.files.map((file) => ({
      name: file.name,
      contents: file.contents,
    })),
    ...(entry.program.mainExport !== undefined
      ? { mainExport: entry.program.mainExport }
      : {}),
  },
  description: entry.metadata.description,
  hashtags: entry.metadata.hashtags,
  keywords: entry.metadata.keywords,
  // What a session looking for this atom would be asking for. The atom was
  // not written to answer one request, so its own description is the honest
  // stand-in: it is the same claim, in the same words the index ranks on.
  directQuery: entry.metadata.description,
  discoverable: true,
  ...(entry.argumentSchema !== undefined
    ? { argumentSchema: entry.argumentSchema as never }
    : {}),
  ...(entry.resultSchema !== undefined
    ? { resultSchema: entry.resultSchema as never }
    : {}),
  ...(entry.priorPatternId !== undefined
    ? { priorPatternId: entry.priorPatternId }
    : {}),
  dependencies: patternIndexDependencies(entry.program.files),
});

/** Where the published generations of each atom are recorded, from root. */
export const GENERATIONS_FILE =
  "packages/cf-harness/scripts/seeded-pattern-generations.json";

/**
 * The identities each atom has been published under, keyed by atom name and
 * ordered oldest first.
 *
 * The last entry of a chain is what the index holds for that atom, and what a
 * new generation names as its `priorPatternId`. `note` states that contract
 * inside the file, for a reader who opened it without this module.
 */
export interface SeedGenerations {
  note: string;
  atoms: Readonly<Record<string, readonly string[]>>;
}

/**
 * The record in `text`.
 *
 * @throws Error naming `path` when the file is not the shape above. A run that
 * read a chain it could not understand would publish a new generation linked
 * to nothing, which is the thing the record exists to prevent, so it stops
 * instead.
 */
export const parseGenerations = (
  path: string,
  text: string,
): SeedGenerations => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${errorMessage(error)}`);
  }
  const record = parsed as Partial<SeedGenerations>;
  // `atoms` is a map from an atom's name to its chain, and an array is an
  // object with numeric keys — so one read here as a record would key every
  // chain by its position, and a run reading it would name a prior generation
  // for an atom called `0`.
  if (
    !isObjectNotArray(parsed) ||
    typeof record.note !== "string" ||
    !isObjectNotArray(record.atoms)
  ) {
    throw new Error(`${path} holds no {note, atoms} record`);
  }
  for (const [name, chain] of Object.entries(record.atoms)) {
    if (
      !Array.isArray(chain) || chain.length === 0 ||
      chain.some((id) => typeof id !== "string" || id === "")
    ) {
      throw new Error(
        `${path} records ${name} as something other than a non-empty list of identities`,
      );
    }
  }
  return { note: record.note, atoms: record.atoms };
};

/** The record as the file holds it: keys in name order, one identity per line. */
export const serializeGenerations = (
  generations: SeedGenerations,
): string => {
  const atoms = Object.fromEntries(
    Object.entries(generations.atoms).sort(([a], [b]) => a < b ? -1 : 1),
  );
  return `${JSON.stringify({ note: generations.note, atoms }, null, 2)}\n`;
};

/**
 * `generations` with `patternId` recorded as `name`'s newest generation, or
 * unchanged when the chain already ends there.
 *
 * Appends rather than replaces, for both an atom the record knows and one it
 * does not: a generation the index accepted is one that can be composed from
 * then on, whether or not a later one displaces it in search.
 */
export const withGeneration = (
  generations: SeedGenerations,
  name: string,
  patternId: string,
): SeedGenerations => {
  const chain = generations.atoms[name] ?? [];
  if (chain.at(-1) === patternId) return generations;
  return {
    note: generations.note,
    atoms: { ...generations.atoms, [name]: [...chain, patternId] },
  };
};

/**
 * What the seed run needs from the world, so the run itself can be exercised
 * without a fabric or an index behind it. `main` supplies the real ones.
 */
export interface SeedDeps {
  /**
   * Assembles and compiles one atom, answering what the index needs to store
   * it. `patternId` is absent when the compile produced no durable
   * content-addressed identity.
   */
  compile: (path: string) => Promise<CompiledAtom>;

  publish: (
    request: PatternIndexPublishRequest,
  ) => Promise<{ patternId: string; created: boolean }>;
  recordCreated: (patternId: string) => Promise<void>;

  /** Answers which of `paths` are not formatted as the repository formats them. */
  checkFormatting: (paths: readonly string[]) => Promise<readonly string[]>;

  readGenerations: () => Promise<SeedGenerations>;
  writeGenerations: (generations: SeedGenerations) => Promise<void>;

  log: (line: string) => void;
  logError: (line: string) => void;
}

/** One compiled atom, in the terms the index stores it under. */
export interface CompiledAtom {
  /** Absent when the compile produced no durable identity. */
  patternId?: string;

  program: RuntimeProgram;
  argumentSchema?: unknown;
  resultSchema?: unknown;
}

export interface SeedOptions {
  dryRun: boolean;
  only: readonly string[];
  directory: string;
}

/** An argument the run cannot proceed without, named so `main` can print it. */
export class SeedUsageError extends Error {
  override name = "SeedUsageError";
}

export const USAGE = `Usage: deno task seed-pattern-index [options]

Publishes the atoms under ${SEED_DIRECTORY} to the pattern index.

  --dry-run          Compile and print what would be published, publishing
                     nothing. Still connects to the fabric, because the
                     identity it prints comes from the compile.
  --only <name>      Seed only the named atom (repeatable), e.g. --only counter
  --api-url <url>    Fabric API             [CF_HARNESS_FABRIC_API_URL]
  --identity <path>  Identity keyfile       [CF_HARNESS_FABRIC_IDENTITY]
  --space <space>    Fabric space           [CF_HARNESS_FABRIC_SPACE]
  --index-url <url>  Pattern index base URL [CF_HARNESS_PATTERN_INDEX_URL]
`;

/** Flags and repeated `--only` names, separated from where they come from. */
export interface ParsedArguments {
  dryRun: boolean;
  help: boolean;
  only: readonly string[];
  named: ReadonlyMap<string, string>;
}

/**
 * @throws SeedUsageError on an argument the parser cannot place, so a
 * misspelled flag stops the run rather than being silently dropped and
 * seeding more than the caller asked for.
 */
export const parseArguments = (args: readonly string[]): ParsedArguments => {
  const only: string[] = [];
  const named = new Map<string, string>();
  let dryRun = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--only") {
      const value = args[++i];
      if (value === undefined) {
        throw new SeedUsageError("--only needs the name of an atom");
      }
      only.push(value);
    } else if (arg.startsWith("--")) {
      const value = args[++i];
      if (value === undefined) {
        throw new SeedUsageError(`${arg} needs a value`);
      }
      named.set(arg.slice(2), value);
    } else {
      throw new SeedUsageError(`unexpected argument "${arg}"`);
    }
  }
  return { dryRun, help, only, named };
};

/**
 * A setting from the flag, else the environment.
 *
 * @throws SeedUsageError when neither supplies it.
 */
export const requiredSetting = (
  parsed: ParsedArguments,
  flag: string,
  envKey: string,
  env: (key: string) => string | undefined,
): string => {
  const value = parsed.named.get(flag) ?? env(envKey);
  if (value === undefined || value === "") {
    throw new SeedUsageError(`--${flag} is required (or set ${envKey})`);
  }
  return value;
};

/** Where the run connects, and as whom. */
export interface SeedSettings {
  apiUrl: string;
  identityKeyPath: string;
  space: string;
  indexBaseUrl: string;
}

/** @throws SeedUsageError naming the first setting nothing supplies. */
export const resolveSettings = (
  parsed: ParsedArguments,
  env: (key: string) => string | undefined,
): SeedSettings => ({
  apiUrl: requiredSetting(parsed, "api-url", "CF_HARNESS_FABRIC_API_URL", env),
  identityKeyPath: requiredSetting(
    parsed,
    "identity",
    "CF_HARNESS_FABRIC_IDENTITY",
    env,
  ),
  space: requiredSetting(parsed, "space", "CF_HARNESS_FABRIC_SPACE", env),
  indexBaseUrl: requiredSetting(
    parsed,
    "index-url",
    "CF_HARNESS_PATTERN_INDEX_URL",
    env,
  ),
});

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
 * Assembles and compiles one atom in `space`, answering what the index needs.
 *
 * Takes the runtime and space rather than a session, so a compile can be
 * exercised against any runtime — the identity is a content hash, and what
 * decides it is the source and the compiler, not what the runtime is
 * connected to.
 */
export const compileAtom = async (
  runtime: SeedRuntime,
  space: MemorySpace,
  path: string,
  root: string,
): Promise<CompiledAtom> => {
  const program = await resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: path, root },
  );
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

/** The part of a `Runtime` a seed compile uses. */
export type SeedRuntime = Pick<Runtime, "harness" | "patternManager">;

/**
 * The atoms whose source is not formatted as the repository formats it.
 *
 * An entry identity is a content hash of the source bytes, so seeding
 * unformatted source mints an identity the next `deno fmt` changes, and the
 * same atom seeds again under a second id. That is how one atom becomes two
 * entries competing in search, and it is what this catches.
 *
 * What it does NOT establish is that the bytes it hashed are the bytes the
 * repository holds. Two gaps, both real:
 *
 * - It compares against the formatter, not against `HEAD`. A formatter-clean
 *   edit that is merely uncommitted passes, and publishes under an identity no
 *   commit contains — which is the failure this guard was written for.
 * - It receives only the selected entry paths, while `compileAtom` hashes the
 *   whole closure `resolveLocalProgram` returns. A local helper contributing to
 *   an atom's identity is never checked.
 *
 * The atoms seeded today are self-contained and committed, so neither gap is
 * live for them. Closing them means resolving the closure first and refusing
 * dirty or untracked source; until then this narrows the failure rather than
 * removing it.
 */
export const unformattedPaths = async (
  paths: readonly string[],
  check: (paths: readonly string[]) => Promise<readonly string[]>,
): Promise<readonly string[]> => await check(paths);

/**
 * Asks `deno fmt --check` which of `paths` it would rewrite, answering the
 * paths IT names rather than the ones passed in. The two can differ: a path
 * through a symlinked directory (`/tmp` on macOS) comes back resolved, so
 * matching the input strings would answer "nothing to do" for a file deno
 * just rejected.
 */
export const denoFmtCheck = async (
  paths: readonly string[],
): Promise<readonly string[]> => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--check", ...paths],
    // Without this deno wraps the path it names in colour escapes, and the
    // pattern below matches nothing — which would fall back to blaming every
    // file for one file's formatting.
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code === 0) return [];
  const decoder = new TextDecoder();
  const text = decoder.decode(stdout) + decoder.decode(stderr);
  const named = [...text.matchAll(/^from (.+):$/gm)].map((match) => match[1]);
  // A non-zero exit deno named no file for is still a refusal to publish: the
  // check did not pass, and seeding on an unreadable answer is the silence
  // this guard exists to prevent.
  return named.length > 0 ? named : [...paths];
};

/** The atoms this run seeds: every one under `directory`, or those `--only` names. */
export const selectedPaths = async (
  options: SeedOptions,
): Promise<readonly string[]> => {
  const all = await seedSourcePaths(options.directory);
  const paths = options.only.length === 0
    ? all
    : all.filter((path) => options.only.includes(basename(path, ".tsx")));
  if (paths.length === 0) {
    throw new SeedUsageError(`no atoms matched under ${options.directory}`);
  }
  return paths;
};

/**
 * Compiles every selected atom and publishes it, answering a process exit
 * code. Answers 1 without publishing anything when an atom compiles to no
 * durable identity.
 */
export const runSeed = async (
  options: SeedOptions,
  deps: SeedDeps,
): Promise<number> => {
  const paths = await selectedPaths(options);
  // Checked before anything compiles, so an id the next format pass would
  // change is never minted, rather than being noticed after it reaches the
  // shared corpus. This does not establish that the source is committed; see
  // `unformattedPaths` for what the check does and does not cover.
  const unformatted = await unformattedPaths(paths, deps.checkFormatting);
  if (unformatted.length > 0) {
    deps.logError(
      `seed-pattern-index: these atoms are not formatted, so the identity they would publish under changes the next time \`deno fmt\` runs. Run it on them and seed again:\n  ${
        unformatted.join("\n  ")
      }`,
    );
    return 1;
  }
  // Every atom's metadata is derived before anything is compiled or published,
  // so a doc comment that describes nothing stops the run while the index is
  // still untouched rather than half-seeded.
  const described = await Promise.all(paths.map(async (path) => {
    const name = basename(path, ".tsx");
    const source = await Deno.readTextFile(path);
    return { name, path, metadata: seedMetadataFromSource(name, source) };
  }));
  const generations = await deps.readGenerations();

  const entries: SeedEntry[] = [];
  for (const { name, path, metadata } of described) {
    const compiled = await deps.compile(path);
    if (compiled.patternId === undefined) {
      deps.logError(
        `seed-pattern-index: ${name} compiled to no durable content-addressed entry identity; not seeding it.`,
      );
      return 1;
    }
    // The recorded generation is a prior one only where it names another
    // identity: the same source compiles to the same identity, and an entry
    // naming itself as what it supersedes would say the atom displaced itself.
    const recorded = generations.atoms[name]?.at(-1);
    entries.push({
      name,
      path,
      metadata,
      patternId: compiled.patternId,
      program: compiled.program,
      ...(compiled.argumentSchema !== undefined
        ? { argumentSchema: compiled.argumentSchema }
        : {}),
      ...(compiled.resultSchema !== undefined
        ? { resultSchema: compiled.resultSchema }
        : {}),
      ...(recorded !== undefined && recorded !== compiled.patternId
        ? { priorPatternId: recorded }
        : {}),
    });
  }

  for (const entry of entries) {
    const request = publishRequestFor(entry);
    deps.log(`\n=== ${entry.name}`);
    deps.log(`  patternId:   ${entry.patternId}`);
    deps.log(`  import:      cf:pattern:${entry.patternId}`);
    deps.log(`  description: ${request.description}`);
    deps.log(`  hashtags:    ${request.hashtags.join(", ")}`);
    deps.log(`  keywords:    ${request.keywords?.join(", ")}`);
    deps.log(
      `  files:       ${
        request.program.files.map((file) => file.name).join(", ")
      }`,
    );
    deps.log(`  supersedes:  ${request.priorPatternId ?? "(nothing)"}`);
    // Both the schema and the type a search renders from it: the type is what
    // a session composing the atom reads, and it names the handle types a
    // pattern author writes rather than the shapes their values have.
    deps.log(
      `  argumentType:   ${
        patternIndexDeclaredType(request.argumentSchema) ?? "(none)"
      }`,
    );
    deps.log(
      `  resultType:     ${
        patternIndexDeclaredType(request.resultSchema) ?? "(none)"
      }`,
    );
    deps.log(
      `  argumentSchema: ${JSON.stringify(request.argumentSchema) ?? "(none)"}`,
    );
  }

  if (options.dryRun) {
    deps.log(
      `\nDry run: ${entries.length} atom(s) compiled, nothing published, ${GENERATIONS_FILE} unchanged.`,
    );
    return 0;
  }

  let created = 0;
  let held = 0;
  let wrote = false;
  let recorded = generations;
  for (const entry of entries) {
    const response = await deps.publish(publishRequestFor(entry));
    const next = withGeneration(recorded, entry.name, response.patternId);
    if (next !== recorded) {
      // Written here rather than once the loop is through. From this point the
      // index holds the entry whatever happens to the atoms after it, and this
      // file is what a later run reads to say which generation a new one
      // supersedes — so a publication that landed and went unrecorded is what
      // makes that link name a generation the index has already displaced.
      await deps.writeGenerations(next);
      recorded = next;
      wrote = true;
    }
    if (response.created) {
      created += 1;
      // The index ranks on recorded events, and a publication is not one. The
      // `created` event is what `run_pattern` records for a first publication,
      // and a seeded atom is entitled to exactly that and nothing more.
      await deps.recordCreated(response.patternId);
    } else {
      held += 1;
    }
    deps.log(
      `${
        response.created ? "published" : "already held"
      }: ${entry.name} (${response.patternId})`,
    );
  }
  if (wrote) {
    deps.log(
      `\n${GENERATIONS_FILE} records what this run published; commit it.`,
    );
  }
  deps.log(`\n${created} published, ${held} already held by the index.`);
  return 0;
};

/**
 * The deps, given the collaborators already built. Separated from the building
 * so the wiring can be exercised without a fabric or an index behind it: what
 * is left in {@link fabricSeedDeps} is the two constructions themselves.
 */
export const seedDepsFrom = (
  options: {
    runtime: SeedRuntime;
    space: MemorySpace;
    getClient: () => Promise<
      Pick<PatternIndexClient, "publishPattern" | "recordEvent">
    >;
    repoRoot: string;
    log: (line: string) => void;
    logError: (line: string) => void;
  },
): SeedDeps => {
  const generationsPath = join(options.repoRoot, GENERATIONS_FILE);
  return {
    compile: (path) =>
      compileAtom(
        options.runtime,
        options.space,
        path,
        join(options.repoRoot, "packages/patterns"),
      ),
    publish: async (request) =>
      await (await options.getClient()).publishPattern(request),
    recordCreated: async (patternId) => {
      await (await options.getClient()).recordEvent({
        patternId,
        eventType: "created",
      });
    },
    checkFormatting: denoFmtCheck,
    readGenerations: async () =>
      parseGenerations(
        GENERATIONS_FILE,
        await Deno.readTextFile(generationsPath),
      ),
    writeGenerations: (generations) =>
      Deno.writeTextFile(generationsPath, serializeGenerations(generations)),
    log: options.log,
    logError: options.logError,
  };
};

/** Builds the deps a real run uses: a fabric session and an index client. */
export const fabricSeedDeps = async (
  settings: SeedSettings,
  repoRoot: string,
  log: (line: string) => void,
  logError: (line: string) => void,
  // The two constructions this function exists to perform, injectable so the
  // wiring between them can be asserted: which setting reaches the fabric and
  // which reaches the index is a thing to get wrong, and both are strings.
  openSession: typeof createHarnessFabricSessionFactory =
    createHarnessFabricSessionFactory,
  makeClient: typeof createHarnessPatternIndexClientFactory =
    createHarnessPatternIndexClientFactory,
): Promise<SeedDeps> => {
  const { pieces } = await openSession({
    apiUrl: settings.apiUrl,
    identityKeyPath: settings.identityKeyPath,
    space: settings.space,
  })();
  return seedDepsFrom({
    runtime: pieces.runtime,
    space: pieces.getSpace(),
    getClient: makeClient(
      { baseUrl: settings.indexBaseUrl },
      settings.identityKeyPath,
    ),
    repoRoot,
    log,
    logError,
  });
};

/** What `main` reaches the world through, so a test can drive all of it. */
export interface SeedIo {
  env: (key: string) => string | undefined;
  log: (line: string) => void;
  logError: (line: string) => void;
  repoRoot: string;
  createDeps: (
    settings: SeedSettings,
    repoRoot: string,
    log: (line: string) => void,
    logError: (line: string) => void,
  ) => Promise<SeedDeps>;
}

// The script lives at packages/cf-harness/scripts/, three levels below root.
const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

export const defaultSeedIo = (): SeedIo => ({
  env: (key) => Deno.env.get(key),
  log: (line) => console.log(line),
  logError: (line) => console.error(line),
  repoRoot: REPO_ROOT,
  createDeps: fabricSeedDeps,
});

export const main = async (
  args: readonly string[],
  io: SeedIo = defaultSeedIo(),
): Promise<number> => {
  let parsed: ParsedArguments;
  let settings: SeedSettings;
  try {
    parsed = parseArguments(args);
    if (parsed.help) {
      io.log(USAGE);
      return 0;
    }
    settings = resolveSettings(parsed, io.env);
  } catch (error) {
    io.logError(`seed-pattern-index: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }
  try {
    const deps = await io.createDeps(
      settings,
      io.repoRoot,
      io.log,
      io.logError,
    );
    return await runSeed({
      dryRun: parsed.dryRun,
      only: parsed.only,
      directory: join(io.repoRoot, SEED_DIRECTORY),
    }, deps);
  } catch (error) {
    io.logError(`seed-pattern-index: ${errorMessage(error)}`);
    return error instanceof SeedUsageError ? 2 : 1;
  }
};

if (import.meta.main) Deno.exit(await main(Deno.args));
