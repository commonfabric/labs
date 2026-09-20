/**
 * Unit tests for what `tab` finishes: the token a line ends in, completed
 * against the verbs and against what stands where shuttle stands.
 *
 * Every read is stood in through the deps bag, so what is under test is which
 * candidates a position offers and what is written back onto the line, with no
 * socket and no server behind any of it. Where a completion lands on the
 * screen is the prompt's (`shuttle-prompt.test.ts`).
 *
 * The verb words are read off the dispatch rather than written here, so a case
 * about "the word that names a verb" stays a case about the table rather than
 * a copy of it that would go quietly stale.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";

import type { SpaceConfig } from "../lib/piece.ts";
import { completeLine } from "../lib/shuttle/completion.ts";
import { HeldConnection } from "../lib/shuttle/connection.ts";
import { ExternalLocation } from "../lib/shuttle/external.ts";
import { CurrentPlace } from "../lib/shuttle/place.ts";
import { ShuttleSession } from "../lib/shuttle/session.ts";
import { moved } from "./shuttle-place-helpers.ts";
import { VERB_WORDS } from "../lib/shuttle/verbs.ts";
import type { Shuttle, VerbDeps } from "../lib/shuttle/vocabulary.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/**
 * The spelling a piece reports its own id as, and so the spelling the pieces
 * facet lists one under.
 */
const BARE_HANDLE = "fid1:abcdefghijklmnop";

/**
 * A second piece, so that a completion over the facet's rows decides by more
 * than the `fid1:` opening every handle shares.
 */
const OTHER_BARE_HANDLE = "fid1:qrstuvwxyz012345";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/** Helper for the cases below, which fails whichever read a case reaches. */
const READS_NOTHING: VerbDeps = {
  listing: {
    listSpaceSlugs: () => {
      throw new Error("The slug index was read.");
    },
    listPieces: () => {
      throw new Error("The pieces were read.");
    },
    getCellValue: () => {
      throw new Error("The cell was listed.");
    },
  },
};

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

/** Helper for the cases below, which stands `value` in for the cell read. */
function holding(value: unknown): VerbDeps {
  return {
    ...READS_NOTHING,
    listing: {
      ...READS_NOTHING.listing,
      getCellValue: () => Promise.resolve(value),
    },
  };
}

/** Helper for the cases below, which stands `slugs` in for the slug index. */
function slugged(...slugs: readonly string[]): VerbDeps {
  return {
    ...READS_NOTHING,
    listing: {
      ...READS_NOTHING.listing,
      listSpaceSlugs: () =>
        Promise.resolve(slugs.map((slug) => ({ slug, piece: HANDLE }))),
    },
  };
}

/** Helper for the cases below, which stands `ids` in for the space's pieces. */
function pieced(...ids: readonly string[]): VerbDeps {
  return {
    ...READS_NOTHING,
    listing: {
      ...READS_NOTHING.listing,
      listPieces: () =>
        Promise.resolve(ids.map((id) => ({ id, name: "Thermostat" }))),
    },
  };
}

/** Helper for the cases below, which is a signal already aborted. */
function cancelled(): AbortSignal {
  const stopper = new AbortController();
  stopper.abort();
  return stopper.signal;
}

/**
 * Helper for the case below, which is the shortest proper prefix of `word`
 * that no other word in `words` opens with, and nothing where every one of
 * them opens another word too.
 *
 * Nothing is an answer about the set rather than a failure to find one: a
 * two-letter verb beside a longer one that opens the same way — `cd` beside
 * `call`, `ls` beside `link` — is told apart from it only by its last
 * character, so the typing that names it alone is the whole of it.
 */
function ownPrefix(
  word: string,
  words: readonly string[],
): string | undefined {
  for (let cut = 1; cut < word.length; cut++) {
    const prefix = word.slice(0, cut);
    const shared = words.some((other) =>
      other !== word && other.startsWith(prefix)
    );
    if (!shared) return prefix;
  }
  return undefined;
}

describe("completion", () => {
  describe("completeLine() over the verbs", () => {
    it("writes the verb a prefix names, where it names one", async () => {
      expect(await completeLine(shuttleIn(), "pw", READS_NOTHING))
        .toBe("pwd");
    });

    it("reads nothing to answer, the verbs being a table rather than a read", async () => {
      // `READS_NOTHING` raises on every read there is, so a case that answers
      // under it is a case in which none was made.

      expect(await completeLine(shuttleIn(), "wi", READS_NOTHING))
        .toBe("wish");
    });

    it("leaves every verb the table declares whole, from the typing that names it alone", async () => {
      // The claim ranges over the verbs, so the enumeration is written out
      // and held to the table beside it. Ranging over `VERB_WORDS` alone
      // would close nothing: the words offered and the words walked would be
      // the same array, so a word missing from it would be a word this never
      // asked about.
      //
      // What is asked of each is that the shortest typing naming it alone
      // leaves the whole verb on the line. For most that means a completion
      // wrote the rest; for a verb every proper prefix of which opens another
      // verb too, it means the typing was already the word. Both are the same
      // sentence about what a person has in front of them, which is why they
      // are one assertion rather than two cases — and a verb the completion
      // does not know at all fails it either way, the line standing at the
      // prefix it was given.

      const words = [
        "call",
        "cd",
        "describe",
        "edit",
        "get",
        "help",
        "link",
        "ls",
        "more",
        "pwd",
        "set",
        "unwatch",
        "verbs",
        "watch",
        "watches",
        "where",
        "wish",
        "xcd",
        "xpwd",
      ];
      expect([...VERB_WORDS]).toEqual(words);
      for (const word of words) {
        const typed = ownPrefix(word, words) ?? word;
        const written = await completeLine(shuttleIn(), typed, READS_NOTHING);
        // `written ?? typed` is the line as it stands afterwards, a
        // completion that wrote nothing having left it as it was.
        expect({ word, line: written ?? typed })
          .toEqual({ word, line: word });
      }
    });

    it("writes as far as several verbs agree, and no further", async () => {
      // `where` and `wish` share `w`, so the shared opening is what a `tab` on
      // it can write.

      expect(await completeLine(shuttleIn(), "w", READS_NOTHING))
        .toBeUndefined();
      expect(await completeLine(shuttleIn(), "wh", READS_NOTHING))
        .toBe("where");
    });

    it("writes nothing where the prefix names no verb", async () => {
      expect(await completeLine(shuttleIn(), "zz", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes nothing where the word is already whole", async () => {
      expect(await completeLine(shuttleIn(), "pwd", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes nothing for the empty line, every verb standing there", async () => {
      expect(await completeLine(shuttleIn(), "", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes a verb for `help`, which is what its operand names", async () => {
      expect(await completeLine(shuttleIn(), "help pw", READS_NOTHING))
        .toBe("help pwd");
    });
  });

  describe("completeLine() over what stands at the place", () => {
    it("writes the facet a prefix names at a space root", async () => {
      expect(await completeLine(shuttleIn(), "cd sl", READS_NOTHING))
        .toBe("cd slugs");
    });

    it("writes a slug the index records, under the facet that lists them", async () => {
      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      expect(await completeLine(shuttle, "cd bo", slugged("board", "topics")))
        .toBe("cd board");
    });

    it("writes a piece's whole handle, under the facet that lists them", async () => {
      // The handle a piece is listed under is the handle `cd` takes to it, so
      // what a completion writes is a line that runs. The name the row also
      // carries is no address and is offered by nothing: a completion writes
      // what reaches the row.

      const shuttle = shuttleIn();
      moved(shuttle.place, "pieces");
      expect(
        await completeLine(
          shuttle,
          `cd ${BARE_HANDLE.slice(0, 8)}`,
          pieced(
            BARE_HANDLE,
            OTHER_BARE_HANDLE,
          ),
        ),
      ).toBe(`cd ${BARE_HANDLE}`);
    });

    it("writes a key of the cell shuttle stands in", async () => {
      // `entities` holds `ti` without opening with it, so the filter is a
      // prefix test rather than a search.

      expect(
        await completeLine(
          atPiece(),
          "cd ti",
          holding({ title: "a", entities: 1 }),
        ),
      ).toBe("cd title");
    });

    it("writes the key for `get`, whose operand takes what `cd` takes", async () => {
      expect(
        await completeLine(atPiece(), "get ti", holding({ title: "a" })),
      ).toBe("get title");
    });

    it("writes the key for `ls`, whose operand names the place to list", async () => {
      // The arm `ls` declares is the one that carries a slot to fill, so a
      // target is offered where a target may be written — the same candidates
      // `cd` and `get` are offered, from the one listing under the place.

      expect(
        await completeLine(atPiece(), "ls ti", holding({ title: "a" })),
      ).toBe("ls title");
    });

    it("writes every key where the token being completed is empty", async () => {
      expect(await completeLine(atPiece(), "cd ", holding({ title: "a" })))
        .toBe("cd title");
    });

    it("writes a key whose name needs quoting as the token that names it", async () => {
      expect(
        await completeLine(atPiece(), "cd my", holding({ "my key": 1 })),
      ).toBe("cd 'my key'");
    });

    it("writes a key the name alone would not reach as the reference that does", async () => {
      // A key called `..` is a reading rather than a name, so the operand
      // `operandForChild` offers is `./..` — which is what the listing prints
      // for the same row, and what `cd` takes back to it. What is typed is the
      // opening of that operand, since a completion extends the token on the
      // line rather than swapping it for another spelling.

      const written = await completeLine(
        atPiece(),
        "cd .",
        holding({ "..": 1 }),
      );
      expect(written).toBe("cd ./..");
    });

    it("writes a key opening with `#` behind the `.` head", async () => {
      // Kills a completion that offers such a key bare, which `cd` reads as a
      // wish target. The token is quoted, `#` being a character the printer
      // quotes wherever it sits.

      expect(await completeLine(atPiece(), "cd ./#", holding({ "#tag": 1 })))
        .toBe("cd './#tag'");
    });

    it("offers no key that neither its name nor a reference reaches", async () => {
      // A key holding a line break has no operand at all — no door admits it
      // — so there is nothing to write that would take the line to the row,
      // and the row is left out rather than offered under a name that
      // reaches nothing.

      expect(await completeLine(atPiece(), "cd a", holding({ "a\nb": 1 })))
        .toBeUndefined();
    });

    it("offers no key under a name that is not the token reaching it", async () => {
      // The bound the case above leaves: `..` is the row's name and not its
      // operand, so typing it is not typing the beginning of what `cd` takes.

      expect(await completeLine(atPiece(), "cd ..", holding({ "..": 1 })))
        .toBeUndefined();
    });

    it("writes nothing where several keys agree only on a partial that needs quoting", async () => {
      // `'my ` is a quote nothing closes, so what agrees is not a token and is
      // not written; the row is reached by typing on.

      expect(
        await completeLine(
          atPiece(),
          "cd my",
          holding({ "my key": 1, "my other": 2 }),
        ),
      ).toBeUndefined();
    });

    it("writes as far as several keys agree where the agreement is bare", async () => {
      expect(
        await completeLine(atPiece(), "cd t", holding({ title: 1, titles: 2 })),
      ).toBe("cd title");
    });

    it("writes nothing where no key matches the prefix", async () => {
      expect(await completeLine(atPiece(), "cd zz", holding({ title: 1 })))
        .toBeUndefined();
    });

    it("writes nothing where the read failed, rather than raising", async () => {
      // A tab is not a request for an answer about the fabric, so a read that
      // failed offers nothing where `ls` reports the failure.

      expect(await completeLine(atPiece(), "cd ti", READS_NOTHING))
        .toBeUndefined();
    });
  });

  describe("completeLine() over where a token may stand", () => {
    it("writes nothing for a verb that takes no operand", async () => {
      expect(await completeLine(shuttleIn(), "pwd sl", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes nothing for a second operand where the verb takes one", async () => {
      expect(await completeLine(shuttleIn(), "cd slugs sl", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes nothing after a word that names no verb", async () => {
      expect(await completeLine(shuttleIn(), "lss sl", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes nothing for `wish`, whose operand is a name the fabric holds", async () => {
      expect(await completeLine(shuttleIn(), "wish sl", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes the dimension `where` sets, which is a word this process holds", async () => {
      // The third of the three surfaces, and it is one for the same reason
      // the other two are: the words are a table this process already has,
      // so answering costs no read.

      expect(await completeLine(shuttleIn(), "where sc", READS_NOTHING))
        .toBe("where scope");
      expect(await completeLine(shuttleIn(), "where ex", READS_NOTHING))
        .toBe("where external");
    });

    it("writes nothing for the value `where` sets a dimension to", async () => {
      // What the slot takes depends on the dimension named before it — a
      // scope word for one, a path outside the fabric for the other — and a
      // slot declares what it offers for the position rather than for the
      // line that reached it, so there is no answer right for both.

      expect(await completeLine(shuttleIn(), "where scope @ses", READS_NOTHING))
        .toBeUndefined();
      expect(
        await completeLine(shuttleIn(), "where external ../f", READS_NOTHING),
      )
        .toBeUndefined();
    });

    it("writes nothing where the line asked for the verb's page", async () => {
      expect(await completeLine(shuttleIn(), "cd --help sl", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes nothing where the token before it is an option's value", async () => {
      // `--select` takes a value, so the token after it is that value and not
      // the verb's operand — on a verb that does take one, which is what
      // makes the position rather than the arity the reason.

      expect(
        await completeLine(atPiece(), "get --select ti", holding({ title: 1 })),
      ).toBeUndefined();
    });

    it("writes the operand after a bare `--`, which ends the options", async () => {
      expect(await completeLine(shuttleIn(), "cd -- sl", READS_NOTHING))
        .toBe("cd -- slugs");
    });

    it("writes the operand after an option the verb declares", async () => {
      expect(
        await completeLine(atPiece(), "get --json ti", holding({ title: 1 })),
      ).toBe("get --json title");
    });

    // A verb taking two operands declares a candidate for each, so which
    // position a token stands in decides what is offered for it. The three
    // cases below are the three answers the table gives at a second position,
    // and each is a different fact about the verb rather than about the
    // grammar: `link` writes a reference and both ends are places, `set`
    // writes a value that nothing enumerates, and `call`'s name belongs to
    // the receiver rather than to the place shuttle stands at.

    it("writes a key at either end of `link`, both being places", async () => {
      const cells = holding({ title: 1, latest: 2 });
      expect(await completeLine(atPiece(), "link ti", cells))
        .toBe("link title");
      expect(await completeLine(atPiece(), "link title la", cells))
        .toBe("link title latest");
    });

    it("writes a key for `set`'s path and nothing for the value after it", async () => {
      const cells = holding({ title: 1, latest: 2 });
      expect(await completeLine(atPiece(), "set ti", cells))
        .toBe("set title");
      expect(await completeLine(atPiece(), "set title la", cells))
        .toBeUndefined();
    });

    it("writes a key for `call`'s receiver and nothing for the name after it", async () => {
      // The name is a callable of the receiver the line names, not a row of
      // the place shuttle stands at, so offering one is a read of somewhere
      // the line has not moved to — which is a completion of its own.

      const cells = holding({ title: 1, latest: 2 });
      expect(await completeLine(atPiece(), "call ti", cells))
        .toBe("call title");
      expect(await completeLine(atPiece(), "call title la", cells))
        .toBeUndefined();
    });

    it("writes nothing in the section a callable's own grammar reads", async () => {
      // Past `call`'s own two operands the words are the callable's, and this
      // dispatch does not read them — so the position is past the end of what
      // the verb declared rather than a position declared empty.

      expect(
        await completeLine(
          atPiece(),
          "call title verb la",
          holding({ title: 1, latest: 2 }),
        ),
      ).toBeUndefined();
    });
  });

  describe("completeLine() over the line's own reading", () => {
    it("completes the token the split reads, not the run after the last separator", async () => {
      // An escaped separator is a character of its token, so the token here is
      // the value of `--select` and the position is an option's value rather
      // than an operand.
      //
      // The place is the one that parts the two readings, and it has to be
      // chosen rather than assumed. A reading taking the run after the last
      // separator finds `sl`, and splitting the head it leaves behind reads
      // `--select` as satisfied by `a ` — so it looks for a row opening with
      // `sl`. At a piece there is no such row and the two readings agree on
      // answering nothing, which is a case that would pass against the very
      // fault it is written for. At a space root `slugs` opens with it, and
      // the faulty reading writes `get --select a\\ slugs` — the option's own
      // value rewritten to reach a row.

      expect(
        await completeLine(shuttleIn(), "get --select a\\ sl", READS_NOTHING),
      ).toBeUndefined();
    });

    it("reads the tokens before that one as the whole ones, and not it among them", async () => {
      // The same line at a place holding a row the token's *value* opens —
      // `a slug` opens with `a sl`. So a reading that counted the token being
      // typed among the tokens before it would read `--select` as satisfied,
      // find an operand position, and write `get --select 'a slug'`.

      expect(
        await completeLine(
          atPiece(),
          "get --select a\\ sl",
          holding({ "a slug": 1 }),
        ),
      ).toBeUndefined();
    });

    it("completes a token whose separator was quoted, as the value it splits to", async () => {
      // The same reading read the other way: the token is `my ke`, which opens
      // where the quote does, so what is written replaces the whole of it.

      expect(
        await completeLine(atPiece(), "cd 'my ke'", holding({ "my key": 1 })),
      ).toBe("cd 'my key'");
    });

    it("writes nothing where the line ends in a quote that never closes", async () => {
      // Where the token being typed opens is exactly what such a line does
      // not yet say, so there is nothing to complete rather than a guess to
      // make.

      expect(await completeLine(shuttleIn(), "cd 'unclosed sl", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes nothing where the line ends in a backslash escaping nothing", async () => {
      expect(await completeLine(shuttleIn(), "cd sl\\", READS_NOTHING))
        .toBeUndefined();
    });

    it("keeps the line before the token exactly as it was written", async () => {
      expect(await completeLine(shuttleIn(), "  cd   sl", READS_NOTHING))
        .toBe("  cd   slugs");
    });

    it("completes a prefix that opens a child's own multi-segment operand", async () => {
      // Nothing gates a candidate on its shape, and this is the row that shows
      // why nothing may: `..` is a reading rather than a name, so the operand
      // reaching it is `./..` — which carries the separator. A rule turning
      // down a prefix holding one would put this row out of reach.

      expect(
        await completeLine(atPiece(), "cd ./.", holding({ "..": 1 })),
      ).toBe("cd ./..");
    });

    it("writes nothing for a name that stands somewhere other than here", async () => {
      // The bound on the case above, and it is a bound on the candidates
      // rather than a rule about the prefix: no row standing at the root is
      // called `slugs/bo`. The row it names stands inside `slugs/`, and
      // reaching one there is a read of a place the line has not moved to.

      expect(await completeLine(shuttleIn(), "cd slugs/bo", READS_NOTHING))
        .toBeUndefined();
    });

    it("writes a common prefix in whole characters, so a pair is never cut in half", async () => {
      // The two keys part inside a surrogate pair, so a common prefix counted
      // in code units would agree one unit past the last character they share
      // and hand back a string ending in half of one — which a terminal cannot
      // draw and which the next character typed lands after rather than
      // completing. They agree on `face` and no further, so nothing is
      // written.

      expect(
        await completeLine(
          atPiece(),
          "cd face",
          holding({ "face\u{1f600}": 1, "face\u{1f601}": 2 }),
        ),
      ).toBeUndefined();

      // And the character itself is written where it is shared whole.
      expect(
        await completeLine(
          atPiece(),
          "cd x",
          holding({ "x\u{1f600}a": 1, "x\u{1f600}b": 2 }),
        ),
      ).toBe("cd x\u{1f600}");
    });
  });

  describe("completeLine() under a cancel", () => {
    it("reads nothing where the line was cancelled before the read", async () => {
      // The claim is about the read rather than about the answer, so the case
      // watches the read: an answer of nothing is what a cancelled line gets
      // either way, and would say nothing about whether the read went out.

      let read = false;
      const written = await completeLine(atPiece(), "cd ti", {
        listing: {
          getCellValue: () => {
            read = true;
            return Promise.resolve({ title: 1 });
          },
        },
        signal: cancelled(),
      });
      expect(read).toBe(false);
      expect(written).toBeUndefined();
    });

    it("writes nothing where the line was cancelled while the read was out", async () => {
      // The read is answered and the cancel arrives with it, which is the one
      // a check cannot stop from being sent — so what the guard after it
      // stops is the answer being written.

      const stopper = new AbortController();
      const written = await completeLine(atPiece(), "cd ti", {
        ...READS_NOTHING,
        listing: {
          ...READS_NOTHING.listing,
          getCellValue: () => {
            stopper.abort();
            return Promise.resolve({ title: 1 });
          },
        },
        signal: stopper.signal,
      });
      expect(written).toBeUndefined();
    });

    it("writes what it read where nothing cancelled the line", async () => {
      // The control for the two above: the same read, the same signal, and
      // nobody aborting it.

      const stopper = new AbortController();
      expect(
        await completeLine(atPiece(), "cd ti", {
          ...holding({ title: 1 }),
          signal: stopper.signal,
        }),
      ).toBe("cd title");
    });
  });
});
