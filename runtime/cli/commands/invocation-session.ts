import { Command } from "@cliffy/command";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import { newSessionId } from "../lib/session.ts";

/**
 * Emit a freshly minted invocation session id. Nothing else goes to stdout:
 * the id is the whole output, so `$(cf invocation-session new)` captures
 * exactly it.
 *
 * The `write` seam is the unit-test hold on the command's output: the id is
 * random, so what a test can check is the token itself and that two runs
 * produce different ones, which the seam hands over rather than leaving it
 * to be scraped off stdout. Runtime callers use the default.
 */
export function renderNewSession(write: (text: string) => void = render): void {
  write(newSessionId());
}

export const invocationSession = new Command()
  .name("invocation-session")
  .description(
    "Mint an invocation session: the caller identity that an invocation id " +
      "passed to `cf piece call` is chosen within. One per agent run.",
  )
  .default("help")
  /* invocation-session new */
  .command("new", "Output a new invocation session id to stdout.")
  .example(
    cliText("export CF_INVOCATION_SESSION=$(cf invocation-session new)"),
    "Mint a session for this shell, so every call made from it shares one.",
  )
  .action(() => renderNewSession());
