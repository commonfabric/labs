import { Command, ValidationError } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import ports from "@commonfabric/ports" with { type: "json" };

import { cliName, cliText } from "../lib/cli-name.ts";
import {
  hasJsonArgument,
  reservesStdoutForCommandOutput,
} from "../lib/json-output.ts";
import { acl } from "./acl.ts";
import { agent } from "./agent.ts";
import { completion } from "./completion.ts";
import { deps } from "./deps.ts";
import { check } from "./dev.ts";
import { exec } from "./exec.ts";
import { fuse } from "./fuse.ts";
import { identity } from "./identity.ts";
import { ingest } from "./ingest.ts";
import { init } from "./init.ts";
import { inspect } from "./inspect.ts";
import { invocationSession } from "./invocation-session.ts";
import { cell } from "./cell.ts";
import { piece, pieceDataCommand } from "./piece.ts";
import { profile } from "./profile.ts";
import { space } from "./space.ts";
import { sh } from "./sh.ts";
import { createTestCommand } from "./test-command.ts";
import { view } from "./view.ts";
import { wish } from "./wish.ts";

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
    // `space` is named by subcommand for the same reason, and by the one
    // subcommand rather than by two: `recreate-root` resolves the target space
    // and refuses without one, while `clone`, `verify`, `reset` and
    // `fingerprint` each name their target themselves, and `set-home` acts on
    // the identity's own home space — it declares the option through the
    // shared target flags and never reads it. Declaring is not consuming,
    // which is the way an entry here goes wrong without going missing.
    lines.push(
      `  CF_SPACE    = ${space} (set, no need to pass --space on cell, ` +
        `piece, wish, acl, deps, space recreate-root)`,
    );
  }
  return lines.join("\n");
}

const mainDescription = cliText(`Tool for running programs on common fabric.

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

export const main = new Command()
  .name(cliName())
  .description(mainDescription)
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
  .reset()
  // @ts-ignore for the above type issue
  .command("acl", acl)
  .command("agent", agent)
  .command("ingest", ingest)
  // @ts-ignore for the above type issue
  .command("piece", piece)
  .command("profile", profile)
  // @ts-ignore for the above type issue
  .command("cell", cell)
  .command("check", check)
  .command("deps", deps)
  // @ts-ignore for the above type issue
  .command("inspect", inspect)
  // @ts-ignore for the above type issue
  .command("space", space)
  .command("view", view)
  .command("exec", exec)
  // @ts-ignore for the above type issue
  .command("fuse", fuse)
  .command(
    "fuse-daemon",
    new Command()
      .description(
        "Internal: run the FUSE daemon directly (used by compiled binary).",
      )
      .usage("<mountpoint> [options]")
      .useRawArgs()
      .action(async function (_options: unknown, ...rawArgs: unknown[]) {
        const daemonArgs = rawArgs.map((arg) => String(arg));
        if (hasJsonArgument(daemonArgs)) {
          throw new ValidationError('Unknown option "--json".');
        }
        if (
          daemonArgs.length === 1 &&
          (daemonArgs[0] === "--help" || daemonArgs[0] === "-h")
        ) {
          this.showHelp();
          return;
        }
        // The FUSE module graph is large and only the mount subcommands
        // reach it, so every other `cf` invocation skips loading it.
        // deno-lint-ignore cf-imports/no-inline-module-import
        const { main } = await import("@commonfabric/fuse");
        await main(daemonArgs);
      }),
  )
  .command(
    "fuse-supervisor",
    new Command()
      .description(
        "Internal: supervise a background FUSE child process.",
      )
      .usage("<mountpoint> [options]")
      // The supervisor argv is parsed once, by the same parser the deno
      // entrypoint uses, so the compiled binary and `deno run` accept exactly
      // the same flags.
      .useRawArgs()
      .action(async (_options: unknown, ...rawArgs: unknown[]) => {
        const supervisorArgs = rawArgs.map((arg) => String(arg));
        // The flag parser sits in the FUSE module graph, which the other
        // subcommands do not load.
        // deno-lint-ignore cf-imports/no-inline-module-import
        const { parseSupervisorArgs, supervisorHelp } = await import(
          "../lib/fuse-mount-flags.ts"
        );
        let parsed;
        try {
          parsed = parseSupervisorArgs(supervisorArgs);
        } catch (error) {
          throw new ValidationError(
            error instanceof Error ? error.message : String(error),
          );
        }
        if (parsed.help) {
          console.log(supervisorHelp());
          return;
        }
        // The supervisor sits in the FUSE module graph, which the other
        // subcommands do not load.
        // deno-lint-ignore cf-imports/no-inline-module-import
        const { runFuseSupervisor } = await import(
          "../lib/fuse-supervisor.ts"
        );
        await runFuseSupervisor(parsed.options);
      }),
  )
  .command("completion", completion)
  .command("id", identity)
  .command("init", init)
  .command("invocation-session", invocationSession)
  .command("sh", sh)
  .command("test", createTestCommand({ recordResults: true }))
  .command("wish", wish)
  // The superseded top-level spellings of the data commands. Each is the one
  // definition its blessed mount uses, reached under the noun it acts on --
  // `cf cell get`, `cf cell set`, `cf piece call` -- and kept here, hidden,
  // so a caller who learned the top-level spelling still works.
  // @ts-ignore for the above type issue
  .command(
    "get",
    pieceDataCommand("get", { replacedBy: "cell get" }).hidden(),
  )
  // @ts-ignore for the above type issue
  .command(
    "set",
    pieceDataCommand("set", { replacedBy: "cell set" }).hidden(),
  )
  // @ts-ignore for the above type issue
  .command(
    "call",
    pieceDataCommand("call", { replacedBy: "piece call" }).hidden(),
  );
