import { Command } from "@cliffy/command";
import { basename, dirname } from "@std/path";
import { LLMClient } from "@commonfabric/llm";
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
  PatternHistoryError,
  rollbackEntry,
  rollbackLines,
} from "../lib/pattern-history.ts";
import { entrySlot, lineageForEntry } from "../lib/pattern-versions.ts";
import {
  chooseProfile,
  NamingError,
  namingWarning,
  profileProof,
} from "../lib/pattern-named.ts";
import { listProfiles } from "../lib/profile.ts";
import type { DIDKey } from "@commonfabric/identity";
import type { PatternIndexClient } from "@commonfabric/pattern-index/client";
import {
  publishPatternFromDisk,
  publishReportLines,
} from "../lib/pattern-publish.ts";
import { loadPieces } from "../lib/piece.ts";
import { render } from "../lib/render.ts";
import { absPath } from "../lib/utils.ts";
import {
  indexAccessOptions,
  requireIdentityPath,
  rethrowAsNotMember,
} from "./pattern-index.ts";
import {
  parseSpaceOptions,
  type PieceCLIOptions,
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
  yes?: boolean;
}

/**
 * Checks and shares `entry`, printing the report; with `naming`, then names
 * its lineage under that profile when the share went through.
 */
async function share(
  options: PublishCLIOptions,
  entry: string,
  naming?: (
    client: PatternIndexClient,
    signer: DIDKey,
  ) => Promise<string>,
): Promise<void> {
  const config = parseSpaceOptions(options);
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  const signer = await loadIdentity(config.identity);
  const client = await openPatternIndexClient({ baseUrl, signer });
  const pieces = await loadPieces(config);
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
        slot: await entrySlot(absPath(entry)),
        skipLocalCheck: !!options.skipLocalCheck,
        ...(options.remixedFrom === undefined
          ? {}
          : { remixedFrom: options.remixedFrom }),
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
        uncommitted: gitUncommitted,
        readTextFile: (path) => Deno.readTextFile(path),
        writeTextFile: (path, contents) => Deno.writeTextFile(path, contents),
        store: new PatternIndexStore(patternIndexStoreDir(baseUrl)),
      },
    );
    const named = naming !== undefined && report.outcome === "shared"
      ? await naming(client, signer.did())
      : undefined;
    render(
      options.json
        ? { ...report, ...(named === undefined ? {} : { named }) }
        : [
          ...publishReportLines(report),
          ...(named === undefined ? [] : [named]),
        ]
          .join("\n"),
      { json: options.json },
    );
    if (report.outcome === "blocked") Deno.exitCode = 1;
  } finally {
    await pieces.dispose();
  }
}

/**
 * `cf pattern publish`: shares `entry` as `share` does, then names the
 * person as its author under one of their profiles. Says what that reveals
 * first, and names nothing without `--yes`.
 */
async function publishNamed(
  options: NamedPublishCLIOptions,
  entry: string,
): Promise<void> {
  const config = parseSpaceOptions(options);
  const identity = await loadIdentity(config.identity);
  const profiles = await listProfiles({ ...config, space: identity.did() });
  let chosen;
  try {
    chosen = chooseProfile(profiles, options.profile);
  } catch (error) {
    if (!(error instanceof NamingError)) throw error;
    console.error(error.message);
    Deno.exitCode = 1;
    return;
  }
  console.error(namingWarning(chosen.name));
  if (!options.yes) {
    console.error(
      `Nothing was published. Pass --yes to publish ${entry} under "${chosen.name}".`,
    );
    Deno.exitCode = 1;
    return;
  }
  const delegations = await recordedDelegations(config, chosen.space);
  await share(options, entry, async (client, signer) => {
    const lineage = await lineageForEntry(client, absPath(entry));
    if (lineage === undefined) {
      return `Not published under your name: the index keeps no versions of ${entry}.`;
    }
    const profile = {
      space: chosen.space,
      piece: chosen.id,
      displayName: chosen.name,
      delegations,
    };
    const { published } = await client.publishLineage({
      lineageId: lineage.lineageId,
      profile: { space: profile.space, piece: profile.piece },
      displayName: profile.displayName,
      profileProof: await profileProof(profile, signer),
    });
    return `Published under "${published.displayName}"; cf pattern unpublish ${entry} stops showing it.`;
  });
}

/** The delegations Home records over the profile space `space`. */
async function recordedDelegations(
  config: ReturnType<typeof parseSpaceOptions>,
  space: string,
): Promise<Uint8Array[]> {
  const pieces = await loadPieces(config);
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

/** The client and store for the index `options` names, signing as its identity. */
async function indexFor(options: IndexCLIOptions) {
  const signer = await loadIdentity(requireIdentityPath(options));
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  return await openPatternIndexClient({ baseUrl, signer });
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

async function history(
  options: IndexCLIOptions,
  entry: string | undefined,
): Promise<void> {
  await ownerOnly(async () => {
    const client = await indexFor(options);
    if (entry === undefined) {
      const { lineages } = await client.listLineages();
      render(options.json ? lineages : lineageLines(lineages).join("\n"), {
        json: options.json,
      });
      return;
    }
    const { rows } = await entryHistory(client, absPath(entry));
    render(options.json ? rows : historyLines(entry, rows).join("\n"), {
      json: options.json,
    });
  });
}

async function rollback(
  options: IndexCLIOptions & { force?: boolean },
  entry: string,
  version: string,
): Promise<void> {
  await ownerOnly(async () => {
    const report = await rollbackEntry(
      absPath(entry),
      version,
      { force: !!options.force },
      {
        client: await indexFor(options),
        readTextFile: (path) => Deno.readTextFile(path),
        writeTextFile: (path, contents) => Deno.writeTextFile(path, contents),
      },
    );
    render(
      options.json ? report : rollbackLines(entry, report).join("\n"),
      { json: options.json },
    );
  });
}

async function unpublish(
  options: IndexCLIOptions,
  entry: string,
): Promise<void> {
  await ownerOnly(async () => {
    const client = await indexFor(options);
    const lineage = await lineageForEntry(client, absPath(entry));
    if (lineage === undefined) {
      throw new PatternHistoryError(`No versions of ${entry} are kept.`);
    }
    const result = await client.unpublishLineage({
      lineageId: lineage.lineageId,
    });
    render(
      options.json
        ? result
        : result.changed
        ? `${entry} is no longer shown under your name; it stays shared as ${lineage.pseudonym}. Anyone who already saw both knows they are the same.`
        : `${entry} was not published under your name.`,
      { json: options.json },
    );
  });
}

async function mine(
  options: { identity?: string; patternIndexUrl?: string; json?: boolean },
): Promise<void> {
  const signer = await loadIdentity(requireIdentityPath(options));
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  const client = await openPatternIndexClient({ baseUrl, signer });
  const store = new PatternIndexStore(patternIndexStoreDir(baseUrl));
  const { patterns } = await client.listPatterns({ mine: true }).catch(
    rethrowAsNotMember,
  );
  const rows = await mineRows(patterns, (id) => store.entryFor(id));
  render(options.json ? rows : mineLines(rows).join("\n"), {
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
      "Apply a privacy rewrite over files with uncommitted edits, keeping no version of them first.",
    )
    .option(
      "--skip-local-check",
      "Skip the local privacy check; the index still checks before listing.",
    )
    .option(
      "--remixed-from <patternId:string>",
      "The published pattern this one was built from, when cf has no record of it.",
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
    "Keep, share and publish patterns in the pattern index: every deploy " +
      "is kept as a private version, with history and rollback.",
  )
  .default("help")
  /* pattern share */
  .command(
    "share",
    targetOptions(
      shareOptions(new Command())
        .description(
          "Share a pattern anonymously: others who share see it under a " +
            "pseudonym of this pattern alone, never linked to your other " +
            "patterns or your name. Join first with cf index join. It " +
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
            "does, then shows one of your profiles as its author to every " +
            "member. Only this pattern is named; your other patterns stay " +
            "anonymous and unlinked. Says what it reveals and names nothing " +
            "without --yes.",
        )
        .option(
          "--profile <space:string>",
          "The profile to publish under, by its space; the one #profile answers with by default.",
        )
        .option("--yes", "Publish under your name, having read what it shows.")
        .example(
          cliText("cf pattern publish ./bins.tsx --yes"),
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
            "each cf piece new or cf piece setsrc of it, private unless " +
            "shared. Without an entry file, lists every pattern of yours " +
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
