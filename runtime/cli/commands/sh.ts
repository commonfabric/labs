/**
 * `cf sh`, which opens shuttle: the interactive shell for exploring and
 * editing fabric state.
 *
 * The command is where a person's flags and environment are read, once and in
 * the words every other command with a space and an identity reads them in.
 * What it hands on is a settled connection, so nothing under it parses a
 * command line again.
 */

import { Command } from "@cliffy/command";

import { cliText } from "../lib/cli-name.ts";
import { runShuttle } from "../lib/shuttle/run.ts";
import { parseSpaceOptions } from "./piece.ts";

/** Options the `cf sh` action receives, from its flags and environment. */
export interface ShuttleCommandOptions {
  apiUrl?: string;
  identity?: string;
  space?: string;
}

/** Injectable effects, so the action body runs with no terminal behind it. */
export interface ShuttleCommandDeps {
  /** Runs the shell over the connection the options named. */
  readonly runShuttle?: typeof runShuttle;
}

/**
 * Opens a shuttle over the connection `options` names, and returns when the
 * person ends the session.
 *
 * The flags are read by `parseSpaceOptions`, the reader every other command
 * with a space and an identity uses, so a missing one is refused in the words
 * it is refused in everywhere else, a relative identity path is made absolute,
 * and the api URL reaches the shell in its canonical spelling — each of them
 * done exactly once, before a connection exists.
 */
export async function shuttleFromCommand(
  options: ShuttleCommandOptions,
  deps: ShuttleCommandDeps = {},
): Promise<void> {
  await (deps.runShuttle ?? runShuttle)(parseSpaceOptions(options));
}

/** The `cf sh` command. */
export const sh = new Command()
  .description(
    cliText(`Open shuttle, the interactive shell for fabric state.

Shuttle holds one connection and one place — the space, piece and path its
prompt shows — and reads lines against them: cd, ls, more, pwd, get, set,
edit, link, call, verbs, describe, wish, and where, which prints the whole
ambient record. The place fills in what a reference leaves out, so a line
names what it acts on rather than repeating the address. Type help at the
prompt for the verbs, and <verb> --help for what one of them takes.

A listing numbers its rows, and %n names a row until the next listing
replaces the numbering: cd %3 and call %4 act on what was shown. Reaching
into a piece starts it, so every read is served by a running pattern; edit
opens $EDITOR on a cell's value and writes back what you save.

The connection is fixed for the run: one shuttle serves one space, and
restarting is how to reach another.`),
  )
  .usage("[options]")
  .example(
    cliText("cf sh -s my-space"),
    "Open a shell on the space named my-space.",
  )
  // The three flags every command taking a space and an identity declares,
  // with the environment behind them. `--url` and `--quiet` are the two the
  // shared declaration adds that a shell has no use for: a URL names a piece,
  // where a shuttle starts at a space root, and the hint posture belongs to a
  // one-shot command's output rather than to a session.
  .env("CF_API_URL=<url:string>", "URL of the fabric server instance.", {
    prefix: "CF_",
  })
  .option("-a,--api-url <url:string>", "URL of the fabric server instance.")
  .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .option("-i,--identity <path:string>", "Path to an identity keyfile.")
  .env("CF_SPACE=<space:string>", "The space name or DID.", { prefix: "CF_" })
  .option("-s,--space <space:string>", "The space name or DID")
  .action(async (options: ShuttleCommandOptions) => {
    await shuttleFromCommand(options);
  });
