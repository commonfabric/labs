/**
 * Unit tests for the prompt: the loop that reads a line, runs it beside the
 * keys, and writes what it produced.
 *
 * Every case drives the whole loop with a scripted key stream and reads back
 * the writes it made, so what is under test is the loop and the bindings — the
 * terminal, the keyboard and the escape sequences are all somewhere else.
 *
 * A case that needs a line to still be running while it types the next keys
 * scripts the keys against the read itself ({@link gated}) rather than against
 * a clock: the stream waits for the read to have started, and the read answers
 * when the stream says so, so which of the two the loop sees first is decided
 * by the case and not by how many microtasks a verb happens to take.
 *
 * The connection is a borrowed one throughout and no case reaches it: a verb
 * that reads stands its read in through the deps bag, so what the prompt does
 * with what a read returned is what these cases turn on.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";

import { UI } from "@commonfabric/runner";

import type { SpaceConfig } from "../lib/piece.ts";
import { HeldConnection } from "../lib/shuttle/connection.ts";
import { ExternalLocation } from "../lib/shuttle/external.ts";
import { CurrentPlace } from "../lib/shuttle/place.ts";
import { ShuttleSession } from "../lib/shuttle/session.ts";
import type { FrameCursor } from "../lib/shuttle/lens.ts";
import { moved } from "./shuttle-place-helpers.ts";
import { type PromptTerminal, runPrompt } from "../lib/shuttle/prompt.ts";
import type { Shuttle, VerbDeps } from "../lib/shuttle/vocabulary.ts";
import type { Key } from "../lib/view/keys.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/** The prompt a shuttle standing at the space root carries. */
const AT_ROOT = "shuttle / @space> ";

/** The prompt a shuttle standing at {@link HANDLE} carries. */
const AT_PIECE = `shuttle ${HANDLE} @space> `;

/** What the prompt wrote, in the order it wrote it. */
type Write =
  /** It drew `text` as the line being edited, the cursor `column` into it. */
  | { readonly kind: "edit"; readonly text: string; readonly column: number }
  /** It ended the line it was drawing. */
  | { readonly kind: "finish" }
  /** It wrote `text` above the line being edited. */
  | { readonly kind: "announce"; readonly text: string }
  /** It drew `rows` as a full-screen frame, the cursor where `cursor` says. */
  | {
    readonly kind: "frame";
    readonly rows: readonly string[];
    readonly cursor: FrameCursor | undefined;
  }
  /** It gave the screen back. */
  | { readonly kind: "unframe" };

/** Helper for the cases below, which is a shuttle at the space root. */
function shuttleIn(): Shuttle {
  return {
    config: CONFIG,
    place: new CurrentPlace(SPACE),
    external: new ExternalLocation(new URL("file:///work/"), "/home/someone"),
    connection: new HeldConnection({
      kind: "borrowed",
      pieces: {
        dispose: () => Promise.resolve(),
        getSpace: () => SPACE,
        getSpaceName: () => "board",
      } as unknown as PiecesController,
    }),
    session: new ShuttleSession(),
    invocationSession: "a-session",
  };
}

/** Helper for the cases below, which stands a shuttle at a piece. */
function atPiece(): Shuttle {
  const shuttle = shuttleIn();
  moved(shuttle.place, `/${HANDLE}`);
  return shuttle;
}

/** Helper for the cases below, which is `text` typed one key at a time. */
function typed(text: string): Key[] {
  return [...text].map((char) => ({ name: char, char }));
}

/** Helper for the cases below, which is the key that runs a line. */
const ENTER: Key = { name: "enter" };

/** Helper for the cases below, which is the key that completes a token. */
const TAB: Key = { name: "tab" };

/** Helper for the cases below, which is the key that recalls an earlier line. */
const UP: Key = { name: "up" };

/** Helper for the cases below, which is the key that recalls a later one. */
const DOWN: Key = { name: "down" };

/** Helper for the cases below, which is `letter` typed with control held. */
function control(letter: string): Key {
  return { name: `ctrl-${letter}`, ctrl: true };
}

/** Helper for the cases below, which is `letter` typed with alt held. */
function alt(letter: string): Key {
  return { name: letter, alt: true };
}

/**
 * Helper for the cases below, which is a read a case starts and answers, and
 * the two events either side of it.
 *
 * A line is in flight for exactly as long as its read has not answered, so a
 * case that wants to type into a running line waits on {@link Gated.started}
 * and then calls {@link Gated.answer}. Neither wait is a poll and neither is a
 * clock: the read resolves the first promise as it is called, and the case
 * resolves the second.
 */
interface Gated {
  /** Settles once the read has been called. */
  readonly started: Promise<void>;

  /** Answers the read with `value`, which settles the line. */
  answer(value: unknown): void;

  /** The read itself, for the deps bag. */
  readonly read: () => Promise<unknown>;
}

/** Helper for the cases below, which is a read a case drives. */
function gated(): Gated {
  const started = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<unknown>();
  return {
    started: started.promise,
    answer: (value) => answered.resolve(value),
    read: () => {
      started.resolve();
      return answered.promise;
    },
  };
}

/**
 * Helper for the cases below, which runs `keys` against `shuttle` and returns
 * what the prompt wrote.
 *
 * The keys are a stream that ends, which is the only thing that ends a run
 * that no key ended: a case says what it types and the loop returns once the
 * line it was running has settled.
 */
async function running(
  keys: readonly Key[] | AsyncIterable<Key>,
  shuttle: Shuttle = shuttleIn(),
  deps: VerbDeps = {},
): Promise<Write[]> {
  const writes: Write[] = [];
  const terminal: PromptTerminal = {
    ...framing(writes),
    keys: Array.isArray(keys)
      ? ReadableStream.from(keys as readonly Key[])
      : keys as AsyncIterable<Key>,
    edit: (text, column) => {
      writes.push({ kind: "edit", text, column });
    },
    finish: () => {
      writes.push({ kind: "finish" });
    },
    announce: (text) => {
      writes.push({ kind: "announce", text });
    },
    // Nothing the prompt does suspends the terminal: the trip is `edit`'s,
    // taken through a dep the run wires (`run.ts`), so a case here that
    // reached this would be a case about a verb rather than about the loop.
    suspend: () => {
      throw new Error("The prompt handed the terminal over.");
    },
  };
  // Warming is answered for every case rather than by each, because it is not
  // something a case here arranges: reaching into a piece warms it, so any
  // line that touches one warms it, and these cases are about what the prompt
  // draws. A case that cares can still say so, `deps` coming last.
  await runPrompt(shuttle, terminal, {
    warmPiece: (config) => Promise.resolve({ piece: config.piece }),
    ...deps,
  });
  return writes;
}

/**
 * Helper for the cases below, which is the frame half of a terminal, recording
 * into `writes`.
 *
 * It holds whether a frame has the screen because the contract does: giving
 * the screen back where no frame took it does nothing, which is what lets a
 * caller put a terminal back without asking first. A stand-in that recorded
 * every call would make a case read one write where a terminal makes none.
 */
function framing(
  writes: Write[],
): Pick<PromptTerminal, "frame" | "unframe"> {
  let framed = false;
  return {
    frame: (rows, cursor) => {
      framed = true;
      writes.push({ kind: "frame", rows, cursor });
    },
    unframe: () => {
      if (!framed) return;
      framed = false;
      writes.push({ kind: "unframe" });
    },
  };
}

/** Helper for the cases below, which is the last line the prompt drew. */
function drawn(writes: readonly Write[]): Write | undefined {
  return writes.filter((write) => write.kind === "edit").at(-1);
}

/** Helper for the cases below, which is what each line produced, in order. */
function produced(writes: readonly Write[]): string[] {
  return writes.filter((write) => write.kind === "announce")
    .map((write) => write.text);
}

describe("prompt", () => {
  describe("runPrompt()", () => {
    it("draws the prompt before a key is typed", async () => {
      expect(await running([])).toEqual([
        { kind: "edit", text: AT_ROOT, column: AT_ROOT.length },
        { kind: "finish" },
      ]);
    });

    it("draws the line as it is typed, and writes what it produced under it", async () => {
      // The one case reading the whole log. What it pins is the order: the
      // line is drawn where it was typed, ended where it was run, and its
      // result written above the prompt that came next — which is what makes
      // a transcript a record of what happened.

      expect(await running([...typed("pw"), ENTER])).toEqual([
        { kind: "edit", text: AT_ROOT, column: 18 },
        { kind: "edit", text: `${AT_ROOT}p`, column: 19 },
        { kind: "edit", text: `${AT_ROOT}pw`, column: 20 },
        { kind: "finish" },
        {
          kind: "announce",
          text: "`pw` is not a verb. The verbs are `call`, `cd`, " +
            "`describe`, `edit`, `get`, `help`, `link`, `ls`, `more`, " +
            "`pwd`, `set`, `unwatch`, `verbs`, `watch`, `watches`, " +
            "`where`, `wish`, `xcd`, and `xpwd`.",
        },
        { kind: "edit", text: AT_ROOT, column: 18 },
        { kind: "finish" },
      ]);
    });

    it("writes the text a verb composed", async () => {
      expect(produced(await running([...typed("pwd"), ENTER]))).toEqual([
        `position  @${SPACE}/\nscope     @space`,
      ]);
    });

    it("writes nothing under a line naming no verb at all", async () => {
      expect(produced(await running([ENTER]))).toEqual([]);
    });

    it("writes nothing under a line that moved the place", async () => {
      expect(produced(await running([...typed("cd slugs"), ENTER])))
        .toEqual([]);
    });

    it("draws the place a line moved to at the next prompt", async () => {
      const writes = await running([...typed("cd slugs"), ENTER]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: "shuttle /slugs/ @space> ",
        column: 24,
      });
    });

    it("writes what a verb read as a value, as indented JSON", async () => {
      // The value arm reaches the one writer (`value.ts`), which is where the
      // form is pinned. What this case is about is that the arm reaches it at
      // all, so the assertion is the shape and not the whole vocabulary.

      const writes = await running([...typed("wish #favorites"), ENTER], {
        ...shuttleIn(),
      }, {
        readWish: () => Promise.resolve({ result: { title: "a" } }),
      });
      expect(produced(writes)).toEqual(['{\n  "title": "a"\n}']);
    });

    it("writes a piece's `$UI` node out for a value a target resolved to", async () => {
      // The arm asks for the node rather than a marker, and the asymmetry is
      // deliberate: a person naming a target asked for that target, where a
      // person reading the cell they are standing in did not ask for the
      // piece's picture of itself. `get` is the verb that elides, and it
      // writes its own rendering.

      const writes = await running([...typed("wish #favorites"), ENTER], {
        ...shuttleIn(),
      }, {
        readWish: () => Promise.resolve({ result: { [UI]: { type: "v" } } }),
      });
      expect(produced(writes)[0]).toBe(
        `{\n  "${UI}": {\n    "type": "v"\n  }\n}`,
      );
    });

    it("writes the writer's own failure for a value it cannot walk at all", async () => {
      // A cycle is not something the writer can take, and a shell that ended
      // on one would end on a value the fabric holds perfectly well.

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve(cyclic),
      });
      expect(produced(writes)[0]).toContain("circular");
    });

    it("writes the message of a read that failed, and reads the next line", async () => {
      const writes = await running(
        [...typed("get"), ENTER, ...typed("pwd"), ENTER],
        atPiece(),
        {
          getCellValue: () => {
            throw new Error("The server cannot be reached.");
          },
        },
      );
      expect(produced(writes)).toEqual([
        "The server cannot be reached.",
        `position  //${SPACE}/${HANDLE}@space\nscope     @space`,
      ]);
    });

    it("ends the run on `ctrl-d` at an empty line", async () => {
      expect(produced(await running([control("d"), ...typed("pwd"), ENTER])))
        .toEqual([]);
    });

    it("deletes forward on `ctrl-d` with something on the line", async () => {
      const writes = await running([
        ...typed("ab"),
        control("a"),
        control("d"),
      ]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}b`,
        column: 18,
      });
    });

    it("abandons the line on `ctrl-c` and reads the next one", async () => {
      // The next line is a whole line rather than the rest of one: were the
      // abandoned text still there, what ran would be `pwdpwd`, which is no
      // verb.

      const writes = await running(
        [...typed("pwd"), control("c"), ...typed("pwd"), ENTER],
      );
      expect(produced(writes))
        .toEqual([`position  @${SPACE}/\nscope     @space`]);
    });

    it("ends the line it was drawing when the keys run out", async () => {
      const writes = await running([...typed("pwd")]);
      expect(writes.at(-1)).toEqual({ kind: "finish" });
      expect(produced(writes)).toEqual([]);
    });
  });

  describe("a line in flight", () => {
    // The loop's other half: the keys are read while a line is running, so a
    // slow server holds up neither the keyboard nor the screen. Each case
    // below scripts its keys against the read rather than against a clock —
    // the stream waits for the read to have started and answers it when the
    // case is done typing — so what the loop saw and in what order is the
    // case's to decide.

    /** Helper for the cases below, which is the read `get` at a piece makes. */
    function reading(read: Gated): VerbDeps {
      return { getCellValue: read.read };
    }

    it("draws a key typed while a line is in flight, before the line answers", async () => {
      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield* typed("pw");
          read.answer({ title: "a" });
        })(),
        atPiece(),
        reading(read),
      );
      const shown = writes.findIndex((write) =>
        write.kind === "edit" && write.text === `${AT_PIECE}pw`
      );
      const answered = writes.findIndex((write) => write.kind === "announce");
      expect(shown).toBeGreaterThan(-1);
      expect(answered).toBeGreaterThan(shown);
    });

    it("keeps what was typed while a line was in flight, under the prompt the line left", async () => {
      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield* typed("pw");
          read.answer({ title: "a" });
        })(),
        atPiece(),
        reading(read),
      );
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_PIECE}pw`,
        column: [...AT_PIECE].length + 2,
      });
    });

    it("holds `enter` typed while a line is in flight, and runs it once the prompt is free", async () => {
      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield* typed("pwd");
          yield ENTER;
          read.answer({ title: "a" });
        })(),
        atPiece(),
        reading(read),
      );
      expect(produced(writes)).toEqual([
        '{\n  "title": "a"\n}',
        `position  //${SPACE}/${HANDLE}@space\nscope     @space`,
      ]);
    });

    it("runs a held line against the place the line before it settled on", async () => {
      // What holding buys over running the line where it was typed: the `cd`
      // is what moves the place, and the `pwd` behind it names the place the
      // `cd` reached rather than the one the prompt showed while it ran.

      const board = "of:fid1:qrstuvwxyz012345";
      const resolution = gated();
      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const writes = await running(
        (async function* () {
          yield* typed("cd board");
          yield ENTER;
          await resolution.started;
          yield* typed("pwd");
          yield ENTER;
          resolution.answer(board);
        })(),
        shuttle,
        {
          resolvePieceReference: async (_pieces, _token, path) => ({
            piece: (await resolution.read()) as string,
            pathAfter: [...path],
          }),
        },
      );
      expect(produced(writes)).toEqual([
        `position  //${SPACE}/${board}@space\nscope     @space`,
      ]);
    });

    it("cancels the line in flight on `ctrl-c`, and reads the next line", async () => {
      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield control("c");
          yield* typed("pwd");
          yield ENTER;
          // The read the person stopped waiting for still answers, into
          // nothing: what a cancel reaches is the line, never the server.
          read.answer({ title: "a" });
        })(),
        atPiece(),
        reading(read),
      );
      expect(produced(writes)).toEqual([
        "Interrupted.",
        `position  //${SPACE}/${HANDLE}@space\nscope     @space`,
      ]);
    });

    it("abandons the line while the read it was waiting on is still outstanding", async () => {
      // The case above says what a cancel produces; this one says when. They
      // are different claims, and only the second is the loop's: a prompt that
      // waited for the read and cancelled afterwards would produce exactly the
      // same words, one server round trip later, and every case that awaits
      // the run before reading its writes would pass. So this one never
      // answers the read while the run is going. What ends the run is the keys
      // running out, and what settles the line is the cancel — so the run
      // returning at all is the claim, and the writes say what it returned
      // with.
      //
      // The read is answered below, after the assertions, because that is what
      // makes them a statement about order rather than about outcome. It is
      // answered rather than dropped for the same reason the case above
      // answers it: the read a person stopped waiting for still comes back,
      // and it comes back into nothing.

      const read = gated();
      let answered = false;
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield control("c");
        })(),
        atPiece(),
        {
          getCellValue: () =>
            read.read().then((value) => {
              answered = true;
              return value;
            }),
        },
      );
      expect(produced(writes)).toEqual(["Interrupted."]);
      expect(answered).toBe(false);
      read.answer({ title: "a" });
    });

    it("drops what was typed ahead when `ctrl-c` cancels the line", async () => {
      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield* typed("pw");
          yield control("c");
          read.answer({ title: "a" });
        })(),
        atPiece(),
        reading(read),
      );
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: AT_PIECE,
        column: [...AT_PIECE].length,
      });
    });

    it("holds `ctrl-d` on an empty line, and ends the run once the prompt is free", async () => {
      // The key that ends a run would leave a line in flight with nothing to
      // report it to, so it is held like the other line-ender and acts once
      // the line it was typed under has answered.
      //
      // The `pwd` behind it is what makes the holding readable rather than
      // merely harmless: keys after a held one are held too, so what the
      // `ctrl-d` ends the run over is a line already typed, and it never
      // runs. Were the `ctrl-d` merely ignored, it would.

      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield control("d");
          yield* typed("pwd");
          yield ENTER;
          read.answer({ title: "a" });
        })(),
        atPiece(),
        reading(read),
      );
      expect(produced(writes)).toEqual(['{\n  "title": "a"\n}']);
    });

    it("keeps what ended the run where the terminal will not be put back", async () => {
      // A terminal that will not take the writing on the way out is one
      // nothing here could put back, and a throw raised over it would replace
      // whatever ended the run — which is the part a reader needs. So the
      // writing is attempted and its failure goes no further, and the
      // keyboard's own error is still what the run rejects with.

      const writes: Write[] = [];
      const terminal: PromptTerminal = {
        ...framing(writes),
        unframe: () => {
          throw new Error("The terminal went.");
        },
        keys: (async function* (): AsyncGenerator<Key> {
          throw new Error("The keyboard went.");
        })(),
        edit: (text, column) => {
          writes.push({ kind: "edit", text, column });
        },
        finish: () => {
          writes.push({ kind: "finish" });
        },
        announce: (text) => {
          writes.push({ kind: "announce", text });
        },
        suspend: () => {
          throw new Error("The prompt handed the terminal over.");
        },
      };
      await expect(runPrompt(shuttleIn(), terminal, {})).rejects.toThrow(
        "The keyboard went.",
      );
    });
  });

  describe("text the fabric wrote", () => {
    // Neither a refusal's reason nor a thrown read's message passed a door, so
    // neither has been held to the class a terminal acts on. Both are held to
    // it here, where each becomes the line above the prompt that follows, and
    // these cases are at that point rather than at either writer for the
    // reason the escaping is: a refusal built as a literal and a `throw` from
    // a module the verbs never see reach the same place by paths no writer
    // covers.

    it("shows a character a terminal acts on, however the refusal was built", async () => {
      // Both rows carry the same fabric-written error and refuse with the same
      // words, and they are built differently: `wish` refuses through the
      // helper, `cd` returns the refusal as a literal while resolving the
      // target. The helper is what an escape at the writer would have covered.

      for (const line of ["wish #favorites", "cd #favorites"]) {
        const writes = await running([...typed(line), ENTER], shuttleIn(), {
          readWish: () =>
            Promise.resolve({ result: null, error: "gone\u009b" }),
        });
        expect(produced(writes)[0]).toBe(
          "`#favorites` resolved to nothing: gone␦",
        );
        expect(/\p{Cc}/u.test(produced(writes)[0])).toBe(false);
      }
    });

    it("answers a read that threw something no message can be read off", async () => {
      // The failure path failing is the case: `String` throws on a value with
      // no `toString`, so the obvious spelling of this catch would throw
      // inside the catch, escape the loop, and end the session on the read
      // that failed. What a reader gets instead says less than a message and
      // far more than a prompt that is gone.

      for (
        const thrown of [
          Object.create(null),
          {
            toString: () => {
              throw new Error("no");
            },
          },
          Object.assign(new Error("x"), { message: { not: "a string" } }),
        ]
      ) {
        const writes = await running([...typed("get"), ENTER], atPiece(), {
          getCellValue: () => Promise.reject(thrown),
        });
        expect(produced(writes)[0]).toBe(
          "The failure carries nothing that can be written as a message.",
        );
      }
    });

    it("reads the line after one that threw something unreadable", async () => {
      // The point of not throwing: the run carries on, which is the whole
      // difference between a bad answer and no shell.

      const writes = await running(
        [...typed("get"), ENTER, ...typed("pwd"), ENTER],
        atPiece(),
        { getCellValue: () => Promise.reject(Object.create(null)) },
      );
      expect(produced(writes).length).toBe(2);
      expect(produced(writes)[1]).toContain("position");
    });

    it("shows one in the message of a read that threw", async () => {
      // A read that throws produces no outcome at all, so it is reached by
      // neither the refusal arm nor the value arm — the catch is its whole
      // path, and the message on it is the server's rather than shuttle's.

      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => {
          throw new Error("the server said \u009b[2J");
        },
      });
      expect(produced(writes)[0]).toBe("the server said ␦[2J");
      expect(/\p{Cc}/u.test(produced(writes)[0])).toBe(false);
    });
  });

  describe("the bindings", () => {
    it("moves the cursor to the start of the line on `ctrl-a`", async () => {
      const writes = await running([...typed("ab"), control("a")]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}ab`,
        column: 18,
      });
    });

    it("kills the word before the cursor on `ctrl-w`", async () => {
      const writes = await running([...typed("one two"), control("w")]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}one `,
        column: 22,
      });
    });

    it("reads a key's alt modifier as part of what it is bound to", async () => {
      // `alt-b` is the word-backward motion, and `b` is a character to insert.
      // The two are the same key name, so nothing but the modifier tells them
      // apart.

      const writes = await running([...typed("one two"), alt("b")]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}one two`,
        column: 22,
      });
    });

    it("runs the motion each key is bound to", async () => {
      // One case over the whole table, so a binding dropped from it fails here
      // rather than quietly stopping working. Every row is written so that the
      // key under test has somewhere to go: a motion is asked from a cursor it
      // can move from, and a kill is asked where there is something to kill.
      // Read it as the line each sequence leaves behind, and its cursor.
      //
      // Which is a rule about tables and not a remark about this one. A table
      // is proven a row at a time and reported a case at a time, so a
      // mutation that reds any single row marks the whole case caught and the
      // rest of the rows ride along having asserted nothing. That is how a
      // row asking a motion where it is a no-op passes: it asserts the line
      // it started with. So a table's mutation has to red the row in question
      // — one mutation per row, or rows picked so that no two are satisfied
      // by the same path — and a row no mutation can red is a row testing
      // nothing, whatever it looks like it says.

      const HOME: Key = { name: "home" };
      const on = (...keys: Key[]): Key[] => [...typed("one two"), ...keys];
      const bound: [Key[], string, number][] = [
        [on(control("b")), "one two", 24],
        [on({ name: "left" }), "one two", 24],
        [on(HOME, control("f")), "one two", 19],
        [on(HOME, { name: "right" }), "one two", 19],
        [on(control("a")), "one two", 18],
        [on(HOME), "one two", 18],
        [on(HOME, control("e")), "one two", 25],
        [on(HOME, { name: "end" }), "one two", 25],
        [on(alt("b")), "one two", 22],
        [on(HOME, alt("f")), "one two", 21],
        [on({ name: "backspace" }), "one tw", 24],
        [on(HOME, { name: "delete" }), "ne two", 18],
        [on(HOME, control("d")), "ne two", 18],
        [on(HOME, control("k")), "", 18],
        [on(control("u")), "", 18],
        [on(control("w")), "one ", 22],
        [on({ name: "backspace", alt: true }), "one ", 22],
        [on(HOME, alt("d")), " two", 18],
        [on(control("u"), control("y")), "one two", 25],
        // The one row that does not open with `on`, and the only shape that
        // can ask this: yank-pop reaches for the kill before last, so the ring
        // has to hold two and nothing else. Starting from `one two` would put
        // a third kill in it and ask a different question. Read the sequence
        // as: kill `a`, kill `b`, yank back `b`, then pop to `a`.
        [
          [
            ...typed("a"),
            control("u"),
            ...typed("b"),
            control("u"),
            control("y"),
            alt("y"),
          ],
          "a",
          19,
        ],
      ];
      for (const [keys, text, column] of bound) {
        expect(drawn(await running(keys)))
          .toEqual({ kind: "edit", text: `${AT_ROOT}${text}`, column });
      }
    });

    it("leaves the line alone for a character a terminal would act on", async () => {
      // The decoder gives every byte below `0x20` a name and no character, so
      // none of those arrives here. A C1 character does, whole, out of a
      // paste — and `U+009B` is a sequence introducer, which drawn into the
      // line would take the rest of it as a command. No place admits a part
      // holding one either, so a line carrying it is a line already refused.

      const pasted: Key[] = [
        { name: "\u009b", char: "\u009b" },
        { name: "\u001b", char: "\u001b" },
      ];
      const writes = await running([...typed("ab"), ...pasted]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}ab`,
        column: 20,
      });
    });

    it("leaves the line alone for a key bound to nothing that typed nothing", async () => {
      const writes = await running([...typed("ab"), { name: "f1" }]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}ab`,
        column: 20,
      });
    });
  });

  describe("recalling a line", () => {
    // What the prompt does with the traversal, which is where the two meet:
    // what the traversal itself holds is pinned in `shuttle-history.test.ts`.

    it("draws the line before it on `up`, with the cursor at its end", async () => {
      const writes = await running([...typed("pwd"), ENTER, UP]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}pwd`,
        column: 21,
      });
    });

    it("draws the line that was being typed on `down` back past the newest", async () => {
      const writes = await running([
        ...typed("pwd"),
        ENTER,
        ...typed("ab"),
        UP,
        DOWN,
      ]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}ab`,
        column: 20,
      });
    });

    it("recalls on `ctrl-p` and `ctrl-n`, which are the same two motions", async () => {
      const back = await running([...typed("pwd"), ENTER, control("p")]);
      expect(drawn(back))
        .toEqual({ kind: "edit", text: `${AT_ROOT}pwd`, column: 21 });
      const forward = await running(
        [...typed("pwd"), ENTER, ...typed("ab"), control("p"), control("n")],
      );
      expect(drawn(forward))
        .toEqual({ kind: "edit", text: `${AT_ROOT}ab`, column: 20 });
    });

    it("records the line where it is taken, so `up` reaches one still running", async () => {
      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield UP;
          read.answer({ title: "a" });
        })(),
        atPiece(),
        { getCellValue: read.read },
      );
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_PIECE}get`,
        column: [...AT_PIECE].length + 3,
      });
    });

    it("records nothing for a line with nothing on it", async () => {
      // The blank line runs nothing, so `up` past it reaches the line that
      // did rather than a position with nothing on it.

      const writes = await running([...typed("pwd"), ENTER, ENTER, UP]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}pwd`,
        column: 21,
      });
    });

    it("returns the traversal to an empty line on `ctrl-c`", async () => {
      // The `ab` was held against the line being typed when the first `up`
      // left it. `ctrl-c` throws that line away, so the position it was held
      // at holds nothing, and `down` back to it draws an empty prompt.

      const writes = await running([
        ...typed("pwd"),
        ENTER,
        ...typed("ab"),
        UP,
        control("c"),
        UP,
        DOWN,
      ]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: AT_ROOT,
        column: 18,
      });
    });
  });

  describe("a lens over the prompt", () => {
    // A lens is a state of this loop rather than a program beside it, because
    // the keyboard is this loop's: a verb reading keys of its own would be
    // reading them out of the stream the loop has already asked for one from.
    //
    // So the cases here are about the loop — what it draws, where the keys go
    // while a frame is up, and what comes back when the frame goes away.
    //
    // Each drives the keys against the frame rather than against the line: a
    // key typed while a line is still in flight goes to the line being typed
    // next, which is the loop's own rule, so a case that wants a key to reach
    // the lens types it once the frame is on screen. The wait is on the
    // drawing itself and on no clock.

    /** The label a lens onto the piece's `title` carries. */
    const WATCHED = `${HANDLE}/title @space`;

    /** What driving a lens through the prompt produced. */
    interface Framed {
      /** Every write the prompt made, in order. */
      readonly writes: Write[];

      /** Settles the first time a frame is drawn. */
      readonly framed: Promise<void>;
    }

    /**
     * Helper for the cases below, which runs `keys` against a shuttle standing
     * on a piece, with the subscriptions a `watch` takes stood in for.
     *
     * The keys are a generator so that a case can hold one back until the
     * frame is drawn, which {@link Framed.framed} is what says.
     */
    function driving(
      keys: (framed: Promise<void>) => AsyncIterable<Key>,
      sink: () => Promise<() => void> = () => Promise.resolve(() => {}),
      refuseAnnounce = false,
      refuseUnframe = false,
      shuttle: Shuttle = atPiece(),
      deps: VerbDeps = {},
      saw: (write: Write) => void = () => {},
    ): {
      writes: Promise<Write[]>;
      drawn: Write[];
      framed: Promise<void>;
    } {
      const writes: Write[] = [];
      const drawn = Promise.withResolvers<void>();
      const framer = framing(writes);
      const terminal: PromptTerminal = {
        ...framer,
        unframe: () => {
          if (refuseUnframe) throw new Error("The screen would not go back.");
          framer.unframe();
        },
        keys: {
          [Symbol.asyncIterator]: () =>
            keys(drawn.promise)[Symbol.asyncIterator](),
        },
        edit: (text, column) => {
          writes.push({ kind: "edit", text, column });
        },
        finish: () => {
          writes.push({ kind: "finish" });
        },
        announce: (text) => {
          if (refuseAnnounce) {
            throw new Error("The terminal would not take it.");
          }
          writes.push({ kind: "announce", text });
          saw(writes[writes.length - 1]!);
        },
        frame: (rows, cursor) => {
          framer.frame(rows, cursor);
          drawn.resolve();
          saw(writes[writes.length - 1]!);
        },
        suspend: () => {
          throw new Error("The prompt handed the terminal over.");
        },
      };
      return {
        framed: drawn.promise,
        // The array itself as well as the promise over it, because a run that
        // threw hands back no array and what it drew on the way out is exactly
        // what such a case is about.
        drawn: writes,
        writes: runPrompt(shuttle, terminal, {
          warmPiece: (config) => Promise.resolve({ piece: config.piece }),
          sinkCellValue: () => sink(),
          ...deps,
        }).then(() => writes),
      };
    }

    /** Helper for the cases below, which is every frame the prompt drew. */
    function frames(writes: readonly Write[]): (readonly string[])[] {
      return writes.filter((write) => write.kind === "frame")
        .map((write) => write.rows);
    }

    /**
     * Helper for the cases below, which types `line`, runs it, and then types
     * `after` once the frame it opened is on screen.
     */
    function opening(
      line: string,
      after: readonly Key[],
    ): (framed: Promise<void>) => AsyncIterable<Key> {
      return async function* (framed) {
        yield* typed(line);
        yield ENTER;
        await framed;
        yield* after;
      };
    }

    it("draws a frame naming the cell the line armed a watch on", async () => {
      const { writes } = driving(opening("watch title", typed("q")));
      const rule = "─".repeat(80 - 4 - WATCHED.length);
      expect(frames(await writes)[0]?.[0]).toBe(`┌ ${WATCHED} ${rule}┐`);
    });

    it("writes what the line produced before the frame takes the screen", async () => {
      // The order it happened in: the verb armed the watch and said what is
      // armed, and the lens opened onto it. Written after, it would reach the
      // transcript below the changes the frame was up for.

      const drawn = await driving(opening("watch title", typed("q"))).writes;
      const said = drawn.findIndex((write) => write.kind === "announce");
      expect(drawn[said]).toEqual({ kind: "announce", text: `%1 ${WATCHED}` });
      expect(said).toBeLessThan(
        drawn.findIndex((write) => write.kind === "frame"),
      );
    });

    it("draws no prompt while the frame has the screen", async () => {
      const drawn = await driving(opening("watch title", typed("jq"))).writes;
      const framed = drawn.findIndex((write) => write.kind === "frame");
      const gave = drawn.findIndex((write) => write.kind === "unframe");
      expect(drawn.slice(framed, gave).every((write) => write.kind === "frame"))
        .toBe(true);
    });

    it("sends a key to the lens rather than to the line being typed", async () => {
      // `j` scrolls the frame; a `j` that reached the buffer would be a
      // character on a line nobody can see.

      const drawn = await driving(opening("watch title", typed("jq"))).writes;
      expect(frames(drawn).length).toBe(2);
      expect(drawn.at(-2))
        .toEqual({ kind: "edit", text: AT_PIECE, column: AT_PIECE.length });
    });

    it("gives the screen back on `q` and draws the prompt again", async () => {
      const drawn = await driving(opening("watch title", typed("q"))).writes;
      const gave = drawn.findIndex((write) => write.kind === "unframe");
      expect(gave).toBeGreaterThan(-1);
      expect(drawn[gave + 1])
        .toEqual({ kind: "edit", text: AT_PIECE, column: AT_PIECE.length });
    });

    it("gives the screen back when the keys run out with a lens open", async () => {
      // A lens is closed by a key and there are no more keys, so the run
      // closes it: a run that ended with the screen still held would leave a
      // person at an alternate screen with nothing drawing on it.

      const drawn = await driving(opening("watch title", [])).writes;
      expect(drawn.filter((write) => write.kind === "unframe").length).toBe(1);
    });

    /**
     * Helper for the two cases below, which types `line`, then `ahead` while
     * that line is still arming its watch, then `after` once the frame it
     * opened is on screen.
     *
     * The gate is the subscription the line takes: it is entered while the
     * line is still running, so what is typed against it is type-ahead at the
     * prompt rather than a key at a frame. Both waits are on the run's own
     * events and neither is a clock.
     */
    function typedAhead(
      line: string,
      ahead: readonly Key[],
      after: readonly Key[],
    ): { writes: Promise<Write[]> } {
      const arming = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      return driving(
        async function* (framed) {
          yield* typed(line);
          yield ENTER;
          await started.promise;
          yield* ahead;
          arming.resolve();
          await framed;
          yield* after;
        },
        () => {
          started.resolve();
          return arming.promise.then(() => () => {});
        },
      );
    }

    it("gives the screen back where the run threw with a lens open", async () => {
      // The one way out of a run a person cannot type their way back from: a
      // frame still holding the screen is an alternate screen with a hidden
      // cursor and nothing drawing on it. So the screen goes back whatever
      // ended the run, and the throw is still the throw.

      const run = driving(async function* (framed) {
        yield* typed("watch title");
        yield ENTER;
        await framed;
        throw new Error("The keyboard went.");
      });
      await expect(run.writes).rejects.toThrow("The keyboard went.");
      expect(run.drawn.filter((write) => write.kind === "unframe").length)
        .toBe(1);
    });

    it("cancels the lens's subscription where the run threw", async () => {
      // The screen is half of it. The subscription the lens was drawing from
      // is the other, and a run that ended holds no cancel for it.

      let cancelled = 0;
      const run = driving(
        async function* (framed) {
          yield* typed("watch title");
          yield ENTER;
          await framed;
          throw new Error("The keyboard went.");
        },
        () => Promise.resolve(() => cancelled++),
      );
      await expect(run.writes).rejects.toThrow("The keyboard went.");
      // One of the two subscriptions the line took: the lens's. The watch's is
      // left armed, which is what a watch is for, and the run's own way out is
      // where that one stops (`run.ts`).
      expect(cancelled).toBe(1);
    });

    it("cancels a lens subscription that arrives after the run threw", async () => {
      // The run can end while a `watch` is still taking the lens's
      // subscription, which is a read nothing can call off. Two things on the
      // way out each see to it: the line is stopped, so the subscription comes
      // back as an interruption and is cancelled; and the lens the line has
      // already opened is closed, so a subscription it adopts anyway is
      // cancelled as it is taken. Either is enough here, and the two cases
      // after this one pin each alone.
      //
      // The run's own way out tears the session down after the prompt returns
      // (`run.ts`), which is done here by hand. The watch's own subscription is
      // cancelled whichever way the line goes — by the interruption, or by the
      // torn-down session refusing to hold it — so that cancel is the event
      // both reach, and the case waits on it rather than on a clock.
      //
      // Kills: ending the run with the line neither stopped nor what it opened
      // closed, which leaves the lens's cancel unrun.

      const shuttle = atPiece();
      const lensAsked = Promise.withResolvers<void>();
      const lensArrives = Promise.withResolvers<() => void>();
      const watchCancelled = Promise.withResolvers<void>();
      let asked = 0;
      let lensCancels = 0;
      const run = driving(
        async function* () {
          yield* typed("watch title");
          yield ENTER;
          await lensAsked.promise;
          throw new Error("The keyboard went.");
        },
        () => {
          asked++;
          if (asked === 1) {
            return Promise.resolve(() => watchCancelled.resolve());
          }
          lensAsked.resolve();
          return lensArrives.promise;
        },
        false,
        false,
        shuttle,
      );
      await expect(run.writes).rejects.toThrow("The keyboard went.");
      shuttle.session.disarmAll();
      lensArrives.resolve(() => lensCancels++);
      await watchCancelled.promise;
      expect(lensCancels).toBe(1);
    });

    it("closes a lens the line produced where the run ended before taking it", async () => {
      // The line can settle with its lens after the prompt has stopped taking
      // what lines settle with: a key stream that fails as a `watch` hands its
      // lens over is seen by the loop first, several awaits lying between a
      // verb's return and its line's outcome reaching the loop. Nothing the
      // loop holds is that lens, and stopping the line comes too late for a
      // subscription it has already adopted. What closes it is the line
      // closing, on the way out, every lens it opened.
      //
      // The key stream fails from inside the session's adoption of the watch,
      // which is the last thing a `watch` does before it returns its lens.
      //
      // Kills: ending the run without closing what the line in flight opened,
      // which leaves the lens's cancel unrun.

      const shuttle = atPiece();
      const failing = Promise.withResolvers<IteratorResult<Key>>();
      const script = [...typed("watch title"), ENTER];
      const arm = shuttle.session.arm.bind(shuttle.session);
      shuttle.session.arm = (watch) => {
        arm(watch);
        failing.reject(new Error("The keyboard went."));
      };
      let asked = 0;
      let lensCancels = 0;
      const run = driving(
        () => ({
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<Key>> =>
              script.length > 0
                ? Promise.resolve({ done: false, value: script.shift()! })
                : failing.promise,
          }),
        }),
        () => {
          asked++;
          return Promise.resolve(asked === 1 ? () => {} : () => lensCancels++);
        },
        false,
        false,
        shuttle,
      );
      await expect(run.writes).rejects.toThrow("The keyboard went.");
      expect(lensCancels).toBe(1);
    });

    it("takes no further subscription for a line the run ended under", async () => {
      // The line in flight is stopped on the way out, so a `watch` still
      // taking its first subscription goes no further once that one arrives,
      // and asks nothing more of a connection the run is closing. It is also
      // what makes closing the line's lenses on the way out enough: a lens the
      // line had not opened yet is one it now never opens.
      //
      // The watch's own cancel is the event the case waits on. Stopped, the
      // line cancels the subscription it was taking; left running, it goes on
      // to arm the watch, and the torn-down session disarms it.
      //
      // Kills: ending the run without stopping the line in flight, which lets
      // the watch go on to ask for the lens's subscription.

      const shuttle = atPiece();
      const watchAsked = Promise.withResolvers<void>();
      const watchArrives = Promise.withResolvers<() => void>();
      const watchCancelled = Promise.withResolvers<void>();
      let asked = 0;
      const run = driving(
        async function* () {
          yield* typed("watch title");
          yield ENTER;
          await watchAsked.promise;
          throw new Error("The keyboard went.");
        },
        () => {
          asked++;
          if (asked === 1) {
            watchAsked.resolve();
            return watchArrives.promise;
          }
          return Promise.resolve(() => {});
        },
        false,
        false,
        shuttle,
      );
      await expect(run.writes).rejects.toThrow("The keyboard went.");
      shuttle.session.disarmAll();
      watchArrives.resolve(() => watchCancelled.resolve());
      await watchCancelled.promise;
      expect(asked).toBe(1);
    });

    it("cancels the lens's subscription where announcing the line threw", async () => {
      // The lens arrives already holding a subscription, so the loop must be
      // holding the lens before anything that can throw. Announcing what the
      // line produced is such a thing — a terminal that will not take the
      // writing — and a lens the loop has not taken yet is one its way out
      // cannot close: no frame is ever drawn, so nothing on the screen says it
      // is there, and its sink runs for the rest of the process.
      //
      // Kills: announcing ahead of taking the lens, which leaves `cancelled`
      // at zero.

      let cancelled = 0;
      const run = driving(
        async function* () {
          yield* typed("watch title");
          yield ENTER;
        },
        () => Promise.resolve(() => cancelled++),
        true,
      );
      await expect(run.writes).rejects.toThrow(
        "The terminal would not take it.",
      );
      expect(cancelled).toBe(1);
    });

    it("ends the line though giving the screen back is what failed", async () => {
      // Two things a run owes a terminal on its way out, and they are not one:
      // the screen goes back, and the line the person was typing is ended.
      // Sharing a `try` makes the first the gate on the second, so a terminal
      // that refuses the unframe leaves the run with its last line unfinished
      // — which is the transcript a reader is left holding.
      //
      // Kills: wrapping both calls in one `try`, which records no `finish`.

      const run = driving(
        opening("watch title", typed("q")),
        () => Promise.resolve(() => {}),
        false,
        true,
      );
      // The refusal ends the run, so what it drew on the way out is read off
      // the array rather than off an answer there is none of.
      await expect(run.writes).rejects.toThrow("The screen would not go back.");
      // The last write and not merely one of them: a line ended earlier in the
      // run writes a `finish` too, so asking whether any was written is the
      // assertion that passes whether or not the way out wrote its own.
      expect(run.drawn.at(-1)?.kind).toBe("finish");
    });

    it("drops what was typed ahead of a `ctrl-c` that closed the lens", async () => {
      // The rule the loop already states at the prompt: a person who pressed
      // it to leave the frame did not mean to run what they had queued behind
      // it.

      const drawn = await typedAhead(
        "watch title",
        [...typed("pwd"), ENTER],
        [control("c")],
      ).writes;
      expect(produced(drawn).filter((text) => text.startsWith("position")))
        .toEqual([]);
    });

    /**
     * Helper for the cases below, which is a lens open over the prompt whose
     * keys carry on once a write the case is waiting for has been made.
     *
     * A line typed at a frame settles when the work behind it does, which is
     * neither when the key was read nor when the next one is typed. So the
     * keys wait on the write that says it settled — a frame carrying the
     * answer, or the announcement of it — and the wait is on that write and on
     * no clock.
     */
    function awaiting(
      after: (
        wrote: (holds: (write: Write) => boolean) => Promise<void>,
      ) => AsyncIterable<Key>,
      deps: VerbDeps = {},
      sink: () => Promise<() => void> = () => Promise.resolve(() => {}),
      also: (write: Write) => void = () => {},
    ): { writes: Promise<Write[]>; drawn: Write[] } {
      const waiting: {
        holds: (write: Write) => boolean;
        settle: () => void;
      }[] = [];
      const wrote = (holds: (write: Write) => boolean) => {
        const reached = Promise.withResolvers<void>();
        waiting.push({ holds, settle: reached.resolve });
        return reached.promise;
      };
      return driving(
        async function* (framed) {
          yield* typed("watch title");
          yield ENTER;
          await framed;
          yield* after(wrote);
        },
        sink,
        false,
        false,
        atPiece(),
        deps,
        (write) => {
          for (const held of waiting.filter((one) => one.holds(write))) {
            held.settle();
          }
          also(write);
        },
      );
    }

    /** Helper for the cases below, which is the modeline of `frame`. */
    function modeline(frame: readonly string[]): string {
      return (frame[frame.length - 2] ?? "").slice(2, -2).trimEnd();
    }

    it("runs a line typed at the frame through the dispatch a prompt uses", async () => {
      // `:` is the general mechanism a view answers with instead of a key per
      // verb, and what makes it general is that the line goes where a typed
      // line goes: the same dispatch, against the same place.

      const drawn = await awaiting(async function* (wrote) {
        yield* typed(":pwd");
        yield ENTER;
        await wrote((write) =>
          write.kind === "announce" && write.text.startsWith("position")
        );
        yield* typed("q");
      }).writes;
      expect(produced(drawn).filter((text) => text.startsWith("position")))
        .toEqual([`position  //${SPACE}/${HANDLE}@space\nscope     @space`]);
    });

    it("stands what the line said in the frame it was typed at", async () => {
      // The whole of it reaches the transcript the frame is holding back; the
      // modeline is the acknowledgement, which is what tells a person still
      // looking at the frame that the line came back at all.

      const drawn = await awaiting(async function* (wrote) {
        yield* typed(":pwd");
        yield ENTER;
        await wrote((write) =>
          write.kind === "frame" && modeline(write.rows).startsWith("position")
        );
        yield* typed("q");
      }).writes;
      expect(modeline(frames(drawn).at(-1)!)).toBe(
        `position  //${SPACE}/${HANDLE}@space`,
      );
    });

    it("stops the line rather than closing the frame on `ctrl-c`", async () => {
      // The third thing a `ctrl-c` at a frame can mean, and the one the frame
      // cannot decide for itself. The order is the prompt's own — what is
      // being typed, then the line in flight, then the way out — so a frame
      // with nothing being typed at it and a line in flight stops the line and
      // stays up.
      //
      // Kills: reading `ctrl-c` as the way out before asking whether a line is
      // in flight, which gives the screen back with the line still running.

      const read = gated();
      const run = awaiting(
        async function* (wrote) {
          yield* typed(":ls");
          yield ENTER;
          await read.started;
          yield control("c");
          await wrote((write) =>
            write.kind === "announce" && write.text === "Interrupted."
          );
          yield* typed("q");
        },
        { listing: { getCellValue: read.read } },
      );
      const drawn = await run.writes;
      const stopped = drawn.findIndex((write) =>
        write.kind === "announce" && write.text === "Interrupted."
      );
      const gave = drawn.findIndex((write) => write.kind === "unframe");
      expect(stopped).toBeGreaterThan(-1);
      expect(gave).toBeGreaterThan(stopped);
    });

    it("closes the frame on the second `ctrl-c`, and not on the first or the end", async () => {
      // The first `ctrl-c` stops the line and the frame stays up, which the
      // case above pins on its own. This one is about the second: it is the way
      // out, and the frame is gone before the keys run out rather than because
      // they did.
      //
      // Both of those are excluded rather than assumed. A `pwd` typed after it
      // runs only at a prompt — at a frame its keys are a motion the view does
      // not take — so the position it wrote is what says the frame had already
      // gone; and the screen is watched from the moment the first key is sent,
      // so a frame that went then would be seen going.
      //
      // What is still not excluded, said because two reviewers have read this
      // case as claiming it: the window the fix closes, between a cancel's
      // signal and the outcome three or four turns of the microtask queue
      // later. Two keys both landing inside it is not arrangeable from here —
      // the settle is already in flight when the second key is asked for — so
      // these assertions hold on the behavior before the fix as well. What
      // guards the window is that there is no second state to get wrong:
      // `Running.stopped()` is the abort signal itself.

      const read = gated();
      let second = false;
      let wentEarly = false;
      const run = awaiting(
        async function* (wrote) {
          yield* typed(":ls");
          yield ENTER;
          await read.started;
          const interrupted = wrote((write) =>
            write.kind === "announce" && write.text === "Interrupted."
          );
          yield control("c");
          await interrupted;
          second = true;
          yield control("c");
          const ran = wrote((write) =>
            write.kind === "announce" && write.text.startsWith("position")
          );
          yield* typed("pwd");
          yield ENTER;
          await ran;
        },
        { listing: { getCellValue: read.read } },
        () => Promise.resolve(() => {}),
        (write) => {
          if (write.kind === "unframe" && !second) wentEarly = true;
        },
      );
      const drawn = await run.writes;
      expect(wentEarly).toBe(false);
      expect(drawn.filter((write) => write.kind === "unframe").length).toBe(1);
      const gave = drawn.findIndex((write) => write.kind === "unframe");
      const ran = drawn.findIndex((write) =>
        write.kind === "announce" && write.text.startsWith("position")
      );
      expect(ran).toBeGreaterThan(gave);
    });

    it("abandons the line being typed at the frame before the one in flight", async () => {
      // Innermost first. A search opened while a line is still running is what
      // a `ctrl-c` reaches there, and the line goes on to settle: a person
      // taking back what they were typing did not ask for the work to stop.
      //
      // Kills: stopping the line in flight whenever there is one, which
      // answers this line as interrupted instead of listing what it read.

      const read = gated();
      const run = awaiting(
        async function* (wrote) {
          yield* typed(":ls");
          yield ENTER;
          await read.started;
          yield* typed("/depth");
          yield control("c");
          // Registered before the read is answered, so the wait is on the
          // drawing that answer causes rather than on one already made.
          const settled = wrote((write) => write.kind === "frame");
          read.answer({});
          await settled;
          yield* typed("q");
        },
        { listing: { getCellValue: read.read } },
      );
      expect(produced(await run.writes)).not.toContain("Interrupted.");
    });

    it("opens the cell the frame watches in the editor on `e`", async () => {
      // `e` composes a line rather than reaching an editor, so what this
      // drives is the composition: the reference the lens carries has to be
      // one the line grammar resolves back to the cell the frame is watching.
      // A lens holding the short form the frame is titled with would compose a
      // line that refuses, and nothing inside the lens could tell.
      //
      // Kills: composing the line out of the label rather than the reference,
      // which reaches `edit` with a name the grammar does not take.

      const edited: string[] = [];
      await awaiting(
        async function* (wrote) {
          yield* typed("e");
          await wrote((write) => write.kind === "announce");
          yield* typed("q");
        },
        {
          getCellValue: () => Promise.resolve("a title"),
          editText: (text) => {
            edited.push(text);
            return Promise.resolve(
              {
                kind: "refused",
                reason: "The editor was closed.",
              } as const,
            );
          },
        },
      ).writes;
      expect(edited).toEqual(['"a title"']);
    });

    it("turns down a second view and says which line it was", async () => {
      // One frame at a time. A line typed at a frame can be any line, and one
      // of them opens a view — so this is the arm where a second arrives. The
      // line itself ran and is not taken back: the watch it armed is armed.
      //
      // Kills: adopting the arriving lens over the open one, which leaves the
      // first lens's subscription running with no frame drawing it.

      let cancels = 0;
      const run = awaiting(
        async function* (wrote) {
          yield* typed(":watch label");
          yield ENTER;
          await wrote((write) =>
            write.kind === "announce" && write.text.startsWith("One frame")
          );
          yield* typed("q");
        },
        {},
        () => Promise.resolve(() => cancels++),
      );
      const drawn = await run.writes;
      expect(produced(drawn)).toContain(
        "One frame at a time, so this line's view was not opened.",
      );
      expect(drawn.filter((write) => write.kind === "unframe").length).toBe(1);
      // What the second line did land: a second watch, numbered beside the
      // first, which is the listing that line produced.
      expect(produced(drawn)).toContain(
        `%1 ${WATCHED}\n%2 ${HANDLE}/label @space`,
      );
      // Two of the four subscriptions the two lines took are cancelled, and
      // they are the two lenses': the one turned down as it arrived, and the
      // one the open frame held, on the way out. The two watches' own go on
      // firing, which is what a watch is for — the run's way out is where
      // those stop (`run.ts`).
      expect(cancels).toBe(2);
    });

    it("places a cursor on the frame only where it is being typed at", async () => {
      // A frame is read until something is being typed at it, and a cursor on
      // one that is only read sits wherever the last row's drawing ended and
      // reads as a place a person could type.

      const drawn = await awaiting(async function* () {
        yield* typed(":");
        yield control("c");
        yield* typed("q");
      }).writes;
      const cursors = drawn.filter((write) => write.kind === "frame")
        .map((write) => write.cursor);
      expect(cursors[0]).toBeUndefined();
      // Past the frame's left edge, the space after it, and the `: ` the
      // command line opens with.
      expect(cursors[1]).toEqual({ row: 23, column: 5 });
      expect(cursors.at(-1)).toBeUndefined();
    });

    it("runs a line typed ahead of the frame once the lens has closed", async () => {
      // Held keys wait for the prompt rather than reaching the lens: a line
      // typed while `watch` was still arming is a line, and the frame that
      // opened over it is not where it runs.

      const drawn = await typedAhead(
        "watch title",
        [...typed("pwd"), ENTER],
        typed("q"),
      ).writes;
      expect(produced(drawn).filter((text) => text.startsWith("position")))
        .toEqual([`position  //${SPACE}/${HANDLE}@space\nscope     @space`]);
    });
  });

  describe("completing a token", () => {
    // What `tab` does at the prompt. Which candidates a position offers is
    // pinned in `shuttle-completion.test.ts`; these are about the loop the
    // read runs inside.

    /** Helper for the cases below, which is the read a listing makes. */
    function listing(read: Gated): VerbDeps {
      return { listing: { getCellValue: read.read } };
    }

    it("draws the completed line, with the cursor at its end", async () => {
      const writes = await running([...typed("pw"), TAB]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}pwd`,
        column: 21,
      });
    });

    it("leaves the line alone where the cursor is not at its end", async () => {
      // The token a completion finishes is the one the line ends in, so a
      // cursor standing anywhere else is standing in a token this is not
      // completing.

      const writes = await running([...typed("pw"), control("a"), TAB]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}pw`,
        column: 18,
      });
    });

    it("writes onto the line it was computed for and onto no other", async () => {
      // A read cannot be called off once sent, so its answer may reach a line
      // that has moved on. Writing `cd title` here would take back the `m`
      // the person typed while the read was out.

      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("cd ti");
          yield TAB;
          await read.started;
          yield* typed("m");
          read.answer({ title: 1 });
        })(),
        atPiece(),
        listing(read),
      );
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_PIECE}cd tim`,
        column: [...AT_PIECE].length + 6,
      });
    });

    it("holds `enter` typed under a completion, and runs the line it completed", async () => {
      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get ti");
          yield TAB;
          await read.started;
          yield ENTER;
          read.answer({ title: 1, tail: 2 });
        })(),
        atPiece(),
        {
          ...listing(read),
          // Answering by path is what makes the line that ran readable: the
          // held `enter` runs whatever is on the buffer, and only the
          // completed line reads `title`.
          getCellValue: (_config, path) =>
            Promise.resolve(path[0] === "title" ? "the title" : "the tail"),
        },
      );
      expect(produced(writes)[0]).toContain("the title");
    });

    it("leaves `tab` alone while a line is in flight, and is not held either", async () => {
      // A line that is running is one that may be about to move the place a
      // completion reads against, so `tab` is not a completion there — and it
      // is not held for later either, since the token it would finish is on a
      // line the person is still typing.

      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get");
          yield ENTER;
          await read.started;
          yield* typed("pw");
          yield TAB;
          read.answer({ title: "a" });
        })(),
        atPiece(),
        { getCellValue: read.read },
      );
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_PIECE}pw`,
        column: [...AT_PIECE].length + 2,
      });
    });

    it("frees the prompt on `ctrl-c` where the read never answers", async () => {
      // The one thing `ctrl-c` at a server that has gone quiet is for. A read
      // already sent cannot be called off, so what the prompt does is stop
      // waiting on it — and the `pwd` behind it is the evidence that it did.

      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get ti");
          yield TAB;
          await read.started;
          yield control("c");
          yield* typed("pwd");
          yield ENTER;
        })(),
        atPiece(),
        listing(read),
      );
      expect(produced(writes)).toEqual([
        `position  //${SPACE}/${HANDLE}@space\nscope     @space`,
      ]);
    });

    it("ends the line being completed on `ctrl-c`, which is still the line being typed", async () => {
      // A verb's line was ended where it was taken and what is under it is
      // the next one; a completion's line is the one on the screen, so
      // throwing it away leaves it there and draws a fresh prompt below.

      const read = gated();
      const writes = await running(
        (async function* () {
          yield* typed("get ti");
          yield TAB;
          await read.started;
          yield control("c");
        })(),
        atPiece(),
        listing(read),
      );
      const typing = writes.findLastIndex((write) =>
        write.kind === "edit" && write.text === `${AT_PIECE}get ti`
      );
      expect(typing).toBeGreaterThan(-1);
      expect(writes[typing + 1]).toEqual({ kind: "finish" });
    });
  });
});
