import { Command, ValidationError } from "@cliffy/command";
import { type DID, isDID } from "@commonfabric/identity/did";
import { parseCellPath } from "@commonfabric/runner";
import { normalizeApiUrl } from "../lib/api-url.ts";
import { cliText } from "../lib/cli-name.ts";
import { refuseSectionMarker } from "../lib/section-marker.ts";
import { render } from "../lib/render.ts";
import { getDidFromFile } from "../lib/identity.ts";
import { absPath } from "../lib/utils.ts";
import { setQuietMode } from "./piece.ts";
import { projectWishValue, readWish } from "../lib/wish.ts";
import {
  type CellSelection,
  CellSelectionError,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";

/** Options the `cf wish` action receives (cliffy-parsed flags + env). */
export interface WishCommandOptions {
  apiUrl?: string;
  identity?: string;
  space?: string;
  path?: string;
  scope?: string[];
  quiet?: boolean;
  allowEmpty?: boolean;
  json?: boolean;
  filter?: string;
  select?: string;
  schema?: string;
}

/** Injectable effects so the action body is unit-testable in-process. */
export interface WishCommandDeps {
  readWish: typeof readWish;
  exit: (code: number) => void;
}

/**
 * Narrow `--scope` values to what the wish builtin accepts ("~" | "." |
 * "profile" | space DID), rejecting anything else up front instead of casting.
 */
export function parseScopeFlags(
  values: string[] | undefined,
): (DID | "~" | "." | "profile")[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((value) => {
    if (value === "~" || value === "." || value === "profile") return value;
    if (isDID(value)) return value;
    throw new ValidationError(
      `Invalid --scope "${value}". Expected "~", ".", "profile", or a space DID.`,
      { exitCode: 1 },
    );
  });
}

/**
 * The `cf wish` action body, extracted so tests can drive it with a stubbed
 * {@link readWish} / exit (same in-process idiom as test/inspect-remote).
 */
export async function wishAction(
  options: WishCommandOptions,
  target: string,
  deps: WishCommandDeps = { readWish, exit: Deno.exit },
): Promise<void> {
  setQuietMode(!!options.quiet);

  if (!options.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  if (!options.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }

  const identity = absPath(options.identity);
  // Profile / home targets resolve against the identity's own home space, so a
  // space is optional. Default to the identity's DID (its home space) so
  // `cf wish '#profile'` works with just an identity.
  const space = options.space ?? (await getDidFromFile(identity));

  const path = options.path ? parseCellPath(options.path).map(String) : [];
  const scope = parseScopeFlags(options.scope);
  // Read before the wish is issued: a malformed selection is a fact about the
  // flags, so it is reported without a resolution having been attempted. The
  // same grammar and the same messages `cf cell get` and `cf piece call`
  // report, because it is the same parser.
  // Through the command's own exit seam rather than `exitWithDataError`, whose
  // `exit` is typed `never`: this command's seam returns, because its unit
  // tests inject a non-terminating exit and go on to read what was written. A
  // direct `Deno.exit` here would take the test runner — or an embedder — down
  // with it.
  const exitSelectionError = (message: string): void => {
    console.error(message);
    deps.exit(1);
  };

  let selection: CellSelection | undefined;
  try {
    selection = await parseCellSelectionOptions(options);
  } catch (error) {
    if (error instanceof CellSelectionError) {
      exitSelectionError(error.message);
      return; // Reached only when a test injects a non-terminating exit.
    }
    throw error;
  }

  let result: unknown;
  let error: string | undefined;
  try {
    ({ result, error } = await deps.readWish({
      apiUrl: normalizeApiUrl(options.apiUrl),
      space,
      identity,
      query: target,
      path,
      scope,
      jsonOutput: true,
      ...(selection === undefined ? {} : { selection }),
    }));
  } catch (thrown) {
    // A selection that does not fit what the wish resolved to — a `--filter`
    // over a non-array, a projection that kept nothing — is a data error about
    // the target in hand, not a usage error about the command line.
    if (thrown instanceof CellSelectionError) {
      exitSelectionError(thrown.message);
      return; // Reached only when a test injects a non-terminating exit.
    }
    throw thrown;
  }

  if (error && result === null && !options.allowEmpty) {
    console.error(`wish "${target}": ${error}`);
    deps.exit(1);
    return; // Reached only when a test injects a non-terminating exit.
  }

  // Project away stream/cell handles before serializing. An object target
  // (#profile) otherwise drags its pattern's stream handles — and through them
  // the whole runtime object graph — into JSON (~50KB of noise). Scalar targets
  // (#profileName etc.) and the null / --allow-empty result pass through
  // unchanged. See projectWishValue (CT-1844).
  render(projectWishValue(result), { json: true });
}

const description = cliText(
  `Resolve a wish target headlessly and print its value (CT-1834).

The blessed, non-interactive read path for wish targets. It resolves through the
SAME runtime builtin patterns use ('wish'), driven headless so no suggestion or
profile-picker UI ever spins up — resolution (default → MRU → first, with
runtime-enforced labels at read time) lives in the builtin and is never
re-implemented here. Use it for the cases that "cannot wish": offline profile
caches demoting to witness/echo, agents, and scripts.

PROFILE TARGETS (resolve against the IDENTITY's home space; '--space' optional):
  #profile        The viewer's active profile object (default → MRU → first)
  #profileName    Its live display name
  #profileAvatar  Its avatar
  #profileBio     Its owner-authored bio
  #profileSpace   Its own space cell

OTHER TARGETS (space-relative; pass '--space'):
  #favorites  #journal  #learned  #mentionable  /  #pieceRegistry  …

ZERO-PROFILE: when no profile exists yet, the wish surfaces an error; this
command prints it to stderr and exits non-zero (use --allow-empty to instead
print 'null' on stdout and exit 0).`,
);

export const wish = new Command()
  .name("wish")
  .description(description)
  .env("CF_API_URL=<url:string>", "URL of the fabric server instance.", {
    prefix: "CF_",
  })
  .option("-a,--api-url <url:string>", "URL of the fabric server instance.")
  .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .option("-i,--identity <path:string>", "Path to an identity keyfile.")
  .env("CF_SPACE=<space:string>", "The space name or DID.", {
    prefix: "CF_",
  })
  .option(
    "-s,--space <space:string>",
    "Space name or DID to connect to, overriding CF_SPACE. Falls back to " +
      "CF_SPACE, then to the identity's home space (where profile targets " +
      "resolve regardless).",
  )
  .option(
    "-p,--path <path:string>",
    "Extra path appended to the resolved target, e.g. 'avatar' or 'a/b/0'.",
  )
  .option(
    "--scope <scope:string>",
    "Hashtag search scope: '~' (favorites), '.' (current space), 'profile', " +
      "or a space DID. Repeatable.",
    { collect: true },
  )
  .option(
    "-q,--quiet",
    "Suppress hints and next-step suggestions.",
  )
  .option(
    "--allow-empty",
    "On an empty/failed wish, print 'null' and exit 0 instead of erroring.",
  )
  .option(
    "--json",
    "Select JSON output explicitly. This command always outputs JSON.",
  )
  .option(
    "--filter <predicate:string>",
    "Filter an array with a jq-inspired predicate",
  )
  .option(
    "--select <fields:string>",
    "Project output to comma-separated field paths; a trailing @ asks for a " +
      "position's address, and @ alone for the resolved target's own",
  )
  .option(
    "--schema <schema:string>",
    "Project output with an inline JSON Schema, @file, or the --select " +
      "field list",
    // Both flags carry the one projection, so a command naming both has not
    // said which shape it wants. Refuse before the wish rather than pick.
    { conflicts: ["select"] },
  )
  .example(
    cliText(`cf wish '#profile' -i ./claude.key`),
    "Read the viewer's active profile object as JSON.",
  )
  .example(
    cliText(`cf wish '#profileName' -i ./claude.key`),
    "Read just the active profile's display name.",
  )
  .example(
    cliText(`cf wish '#mentionable' -i ./claude.key -s my-space`),
    "Read a space-relative target (needs an explicit --space).",
  )
  .example(
    cliText(`cf wish '#profile' -i ./claude.key --select name,avatar`),
    "Project the resolved target to selected fields.",
  )
  .example(
    cliText(`cf wish '#profile' -i ./claude.key --select '@'`),
    "Return the resolved target's address instead of its contents.",
  )
  .arguments("<target:string>")
  .action(async function (options, target) {
    // `wish` reads a target directly, so it has no callable section and no
    // marker to close one. See lib/section-marker.ts.
    refuseSectionMarker("wish", this.getRawArgs());
    await wishAction(options, target);
  });
