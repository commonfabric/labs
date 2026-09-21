/**
 * `cf profile`: create, locate, or inspect and repair a person's profile. The create path is the CLI equivalent of
 * the shell's create form; `lib/profile.ts` says why a command may stand in
 * for that gesture.
 */

import { Command, ValidationError } from "@cliffy/command";

import { normalizeApiUrl } from "../lib/api-url.ts";
import { parseCellSelectionOptions } from "../lib/cell-selection.ts";
import { cliText } from "../lib/cli-name.ts";
import { getDidFromFile } from "../lib/identity.ts";
import { createProfile } from "../lib/profile.ts";
import { profileNameProtection } from "../lib/profile-name-protection.ts";
import { render } from "../lib/render.ts";
import { absPath } from "../lib/utils.ts";
import { projectWishValue, readWish } from "../lib/wish.ts";
import { setQuietMode } from "./piece.ts";

/** Options every `cf profile` subcommand receives (cliffy flags plus env). */
export interface ProfileCommandOptions {
  apiUrl?: string;
  identity?: string;
  quiet?: boolean;
  json?: boolean;
}

/** Injectable effects so the action bodies are unit-testable in-process. */
export interface ProfileCommandDeps {
  createProfile: typeof createProfile;
  readWish: typeof readWish;
}

const defaultDeps: ProfileCommandDeps = { createProfile, readWish };

/**
 * The connection `options` describe, with the identity's home space as the
 * target: a profile belongs to the home root, so no `--space` is offered.
 *
 * @throws ValidationError when the identity or the API URL is missing.
 */
async function connection(options: ProfileCommandOptions): Promise<{
  apiUrl: string;
  identity: string;
  space: string;
}> {
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
  return {
    apiUrl: normalizeApiUrl(options.apiUrl),
    identity,
    space: await getDidFromFile(identity),
  };
}

/** The `cf profile create <name>` action body. */
export async function profileCreateAction(
  options: ProfileCommandOptions,
  name: string,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("A profile needs a name.", { exitCode: 1 });
  }
  // The name is persisted as the profile's `initialName` and echoed to the
  // terminal; a control character in it would reach both.
  if (/\p{Cc}/u.test(trimmed)) {
    throw new ValidationError(
      "A profile name cannot contain control characters.",
      { exitCode: 1 },
    );
  }
  const created = await deps.createProfile({
    ...(await connection(options)),
    name: trimmed,
    jsonOutput: !!options.json,
  });
  if (options.json) {
    render(created, { json: true });
  } else {
    render(`Created profile "${created.name}" at ${created.address}`);
  }
}

/**
 * The `cf profile show` action body: the profile `#profile` resolves to,
 * as its address and display name, through the same headless read `cf wish`
 * performs.
 */
export async function profileShowAction(
  options: ProfileCommandOptions,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const selection = await parseCellSelectionOptions({ select: "@,name" });
  const { result, error } = await deps.readWish({
    ...(await connection(options)),
    query: "#profile",
    jsonOutput: true,
    ...(selection === undefined ? {} : { selection }),
  });
  if (error && result === null) {
    throw new ValidationError(`wish "#profile": ${error}`, { exitCode: 1 });
  }
  render(projectWishValue(result), { json: true });
}

/** Inspects a named profile, or applies the exact receipt the owner reviewed. */
export async function profileRepairNameProtectionAction(
  options: ProfileCommandOptions & {
    cell: string;
    apply?: boolean;
    expect?: string;
  },
  run: typeof profileNameProtection = profileNameProtection,
): Promise<void> {
  if (!!options.apply !== (options.expect !== undefined)) {
    throw new ValidationError(
      "Use --apply and --expect <inspection> together.",
      { exitCode: 1 },
    );
  }
  setQuietMode(!!options.quiet);
  const connectionConfig = await connection(options);
  render(
    await run({
      ...connectionConfig,
      cell: options.cell,
      expectedInspection: options.expect,
      jsonOutput: true,
    }),
    { json: true },
  );
}

/**
 * Connection flags shared by `cf profile` verbs. Create and show use the
 * identity's home space; repair takes the profile's explicit full address.
 */
// Typed as the other subcommand builders are: cliffy's `.command()` overloads
// take a `Command<any>`, and a builder returning the narrowed option type is
// refused by every one of them.
// deno-lint-ignore no-explicit-any
function connected(description: string): Command<any> {
  return new Command()
    .description(description)
    .env("CF_API_URL=<url:string>", "URL of the fabric server instance.", {
      prefix: "CF_",
    })
    .option("-a,--api-url <url:string>", "URL of the fabric server instance.")
    .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
      prefix: "CF_",
    })
    .option("-i,--identity <path:string>", "Path to an identity keyfile.")
    .option("-q,--quiet", "Suppress hints and next-step suggestions.")
    .option("--json", "Output machine-readable JSON.");
}

export const profile = new Command()
  .name("profile")
  .description(
    cliText(
      "Your profile: create, locate, or repair its stored name protection.",
    ),
  )
  .default("help")
  .command(
    "create",
    connected(
      cliText(
        `Create a profile named <name> in your home space.

The same act as the shell's create form: the profile is made by the home
pattern's own handler, in a space of its own, and appended to your profile
list. Prints the new profile's address.`,
      ),
    )
      .arguments("<name:string>")
      .example(
        cliText(`cf profile create "Ada Lovelace" -i ./ada.key -a <url>`),
        "Create a profile and print where it landed.",
      )
      .action(async (options: ProfileCommandOptions, name: string) => {
        await profileCreateAction(options, name);
      }),
  )
  .command(
    "show",
    connected(
      cliText(
        `Print the profile '#profile' resolves to, as JSON: its address and
its display name.`,
      ),
    )
      .example(
        cliText(`cf profile show -i ./ada.key -a <url>`),
        "Read the active profile's address and display name as JSON.",
      )
      .action(async (options: ProfileCommandOptions) => {
        await profileShowAction(options);
      }),
  )
  .command(
    "repair-name-protection",
    connected(
      "Inspect a profile's stored name protection, or apply its reviewed repair. Always prints JSON.",
    )
      .option(
        "--cell <address:string>",
        "Full profile address including its space DID.",
        { required: true },
      )
      .option(
        "--apply",
        "Accept the inspected name and persist its missing protection.",
      )
      .option(
        "--expect <inspection:string>",
        "Exact inspection receipt required with --apply.",
      )
      .action(
        async (
          options: ProfileCommandOptions & {
            cell: string;
            apply?: boolean;
            expect?: string;
          },
        ) => {
          await profileRepairNameProtectionAction(options);
        },
      ),
  );
