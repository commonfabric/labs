import { Command, ValidationError } from "@cliffy/command";
import { basename, dirname } from "@std/path";
import { LLMClient } from "@commonfabric/llm";
import type { MemorySpace, Runtime } from "@commonfabric/runner";
import type { ObjectGenerator } from "@commonfabric/pattern-index/privacy";
import {
  compileLocalPattern,
  compileProgram,
} from "@commonfabric/pattern-index/publish";

import { cliText } from "../lib/cli-name.ts";
import { loadIdentity } from "../lib/identity.ts";
import {
  openPatternIndexClient,
  resolvePatternIndexUrl,
} from "@commonfabric/pattern-index/access";
import {
  PatternIndexStore,
  patternIndexStoreDir,
} from "@commonfabric/pattern-index/store";
import { mineLines, mineRows } from "../lib/pattern-mine.ts";
import {
  entryHistory,
  historyLines,
  lineageLines,
  type LinkChannel,
  linkLine,
  makeStable,
  PatternHistoryError,
  patternLink,
  requireLineage,
  rollbackEntry,
  rollbackLines,
  stableLine,
} from "../lib/pattern-history.ts";
import {
  type DeployedSource,
  entrySlot,
  lineageForEntry,
  type SlotSources,
  versionJson,
  versionLine,
  type VersionOutcome,
} from "../lib/pattern-versions.ts";
import {
  chooseProfile,
  NamingError,
  namingWarning,
  profileProof,
} from "../lib/pattern-named.ts";
import { type ListedProfile, listProfiles } from "../lib/profile.ts";
import type { DIDKey } from "@commonfabric/identity";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type {
  PatternIndexChannel,
  PatternIndexClient,
} from "@commonfabric/pattern-index/client";
import {
  publishPatternFromDisk,
  type PublishReport,
  publishReportLines,
} from "../lib/pattern-publish.ts";
import {
  loadPieces,
  readRunningPattern,
  type RunningPattern,
  type SpaceConfig,
} from "../lib/piece.ts";
import { render } from "../lib/render.ts";
import { absPath } from "../lib/utils.ts";
import {
  indexAccessOptions,
  type IndexDeps,
  requireIdentityPath,
  rethrowAsNotMember,
} from "./pattern-index.ts";
import {
  parsePieceOptions,
  parseSpaceOptions,
  type PieceCLIOptions,
  recordVersionInIndex,
  targetOptions,
} from "./piece.ts";

/** What `cf pattern share` takes beyond the target options. */
interface PublishCLIOptions extends PieceCLIOptions {
  root?: string;
  test?: string[];
  datafile?: string[];
  mainExport?: string;
  description?: string;
  hashtags?: string;
  keywords?: string;
  allowDirty?: boolean;
  skipLocalCheck?: boolean;
  remixedFrom?: string;
  standalone?: boolean;
  part?: boolean;
  patternIndexUrl?: string;
  json?: boolean;
}

/** A comma-separated flag's values, or `undefined` when it was not given. */
const listFlag = (value: string | undefined): string[] | undefined =>
  value === undefined ? undefined : value.split(",").map((v) => v.trim())
    .filter((v) => v !== "");

/**
 * Which of `paths` a rewrite may not be written over, or `undefined` where
 * they are not in a git working tree. A path may be written over only when
 * `git checkout` can take the rewrite back: git tracks it, it has no
 * uncommitted edits, and it is not a symbolic link, whose target is a
 * different file from the one git compared.
 */
export const gitUncommitted = async (
  paths: readonly string[],
): Promise<string[] | undefined> => {
  const git = async (cwd: string, ...args: string[]) => {
    const { code, stdout } = await new Deno.Command("git", {
      args: ["-C", cwd, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    return { code, stdout: new TextDecoder().decode(stdout) };
  };
  const dirty: string[] = [];
  for (const path of paths) {
    const cwd = dirname(path);
    if ((await git(cwd, "rev-parse", "--is-inside-work-tree")).code !== 0) {
      return undefined;
    }
    const link = await Deno.lstat(path).then(
      (info) => info.isSymlink,
      () => false,
    );
    const tracked =
      (await git(cwd, "ls-files", "--error-unmatch", "--", basename(path)))
        .code === 0;
    const status = await git(
      cwd,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      basename(path),
    );
    if (link || !tracked || status.code !== 0 || status.stdout.trim() !== "") {
      dirty.push(path);
    }
  }
  return dirty;
};

/** What `cf pattern share` reads of the connection to the space. */
export interface PublishConnection {
  runtime: Runtime;
  getSpace(): MemorySpace;
  dispose(): Promise<void>;
}

/**
 * What `cf pattern share` reaches outside the process, beyond what
 * `cf index` does: the connection whose runtime compiles the pattern, and
 * which files git could restore. Each defaults to the real one.
 */
export interface PublishCommandDeps extends Omit<IndexDeps, "stdin"> {
  loadPieces?: (config: SpaceConfig) => Promise<PublishConnection>;
  uncommitted?: typeof gitUncommitted;
}

/**
 * What `cf pattern publish` reaches beyond what `share` does: the person's
 * profiles. Defaults to the real ones.
 */
export interface PublishNamedDeps extends PublishCommandDeps {
  listProfiles?: (config: SpaceConfig) => Promise<ListedProfile[]>;
}

/** The store `cf` keeps for the index at `baseUrl`, unless one is given. */
const storeFor = (
  baseUrl: string,
  store: PatternIndexStore | undefined,
): PatternIndexStore =>
  store ?? new PatternIndexStore(patternIndexStoreDir(baseUrl));

/** The model `cf` reaches through its fabric's toolshed. */
const toolshedGenerator = (apiUrl: string): ObjectGenerator => {
  const client = new LLMClient();
  const endpoint = new URL("/api/ai/llm", apiUrl);
  return async ({ system, user, schema }) =>
    (await client.generateObject(
      { schema, system, messages: [{ role: "user", content: user }] },
      undefined,
      { endpoint },
    )).object;
};

/** What `cf pattern publish` takes beyond what `share` does. */
interface NamedPublishCLIOptions extends PublishCLIOptions {
  profile?: string;

  /** The profile name the person agreed to show, which must match. */
  as?: string;
}

/**
 * `cf pattern share`: checks and shares `entry` on beta, by link only,
 * printing the report; `cf pattern stable` makes it findable.
 */
export async function share(
  options: PublishCLIOptions,
  entry: string,
  deps: PublishCommandDeps = {},
): Promise<void> {
  await shareOn("beta", options, entry, deps);
}

/**
 * Checks and shares `entry` on `channel`, printing the report; with
 * `naming`, then names the lineage the share was kept in, once the report is
 * out, so a naming that fails never hides what the share did.
 */
async function shareOn(
  channel: PatternIndexChannel,
  options: PublishCLIOptions,
  entry: string,
  {
    loadPieces: load = loadPieces,
    uncommitted = gitUncommitted,
    render: out = render,
    fetchFn,
    store: given,
  }: PublishCommandDeps = {},
  naming?: (
    client: PatternIndexClient,
    report: Extract<PublishReport, { outcome: "shared" }>,
  ) => Promise<string>,
): Promise<void> {
  const config = parseSpaceOptions(options);
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  const signer = await loadIdentity(config.identity);
  const store = storeFor(baseUrl, given);
  const client = await openPatternIndexClient({
    baseUrl,
    signer,
    fetchFn,
    store,
  });
  const pieces = await load(config);
  try {
    const runtime = pieces.runtime;
    const space = pieces.getSpace();
    const report = await publishPatternFromDisk(
      {
        entry: absPath(entry),
        ...(options.root === undefined ? {} : { root: absPath(options.root) }),
        ...(options.test === undefined
          ? {}
          : { testPaths: options.test.map((path) => absPath(path)) }),
        ...(options.datafile === undefined
          ? {}
          : { dataFilePaths: options.datafile.map((path) => absPath(path)) }),
        ...(options.mainExport === undefined
          ? {}
          : { mainExport: options.mainExport }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.hashtags === undefined
          ? {}
          : { hashtags: listFlag(options.hashtags) }),
        ...(options.keywords === undefined
          ? {}
          : { keywords: listFlag(options.keywords) }),
        allowDirty: !!options.allowDirty,
        slot: await entrySlot(absPath(entry), slotSources(store)),
        channel,
        skipLocalCheck: !!options.skipLocalCheck,
        ...(options.remixedFrom === undefined
          ? {}
          : { remixedFrom: options.remixedFrom }),
        ...(options.standalone
          ? { standalone: true }
          : options.part
          ? { standalone: false }
          : {}),
      },
      {
        compileEntry: (main, program) =>
          compileLocalPattern(runtime, space, {
            main,
            ...program,
          }),
        compileProgram: (program) => compileProgram(runtime, space, program),
        client,
        generate: toolshedGenerator(config.apiUrl),
        modelLabel: config.apiUrl,
        uncommitted,
        readTextFile: (path) => Deno.readTextFile(path),
        writeTextFile: (path, contents) => Deno.writeTextFile(path, contents),
        store,
      },
    );
    if (naming === undefined || report.outcome !== "shared") {
      out(
        options.json ? report : publishReportLines(report).join("\n"),
        { json: options.json },
      );
      if (report.outcome === "blocked") Deno.exitCode = 1;
      return;
    }
    if (!options.json) out(publishReportLines(report).join("\n"));
    let named: string;
    try {
      named = await naming(client, report);
    } catch (error) {
      named = `Shared, but not published under your name: ${
        describeFailure(error)
      }`;
      Deno.exitCode = 1;
    }
    out(options.json ? { ...report, named } : named, {
      json: options.json,
    });
  } finally {
    await pieces.dispose();
  }
}

/**
 * `cf pattern publish`: shares `entry` as `share` does but on stable, so it
 * is findable once checked, then names the
 * person as its author under one of their profiles. It names nothing unless
 * `--as` repeats the profile's name, so whoever runs it has had to read the
 * name it shows, and an agent has to have asked the person. Everything that
 * can refuse the naming is checked before anything is shared.
 */
export async function publishNamed(
  options: NamedPublishCLIOptions,
  entry: string,
  deps: PublishNamedDeps = {},
): Promise<void> {
  const config = parseSpaceOptions(options);
  const identity = await loadIdentity(config.identity);
  const refuse = (message: string) => {
    console.error(message);
    Deno.exitCode = 1;
  };
  let proof: string[];
  let chosen: ListedProfile;
  try {
    const profiles = await (deps.listProfiles ?? listProfiles)({
      ...config,
      space: identity.did(),
    });
    chosen = chooseProfile(profiles, options.profile);
    if (options.as !== chosen.name) {
      refuse(
        `${
          namingWarning(chosen.name)
        } Nothing was published. Ask the person whether to show it; if they agree, run this again with --as ${
          JSON.stringify(chosen.name)
        }.`,
      );
      return;
    }
    proof = await profileProof(
      {
        space: chosen.space,
        piece: chosen.id,
        displayName: chosen.name,
        delegations: await recordedDelegations(
          config,
          chosen.space,
          deps.loadPieces,
        ),
      },
      identity.did(),
    );
  } catch (error) {
    if (!(error instanceof NamingError)) throw error;
    refuse(`${error.message} Nothing was published.`);
    return;
  }
  const sources = slotSources(
    storeFor(resolvePatternIndexUrl(options.patternIndexUrl), deps.store),
  );
  // Publishing under a name is meant to be found, so it shares on stable.
  await shareOn("stable", options, entry, deps, async (client, report) => {
    // The lineage the share landed in, which the index may have found by
    // an earlier publication rather than by this file's slot.
    const lineageId = report.lineageId ??
      (await lineageForEntry(client, absPath(entry), sources))?.lineageId;
    if (lineageId === undefined) {
      throw new Error(`the index keeps no versions of ${entry}`);
    }
    await client.publishLineage({
      lineageId,
      profile: { space: chosen.space, piece: chosen.id },
      displayName: chosen.name,
      profileProof: proof,
    });
    return `Published under "${chosen.name}"; cf pattern unpublish ${entry} stops showing it.`;
  });
}

/** Where a lineage slot's inputs come from: `store`'s key, and git. */
const slotSources = (store: PatternIndexStore): SlotSources => ({
  pathKey: () => store.slotKey(),
});

/** The delegations Home records over the profile space `space`. */
async function recordedDelegations(
  config: ReturnType<typeof parseSpaceOptions>,
  space: string,
  load: (config: SpaceConfig) => Promise<PublishConnection> = loadPieces,
): Promise<Uint8Array[]> {
  const pieces = await load(config);
  try {
    return await pieces.runtime.recordedDelegations(space as DIDKey);
  } finally {
    await pieces.dispose();
  }
}

/** Options every owner-only `cf pattern` command takes. */
interface IndexCLIOptions {
  identity?: string;
  patternIndexUrl?: string;
  json?: boolean;
}

/**
 * The client for the index `options` names, signing as its identity, and
 * where that index's lineage slots get their inputs.
 */
async function indexFor(
  options: IndexCLIOptions,
  { fetchFn, store: given }: IndexDeps,
) {
  const signer = await loadIdentity(requireIdentityPath(options));
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  const store = storeFor(baseUrl, given);
  return {
    client: await openPatternIndexClient({ baseUrl, signer, fetchFn, store }),
    sources: slotSources(store),
  };
}

/**
 * Runs an owner-only command, turning a refusal of the identity into what
 * to do about it and a history refusal into a message with exit status 1.
 */
async function ownerOnly(run: () => Promise<void>): Promise<void> {
  try {
    await run().catch(rethrowAsNotMember);
  } catch (error) {
    if (!(error instanceof PatternHistoryError)) throw error;
    console.error(error.message);
    Deno.exitCode = 1;
  }
}

export async function history(
  options: IndexCLIOptions,
  entry: string | undefined,
  { render: out = render, ...access }: IndexDeps = {},
): Promise<void> {
  await ownerOnly(async () => {
    const { client, sources } = await indexFor(options, access);
    if (entry === undefined) {
      const { lineages } = await client.listLineages();
      out(options.json ? lineages : lineageLines(lineages).join("\n"), {
        json: options.json,
      });
      return;
    }
    const { rows } = await entryHistory(client, absPath(entry), sources);
    out(options.json ? rows : historyLines(entry, rows).join("\n"), {
      json: options.json,
    });
  });
}

export async function rollback(
  options: IndexCLIOptions & { force?: boolean },
  entry: string,
  version: string,
  { render: out = render, ...access }: IndexDeps = {},
): Promise<void> {
  await ownerOnly(async () => {
    const { client, sources } = await indexFor(options, access);
    const report = await rollbackEntry(
      absPath(entry),
      version,
      { force: !!options.force },
      {
        client,
        sources,
        readFile: (path) => Deno.readFile(path),
        writeFile: (path, bytes) => Deno.writeFile(path, bytes),
      },
    );
    out(
      options.json ? report : rollbackLines(entry, report).join("\n"),
      { json: options.json },
    );
  });
}

/** What `cf pattern checkpoint` reaches; the real piece and index by default. */
export interface CheckpointDeps {
  readRunning?: typeof readRunningPattern;
  readTextFile?: (path: string) => Promise<string>;
  recordVersion?: (deployed: DeployedSource) => Promise<VersionOutcome>;
  render?: typeof render;
}

/**
 * `cf pattern checkpoint`: keeps what a piece runs now as a private version
 * of `entry`'s lineage, which the sharing setting may share once it settles,
 * as it may a deployed one. It deploys nothing, so a pattern made with
 * `--no-index-version` deploys is kept once a change is finished. Exits 1 when no version was kept, since the
 * person asked for one.
 */
export async function checkpoint(
  options: PieceCLIOptions & { json?: boolean },
  entry: string,
  {
    readRunning = readRunningPattern,
    readTextFile = (path) => Deno.readTextFile(path),
    recordVersion,
    render: out = render,
  }: CheckpointDeps = {},
): Promise<void> {
  const config = parsePieceOptions(options);
  const running: RunningPattern = await readRunning(config);
  // The entry names the lineage the version joins, so it must be the file
  // the piece runs, as it was deployed: another file, or this one edited
  // since, would file the piece's source under the wrong history.
  const runningMain = running.program.files.find((file) =>
    file.name === running.program.main
  );
  if (runningMain?.contents !== await readTextFile(absPath(entry))) {
    throw new ValidationError(
      `${entry} is not what the piece runs: deploy it first ` +
        `(cf piece setsrc), or name the entry file the piece was deployed from.`,
      { exitCode: 1 },
    );
  }
  const outcome = await (recordVersion ??
    ((deployed) => recordVersionInIndex(config.identity, deployed)))({
      entry: absPath(entry),
      program: running.program,
      patternId: () => Promise.resolve(running.patternId),
      piece: { space: running.space, id: running.id },
      // A piece following a system or repository pattern is not the
      // person's work, and keeps no version, as a deploy of it does not.
      ...(running.origin === undefined ? {} : { origin: running.origin }),
      // No keepPrivate: the sharing setting covers a checkpoint as it does a
      // deploy, and the index shares one only once it has settled.
    });
  if (options.json) {
    out(versionJson(outcome), { json: true });
  } else {
    out(checkpointLine(outcome));
  }
  if (outcome.status !== "recorded") Deno.exitCode = 1;
}

/** What a checkpoint came to, in one line; a version not kept says why. */
export const checkpointLine = (outcome: VersionOutcome): string => {
  switch (outcome.status) {
    case "recorded":
      return versionLine(outcome) ?? "";
    case "not-joined":
      return "No version kept: this machine has not joined a pattern index (cf index join).";
    case "skipped":
    case "failed":
      return `No version kept: ${outcome.reason}.`;
  }
};

export async function unshare(
  options: IndexCLIOptions,
  entry: string,
  { render: out = render, ...access }: IndexDeps = {},
): Promise<void> {
  await ownerOnly(async () => {
    const { client, sources } = await indexFor(options, access);
    const lineage = await lineageForEntry(client, absPath(entry), sources);
    if (lineage === undefined) {
      throw new PatternHistoryError(`No versions of ${entry} are kept.`);
    }
    const result = await client.unshareLineage({
      lineageId: lineage.lineageId,
    });
    out(
      options.json
        ? result
        : `${entry} is no longer listed or shared on its own. Anyone holding the id of a version already shared can still open it; cf pattern share shares it again.`,
      { json: options.json },
    );
  });
}

/** `cf pattern stable`: makes the newest shared version findable. */
export async function stable(
  options: IndexCLIOptions,
  entry: string,
  { render: out = render, ...access }: IndexDeps = {},
): Promise<void> {
  await ownerOnly(async () => {
    const { client, sources } = await indexFor(options, access);
    const lineage = await requireLineage(client, absPath(entry), sources);
    const report = await makeStable(client, lineage, entry);
    out(options.json ? report : stableLine(entry, report), {
      json: options.json,
    });
  });
}

/** `cf pattern link`: a link to the entry's stable, beta or numbered version. */
export async function link(
  options: IndexCLIOptions & { beta?: boolean; number?: number },
  entry: string,
  { render: out = render, ...access }: IndexDeps = {},
): Promise<void> {
  if (options.beta && options.number !== undefined) {
    throw new ValidationError("Pass --beta or --number, not both.");
  }
  const channel: LinkChannel = options.number ??
    (options.beta ? "beta" : "stable");
  await ownerOnly(async () => {
    const { client, sources } = await indexFor(options, access);
    const lineage = await requireLineage(client, absPath(entry), sources);
    const report = await patternLink(client, lineage, entry, channel);
    out(options.json ? report : linkLine(entry, lineage, report), {
      json: options.json,
    });
  });
}

export async function unpublish(
  options: IndexCLIOptions,
  entry: string,
  { render: out = render, ...access }: IndexDeps = {},
): Promise<void> {
  await ownerOnly(async () => {
    const { client, sources } = await indexFor(options, access);
    const lineage = await lineageForEntry(client, absPath(entry), sources);
    if (lineage === undefined) {
      throw new PatternHistoryError(`No versions of ${entry} are kept.`);
    }
    const result = await client.unpublishLineage({
      lineageId: lineage.lineageId,
    });
    out(
      options.json
        ? result
        : result.changed
        ? `${entry} is no longer shown under your name; it stays shared as ${lineage.pseudonym}. Anyone who already saw both knows they are the same.`
        : `${entry} was not published under your name.`,
      { json: options.json },
    );
  });
}

export async function mine(
  options: { identity?: string; patternIndexUrl?: string; json?: boolean },
  { render: out = render, fetchFn, store: given }: IndexDeps = {},
): Promise<void> {
  const signer = await loadIdentity(requireIdentityPath(options));
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  const store = storeFor(baseUrl, given);
  const client = await openPatternIndexClient({
    baseUrl,
    signer,
    fetchFn,
    store,
  });
  const { patterns } = await client.listPatterns({ mine: true }).catch(
    rethrowAsNotMember,
  );
  const rows = await mineRows(patterns, (id) => store.entryFor(id));
  out(options.json ? rows : mineLines(rows).join("\n"), {
    json: options.json,
  });
}

/** The options `share` and `publish` both take: what to share, and how. */
// deno-lint-ignore no-explicit-any
const shareOptions = (cmd: Command<any>) =>
  cmd
    .arguments("<entry:string>")
    .option(
      "--root <path:string>",
      "The program root its files are named against; as for cf piece new.",
    )
    .option(
      "--test <path:string>",
      "A test entry packaged with it, as for cf piece new. Repeatable; " +
        "pass the same ones the piece was deployed with, so the id matches.",
      { collect: true },
    )
    .option(
      "--datafile <path:string>",
      "A data file attached to it, as for cf piece new. Repeatable.",
      { collect: true },
    )
    .option(
      "--main-export <name:string>",
      "The export it runs, as for cf piece new.",
    )
    .option(
      "--description <text:string>",
      "What the pattern does, in place of its doc comment's first paragraph.",
    )
    .option(
      "--hashtags <tags:string>",
      "Comma-separated hashtags, in place of its doc comment's @hashtags.",
    )
    .option(
      "--keywords <words:string>",
      "Comma-separated keywords, in place of its doc comment's @keywords.",
    )
    .option(
      "--allow-dirty",
      "Apply a privacy rewrite over files with uncommitted edits; your source as it was is still kept as a version that cf pattern rollback restores.",
    )
    .option(
      "--skip-local-check",
      "Skip the local privacy check; the index still checks before listing.",
    )
    .option(
      "--remixed-from <patternId:string>",
      "The published pattern this one was built from, when cf has no record of it.",
    )
    .option(
      "--standalone",
      "Offer it to people choosing what to place, on its own at the top of a " +
        "loom. Without --standalone or --part, a new version keeps its " +
        "predecessor's answer, and a first version stands alone when its " +
        "entry file is main.tsx.",
      { conflicts: ["part"] },
    )
    .option(
      "--part",
      "Offer it only as a part other patterns build from, not on its own.",
      { conflicts: ["standalone"] },
    )
    .env(
      "CF_PATTERN_INDEX_URL=<url:string>",
      "Base URL of the pattern index.",
      { prefix: "CF_" },
    )
    .option(
      "--pattern-index-url <url:string>",
      "Base URL of the pattern index; the deployment's by default.",
    )
    .option("--json", "Print the report as JSON, for an agent to read.");

export const pattern = new Command()
  .name("pattern")
  .description(
    "Keep, share and publish patterns in the pattern index: each deploy " +
      "of your own pattern is kept as a private version, with history and " +
      "rollback.",
  )
  .default("help")
  /* pattern share */
  .command(
    "share",
    targetOptions(
      shareOptions(new Command())
        .description(
          "Share a pattern anonymously on beta: anyone with its link " +
            "(cf pattern link --beta) can reach it, under a pseudonym of this " +
            "pattern alone, never linked to your other patterns or your " +
            "name; cf pattern stable makes it findable. Join first with " +
            "cf index join. It " +
            "checks the pattern for personal details with the index's own " +
            "privacy question, and when it finds some, rewrites it into a " +
            "general version (specific values lifted into arguments). The " +
            "rewrite goes over your files when git can take it back, or " +
            "after your source is kept as a private version that " +
            "cf pattern rollback restores. The index checks it again " +
            "before others can see it.",
        )
        .example(
          cliText("cf pattern share ./bins.tsx"),
          "Check ./bins.tsx and share it anonymously.",
        ),
      { global: false },
    ).action((options, entry) => share(options, entry)),
  )
  /* pattern publish */
  .command(
    "publish",
    targetOptions(
      shareOptions(new Command())
        .description(
          "Publish a pattern under your name: shares it as cf pattern share " +
            "does but on stable, findable once checked, then shows one of your profiles as its author to every " +
            "member. Only this pattern is named; your other patterns stay " +
            "anonymous and unlinked. Says what it reveals, and names nothing " +
            "unless --as repeats the name it shows.",
        )
        .option(
          "--profile <space:string>",
          "The profile to publish under, by its space; the one #profile answers with by default.",
        )
        .option(
          "--as <name:string>",
          "The profile's name, repeated to confirm the person agreed to show it; nothing is named without it.",
        )
        .example(
          cliText('cf pattern publish ./bins.tsx --as "Sam Lee"'),
          "Share ./bins.tsx and name you as its author.",
        ),
      { global: false },
    ).action(publishNamed),
  )
  /* pattern history */
  .command(
    "history",
    indexAccessOptions(
      new Command()
        .description(
          "The versions the index keeps of a pattern you deploy: one for " +
            "each cf piece new or cf piece setsrc of it, and each " +
            "cf pattern checkpoint, private unless shared. Without an entry file, lists every pattern of yours " +
            "the index keeps. Only you can read them.",
        )
        .arguments("[entry:string]")
        .example(
          cliText("cf pattern history ./bins.tsx"),
          "List the kept versions of ./bins.tsx, newest first.",
        ),
    ).action(history),
  )
  /* pattern rollback */
  .command(
    "rollback",
    indexAccessOptions(
      new Command()
        .description(
          "Restore an earlier version of a pattern: the index keeps it as " +
            "the newest version, and its files are written back over the " +
            "entry's. Refuses when the files have edits no version keeps, " +
            "unless --force. Deploy it afterwards to update running pieces.",
        )
        .arguments("<entry:string> <version:string>")
        .option(
          "--force",
          "Write over edits that no version keeps; they are lost.",
        )
        .example(
          cliText("cf pattern rollback ./bins.tsx 3"),
          "Restore version 3 of ./bins.tsx.",
        ),
    ).action(rollback),
  )
  /* pattern checkpoint */
  .command(
    "checkpoint",
    targetOptions(
      new Command()
        .description(
          "Keep what a piece runs now as a private checkpoint in a " +
            "pattern's history, the version cf pattern rollback goes back " +
            "to. It deploys nothing, and is shared as a deploy is: by " +
            "cf pattern share, or by your sharing setting once it settles.",
        )
        .arguments("<entry:string>")
        .option(
          "-c,--cell, --piece <cell:string>",
          "The piece whose pattern to keep.",
        )
        .option("--json", "Print the outcome as JSON, for an agent to read.")
        .example(
          cliText("cf pattern checkpoint ./bins.tsx --cell <piece>"),
          "Keep the pattern <piece> runs as a private version of ./bins.tsx.",
        ),
      { global: false },
    ).action(checkpoint),
  )
  /* pattern unshare */
  .command(
    "unshare",
    indexAccessOptions(
      new Command()
        .description(
          "Stop sharing a pattern: it leaves others' searches and listings, " +
            "and no later version is shared until cf pattern share. A version " +
            "already shared stays readable by its id, so imports of it keep " +
            "working.",
        )
        .arguments("<entry:string>"),
    ).action(unshare),
  )
  /* pattern stable */
  .command(
    "stable",
    indexAccessOptions(
      new Command()
        .description(
          "Make a pattern's newest shared version stable: what search, the " +
            "catalog and a plain link give. It passed the privacy check when " +
            "it was shared on beta, so no new source is exposed; only who " +
            "can find it changes. One still being checked becomes stable " +
            "once it passes.",
        )
        .arguments("<entry:string>"),
    ).action(stable),
  )
  /* pattern link */
  .command(
    "link",
    indexAccessOptions(
      new Command()
        .description(
          "Print a link to a shared pattern: its stable version, or beta " +
            "when nothing is stable yet. A link names the pattern by its " +
            "pseudonym, and shows your name only on a pattern published " +
            "under it.",
        )
        .arguments("<entry:string>")
        .option("--beta", "Link to beta, the newest shared version.")
        .option(
          "--number <n:integer>",
          "Link to exactly shared version n, which never changes.",
        ),
    ).action(link),
  )
  /* pattern unpublish */
  .command(
    "unpublish",
    indexAccessOptions(
      new Command()
        .description(
          "Stop showing your name on a pattern you published. It stays " +
            "shared under its pseudonym; anyone who saw both already knows " +
            "they are the same.",
        )
        .arguments("<entry:string>"),
    ).action(unpublish),
  )
  /* pattern mine */
  .command(
    "mine",
    indexAccessOptions(
      new Command().description(
        "Your shared patterns, one per lineage: whether each is listed, " +
          "held (with the findings to fix) or still being checked, its " +
          "bucket and use counts, and what moves it on.",
      ),
    ).alias("ls").action(mine),
  );
