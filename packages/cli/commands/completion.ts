/**
 * `cf completion` — shell completion scripts and the callback that feeds them.
 *
 * Cliffy ships a `CompletionsCommand`, but its dynamic hook passes the
 * completion callback only `(command, parent)`: no cursor word, and no access
 * to the options already typed. That is enough for a static command tree and
 * nothing more — it cannot answer "the callables of the piece named by the
 * `--cell` on this line". Since the values worth completing in cf are exactly
 * those context-dependent ones (piece ids, callables, cell paths), this command
 * emits its own thin shell functions that forward the whole line instead.
 */

import { Command } from "@cliffy/command";
import { cliName } from "../lib/cli-name.ts";
import {
  bashCompletionScript,
  zshCompletionScript,
} from "../lib/completion/script.ts";
import { complete, tokenizeLine } from "../lib/completion/mod.ts";
import {
  missingCommandWarning,
  resolvesOnPath,
} from "../lib/completion/install-check.ts";

const description = `Generate shell completion scripts.

Completion covers the command tree and, when the line names a reachable space,
live values: piece ids annotated with their names, a piece's callables, cell
paths walked a segment at a time, and locally known spaces.

Live values need an identity and api-url, taken from the line being typed
(-i/-a/-u) or from CF_IDENTITY/CF_API_URL. Without them the command tree still
completes.

These also complete "deno task ${cliName()} ..." — see DENO TASK below.

REQUIRES '${cliName()}' ON PATH:
  The installed function calls '${cliName()} completion complete' on every Tab,
  and swallows its errors, so without a '${cliName()}' on PATH completion
  silently yields nothing — including for "deno task ${cliName()} <TAB>".
  Put one there once with 'deno task install-cf'.
  See "Installing ${cliName()} on PATH" in packages/cli/README.md.

INSTALL (zsh), in ~/.zshrc after compinit:
  source <(${cliName()} completion zsh)

INSTALL (bash), in ~/.bashrc:
  source <(${cliName()} completion bash)
  # or system-wide:
  ${cliName()} completion bash > /usr/local/etc/bash_completion.d/${cliName()}

DENO TASK:
  The scripts bind 'deno' as well as '${cliName()}', so "deno task ${cliName()} ..."
  completes too. A deno line that is not a ${cliName()} invocation is handed back
  to deno's own completion. Use --no-deno-task to bind only ${cliName()}.

  This binding needs the script evaluated, not just autoloadable. Installing
  the zsh script into fpath instead ('completion zsh > "\${fpath[1]}/_${cliName()}"')
  completes ${cliName()} itself, but the deno binding waits until ${cliName()} completes
  once. To keep that layout, add after compinit:
    _${cliName()}_deno_previous="\${_comps[deno]:-}"
    compdef _${cliName()} deno

The scripts forward the command line to '${cliName()} completion complete',
so they keep working as commands are added — reinstall only if this CLI moves.`;

/**
 * The callback the installed shell function invokes on every Tab.
 *
 * Accepts either shape of input: zsh forwards its own tokenized `words` with
 * `--cword`, bash forwards the raw buffer with `--line`/`--point` (its own
 * word-splitting mangles `:` and `=`, which cf values are full of).
 */
export interface CompleteRequest {
  readonly shell: "bash" | "zsh";
  readonly words: string[];
  readonly cword: number;
}

/**
 * Parse the callback's arguments by hand.
 *
 * Deliberately not Cliffy options: this command's stdout is a data channel a
 * shell reads on every keystroke, and Cliffy answers a malformed invocation by
 * printing usage text to stdout — which the shell would then offer as
 * completion candidates ("Usage:", "-h, --help", ...). Raw args mean no input,
 * however mangled, can put anything on stdout but candidates. An empty
 * `--line` is a value here, not the missing-value error Cliffy reports.
 */
export function parseCompleteRequest(args: readonly string[]): CompleteRequest {
  let shell: "bash" | "zsh" = "bash";
  let line: string | undefined;
  let point: number | undefined;
  let cword: number | undefined;
  const words: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--shell") shell = args[++i] === "zsh" ? "zsh" : "bash";
    else if (arg === "--line") line = args[++i] ?? "";
    else if (arg === "--point") point = Number(args[++i]);
    else if (arg === "--cword") cword = Number(args[++i]);
    else if (arg === "--") {
      for (const word of args.slice(i + 1)) words.push(word);
      break;
    } else if (!arg.startsWith("-")) words.push(arg);
  }

  if (line !== undefined) {
    const offset = Number.isFinite(point) ? point as number : line.length;
    return { shell, ...tokenizeLine(line, offset) };
  }
  return {
    shell,
    words,
    cword: Number.isFinite(cword)
      ? cword as number
      : Math.max(0, words.length - 1),
  };
}

const completeCommand = new Command()
  .description("Internal: emit completion candidates for a command line.")
  .usage(
    "[--shell <shell>] [--cword <n> -- <words...>] [--line <line> --point <n>]",
  )
  .useRawArgs()
  .action(async (_options: unknown, ...rawArgs: unknown[]) => {
    try {
      const request = parseCompleteRequest(rawArgs.map(String));

      // Resolved lazily: importing the root command pulls in the whole command
      // tree, and doing it inside the guard keeps a failure silent.
      // deno-lint-ignore cf-imports/no-inline-module-import
      const { main } = await import("./main.ts");

      const lines = await complete(
        main,
        request.words,
        request.cword,
        request.shell,
      );
      if (lines.length > 0) console.log(lines.join("\n"));
    } catch {
      // A completion request runs mid-keystroke. Anything unexpected yields no
      // candidates rather than text pasted into the user's command line.
    }
  });

/**
 * Warn on stderr when the generated script cannot reach the CLI it calls.
 *
 * stderr specifically: stdout is the script, and these commands are meant to be
 * redirected into a file or `source <(…)`. A warning on stdout would be
 * installed as shell code.
 */
function warnIfNotInstalled(name: string): void {
  if (!resolvesOnPath(name)) {
    console.error(missingCommandWarning(name));
  }
}

export const completion = new Command()
  .description(description)
  .default("help")
  .command(
    "bash",
    new Command()
      .description("Output the bash completion script.")
      .option(
        "--no-deno-task",
        `Do not also complete "deno task ${cliName()} ...".`,
      )
      .noGlobals()
      .action((options) => {
        warnIfNotInstalled(cliName());
        console.log(
          bashCompletionScript(cliName(), { denoTask: options.denoTask }),
        );
      }),
  )
  .command(
    "zsh",
    new Command()
      .description("Output the zsh completion script.")
      .option(
        "--no-deno-task",
        `Do not also complete "deno task ${cliName()} ...".`,
      )
      .noGlobals()
      .action((options) => {
        warnIfNotInstalled(cliName());
        console.log(
          zshCompletionScript(cliName(), { denoTask: options.denoTask }),
        );
      }),
  )
  .command("complete", completeCommand.hidden());
