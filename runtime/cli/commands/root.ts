// deno-lint-ignore-file cf-imports/no-inline-module-import -- every command
// loads here only when a run addresses it, because `deno run` walks whatever a
// run imports before it starts and most of `cf`'s start is that walk. The
// launcher's `--unstable-lazy-dynamic-imports` is what stops the walk from
// following these; `deno compile` follows them, which is what embeds them.

/**
 * The root of the `cf` command tree, naming every top-level command without
 * loading it. A run loads only the command it addresses; the rest stand in as
 * entries that say what the root's help says about them.
 */

import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import ports from "@commonfabric/ports" with { type: "json" };

import { cliName, cliText } from "../lib/cli-name.ts";
import { reservesStdoutForCommandOutput } from "../lib/json-output.ts";

/**
 * A top-level command. `description` and `arguments` repeat what the command
 * itself declares, as the root's help prints them, so that printing that help
 * loads nothing. `main-command.serial.test.ts` holds the two equal.
 */
interface TopLevelCommand {
  readonly name: string;
  readonly description: string;
  readonly arguments?: string;

  // deno-lint-ignore no-explicit-any
  readonly load: () => Promise<Command<any>>;
}

export const TOP_LEVEL_COMMANDS: readonly TopLevelCommand[] = [
  {
    name: "acl",
    description: "Manage Access Control Lists for spaces.",
    load: async () => (await import("./acl.ts")).acl,
  },
  {
    name: "agent",
    description: "Run and inspect agent requests.",
    load: async () => (await import("./agent.ts")).agent,
  },
  {
    name: "ingest",
    description:
      "Mint and manage ingest channels — bearer-token endpoints that let a " +
      "device with no identity of its own durably append records to your " +
      "space.",
    load: async () => (await import("./ingest.ts")).ingest,
  },
  {
    name: "piece",
    description: "Interact with pieces running on a server.",
    load: async () => (await import("./piece.ts")).piece,
  },
  {
    name: "profile",
    description:
      "Your profile: create, locate, or repair its stored name protection; " +
      "or, as an operator, make every profile its space's root.",
    load: async () => (await import("./profile.ts")).profile,
  },
  {
    name: "cell",
    description: "Read and write cells, and the CFC labels on them.",
    load: async () => (await import("./cell.ts")).cell,
  },
  {
    name: "check",
    description: "Compile and execute patterns for debugging.",
    arguments: "<files...:string>",
    load: async () => (await import("./dev.ts")).check,
  },
  {
    name: "delegation",
    description:
      "Delegate a space to another key, and read the chains such a key holds.",
    load: async () => (await import("./delegation.ts")).delegation,
  },
  {
    name: "deps",
    description: "Manage fabric import dependencies.",
    load: async () => (await import("./deps.ts")).deps,
  },
  {
    name: "inspect",
    description:
      "Offline autopsy of local memory v2 space DBs (state, history, " +
      "convergence).",
    load: async () => (await import("./inspect.ts")).inspect,
  },
  {
    name: "space",
    description:
      "Commands that act on a space: its root and home patterns, access " +
      "invitations, and rehearsal clones of its store.",
    load: async () => (await import("./space.ts")).space,
  },
  {
    name: "view",
    description:
      "Interactive, syntax-aware pager for transformed patterns, source " +
      "files and diffs.",
    arguments: "[file:string]",
    load: async () => (await import("./view.ts")).view,
  },
  {
    name: "exec",
    description:
      "Execute a mounted callable file from a Common Fabric FUSE mount.",
    arguments: "<mountedFile:string> [tail...:string]",
    load: async () => (await import("./exec.ts")).exec,
  },
  {
    name: "fuse",
    description: "Mount Common Fabric spaces as a FUSE filesystem.",
    load: async () => (await import("./fuse.ts")).fuse,
  },
  {
    name: "fuse-daemon",
    description:
      "Internal: run the FUSE daemon directly (used by compiled binary).",
    load: async () => (await import("./fuse.ts")).fuseDaemon,
  },
  {
    name: "fuse-supervisor",
    description: "Internal: supervise a background FUSE child process.",
    load: async () => (await import("./fuse.ts")).fuseSupervisor,
  },
  {
    name: "completion",
    description: "Generate shell completion scripts.",
    load: async () => (await import("./completion.ts")).completion,
  },
  {
    name: "id",
    description: "Interact with common identites.",
    load: async () => (await import("./identity.ts")).identity,
  },
  {
    name: "init",
    description:
      "Initialize a TypeScript environment for evaluating patterns in " +
      "external tools.",
    load: async () => (await import("./init.ts")).init,
  },
  {
    name: "invocation-session",
    description:
      "Mint an invocation session: the caller identity that an invocation " +
      "id passed to `cf piece call` is chosen within. One per agent run.",
    load: async () =>
      (await import("./invocation-session.ts")).invocationSession,
  },
  {
    name: "sh",
    description: "Open shuttle, the interactive shell for fabric state.",
    load: async () => (await import("./sh.ts")).sh,
  },
  {
    name: "test",
    description: "Run pattern tests (.test.tsx files).",
    arguments: "<paths...:string>",
    load: async () =>
      (await import("./test-command.ts")).createTestCommand({
        recordResults: true,
      }),
  },
  {
    name: "wish",
    description:
      "Resolve a wish target headlessly and print its value (CT-1834).",
    arguments: "<target:string>",
    load: async () => (await import("./wish.ts")).wish,
  },
];

function envStatus(): string {
  const identity = Deno.env.get("CF_IDENTITY");
  const apiUrl = Deno.env.get("CF_API_URL");
  const space = Deno.env.get("CF_SPACE");
  if (!identity && !apiUrl && !space) return "";
  const lines: string[] = ["", "ENVIRONMENT:"];
  if (identity) {
    lines.push(`  CF_IDENTITY = ${identity} (set, no need to pass --identity)`);
  }
  if (apiUrl) {
    lines.push(`  CF_API_URL  = ${apiUrl} (set, no need to pass --api-url)`);
  }
  if (space) {
    // Named rather than promised generally: `ingest`, `fuse` and `check` take
    // a space and do not read this, so a blanket "no need to pass --space"
    // would be wrong exactly where a caller is most surprised to be asked.
    //
    // `space` is named by subcommand for the same reason: `recreate-root`
    // resolves the target space and refuses without one, while `clone`,
    // `verify`, `reset` and `fingerprint` each name their target themselves.
    // Declaring the option is not consuming it, which is the way an entry
    // here goes wrong without going missing.
    lines.push(
      `  CF_SPACE    = ${space} (set, no need to pass --space on cell, ` +
        `piece, wish, acl, deps, space recreate-root)`,
    );
  }
  return lines.join("\n");
}

function mainDescription(): string {
  return cliText(`Tool for running programs on common fabric.

QUICK START:
  cf check ./pattern.tsx            # Type-check and test locally
  cf piece new ./pattern.tsx ...    # Deploy to a space
  cf piece --help                   # Help for deployed patterns (with tips)

FIRST TIME SETUP:
  cf id new > claude.key            # Create identity key
  export CF_IDENTITY=./claude.key   # Set default identity
  export CF_API_URL=http://localhost:${ports.toolshed}  # Set default API URL
  export CF_SPACE=my-space          # Default space for cell, piece, wish, acl,
                                    # deps and space recreate-root
                                    # (--space overrides)

SHELL COMPLETION:
  source <(cf completion zsh)      # add to ~/.zshrc  (bash: completion bash)
  Completes commands and flags, plus live piece ids, callable names, and cell
  paths. Also completes 'deno task cf ...'. See 'cf completion --help'.

LOCAL DEVELOPMENT:
  ./scripts/start-local-dev.sh      # Start local servers
  ./scripts/stop-local-dev.sh       # Stop local servers
${envStatus()}
LOGGING:
  Warnings and errors are shown by default. Adjust with:
    cf --log-level info check ./pattern.tsx
    cf --log-level error check ./pattern.tsx   # quieter: errors only
    CF_LOG_LEVEL=debug cf piece ls
  Valid levels: debug, info, warn (default), error, silent

COLOR:
  ANSI colors are emitted only when stdout is a terminal. Override with
  --no-color or NO_COLOR=1 to disable, FORCE_COLOR=1 or CLICOLOR_FORCE=1 to
  force when piped.

Run 'cf <command> --help' for command-specific help.`);
}

/** A root that has a name, a version and help, and no other command. */
function emptyRoot() {
  return new Command()
    .name(cliName())
    .description(mainDescription())
    .version("0.0.1")
    .error((error, command) => {
      if (
        reservesStdoutForCommandOutput(command.getMainCommand().getRawArgs())
      ) {
        throw error;
      }
    })
    // Add global help subcommand to all commands
    // like `cf foo help` -- this is OK, but the most appealing
    // feature here is adding a "default" command when none are provided
    // as a way to display help text on a root command.
    .default("help")
    .command("help", new HelpCommand().global())
    // This reset is needed to satisfy the typechecker
    // because one of `.command()`'s overloads are not public
    // and cannot match. Still seeing IDE typing errors, but at least
    // deno checker is satisfied.
    .reset();
}

/**
 * What stands in for a command this run did not address. Reaching its action
 * means `addressedCommand()` missed what Cliffy resolved, so it fails rather
 * than do nothing.
 */
function standIn({ name, description, arguments: args }: TopLevelCommand) {
  const command = new Command().description(description);
  return (args === undefined ? command : command.arguments(args)).action(() => {
    throw new Error(`The \`${name}\` command was not loaded for this run.`);
  });
}

/**
 * The name of the top-level command `args` runs, or asks `help` about. The
 * root takes no option with a value, so its first word that is not an option
 * is a command.
 */
export function addressedCommand(args: readonly string[]): string | undefined {
  const words = args.filter((arg) => !arg.startsWith("-"));
  return words[0] === "help" ? words[1] : words[0];
}

/** The command tree for a run of `args`, with only what that run needs loaded. */
export async function rootCommandFor(args: readonly string[]) {
  const addressed = addressedCommand(args);
  const root = emptyRoot();
  for (const command of TOP_LEVEL_COMMANDS) {
    // Awaited in place, so that the commands keep their order in the help.
    root.command(
      command.name,
      command.name === addressed ? await command.load() : standIn(command),
    );
  }
  return root.reset();
}

/** The command tree with every command loaded, as a tool walking it needs it. */
export async function fullRootCommand() {
  const root = emptyRoot();
  for (const command of TOP_LEVEL_COMMANDS) {
    root.command(command.name, await command.load());
  }
  return root.reset();
}
