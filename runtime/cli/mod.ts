import { ValidationError } from "@cliffy/command";

import { parse } from "./commands/mod.ts";
import { cliName } from "./lib/cli-name.ts";
import { applyColorMode } from "./lib/color-mode.ts";
import { reservesStdoutForCommandOutput } from "./lib/json-output.ts";
import { applyLogLevel } from "./lib/log-level.ts";

/**
 * What a failure prints. Which error classes print how spans the modules of
 * every command, and a run loads only its own, so the classes load once one
 * fails. A `ValidationError` needs none of them: it is how a mistyped command
 * line ends.
 */
async function failureText(e: unknown): Promise<unknown> {
  if (e instanceof ValidationError) return e.message;
  // deno-lint-ignore cf-imports/no-inline-module-import
  const { renderCliError } = await import("./lib/cli-error.ts");
  return renderCliError(e);
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
  Deno.env.set("CF_CLI_NAME", cliName());
  const profileDoneMarker = Deno.env.get("CF_PROFILE_DONE_MARKER");

  const exit = deps.exit ?? Deno.exit;
  try {
    await (deps.parse ?? ((args) => parse(args, colorsEnabled)))(cleanArgs);
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
    console.error(await failureText(e));
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
