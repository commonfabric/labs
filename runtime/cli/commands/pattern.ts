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

/** What `cf pattern publish` takes beyond the target options. */
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

async function publish(
  options: PublishCLIOptions,
  entry: string,
): Promise<void> {
  const config = parseSpaceOptions(options);
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  const signer = await loadIdentity(config.identity);
  const client = await openPatternIndexClient({ baseUrl, signer });
  const pieces = await loadPieces(config);
  try {
    const runtime = pieces.runtime;
    const space = pieces.getSpace();
    const getClient = () => Promise.resolve(client);
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
            getClient,
          }),
        compileProgram: (program) =>
          compileProgram(runtime, space, program, getClient),
        client,
        generate: toolshedGenerator(config.apiUrl),
        modelLabel: config.apiUrl,
        uncommitted: gitUncommitted,
        readTextFile: (path) => Deno.readTextFile(path),
        writeTextFile: (path, contents) => Deno.writeTextFile(path, contents),
        store: new PatternIndexStore(patternIndexStoreDir(baseUrl)),
      },
    );
    render(
      options.json ? report : publishReportLines(report).join("\n"),
      { json: options.json },
    );
    if (report.outcome === "blocked") Deno.exitCode = 1;
  } finally {
    await pieces.dispose();
  }
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

export const pattern = new Command()
  .name("pattern")
  .description(
    "Publish patterns to the pattern index, and see where yours stand.",
  )
  .default("help")
  /* pattern publish */
  .command(
    "publish",
    targetOptions(
      new Command()
        .description(
          "Publish a pattern to the pattern index and ask for it to be " +
            "listed; join first with cf index join. It checks the pattern " +
            "for personal details with the index's own privacy question, " +
            "and when it finds some, rewrites it into a general version " +
            "(specific values lifted into arguments), writing the rewrite " +
            "over your files only when they are committed, so git diff " +
            "shows it. Exits 1, publishing nothing, when it cannot.",
        )
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
          "Apply a privacy rewrite even over files with uncommitted edits.",
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
        .option("--json", "Print the report as JSON, for an agent to read.")
        .example(
          cliText("cf pattern publish ./bins.tsx"),
          "Check, publish and request a listing for ./bins.tsx.",
        ),
      { global: false },
    ).action(publish),
  )
  /* pattern mine */
  .command(
    "mine",
    indexAccessOptions(
      new Command().description(
        "Your published patterns, one per lineage: whether each is listed, " +
          "held (with the findings to fix) or still being checked, its " +
          "bucket and use counts, and what moves it on.",
      ),
    ).alias("ls").action(mine),
  );
