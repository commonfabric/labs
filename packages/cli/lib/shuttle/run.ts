/**
 * Running a shuttle: one connection, one place, and the prompt over both, for
 * as long as the person keeps typing.
 *
 * This is what `cf sh` calls. The terminal opens first and the connection
 * inside it, because the terminal is where the connection's own writing has to
 * land: a pattern's console output and the lines a connect writes for itself
 * would otherwise reach the process's streams, which is the middle of the
 * drawing once a prompt is painted (`announce.ts`). The connect then happens
 * before the first line rather than on it, because the place cannot be built
 * without it: a space written as a name is a DID only once a session has
 * resolved it, and a place stands in a space. That is the connect a shell pays
 * once where a one-shot command pays it per invocation.
 *
 * The invocation session is minted here for the same reason and on the same
 * terms: it is what makes an invocation id replayable, and one shuttle is one
 * run — exactly the span over which repeating an id should mean repeating a
 * call.
 *
 * The editor is wired here and nowhere under it, because an editor draws on
 * the screen the prompt is holding in raw mode: what runs one has to take that
 * mode off around it and put it back after, and only what opened the terminal
 * can.
 *
 * Nothing here reads the command line. What a person wrote is read by the
 * command, in the words every other command reads a space and an identity in,
 * and what arrives is the connection it settled on.
 */

import { toFileUrl } from "@std/path";

import { loadPieces, type SpaceConfig } from "../piece.ts";
import { newSessionId } from "../session.ts";
import { announcingOutput } from "./announce.ts";
import { type ConnectionOpener, HeldConnection } from "./connection.ts";
import { openEditor } from "./editor.ts";
import { ExternalLocation } from "./external.ts";
import { CurrentPlace } from "./place.ts";
import { runPrompt } from "./prompt.ts";
import { ShuttleSession } from "./session.ts";
import { consoleColumns, consoleRows, withPromptTerminal } from "./terminal.ts";
import type { Shuttle } from "./vocabulary.ts";

/** What a run reaches the world through, so that a case can stand for it. */
export interface ShuttleDeps {
  /**
   * Opens the connection; `loadPieces` where a caller names none. It takes
   * the output bag as well as the config, because where the connection's own
   * writing goes is this module's decision rather than the holder's.
   */
  readonly open?: typeof loadPieces;

  /** Holds a terminal open for the prompt to read and write through. */
  readonly terminal?: typeof withPromptTerminal;

  /** Mints the invocation session; a fresh one where a caller names none. */
  readonly newSessionId?: typeof newSessionId;

  /**
   * The external working location the run starts at; the process's own
   * working directory where a caller names none.
   *
   * It is a seam because the two things it is built from — the working
   * directory and the home — are facts about the machine, and a case that
   * read them would assert what that machine happens to hold.
   */
  readonly external?: ExternalLocation;

  /**
   * Reads lines against what this composed, which is where everything above
   * ends up.
   *
   * It is a seam for the same reason the other three are: what this module
   * does is compose, and a composition nothing can stand behind is one whose
   * wiring is only ever asserted by running the whole shell. The editor trip
   * is the wire that needs it — it exists to be handed to a verb, and no verb
   * reaches it without a cell to read first.
   */
  readonly prompt?: typeof runPrompt;
}

/**
 * Returns the external location a run starts at: the process's own working
 * directory, on the plane that reads a directory.
 *
 * A shell starts where it was started from, and the external plane is the one
 * a `file:` path is read against, so the process's working directory is what
 * makes `xcd ../foo` on the first line mean what a person typing it means.
 * The home is read here for the same reason and passed on rather than reached
 * for again (`external.ts`).
 */
function startingExternal(): ExternalLocation {
  // The directory is handed over as it stands. `ExternalLocation` is what
  // makes a location read as a container, so a separator added here would be
  // a second answer to a question already answered — and at the filesystem
  // root it is a separator appended to one.
  return new ExternalLocation(toFileUrl(Deno.cwd()), Deno.env.get("HOME"));
}

/**
 * Runs a shuttle over `config`, returning when the person ends the session.
 *
 * The connection is this call's to close, so it is closed on the way out
 * whatever ended the run — a line that ended it, or a throw from anywhere
 * under the prompt. Every watch the run armed is disarmed first, for the same
 * reason and in the order that reason asks for: a subscription is over the
 * connection, so it stops before the connection does. A terminal that will not
 * open is the one way out that closes nothing, and closes nothing because
 * nothing was opened: the terminal is what the connection is opened inside.
 *
 * @throws Whatever opening the terminal or the connection throws, and whatever
 * the prompt throws that it did not report as a line's own failure.
 */
export async function runShuttle(
  config: SpaceConfig,
  deps: ShuttleDeps = {},
): Promise<void> {
  await (deps.terminal ?? withPromptTerminal)(async (terminal) => {
    const opening = deps.open ?? loadPieces;
    const output = announcingOutput((text) => terminal.announce(text));
    const open: ConnectionOpener = (opened) => opening(opened, output);
    await using connection = new HeldConnection({
      kind: "owned",
      record: config,
      open,
    });
    const pieces = await connection.pieces();
    const shuttle: Shuttle = {
      config,
      place: new CurrentPlace(pieces.getSpace()),
      external: deps.external ?? startingExternal(),
      connection,
      session: new ShuttleSession(),
      invocationSession: (deps.newSessionId ?? newSessionId)(),
    };
    // How big the screen is arrives as functions rather than numbers, so a
    // window resized mid-session bounds the next line at the size it has then.
    // Both dimensions ride the deps bag because that is what already reaches
    // every verb, and a verb writing a page is where both are wanted: a page
    // is measured in rows, and a line becomes rows at the width.
    try {
      await (deps.prompt ?? runPrompt)(shuttle, terminal, {
        rows: consoleRows,
        columns: consoleColumns,
        // The same sink the connection's own writing goes to, so a call's
        // dispatch announcement and a pattern's console reach one screen in
        // the order they happened rather than in two orders.
        announce: (text) => terminal.announce(text),
        editText: (text) => terminal.suspend(() => openEditor(text)),
      });
    } finally {
      // Before the connection closes, whatever ended the run. A watch outlives
      // the view that armed it and nothing else, so what it must not outlive
      // is the runtime it subscribed to: a sink still armed over a disposed
      // connection is a callback into a torn-down runtime.
      shuttle.session.disarmAll();
    }
  });
}
