import { ValidationError } from "@cliffy/command";
import { CompilerError, TransformerError } from "@commonfabric/js-compiler";
import { SlugAssignedError } from "@commonfabric/piece";
import { SlugResolutionError } from "@commonfabric/runner";

import { main as rootCommand } from "./commands/main.ts";
import { parse } from "./commands/mod.ts";
import { VerbInputValidationError } from "./lib/callable.ts";
import { cliName } from "./lib/cli-name.ts";
import { applyColorMode } from "./lib/color-mode.ts";
import { IdentityKeyfileError } from "./lib/identity.ts";
import { reservesStdoutForCommandOutput } from "./lib/json-output.ts";
import { applyLogLevel } from "./lib/log-level.ts";

/**
 * The value to print for a top-level CLI failure. Validation, transformer,
 * compiler, verb-input, slug, and identity-keyfile errors carry user-facing
 * messages, so print those without a stack trace. Other Errors print their
 * stack, falling back to the message. Anything else prints as-is.
 */
export function renderCliError(e: unknown): unknown {
  if (
    e instanceof ValidationError || e instanceof TransformerError ||
    e instanceof CompilerError || e instanceof VerbInputValidationError ||
    e instanceof SlugResolutionError || e instanceof SlugAssignedError ||
    e instanceof IdentityKeyfileError
  ) {
    return e.message;
  }
  if (e instanceof Error) {
    return e.stack || e.message;
  }
  return e;
}

/** Injectable effects for testing how `main` ends the process. */
export interface MainDependencies {
  parse?: (args: string[]) => Promise<unknown>;
  exit?: (code: number) => void;
  /** The code the command left in `Deno.exitCode`; a test injects its own. */
  exitCode?: () => number;
}

export async function main(args: string[], deps: MainDependencies = {}) {
  // Extract --log-level and --no-color before Cliffy parses; apply the log
  // floor and the color policy (TTY detection, NO_COLOR, FORCE_COLOR).
  const { args: cleanArgs, enabled: colorsEnabled } = applyColorMode(
    applyLogLevel(args),
  );
  const reservedStdout = reservesStdoutForCommandOutput(cleanArgs);
  // Cliffy's help generator ignores the global color flag (it force-sets its
  // own `colors` option while rendering), so mirror the decision here. The
  // .reset() re-targets the builder chain at the root command (without it,
  // .help() lands on the last-registered subcommand); help settings inherit,
  // so the root covers every subcommand.
  rootCommand.reset().help({ colors: colorsEnabled });
  Deno.env.set("CF_CLI_NAME", cliName());
  const profileDoneMarker = Deno.env.get("CF_PROFILE_DONE_MARKER");

  const exit = deps.exit ?? Deno.exit;
  try {
    await (deps.parse ?? parse)(cleanArgs);
    if (profileDoneMarker) {
      (reservedStdout ? console.error : console.log)(profileDoneMarker);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A command can report a failure without throwing, by leaving a nonzero
    // `Deno.exitCode` — `piece setsrc` does, for a source that committed but
    // whose running refresh failed, so the receipt still prints and the
    // status still fails. An explicit `Deno.exit(0)` here would discard that
    // code, so end with whatever the command left.
    exit((deps.exitCode ?? (() => Deno.exitCode))());
  } catch (e) {
    console.error(renderCliError(e));
    if (profileDoneMarker) {
      (reservedStdout ? console.error : console.log)(profileDoneMarker);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    exit(e instanceof ValidationError ? e.exitCode : 1);
  }
}

if (import.meta.main) {
  main(Deno.args);
}
