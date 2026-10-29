/**
 * Unit tests for running a shuttle: the connection, the place, and the prompt
 * composed into one session.
 *
 * Both ends are stood in for — the connection by an opener the case supplies,
 * and the terminal by one that delivers a scripted line — so what is under
 * test is the composing. A case that wants to know where the place stands asks
 * the session for it, by typing `pwd` at the prompt and reading what came
 * back, which is the only way in that does not reach past the seam.
 *
 * One case stands in for `Deno.consoleSize`, which is a member of the whole
 * process, so this file is a serial one, which the package's `deno-test` task
 * runs apart from the rest.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";
import { ConsoleMethod } from "@commonfabric/runner";

import type { ConnectionOutput, SpaceConfig } from "../lib/piece.ts";
import type { PromptTerminal } from "../lib/shuttle/prompt.ts";
import { runShuttle, type ShuttleDeps } from "../lib/shuttle/run.ts";
import { runLine } from "../lib/shuttle/verbs.ts";
import type { VerbDeps } from "../lib/shuttle/vocabulary.ts";
import type { Key } from "../lib/view/keys.ts";
import { moved } from "./shuttle-place-helpers.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example",
  space: "board",
  identity: "/keys/shuttle.pkcs8",
};

/** What a case saw of the session it ran. */
interface Ran {
  /** The config each opener call was given. */
  readonly opened: SpaceConfig[];

  /** How many times the connection was closed. */
  closed(): number;

  /** What each line the case typed produced. */
  readonly produced: string[];
}

/** Helper for the cases below, which is `text` typed one key at a time. */
function typed(text: string): Key[] {
  return [...text].map((char) => ({ name: char, char }));
}

/**
 * Helper for the cases below, which runs a session that types `line` and
 * returns what it saw.
 *
 * `deps` overrides what the helper supplies, which is what lets a case hand
 * in an opener that fails or a terminal that throws.
 */
async function running(
  line: string,
  deps: ShuttleDeps = {},
): Promise<Ran> {
  const opened: SpaceConfig[] = [];
  const produced: string[] = [];
  let closed = 0;
  const pieces = {
    dispose: () => {
      closed += 1;
      return Promise.resolve();
    },
    getSpace: () => SPACE,
    getSpaceName: () => "board",
  } as unknown as PiecesController;
  const terminal: PromptTerminal = {
    keys: ReadableStream.from([...typed(line), { name: "enter" }]),
    edit: () => {},
    finish: () => {},
    announce: (text) => {
      produced.push(text);
    },
    frame: () => {},
    unframe: () => {},
    suspend: (body) => body(),
  };
  await runShuttle(CONFIG, {
    open: (config) => {
      opened.push(config);
      return Promise.resolve(pieces);
    },
    terminal: (body) => body(terminal),
    ...deps,
  });
  return { opened, closed: () => closed, produced };
}

describe("runShuttle()", () => {
  it("opens one connection, over the config it was given", async () => {
    const ran = await running("");
    expect(ran.opened).toEqual([CONFIG]);
  });

  it("stands the place in the space the connection settled on", async () => {
    // The config names the space `board`; what a place holds is the DID the
    // session resolved that name to, which is why the connection has to be
    // open before the place exists.

    const ran = await running("pwd");
    expect(ran.produced[0]).toBe(
      `position  @${SPACE}/\nscope     @space`,
    );
  });

  it("closes the connection it opened", async () => {
    const ran = await running("");
    expect(ran.closed()).toBe(1);
  });

  it("opens the connection writing onto the prompt's own line", async () => {
    // Finding 8's wiring, read at the seam the connection is opened through:
    // what the connection writes for itself and what a pattern writes to its
    // console both reach the terminal's out-of-band line, which is the only
    // place a line can land while a prompt is painted in raw mode.

    const announced: string[] = [];
    let output: ConnectionOutput | undefined;
    const pieces = {
      dispose: () => Promise.resolve(),
      getSpace: () => SPACE,
      getSpaceName: () => "board",
    } as unknown as PiecesController;
    await runShuttle(CONFIG, {
      open: (_config, opened) => {
        output = opened;
        return Promise.resolve(pieces);
      },
      terminal: (body) =>
        body({
          keys: ReadableStream.from([]),
          edit: () => {},
          finish: () => {},
          announce: (text) => {
            announced.push(text);
          },
          frame: () => {},
          unframe: () => {},
          suspend: (body) => body(),
        }),
    });
    output?.report?.("navigateTo new piece id of:fid1:whatever");
    // What the runtime does with a handler's answer: it writes the arguments
    // to the console the handler named. Where that console writes is what
    // `announce.ts` decides and what its own cases pin.
    const routed = output?.consoleHandler?.({
      metadata: undefined,
      method: ConsoleMethod.Log,
      args: ["a pattern said so"],
    });
    const target = Array.isArray(routed) ? undefined : routed?.target;
    target?.log("a pattern said so");
    expect(announced).toEqual([
      "navigateTo new piece id of:fid1:whatever",
      "a pattern said so",
    ]);
  });

  it("bounds what a line writes at the height the terminal reports", async () => {
    // The one wiring only this seam can show: a verb bounds its page at what
    // the deps say the screen is, and `run.ts` is where that number comes
    // from. A session that handed the prompt nothing would take the assumed
    // height instead and write both facets, which is what makes the case
    // fail rather than merely look different.
    //
    // `ls` at a space root reads nothing — the facets are a closed set — so
    // the case needs no controller past the one the helper supplies.
    //
    // Two rows is the only height that bounds a two-row listing, and a page
    // that small cannot hold a row and a status line at once. So the line it
    // writes carries both halves of what a bounded page promises: what it
    // held back, and that what it did write ran past the screen.

    const prior = Deno.consoleSize;
    Deno.consoleSize = () => ({ columns: 80, rows: 2 });
    try {
      const ran = await running("ls");
      expect(ran.produced[0]).toBe(
        "%1 slugs\n<what is above fills more than the screen; 1 line not " +
          "shown — more continues>",
      );
    } finally {
      Deno.consoleSize = prior;
    }
  });

  it("closes the connection where the session threw", async () => {
    let closed = 0;
    const pieces = {
      dispose: () => {
        closed += 1;
        return Promise.resolve();
      },
      getSpace: () => SPACE,
      getSpaceName: () => "board",
    } as unknown as PiecesController;
    await expect(runShuttle(CONFIG, {
      open: () => Promise.resolve(pieces),
      terminal: (body) =>
        body({
          keys: ReadableStream.from([]),
          edit: () => {
            throw new Error("No screen.");
          },
          finish: () => {},
          announce: () => {},
          frame: () => {},
          unframe: () => {},
          suspend: (body) => body(),
        }),
    })).rejects.toThrow("No screen.");
    expect(closed).toBe(1);
  });

  it("disarms every watch before the connection closes", async () => {
    // A watch outlives the view that armed it and nothing else, so what it
    // must not outlive is the runtime it subscribed to: a sink still armed
    // over a disposed connection is a callback into a torn-down runtime.

    const order: string[] = [];
    let taken = 0;
    const pieces = {
      dispose: () => {
        order.push("closed");
        return Promise.resolve();
      },
      getSpace: () => SPACE,
      getSpaceName: () => "board",
    } as unknown as PiecesController;
    await runShuttle(CONFIG, {
      open: () => Promise.resolve(pieces),
      terminal: (body) =>
        body({
          keys: ReadableStream.from([]),
          edit: () => {},
          finish: () => {},
          announce: () => {},
          frame: () => {},
          unframe: () => {},
          suspend: (inner) => inner(),
        }),
      prompt: async (shuttle) => {
        moved(shuttle.place, `/${HANDLE}`);
        const outcome = await runLine("watch title", shuttle, {
          warmPiece: (config) => Promise.resolve({ piece: config.piece }),
          sinkCellValue: () => {
            const at = ++taken;
            return Promise.resolve(() => order.push(`cancel ${at}`));
          },
        });
        // The lens the line opened is the prompt loop's to close, and this
        // case stands in for that loop. What is left armed after it is the
        // watch alone, which is what the run has to disarm.
        if (outcome.kind === "watching") outcome.lens.close();
      },
    });
    expect(order).toEqual(["cancel 2", "cancel 1", "closed"]);
  });

  it("opens no connection at all where the terminal would not open", async () => {
    // The terminal is opened first, because it is where the connection's own
    // writing has to land. So a terminal that will not open closes nothing —
    // there is nothing to close, which is a stronger property than closing
    // what there was.

    let opened = 0;
    await expect(runShuttle(CONFIG, {
      open: () => {
        opened += 1;
        return Promise.reject(new Error("Never asked."));
      },
      terminal: () => Promise.reject(new Error("No terminal.")),
    })).rejects.toThrow("No terminal.");
    expect(opened).toBe(0);
  });

  it("reports the connection that would not open, from inside the terminal", async () => {
    // What the name does not claim is that nothing was closed. With no
    // connection there is no controller to close, so a case asserting a
    // close count would be asserting on a stub nothing could reach. What is
    // observable is that the opener's own failure is what comes back — a
    // disposal that raised over it would say something else — and that the
    // terminal was already open when it happened, which is what puts the
    // connection's own writing on the screen the shell holds.

    let reached = false;
    await expect(runShuttle(CONFIG, {
      open: () => Promise.reject(new Error("The server refused.")),
      terminal: (body) => {
        reached = true;
        return body({
          keys: ReadableStream.from([]),
          edit: () => {},
          finish: () => {},
          announce: () => {},
          frame: () => {},
          unframe: () => {},
          suspend: (body) => body(),
        });
      },
    })).rejects.toThrow("The server refused.");
    expect(reached).toBe(true);
  });

  describe("what it hands the prompt", () => {
    it("wires the editor trip to run inside the terminal's suspension", async () => {
      // The one wire no verb reaches without a cell to read first. What it
      // composes is two things with cases of their own — the terminal's
      // suspension and the trip through `$EDITOR` — so what is left to check
      // is that they are composed in that order and that the text goes
      // through.

      const order: string[] = [];
      let opened: string | undefined;
      const pieces = {
        dispose: () => Promise.resolve(),
        getSpace: () => SPACE,
        getSpaceName: () => "board",
      } as unknown as PiecesController;
      let deps: VerbDeps | undefined;
      await runShuttle(CONFIG, {
        open: () => Promise.resolve(pieces),
        terminal: (body) =>
          body({
            keys: ReadableStream.from([]),
            edit: () => {},
            finish: () => {},
            announce: () => {},
            frame: () => {},
            unframe: () => {},
            suspend: async (inner) => {
              order.push("suspended");
              const answer = await inner();
              order.push("resumed");
              return answer;
            },
          }),
        prompt: (_shuttle, _terminal, given) => {
          deps = given;
          return Promise.resolve();
        },
      });
      // The editor is named for the case rather than taken from whatever this
      // process inherited: an ambient `$EDITOR` would be a real editor with
      // this terminal, waiting for somebody to quit it. `true` reads nothing,
      // writes nothing and exits zero, so the trip comes back with the text it
      // went out with.
      const before = Deno.env.get("EDITOR");
      Deno.env.set("EDITOR", "true");
      try {
        const editing = await deps?.editText?.("the value");
        opened = editing?.kind === "edited" ? editing.text : undefined;
        if (editing?.kind === "edited") await editing.discard();
      } finally {
        if (before === undefined) Deno.env.delete("EDITOR");
        else Deno.env.set("EDITOR", before);
      }
      expect(order).toEqual(["suspended", "resumed"]);
      expect(opened).toBe("the value");
    });
  });
});
