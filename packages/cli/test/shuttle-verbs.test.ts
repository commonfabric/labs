/**
 * Unit tests for the verbs a line names and the dispatch that picks one.
 *
 * Every read a verb makes is `packages/cli`'s, and every case stands its own
 * in through the deps bag, so what is under test is the composing — which read
 * a verb reaches, what it is handed, and what comes back as an outcome — with
 * no socket, no server and no piece behind any of it. One case is the
 * exception and drives the real derivation: which space a name denotes is a
 * fact two callers have to agree about, so that case asks both.
 *
 * The connection is a borrowed one in every case but one. No verb opens or
 * closes one, so which arm a case stands it up through decides nothing here,
 * and the borrowed arm is the one that needs no opener behind it. The
 * exception is `where` over a connection that will not open, which is the one
 * question the arm decides: the borrowed arm has a controller already, so only
 * an owned one can be asked what it answers when the opening fails.
 *
 * Two properties the file exists for run through it. A read never moves the
 * place, and a move never happens twice, so each of the two verbs that resolve
 * an operand is asked what it left behind as well as what it returned. And
 * nothing here writes: the dispatch hands its outcome back, so a prompt drawing
 * its own screen is never written over from underneath.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import { SlugResolutionError } from "@commonfabric/piece";
import type { PiecesController } from "@commonfabric/piece/ops";

import { UI } from "@commonfabric/runner";

import { ValidationError } from "@cliffy/command";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { BaseFabricSpecialObject } from "@commonfabric/data-model/fabric-bases";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { pieceDataCommand } from "../commands/piece.ts";
import {
  type CellSelection,
  LINK_MARKER_KEY,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import { LinkValidationError } from "../lib/piece.ts";
import type {
  GetCellValueOptions,
  PieceCallableListing,
  PieceConfig,
  SpaceConfig,
} from "../lib/piece.ts";
import { HeldConnection } from "../lib/shuttle/connection.ts";
import { ExternalLocation } from "../lib/shuttle/external.ts";
import { CurrentPlace, operandForChild } from "../lib/shuttle/place.ts";
import { ShuttleSession } from "../lib/shuttle/session.ts";
import { ASSUMED_ROWS } from "../lib/shuttle/page.ts";
import { renderValue } from "../lib/shuttle/value.ts";
import { moved } from "./shuttle-place-helpers.ts";
import { runLine } from "../lib/shuttle/verbs.ts";
import type { ValueLens } from "../lib/shuttle/lens.ts";
import type { Outcome, Shuttle, VerbDeps } from "../lib/shuttle/vocabulary.ts";
import type { WishReadConfig } from "../lib/wish.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const OTHER_SPACE = "did:key:z6MkHomeSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/**
 * The spelling a piece reports its own id as, and so the spelling the pieces
 * facet prints beside a row number.
 */
const BARE_HANDLE = "fid1:abcdefghijklmnop";

/** The handle the space's index points the slug `board` at. */
const BOARD = "of:fid1:qrstuvwxyz012345";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/** The space name every shuttle here is opened under unless a case says so. */
const SPACE_NAME = "board";

/**
 * Helper for the cases below, which is a controller that answers for the space
 * it was opened over and nothing else. `name` is what a session opened by name
 * recorded, and its absence is what one opened by a DID recorded instead;
 * `space` is the DID that session settled on, which every case but one leaves
 * agreeing with the place.
 *
 * `name` takes no default, because an explicit `undefined` runs one — and the
 * arm with no name is the one a default would quietly hide.
 */
function controller(
  name: string | undefined,
  space: MemorySpace = SPACE,
): PiecesController {
  return {
    dispose: () => Promise.resolve(),
    getSpace: () => space,
    getSpaceName: () => name,
    entityIdExists: () => Promise.resolve(true),
  } as unknown as PiecesController;
}

/**
 * Helper for the cases below, which is a controller whose space answers
 * `holds` when a handle is looked up in it.
 *
 * The three answers are the lookup's own: `true` where the space holds the
 * piece, `false` where it does not, and `undefined` where the server does not
 * advertise the lookup and so says nothing either way. It takes no default for
 * the reason {@link controller}'s `name` takes none — `undefined` is one of
 * the answers rather than the absence of one.
 */
function lookingUp(holds: boolean | undefined): PiecesController {
  return {
    dispose: () => Promise.resolve(),
    getSpace: () => SPACE,
    getSpaceName: () => SPACE_NAME,
    entityIdExists: () => Promise.resolve(holds),
  } as unknown as PiecesController;
}

/** Helper for the cases below, which is the controller a shuttle borrows. */
const PIECES = controller(SPACE_NAME);

/** Helper for the cases below, which fails whichever read a case reaches. */
const READS_NOTHING: VerbDeps = {
  getCellValue: () => {
    throw new Error("A cell was read.");
  },
  readWish: () => {
    throw new Error("A wish was resolved.");
  },
  resolvePieceReference: () => {
    throw new Error("A piece was resolved.");
  },
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
    listCallableKeys: () => {
      throw new Error("The cell's callables were listed.");
    },
  },
  setCellValue: () => {
    throw new Error("A cell was written.");
  },
  linkPieces: () => {
    throw new Error("A reference was written.");
  },
  // Answered rather than refused, because warming is not a read a case
  // arranges: reaching into a piece warms it (decision 10), so every line that
  // touches one warms it, and a fixture that threw here would fail every such
  // case for doing what the verb is meant to do. It answers with the piece the
  // config named, which is what a resolution spending no collection segment
  // returns.
  warmPiece: (config) => Promise.resolve({ piece: config.piece }),
  listPieceCallables: () => {
    throw new Error("The callables were listed.");
  },
  describePiece: () => {
    throw new Error("A piece was described.");
  },
  callFromCommand: () => {
    throw new Error("A call was dispatched.");
  },
  sinkCellValue: () => {
    throw new Error("A cell was subscribed to.");
  },
};

/**
 * Helper for the cases below, which is a shuttle standing at the space root,
 * over a connection opened as `pieces` says it was.
 */
function shuttleIn(pieces: PiecesController = PIECES): Shuttle {
  return {
    config: CONFIG,
    place: new CurrentPlace(SPACE),
    external: new ExternalLocation(new URL("file:///work/"), "/home/someone"),
    connection: new HeldConnection({ kind: "borrowed", pieces }),
    session: new ShuttleSession(),
    invocationSession: "a-session",
  };
}

/** Helper for the cases below, which stands at a piece, at `path` inside it. */
function atPiece(...path: string[]): Shuttle {
  const shuttle = shuttleIn();
  moved(shuttle.place, `/${HANDLE}`);
  for (const segment of path) moved(shuttle.place, segment);
  return shuttle;
}

/**
 * Helper for the cases below, which is one callable, as a listing describes
 * one.
 */
function callable(
  name: string,
  extra: Partial<PieceCallableListing> = {},
): PieceCallableListing {
  return {
    name,
    kind: "handler",
    on: "result",
    inputSchema: true,
    ...extra,
  };
}

/**
 * Helper for the cases below, which answers every read a verb can make with
 * something harmless.
 *
 * It is for the cases that are about the dispatch rather than about a read: a
 * verb that reaches a seam gets an answer, so what such a case observes is
 * what the dispatch did with the line and not what the fabric said.
 */
function answering(over: VerbDeps = {}): VerbDeps {
  return {
    getCellValue: () => Promise.resolve({ title: "a" }),
    readWish: () => Promise.resolve({ result: "b" }),
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve({ piece: token, pathAfter: [...path] }),
    listing: {
      getCellValue: () => Promise.resolve({ title: "a" }),
      listCallableKeys: () => Promise.resolve(new Set<string>()),
      listSpaceSlugs: () => Promise.resolve([]),
      listPieces: () => Promise.resolve([]),
    },
    warmPiece: (config) => Promise.resolve({ piece: config.piece }),
    setCellValue: () => Promise.resolve({ piece: HANDLE, path: ["title"] }),
    linkPieces: () => Promise.resolve(),
    listPieceCallables: () =>
      Promise.resolve({ pattern: null, verbs: [callable("a-verb")] }),
    describePiece: () =>
      Promise.resolve({ pattern: null, verbs: [callable("a-verb")] }),
    callFromCommand: () => Promise.resolve(),
    sinkCellValue: () => Promise.resolve(() => {}),
    editText: (text) =>
      Promise.resolve({
        kind: "edited" as const,
        text: `${text} `,
        file: "/tmp/edited",
        discard: () => Promise.resolve(),
      }),
    ...over,
  };
}

/** Helper for the cases below, which stands `value` in for a cell's value. */
function cellValue(value: unknown): VerbDeps {
  return { ...READS_NOTHING, getCellValue: () => Promise.resolve(value) };
}

/**
 * Helper for the cases below, which stands in the two answers a `cd` onto a
 * piece reads: the piece an address resolves to, and `value` for the cell the
 * path is checked against.
 *
 * `resolves` names the pieces the index points a slug at, and a token it has
 * no entry for resolves to itself — which is what the fabric does with a
 * handle, and what makes a case that is not about the resolution read as it
 * would have before there was one.
 */
function settling(
  value: unknown,
  resolves: Readonly<Record<string, string>> = {},
): VerbDeps {
  return {
    ...READS_NOTHING,
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve({
        piece: resolves[token] ?? token,
        pathAfter: [...path],
      }),
    getCellValue: () => Promise.resolve(value),
  };
}

/**
 * Helper for the cases below, which stands `value` in for the cell a `cd`
 * checks its path against, and resolves no piece.
 *
 * The piece is left unresolved on purpose. A `cd` that spells the piece
 * shuttle already stands on has none to resolve, so a case standing at one
 * keeps `READS_NOTHING`'s resolution and fails if the settle reaches for it.
 * A case that moves onto another piece wants {@link settling} instead.
 */
function holding(value: unknown): VerbDeps {
  return { ...READS_NOTHING, getCellValue: () => Promise.resolve(value) };
}

/**
 * Helper for the cases below, which serves a different document per scope and
 * raises on a path it does not hold, the way a cell read does.
 *
 * The raise is the point: `getCellValue` throws where a path is not there
 * (`resolveCellPath`, `packages/runner/src/piece-helpers.ts`), so a fixture
 * that answered `undefined` instead would turn the failure a settle exists to
 * prevent into a quiet refusal and hide it.
 */
function atScopes(documents: Record<string, unknown>): VerbDeps {
  return {
    ...READS_NOTHING,
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve({ piece: token, pathAfter: [...path] }),
    getCellValue: (config, path) => {
      let at: unknown = documents[config.pieceScope ?? "space"];
      for (const segment of path) {
        const key = String(segment);
        if (!isObjectOrArray(at) || !(key in at)) {
          throw new Error(
            `Cannot access path "${path.join("/")}" - property "${key}" not ` +
              `found`,
          );
        }
        at = (at as Record<string, unknown>)[key];
      }
      return Promise.resolve(at);
    },
  };
}

/**
 * Helper for the cases below, which resolves `slug` as a collection — its
 * first path segment selecting the member — and answers a read by walking the
 * value below, so a walk of more than one segment is answered as the fabric
 * would answer it rather than by one stub value at every depth.
 */
function collectionAt(slug: string): VerbDeps {
  const value: Record<string, unknown> = {
    title: "a",
    topics: { 0: "x" },
    first: { title: "a" },
  };
  return {
    ...READS_NOTHING,
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve(
        token === slug
          ? { piece: BOARD, pathAfter: [...path].slice(1) }
          : { piece: token, pathAfter: [...path] },
      ),
    getCellValue: (_config, path) => {
      let at: unknown = value;
      for (const segment of path) {
        at = (at as Record<string, unknown> | undefined)?.[String(segment)];
      }
      return Promise.resolve(at);
    },
  };
}

/**
 * Helper for the cases below, which answers a listing's read and the read a
 * `cd` checks its path with by walking `value`, so a listing taken at a path
 * and a move onto one of its rows agree about what stands where.
 *
 * Both reads walk the one value because the property the cases ask about
 * spans them: a listing numbers rows at the place it read, and the mover
 * takes a handle back to that place. Two fixtures answering one tree apiece
 * would let the two agree here and disagree in the tree.
 */
function walking(value: unknown): VerbDeps {
  const at = (path: readonly (string | number)[]) => {
    let held: unknown = value;
    for (const segment of path) {
      held = (held as Record<string, unknown> | undefined)?.[String(segment)];
    }
    return Promise.resolve(held);
  };
  return {
    ...READS_NOTHING,
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve({ piece: token, pathAfter: [...path] }),
    getCellValue: (_config, path) => at(path),
    listing: {
      ...READS_NOTHING.listing,
      getCellValue: (_config, path) => at(path),
      listCallableKeys: () => Promise.resolve(new Set<string>()),
    },
  };
}

/** Helper for the cases below, which stands `keys` in for a cell's keys. */
function cellKeys(keys: string[]): VerbDeps {
  return listedCell(Object.fromEntries(keys.map((key) => [key, "a value"])));
}

/**
 * Helper for the cases below, which reports a terminal `rows` rows tall and
 * `columns` wide to `deps`, which is what bounds the page a verb writes.
 *
 * The width defaults wide enough that nothing a case writes wraps at it, so a
 * case about the height states only the height. A case about the width states
 * one narrow enough to wrap what it writes.
 */
function screen(rows: number, deps: VerbDeps, columns = 200): VerbDeps {
  return { ...deps, rows: () => rows, columns: () => columns };
}

/**
 * Helper for the cases below, which stands `value` in for a listed cell and
 * `callables` in for the keys whose stored links declare a stream.
 */
function listedCell(
  value: unknown,
  callables: readonly string[] = [],
): VerbDeps {
  return {
    ...READS_NOTHING,
    listing: {
      ...READS_NOTHING.listing,
      getCellValue: () => Promise.resolve(value),
      listCallableKeys: () => Promise.resolve(new Set(callables)),
    },
  };
}

/** Helper for the cases below, which stands a wish's answer in for a read. */
function wishing(result: unknown, error?: string): VerbDeps {
  return {
    ...READS_NOTHING,
    readWish: () =>
      Promise.resolve({ result, ...(error === undefined ? {} : { error }) }),
  };
}

/**
 * Helper for the cases below, which answers a wish with the address `link`
 * names, the way a marked position does.
 *
 * The key is `packages/cli`'s own rather than a second spelling of it, so a
 * fixture and the reader that meets it cannot drift apart while both look
 * right.
 */
function addressed(link: string): VerbDeps {
  return wishing({ [LINK_MARKER_KEY]: link });
}

/**
 * Helper for the cases below, which is the outcome `get` returns for a cell
 * holding `value`.
 *
 * `get` writes its own rendering rather than handing the value back, because
 * the rendering is what a page is cut from. The form is `renderValue`'s and is
 * pinned where that lives; asking it here is what keeps one question with one
 * answer.
 */
function writtenAs(value: unknown): Outcome {
  return { kind: "text", text: renderValue(value) };
}

/** Helper for the cases below, which is the text `outcome` composed. */
function textOf(outcome: Outcome): string {
  return outcome.kind === "text" ? outcome.text : `not text: ${outcome.kind}`;
}

/** Helper for the cases below, which is the reason `outcome` was refused. */
function reasonOf(outcome: Outcome): string {
  return outcome.kind === "refused"
    ? outcome.reason
    : `not refused: ${outcome.kind}`;
}

/**
 * Helper for the cases below, which is every verb the dispatch takes, in the
 * order it lists them, with how many operands each one takes.
 *
 * It is written out rather than read off the table, so that a verb added
 * without a page, or with an arity nobody meant, fails a case here instead of
 * passing one that walks whatever it finds. What holds it to the table is the
 * case asserting that `help` lists exactly these and nothing else.
 */
const VERB_ARITY: readonly (readonly [
  string,
  "none" | "optional" | "required" | "pair" | "none-or-pair" | "section",
])[] = [
  ["call", "section"],
  ["cd", "required"],
  ["describe", "optional"],
  ["edit", "optional"],
  ["get", "optional"],
  ["help", "optional"],
  ["link", "pair"],
  ["ls", "optional"],
  ["more", "none"],
  ["pwd", "none"],
  ["set", "pair"],
  ["unwatch", "required"],
  ["verbs", "optional"],
  ["watch", "optional"],
  ["watches", "none"],
  ["where", "none-or-pair"],
  ["wish", "required"],
  ["xcd", "required"],
  ["xpwd", "none"],
];

/**
 * Helper for the cases below, which is the most operands the dispatch takes
 * for each arity, and nothing for the arity that takes any number.
 *
 * A verb whose maximum is stated is one a line may write too many operands
 * for; the section arity has no maximum, since the words past a verb's own
 * operands are the callable's section and no number here bounds them.
 */
const MOST_OPERANDS: ReadonlyMap<string, number> = new Map([
  ["none", 0],
  ["optional", 1],
  ["required", 1],
  ["pair", 2],
  ["none-or-pair", 2],
]);

/** Helper for the cases below, which is what the dispatch calls that maximum. */
const TAKES: ReadonlyMap<string, string> = new Map([
  ["none", "no operand"],
  ["optional", "one operand"],
  ["required", "one operand"],
  ["pair", "two operands"],
  ["none-or-pair", "two operands"],
]);

/**
 * Helper for the cases below, which is what a verb needing operands refuses a
 * line naming too few with. A verb absent from this reads its own meaning into
 * having none.
 */
const NEEDS_ONE: ReadonlyMap<string, string> = new Map([
  [
    "call",
    "`call` takes the piece to call on and the verb to call, as in `call " +
    "topics/3 add-reply`. A piece handle stands where the reference does, " +
    "and a callable handle off `verbs` carries the name already, as in " +
    "`call %4`.",
  ],
  ["cd", "`cd` takes a place to move to."],
  [
    "link",
    "`link` takes the cell to point at and the path to write it at, as in " +
    "`link topics/3 latest`.",
  ],
  [
    "set",
    "`set` takes the path to write and the value to write there, as in " +
    `\`set title '"a"'\`.`,
  ],
  [
    "unwatch",
    "`unwatch` takes the watch to disarm, as in `unwatch %1`.",
  ],
  [
    "where",
    "`where` takes a dimension and the value to set it to, or no operand " +
    "at all.",
  ],
  ["wish", "`wish` takes the target to resolve, as in `wish #favorites`."],
  ["xcd", "`xcd` takes a place on the external plane to move to."],
]);

/**
 * Helper for the cases below, which is the sentence naming every verb, as the
 * refusal for a word that names none writes it.
 *
 * Written out rather than composed from {@link VERB_WORDS}, because what these
 * cases claim is the sentence: the set, the order the dispatch lists it in,
 * and the English list the words are joined into. One copy rather than one per
 * case, so a verb added is a verb named here once and the cases still fail
 * until it is.
 */
const THE_VERBS = "The verbs are `call`, `cd`, `describe`, `edit`, `get`, " +
  "`help`, `link`, `ls`, `more`, `pwd`, `set`, `unwatch`, `verbs`, `watch`, " +
  "`watches`, `where`, `wish`, `xcd`, and `xpwd`.";

/** Helper for the cases below, which is every verb, in that same order. */
const VERB_WORDS = VERB_ARITY.map(([word]) => word);

/**
 * Helper for the case that runs every verb, which is a line naming each: the
 * verb, and whatever operand it needs to get past the dispatch's arity.
 *
 * It is a map rather than a list so that the case can be held to
 * {@link VERB_WORDS}, which is itself held to the table. A verb added without
 * a line here is a verb that case does not run, and the lookup is what says
 * so.
 */
const LINE_PER_VERB: ReadonlyMap<string, string> = new Map([
  ["call", "call . a-verb"],
  ["cd", "cd .."],
  ["describe", "describe"],
  ["edit", "edit"],
  ["get", "get"],
  ["help", "help"],
  ["link", "link a b"],
  ["ls", "ls"],
  ["more", "more"],
  ["pwd", "pwd"],
  ["set", 'set a "b"'],
  ["unwatch", "unwatch %1"],
  ["verbs", "verbs"],
  ["watch", "watch"],
  ["watches", "watches"],
  ["where", "where"],
  ["wish", "wish #favorites"],
  ["xcd", "xcd ../elsewhere"],
  ["xpwd", "xpwd"],
]);

describe("verbs", () => {
  describe("the dispatch", () => {
    it("returns nothing for a line naming no verb", async () => {
      expect(await runLine("   ", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "nothing",
      });
    });

    it("returns a refusal naming a word that is no verb, and listing the verbs", async () => {
      expect(await runLine("frob x", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "refused",
        reason: `\`frob\` is not a verb. ${THE_VERBS}`,
      });
    });

    it("returns a refusal for a word naming a member every object carries", async () => {
      // A word a person can type is not a verb because the table happens to
      // answer for it. Looked up on an object, three of these hand back a
      // function of `Object.prototype`'s and each fails its own way: `toString`
      // and `constructor` return something that is no outcome — the second of
      // them the shuttle record itself, identity path and all — while `valueOf`
      // and `hasOwnProperty` throw out of the dispatch, where a throw means a
      // read that failed. `__proto__` answers with nothing and was already
      // refused, and it is here so that it stays refused.

      for (
        const word of [
          "toString",
          "constructor",
          "valueOf",
          "hasOwnProperty",
          "__proto__",
        ]
      ) {
        expect(await runLine(word, shuttleIn(), READS_NOTHING)).toEqual({
          kind: "refused",
          reason: `\`${word}\` is not a verb. ${THE_VERBS}`,
        });
      }
    });

    it("returns the reason the split gave a line it would not split", async () => {
      expect(await runLine("get 'a", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "refused",
        reason: "The `'` opened at column 5 is never closed.",
      });
    });

    it("writes nothing itself, whichever verb the line names", async () => {
      // The one claim in this file about what a verb does *not* do, and the
      // one that no other case could show. `render()` — what every `cf` seam
      // reaches for — writes through `Deno.stdout.writeSync`, so the recorder
      // stands in for that member and the case opens by proving the recorder
      // sees a write, without which it would pass over a verb that wrote
      // through it all day.

      const written: number[] = [];
      const stdout = Deno.stdout.writeSync;
      const stderr = Deno.stderr.writeSync;
      Deno.stdout.writeSync = (data) => {
        written.push(data.length);
        return data.length;
      };
      Deno.stderr.writeSync = Deno.stdout.writeSync;
      try {
        Deno.stdout.writeSync(new Uint8Array([0x61]));
        expect(written).toEqual([1]);
        written.length = 0;
        const answers = answering();
        const shuttle = atPiece();
        for (const word of VERB_WORDS) {
          const line = LINE_PER_VERB.get(word);
          // A verb added without a line here fails rather than going unrun,
          // which is what makes "whichever verb the line names" a claim over
          // the table rather than over a list somebody kept up.
          expect(line).toBeDefined();
          await runLine(line!, shuttle, answers);
        }
      } finally {
        Deno.stdout.writeSync = stdout;
        Deno.stderr.writeSync = stderr;
      }
      expect(written).toEqual([]);
    });
  });

  describe("the option grammar", () => {
    it("hands a token opening with `-` to no verb, and refuses it as an option nobody declared", async () => {
      expect(reasonOf(await runLine("ls -x", shuttleIn(), READS_NOTHING)))
        .toBe(
          'Unknown option "-x". Did you mean option "-h"? `ls --help` says ' +
            "what `ls` takes, and a bare `--` writes every token after it " +
            "as an operand, whatever it opens with.",
        );
    });

    it("hands `-` on its own to the verb as an operand, it being the previous place", async () => {
      // The one token the rule turns on that a shipped verb already spends:
      // read as an option it would refuse here as `-x` does, and the reason
      // it gives instead is the place's own.

      expect(reasonOf(await runLine("cd -", shuttleIn(), READS_NOTHING)))
        .toBe("There is no previous place to return to.");
    });

    it("hands a token after a bare `--` on as an operand, though it opens with `-`", async () => {
      expect(reasonOf(await runLine("cd -- -x", shuttleIn(), READS_NOTHING)))
        .toBe(
          "A space root lists facets, and `-x` names none. The facets are " +
            "`slugs/` and `pieces/`.",
        );
    });

    it("takes back the operand a listing offers for a key it would otherwise eat", async () => {
      // The composed claim the rule puts at risk: a listing prints a name to
      // be typed back, and a token opening with `-` never reaches a verb as an
      // operand. What closes it is the reference, which opens with `/`.

      const shuttle = atPiece();
      const operand = operandForChild(shuttle.place.place, "-x");
      expect(operand).toBeDefined();
      await runLine(`cd ${operand}`, shuttle, holding({ "-x": 1 }));
      expect(shuttle.place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: HANDLE,
        path: ["-x"],
      });
    });

    it("takes a key called `--` by the second one, only the first ending the options", async () => {
      // The typed spelling and what a listing offers are two questions. The
      // listing prints the reference for this key, `readsAsOption` taking the
      // name; the line below is what a person can type for it either way.

      const shuttle = atPiece();
      await runLine("cd -- --", shuttle, holding({ "--": 1 }));
      expect(shuttle.place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: HANDLE,
        path: ["--"],
      });
    });

    it("counts the operands rather than the tokens, a bare `--` being neither", async () => {
      const shuttle = shuttleIn();
      expect(await runLine("cd -- slugs", shuttle, READS_NOTHING))
        .toEqual({ kind: "moved", place: shuttle.place.place });
    });
  });

  describe("`--help`", () => {
    // One case per verb rather than one case walking them, because what is
    // claimed is of each: the dispatch puts the option in front of whatever a
    // verb declared, so a verb that stopped taking it names itself here.

    for (const word of VERB_WORDS) {
      it(`writes \`${word}\`'s page, which \`help ${word}\` writes too`, async () => {
        const opening = `Usage: ${word}`;
        const byOption = textOf(
          await runLine(`${word} --help`, shuttleIn(), READS_NOTHING),
        );
        expect(byOption.slice(0, opening.length)).toBe(opening);
        expect(
          textOf(await runLine(`help ${word}`, shuttleIn(), READS_NOTHING)),
        )
          .toBe(byOption);
      });
    }

    it("writes the page though an operand was written beside the option", async () => {
      // The option takes the whole reading, so the operand beside it reaches
      // no verb. What each case above shows is the other half: a verb that ran
      // instead would answer with its own refusal for the operands it was not
      // given, and none of these would be text at all.

      expect(
        textOf(await runLine("cd --help slugs", shuttleIn(), READS_NOTHING))
          .split("\n")[0],
      ).toBe("Usage: cd <ref>");
    });
  });

  describe("arity", () => {
    // How many operands a verb takes is the dispatch table's, and the dispatch
    // is what holds a verb to it, so there is one case per verb here rather
    // than one in each verb's own block. What a case turns on is the entry it
    // reads, so a count changed there names the verb it was changed for.

    for (const [word, arity] of VERB_ARITY) {
      const most = MOST_OPERANDS.get(arity);
      if (most === undefined) continue;
      const given = most + 1;
      it(`refuses ${given} operand${given === 1 ? "" : "s"}, one more than \`${word}\` takes`, async () => {
        const line = [word, ...["a", "b", "c"].slice(0, given)].join(" ");
        expect(reasonOf(await runLine(line, shuttleIn(), READS_NOTHING)))
          .toBe(
            `\`${word}\` takes ${TAKES.get(arity)}, and was given ${given}.`,
          );
      });
    }

    it("takes every operand past a section verb's own, up to twelve of them", async () => {
      // The half no maximum can express, and the reason `section` is an arm
      // rather than a large number. The claim is bounded because the set is
      // not: what is asserted is that a line of each length is taken *and*
      // that the whole of its tail reached the seam, so a maximum anywhere in
      // that range fails here rather than passing on the one length somebody
      // happened to write.

      const taken: number[] = [];
      const handed: string[][] = [];
      for (let count = 0; count <= 12; count++) {
        const tail = Array.from({ length: count }, (_, at) => `word${at}`);
        const outcome = await runLine(
          ["call", ".", "a-verb", ...tail].join(" "),
          atPiece(),
          answering({
            callFromCommand: (_options, _spelling, _name, tailArgs) => {
              handed.push([...tailArgs]);
              return Promise.resolve();
            },
          }),
        );
        if (outcome.kind !== "refused") taken.push(count);
      }
      expect(taken).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(handed.map((tail) => tail.length))
        .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(handed[12]?.at(-1)).toBe("word11");
    });

    for (const [word, arity] of VERB_ARITY) {
      if (
        arity !== "required" && arity !== "pair" &&
        arity !== "none-or-pair" && arity !== "section"
      ) {
        continue;
      }
      const given = arity === "required" || arity === "section" ? 0 : 1;
      it(
        `refuses a line naming ${given} operand${
          given === 1 ? "" : "s"
        }, \`${word}\` needing more`,
        async () => {
          const line = [word, ...["a"].slice(0, given)].join(" ");
          expect(reasonOf(await runLine(line, shuttleIn(), READS_NOTHING)))
            .toBe(NEEDS_ONE.get(word));
        },
      );
    }

    for (const [word, arity] of VERB_ARITY) {
      if (arity !== "optional" && arity !== "none-or-pair") continue;
      it(`runs \`${word}\` given no operand, which is a default and not too few`, async () => {
        // The half a maximum alone cannot express. `get` reads where it stands
        // and `help` lists the verbs, so neither is a line the dispatch may
        // answer for, and a count refusing none would take both readings away.
        //
        // Standing inside the piece rather than on it, so that the count is
        // the only thing that could refuse: a whole piece is no cell to write
        // onto, which `edit` says of a line naming none from a piece's root.

        const outcome = await runLine(word, atPiece("title"), answering());
        expect(outcome.kind).not.toBe("refused");
      });
    }

    it("counts the operands it was given rather than the count the verb takes", async () => {
      expect(reasonOf(await runLine("pwd a b c", shuttleIn(), READS_NOTHING)))
        .toBe("`pwd` takes no operand, and was given 3.");
    });
  });

  describe("help", () => {
    it("lists every verb, one to a row, and nothing else", async () => {
      // The list and the dispatch read one table, so a verb the dispatch
      // takes and this does not list is a verb a person has no way to find.
      // The last two lines are the blank and the line naming the option.

      const lines = textOf(await runLine("help", shuttleIn(), READS_NOTHING))
        .split("\n");
      expect(lines.slice(0, -2).map((row) => row.split(" ")[0]))
        .toEqual(VERB_WORDS);
    });

    it("refuses a word that names no verb, in the sentence the dispatch refuses one in", async () => {
      expect(reasonOf(await runLine("help frob", shuttleIn(), READS_NOTHING)))
        .toBe(
          `\`frob\` is not a verb. ${THE_VERBS}`,
        );
    });
  });

  describe("cd", () => {
    it("returns the place a relative operand moved to", async () => {
      const shuttle = shuttleIn();
      const outcome = await runLine("cd slugs", shuttle, READS_NOTHING);
      expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      expect(shuttle.place.place.position).toEqual({
        kind: "facet",
        space: SPACE,
        facet: "slugs",
      });
    });

    it("returns the reason a place gave an operand it would not take, and moves nowhere", async () => {
      const shuttle = shuttleIn();
      const before = shuttle.place.place;
      const outcome = await runLine("cd nowhere", shuttle, READS_NOTHING);
      expect(reasonOf(outcome)).toBe(
        "A space root lists facets, and `nowhere` names none. The facets are " +
          "`slugs/` and `pieces/`.",
      );
      expect(shuttle.place.place).toBe(before);
    });

    it("returns the place's own refusal for an operand that is the empty string", async () => {
      // One operand, so the dispatch hands it on and `movePlace`'s guard is
      // what answers, in this verb's name — the guard being the one every
      // verb aims an operand through.

      expect(reasonOf(await runLine("cd ''", shuttleIn(), READS_NOTHING)))
        .toBe("`cd` was given an empty operand, which names no place.");
    });

    it("refuses an operand ending in `#argument`, a place being result-rooted", async () => {
      // The asymmetry `get`'s own door turns on: `cd` refuses the member in
      // every spelling that takes one, and `get` reads it.
      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      expect(
        reasonOf(await runLine("cd board#argument", shuttle, READS_NOTHING)),
      )
        .toBe(
          "A place is result-rooted, so `cd` selects no `#argument` member. " +
            "A place rooted at the arguments cell would leave every later " +
            "relative read ambiguous about which side of the piece it " +
            "addressed. Reach arguments per operand instead, as in " +
            "`get .#argument/title` or `get /slugs/board#argument/title`.",
        );
    });

    it("says a trailing separator named the empty key where the cell holds none", async () => {
      // Inside a piece the separator ending an operand names the key `""`,
      // which a person typing a path the way a directory is typed does not
      // mean, so the refusal says what named it and what to type instead.
      // Kills a refusal that quotes the empty key as backticks around nothing.

      expect(
        reasonOf(
          await runLine("cd title/", atPiece(), settling({ title: { a: 1 } })),
        ),
      ).toBe(
        "`title/` reaches no cell: the trailing `/` names the empty key, " +
          "which is no key of the cell above it, whose keys are `a`. " +
          "`title` names the cell above it.",
      );
    });

    it("names the empty key in words where a separator inside the operand wrote it", async () => {
      expect(
        reasonOf(
          await runLine(
            "cd title//a",
            atPiece(),
            settling({ title: { a: 1 } }),
          ),
        ),
      ).toBe(
        "`title//a` reaches no cell: the empty key is no key of the cell " +
          "above it, whose keys are `a`.",
      );
    });

    it("names the empty key in words where it is missing inside an operand that ends in the separator", async () => {
      // The missing key is the first empty one, under `title`, and not the
      // final one the trailing `/` wrote, so the trailing-separator sentence
      // and its remedy do not apply: `title//a` fails as well. Kills a refusal
      // that decides the key was the trailing one from the operand's last
      // character alone.

      expect(
        reasonOf(
          await runLine(
            "cd title//a/",
            atPiece(),
            settling({ title: { a: 1 } }),
          ),
        ),
      ).toBe(
        "`title//a/` reaches no cell: the empty key is no key of the cell " +
          "above it, whose keys are `a`.",
      );
    });

    describe("the read that settles a move", () => {
      // What makes `cd` a promise. A move onto a piece is asked of the fabric
      // before the place is adopted — the piece resolved, and the path found —
      // so the prompt after a `cd` names a place that is there, and a place
      // that is not there is refused here rather than reported by whichever
      // verb reads next.

      /** Helper for the cases below, which is a second piece to move onto. */
      const OTHER = "of:fid1:0123456789abcdef";

      /**
       * Helper for the cases below, which is where a settle read, and the
       * piece it read through.
       */
      async function read(
        shuttle: Shuttle,
        line: string,
        value: unknown,
      ): Promise<{ config?: PieceConfig; path?: (string | number)[] }> {
        const seen: { config?: PieceConfig; path?: (string | number)[] } = {};
        await runLine(line, shuttle, {
          ...settling(value),
          getCellValue: (config, path) => {
            seen.config = config;
            seen.path = path;
            return Promise.resolve(value);
          },
        });
        return seen;
      }

      it("lands the handle the piece resolved to, with the slug as the name", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        await runLine("cd board", shuttle, settling(null, { board: BOARD }));
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: [],
        });
      });

      it("hands the resolution the connection this process holds", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        let asked: unknown;
        await runLine("cd board", shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (pieces, token, path) => {
            asked = pieces;
            return Promise.resolve({ piece: token, pathAfter: [...path] });
          },
        });
        expect(asked).toBe(PIECES);
      });

      it("refuses a slug the index names nothing for, and moves nowhere", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        const before = shuttle.place.place;
        const outcome = await runLine("cd todo", shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: () => {
            throw new SlugResolutionError('Slug "todo" not found.', "missing");
          },
        });
        expect(reasonOf(outcome)).toBe(
          '`todo` reaches no piece: Slug "todo" not found.',
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("raises what a resolution that failed for another reason raised", async () => {
        // A slug that names nothing is a fact about the line. A connection
        // that went away is not, and the two have to stay told apart.

        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        await expect(runLine("cd todo", shuttle, READS_NOTHING)).rejects
          .toThrow("A piece was resolved.");
      });

      it("refuses a handle the space does not hold, and moves nowhere", async () => {
        // A handle is a spelling and not a lookup, so the resolution hands one
        // back unread. The space's own index is what tells a piece it holds
        // from one it does not, where a value read cannot: an absent piece
        // reads as nothing, and so does an empty one.

        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, "pieces");
        const before = shuttle.place.place;
        expect(reasonOf(await runLine(`cd ${HANDLE}`, shuttle, settling(null))))
          .toBe(
            `\`${HANDLE}\` reaches no piece: this space holds none by the ` +
              `handle \`${HANDLE}\`.`,
          );
        expect(shuttle.place.place).toBe(before);
      });

      it("lands a handle the space holds", async () => {
        const shuttle = shuttleIn(lookingUp(true));
        moved(shuttle.place, "pieces");
        const outcome = await runLine(`cd ${HANDLE}`, shuttle, settling(null));
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("lands a handle written as the bare hash a listing prints, asking the index about it", async () => {
        // The pieces facet prints a piece's own id, which carries no entity
        // scheme, and `%n` hands that spelling back — so the walk to the row
        // has to admit it and the lookup has to be asked about it. Reading
        // both spellings of one entity is `entityIdExists`'s own
        // (`PiecesController`, `pieces-entity-id-exists.test.ts`), which is
        // why this case reads what the index was asked rather than what it
        // answered.

        const asked: string[] = [];
        const shuttle = shuttleIn(
          {
            dispose: () => Promise.resolve(),
            getSpace: () => SPACE,
            getSpaceName: () => SPACE_NAME,
            entityIdExists: (id: string) => {
              asked.push(id);
              return Promise.resolve(true);
            },
          } as unknown as PiecesController,
        );
        moved(shuttle.place, "pieces");
        const outcome = await runLine(
          `cd ${BARE_HANDLE}`,
          shuttle,
          settling(null),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(asked).toEqual([BARE_HANDLE]);
      });

      it("lands a handle where the server does not answer the lookup", async () => {
        // The lookup is a server capability, and `undefined` is what a server
        // that does not advertise it says. Nothing was learned, so the move
        // goes on — which is the one case left where a handle the space does
        // not hold is adopted.

        const shuttle = shuttleIn(lookingUp(undefined));
        moved(shuttle.place, "pieces");
        const outcome = await runLine(`cd ${HANDLE}`, shuttle, settling(null));
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("looks up no handle for a slug, the index having reached the piece", async () => {
        // A slug resolved through the index, which read the document to take
        // its id, so the resolution is the existence proof and a second one
        // would ask what is answered.

        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, "slugs");
        const outcome = await runLine(
          "cd board",
          shuttle,
          settling(null, { board: BOARD }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("looks up no handle for a key under the piece already stood at", async () => {
        const shuttle: Shuttle = {
          config: CONFIG,
          place: new CurrentPlace(SPACE),
          external: new ExternalLocation(
            new URL("file:///work/"),
            "/home/someone",
          ),
          connection: new HeldConnection({
            kind: "borrowed",
            pieces: lookingUp(false),
          }),
          session: new ShuttleSession(),
          invocationSession: "a-session",
        };
        moved(shuttle.place, `/${HANDLE}`);
        const outcome = await runLine(
          "cd topics",
          shuttle,
          holding({ topics: [] }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("lands the resolved piece in the route, not only on top of it", async () => {
        // A trail is made of positions `..` walks back through, so a route
        // entry holding an unresolved slug is a place shuttle returns to and
        // reads through the index as it points then. The invariant is the
        // route's as much as the destination's.

        const shuttle = shuttleIn();
        await runLine(
          "cd /slugs/board/topics",
          shuttle,
          settling({ topics: [] }, { board: BOARD }),
        );
        await runLine("cd ..", shuttle, READS_NOTHING);
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: [],
        });
      });

      it("takes `./items@user` to that key though the piece holds one named `.`", async () => {
        // The silent wrong landing the head reading ends. Read as a walk, the
        // operand descends through a key called `.` — and where the piece
        // holds one, that walk *succeeds*, so the settle confirms it and the
        // place adopts a cell nobody named. The head is read first, so the
        // cell reached is the one the operand names whatever the piece holds.

        const shuttle = atPiece();
        const outcome = await runLine(
          "cd ./items@user",
          shuttle,
          settling({ ".": { "items@user": 99 }, "items@user": 1 }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["items@user"],
        });
      });

      it("offers the `.@` spelling where a bare scope word names no key", async () => {
        // Inside a piece a bare `@session` is an ordinary key name, so this
        // is the read finding no such key — and the operand looks enough like
        // an attempt at the scope to say what would have moved it.

        expect(
          reasonOf(
            await runLine("cd @session", atPiece(), settling({ topics: 1 })),
          ),
        ).toBe(
          "`@session` reaches no cell: `@session` is no key of the cell " +
            "above it, whose keys are `topics`. `.@session` is what moves " +
            "the scope.",
        );
      });

      it("reaches a key genuinely named `@session`, with no offer made", async () => {
        // The condition the offer hangs on. A place that holds the key lands
        // on it, and nothing is suggested, because nothing went wrong.

        const shuttle = atPiece();
        const outcome = await runLine(
          "cd @session",
          shuttle,
          settling({ "@session": 1 }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["@session"],
        });
        expect(shuttle.place.place.scope).toBe("space");
      });

      it("settles a scope on its own, reading the place at the scope it moves to", async () => {
        // A scope selects which document a piece's id names, so the place a
        // scope move reaches is one nothing has read. It settles like any
        // other move onto a piece, and the read goes to the new scope.

        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
        let scope: string | undefined;
        const outcome = await runLine("cd .@session", shuttle, {
          ...settling({ topics: 1 }),
          getCellValue: (config) => {
            scope = config.pieceScope;
            return Promise.resolve({ topics: 1 });
          },
        });
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(scope).toBe("session");
      });

      it("refuses a scope whose document does not hold the path, and moves nowhere", async () => {
        // The chain the settle exists for, in one line rather than two: the
        // place at `@space` holds `topics`, the one at `@session` does not,
        // and the move that would have adopted it is refused instead.

        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
        const before = shuttle.place.place;
        const outcome = await runLine("cd .@session", shuttle, settling({}));
        expect(reasonOf(outcome)).toBe(
          "`.@session` reaches no cell: `topics` is no key of the cell above " +
            "it, which holds no keys at all.",
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("descends after a refused scope move without meeting the runtime", async () => {
        // The chain rather than the unit: settle at one scope, change scope,
        // descend. The piece holds `topics/child` at `@space` and nothing at
        // `@session`, so the scope move is refused and the descent runs from
        // the place that was never left — reading a level that is there.
        //
        // A scope move that landed instead would leave the place at
        // `@session/topics`, which no read confirmed, and the descent would
        // read that parent and raise. So the third line is the assertion: it
        // lands, rather than rejecting with the runtime's sentence.

        const deps = atScopes({
          space: { topics: { child: 1 } },
          session: {},
        });
        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, deps);
        expect(reasonOf(await runLine("cd .@session", shuttle, deps))).toBe(
          "`.@session` reaches no cell: `topics` is no key of the cell above " +
            "it, which holds no keys at all.",
        );
        const descended = await runLine("cd child", shuttle, deps);
        expect(descended).toEqual({
          kind: "moved",
          place: shuttle.place.place,
        });
        expect(shuttle.place.place).toEqual({
          position: {
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: ["topics", "child"],
          },
          scope: "space",
        });
      });

      it("looks the handle up again where the move changes only the scope", async () => {
        // The lookup's own skip, keyed the same way as the read's: one id at
        // two scopes is two documents, so a move to the second has a piece
        // nothing has asked about even though the id is one shuttle stands on.

        // Standing is set through the place directly, which makes no lookup,
        // so the one the case is about is the only one the controller sees.
        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, `/${HANDLE}`);
        const before = shuttle.place.place;
        expect(reasonOf(
          await runLine(`cd /${HANDLE}@session`, shuttle, settling(null)),
        )).toBe(
          `\`/${HANDLE}@session\` reaches no piece: this space holds none ` +
            `by the handle \`${HANDLE}\`.`,
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("looks the handle up once for the cell it already stands at", async () => {
        // The other side of that key: same id, same scope, so the piece was
        // settled when shuttle arrived and a move naming it again asks
        // nothing. The controller refuses every lookup, so one being made
        // would fail the case.

        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, `/${HANDLE}`);
        const outcome = await runLine(
          `cd /${HANDLE}`,
          shuttle,
          settling(null),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("reads again where the move changes only the scope", async () => {
        // One id at `@space` and the same id at `@session` are two documents,
        // so a place confirmed at one is not confirmed at the other. A skip
        // that compared the position alone would land here having read
        // nothing.

        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
        const outcome = await runLine(
          `cd /${HANDLE}@session/topics`,
          shuttle,
          settling({ other: 1 }),
        );
        expect(reasonOf(outcome)).toBe(
          "`/of:fid1:abcdefghijklmnop@session/topics` reaches no cell: " +
            "`topics` is no key of the cell above it, whose keys are `other`.",
        );
      });

      it("reads at the level stood at where only the path goes deeper", async () => {
        // The other side of every boundary above: same piece, same scope, one
        // key deeper. Where shuttle stands is a place a read already
        // confirmed, so what the settle has to find is the segment past it
        // rather than the whole piece.

        const seen = await read(atPiece("topics"), "cd 0", ["a"]);
        expect(seen.path).toEqual(["topics"]);
      });

      it("settles a slug that names a collection, as a read of it would", async () => {
        // The canonical resolution spends leading segments reaching a
        // collection's member, so `/tasks/first/title` names the member's
        // piece with `title` left inside it. Settling the head as a bare piece
        // would refuse a cell `get` reads, and two verbs disagreeing about
        // whether a reference names anything is worse than either answer.

        const shuttle = shuttleIn();
        await runLine(`cd /tasks/first/title`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, token, path) =>
            Promise.resolve(
              token === "tasks"
                ? { piece: BOARD, pathAfter: [...path].slice(1) }
                : { piece: token, pathAfter: [...path] },
            ),
          getCellValue: () => Promise.resolve({ title: "a" }),
        });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          path: ["title"],
        });
      });

      it("keeps the member's own levels in a route a collection resolved through", async () => {
        // The resolution spends the levels that select the member, and those
        // are levels of the collection rather than of what it held. The level
        // the member itself sits at is the member's, and lands with the
        // member's piece — so `..` reaches the member's root, not the facet
        // two levels above it.

        const shuttle = shuttleIn();
        await runLine(
          "cd slugs/tasks/first/title",
          shuttle,
          collectionAt("tasks"),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          path: ["title"],
        });
        await runLine("cd ..", shuttle, READS_NOTHING);
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          path: [],
        });
        await runLine("cd ..", shuttle, READS_NOTHING);
        expect(shuttle.place.place.position).toEqual({
          kind: "facet",
          space: SPACE,
          facet: "slugs",
        });
      });

      it("routes one walk the same whether it is typed whole or in steps", async () => {
        // A route records how shuttle reached a place, and `cd a/b/c` and
        // `cd a/b` then `cd c` are one walk written two ways. So they leave
        // the same route, and `..` lands the same sequence from either — the
        // property that catches a resolution spending segments and taking the
        // levels below them with it.

        /** Every `..` landing from `lines`, after where they end. */
        const landings = async (lines: string[]): Promise<unknown[]> => {
          const shuttle = shuttleIn();
          for (const line of lines) {
            await runLine(line, shuttle, collectionAt("tasks"));
          }
          const seen: unknown[] = [shuttle.place.place.position];
          for (let step = 0; step < 3; step++) {
            await runLine("cd ..", shuttle, READS_NOTHING);
            seen.push(shuttle.place.place.position);
          }
          return seen;
        };

        expect(await landings(["cd slugs/tasks/first/title"]))
          .toEqual(await landings(["cd slugs/tasks/first", "cd title"]));
        expect(await landings(["cd slugs/board/topics"]))
          .toEqual(await landings(["cd slugs/board", "cd topics"]));
      });

      it("takes the scope a narrowed link was reached through", async () => {
        // A member held through a narrowed link is a different document from
        // the one its id alone names, so the place has to read through the
        // scope the resolution reached it at.

        const shuttle = shuttleIn();
        await runLine(`cd /tasks/first`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, _token, path) =>
            Promise.resolve({
              piece: BOARD,
              pathAfter: [...path].slice(1),
              scope: "session",
            }),
        });
        expect(shuttle.place.place.scope).toBe("session");
      });

      it("reads the path through the scope the resolution reached it at", async () => {
        // The place's scope and the read's are the same scope, and the read
        // has to use it: a member held through a narrowed link is a different
        // document, so checking its path at the ambient scope would look for
        // the key in a cell the place does not name.

        const shuttle = shuttleIn();
        let scope: string | undefined;
        await runLine(`cd /tasks/first/title`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, _token, path) =>
            Promise.resolve({
              piece: BOARD,
              pathAfter: [...path].slice(1),
              scope: "session",
            }),
          getCellValue: (config) => {
            scope = config.pieceScope;
            return Promise.resolve({ title: "a" });
          },
        });
        expect(scope).toBe("session");
        expect(shuttle.place.place.scope).toBe("session");
      });

      it("resolves a slug reached from inside another piece", async () => {
        // Standing at a piece is not standing at *this* piece. The skip above
        // is for the one the place already holds, and a move onto any other
        // resolves — which is the whole of what keeps a repointed slug from
        // walking the place onto a piece it did not name.

        const shuttle = atPiece("topics");
        await runLine(
          "cd /slugs/board",
          shuttle,
          settling(null, { board: BOARD }),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: [],
        });
      });

      it("resolves nothing for a key under the piece already stood at", async () => {
        // The piece is the one shuttle stands on, which came through a settle
        // of its own, so a descent has none left to ask about. `READS_NOTHING`
        // resolves none, and the case fails if the settle reaches for one.

        const shuttle = atPiece();
        await runLine("cd topics", shuttle, holding({ topics: [] }));
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["topics"],
        });
      });

      it("resolves nothing for a reference naming the piece already stood at", async () => {
        const shuttle = atPiece("topics");
        await runLine(
          `cd /${HANDLE}/title`,
          shuttle,
          holding({ title: "a" }),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["title"],
        });
      });

      it("raises what the read that checks the path raised", async () => {
        // The seam's own distinction, on the door this slice added. A slug
        // the index names nothing for is a fact about the line and comes back
        // refused; a read that failed is a server that went away, and it
        // raises so a shell whose server is gone is still a shell. The
        // message is asserted because both stubs in `READS_NOTHING` throw,
        // and only one of them is the read.

        await expect(runLine("cd title", atPiece(), READS_NOTHING)).rejects
          .toThrow("A cell was read.");
      });

      it("refuses a segment that is no key, naming the keys that are", async () => {
        const shuttle = atPiece();
        const before = shuttle.place.place;
        const outcome = await runLine(
          "cd nosuchkey",
          shuttle,
          settling({ value: 0, increment: null, decrement: null }),
        );
        expect(reasonOf(outcome)).toBe(
          "`nosuchkey` reaches no cell: `nosuchkey` is no key of the cell " +
            "above it, whose keys are `value`, `increment`, and `decrement`.",
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("refuses a segment where the cell above it holds no keys at all", async () => {
        expect(
          reasonOf(await runLine("cd title", atPiece(), settling(7))),
        ).toBe(
          "`title` reaches no cell: `title` is no key of the cell above it, " +
            "which holds no keys at all.",
        );
      });

      it("names the segment that is missing rather than the operand's last", async () => {
        expect(
          reasonOf(
            await runLine(
              "cd nosuchkey/title",
              atPiece(),
              settling({ topics: [] }),
            ),
          ),
        ).toBe(
          "`nosuchkey/title` reaches no cell: `nosuchkey` is no key of the " +
            "cell above it, whose keys are `topics`.",
        );
      });

      it("lands a key the read found", async () => {
        const shuttle = atPiece();
        const outcome = await runLine(
          "cd topics",
          shuttle,
          settling({ topics: [] }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["topics"],
        });
      });

      it("reads an index a walk into an array reached", async () => {
        const shuttle = atPiece("topics");
        const outcome = await runLine(
          "cd 3",
          shuttle,
          settling(["a", 1, 2, 3]),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("reads at the piece's root where the move went up before it came down", async () => {
        const seen = await read(atPiece("topics"), "cd ../items", {
          items: {},
        });
        expect(seen.path).toEqual([]);
      });

      it("reads at the piece's root for a move onto another piece", async () => {
        // The path a move onto another piece extends is a path in that
        // piece, so a standing that spells the same segments has confirmed
        // nothing about it. The operand shares its first segment with where
        // shuttle stands, which is what makes the piece the thing deciding.

        const seen = await read(atPiece("topics"), `cd /${OTHER}/topics/3`, {
          topics: ["a", "b", "c", "d"],
        });
        expect(seen.path).toEqual([]);
        expect(seen.config?.piece).toBe(OTHER);
      });

      it("reads at the scope the move lands at, not the one it left", async () => {
        // A reference carrying a suffix moves both halves of the place, and
        // the cell the read has to find is the one that scope selects.

        const seen = await read(
          atPiece(),
          `cd /${HANDLE}@session/title`,
          { title: 1 },
        );
        expect(seen.config?.pieceScope).toBe("session");
      });

      it("reads nothing at all for a move onto a piece with no path", async () => {
        // Nothing is left to find: the resolution answered for the piece, and
        // there is no path under it for a read to look for.

        const shuttle = shuttleIn();
        moved(shuttle.place, "pieces");
        const outcome = await runLine(`cd ${HANDLE}`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, token, path) =>
            Promise.resolve({ piece: token, pathAfter: [...path] }),
        });
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("reads through the piece the resolution handed back", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        let piece: string | undefined;
        await runLine("cd board/title", shuttle, {
          ...settling({ title: 1 }, { board: BOARD }),
          getCellValue: (config) => {
            piece = config.piece;
            return Promise.resolve({ title: 1 });
          },
        });
        expect(piece).toBe(BOARD);
      });

      it("writes the name in the prompt and the handle in what `pwd` prints", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        await runLine("cd board", shuttle, settling(null, { board: BOARD }));
        expect(shuttle.place.label()).toBe("board @space");
        expect(textOf(await runLine("pwd", shuttle, READS_NOTHING))).toBe(
          `position  //${SPACE}/${BOARD}@space\nscope     @space`,
        );
      });

      it("settles a space written as a name before it settles the piece", async () => {
        const shuttle = shuttleIn();
        await runLine(
          `cd //${SPACE_NAME}/board/title`,
          shuttle,
          settling({ title: 1 }, { board: BOARD }),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: ["title"],
        });
      });

      it("refuses an entry point resolving to an address naming its piece by slug", async () => {
        expect(
          reasonOf(
            await runLine("cd #favorites", shuttleIn(), addressed("/board")),
          ),
        ).toBe(
          "`#favorites` resolves to slug `board`, and a place holds the " +
            "handle a name resolved to. An address the fabric wrote names " +
            "its piece by handle.",
        );
      });

      it("settles nothing for `get`, whose own read is what finds the cell", async () => {
        // The asymmetry the two doors have. A `cd` waits because the prompt
        // would go on promising the place; a read of a cell that is not there
        // fails on its own account, so there is nothing for a check in front
        // of it to add — and `READS_NOTHING` resolves no piece, which is what
        // shows that none was asked for.

        expect(await runLine("get title", atPiece(), cellValue("read")))
          .toEqual(writtenAs("read"));
      });
    });

    describe("a `#name` target", () => {
      it("lands on the piece the fabric resolved the target to", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          "cd #favorites",
          shuttle,
          addressed(`/${HANDLE}/topics/3`),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["topics", 3],
        });
      });

      it("asks the wish for the target's address rather than for its value", async () => {
        let asked: WishReadConfig | undefined;
        await runLine("cd #favorites", shuttleIn(), {
          ...READS_NOTHING,
          readWish: (config) => {
            asked = config;
            return Promise.resolve({
              result: { [LINK_MARKER_KEY]: `/${HANDLE}` },
            });
          },
        });
        expect(asked?.query).toBe("#favorites");
        expect(asked?.selection?.projection?.markers).toEqual({ marked: true });
        expect(asked?.selection?.projection?.schema).toBe(false);
      });

      it("hands the wish the connection this process holds", async () => {
        let loaded: unknown;
        await runLine("cd #favorites", shuttleIn(), {
          ...READS_NOTHING,
          readWish: async (config, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return { result: { [LINK_MARKER_KEY]: `/${HANDLE}` } };
          },
        });
        expect(loaded).toBe(PIECES);
      });

      it("refuses a target the fabric resolved in another space, and says what would reach it", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          "cd #profile",
          shuttle,
          addressed(`/@${OTHER_SPACE}/${HANDLE}`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#profile` resolves in space `did:key:z6MkHomeSpace`, and this " +
            "shuttle is connected to `did:key:z6MkConnectedSpace`. One " +
            "connection serves one space, so reaching that cell means a " +
            "shuttle started against that space.",
        );
        expect(shuttle.place.place.position.kind).toBe("root");
      });

      it("refuses a target whose address carries a scope qualifier", async () => {
        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`/${HANDLE}@session/title`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address carrying an `@session` " +
            "qualifier, which a place reached through a target does not " +
            "keep: a " +
            "place holds one scope and roots at a result. Reach that cell by " +
            `its own reference, \`/${HANDLE}@session/title\`.`,
        );
      });

      it("refuses a target whose address carries a pin", async () => {
        // Kills a target reading that drops the pin the reader carries, which
        // would land a place on a piece at a version it does not hold.

        const pin = "A".repeat(43);
        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`/${HANDLE}@pin=${pin}/title`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address carrying a `@pin=` qualifier, " +
            "which a place reached through a target does not keep: a place " +
            "holds no pin, and shuttle reads a piece as it runs rather than " +
            "at a pinned version. Reach that cell by its own reference, " +
            "written without the qualifier.",
        );
      });

      it("refuses a target whose address carries the `#argument` member", async () => {
        // The member on the address's piece segment: an arguments cell, which
        // a place reached through a target does not stand in.

        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`/${HANDLE}#argument/title`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address carrying the `#argument` " +
            "member, which a place reached through a target does not keep: a " +
            "place holds one scope and roots at a result. Reach that cell by " +
            `its own reference, \`/${HANDLE}#argument/title\`.`,
        );
      });

      it("moves to the result key an address names where `#argument` follows its path", async () => {
        // `#` in a path is data, so this address selects no member. Kills a
        // target reading that still takes a trailing `#argument` off.

        const shuttle = shuttleIn();
        const outcome = await runLine(
          "cd #favorites",
          shuttle,
          addressed(`/${HANDLE}/title#argument`),
        );
        expect(outcome.kind).toBe("moved");
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["title#argument"],
        });
      });

      it("refuses an address naming its space by a name rather than a DID", async () => {
        // An address the fabric wrote names its space by DID or leaves it
        // out, so a name in that slot is an answer nothing here can compare
        // against the connected space — and comparing it wrongly is what
        // decision 5's whole refusal turns on.
        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`//estuary/${HANDLE}`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address naming space `estuary`, " +
            "which is no DID. An address the fabric wrote names its space by " +
            "DID or leaves it out.",
        );
      });

      it("refuses an address that is not written as a reference", async () => {
        expect(
          reasonOf(
            await runLine("cd #favorites", shuttleIn(), addressed(HANDLE)),
          ),
        ).toBe(
          `\`#favorites\` resolved to \`${HANDLE}\`, which is no reference: ` +
            "one is rooted, and this is not.",
        );
      });

      it("carries the reason the reference grammar gave an address it refused", async () => {
        expect(
          reasonOf(
            await runLine("cd #favorites", shuttleIn(), addressed("/Board")),
          ),
        ).toBe(
          '"Board" is not a slug: a slug is lowercase letters, numbers, and ' +
            "single hyphens between words.",
        );
      });

      it("refuses a target the wish matched nothing for, carrying the wish's own error", async () => {
        const outcome = await runLine(
          "cd #profile",
          shuttleIn(),
          wishing(null, "no profile yet"),
        );
        expect(reasonOf(outcome)).toBe(
          "`#profile` resolved to nothing: no profile yet",
        );
      });

      it("refuses a target the wish matched nothing for and said nothing about", async () => {
        expect(
          reasonOf(await runLine("cd #profile", shuttleIn(), wishing(null))),
        ).toBe("`#profile` resolved to nothing.");
      });
    });

    describe("a space written as a name", () => {
      // One connection serves one space, so all a reference naming a space can
      // want to know is whether it names this one. The connection records the
      // name it was opened under, which answers that; nothing here derives a
      // DID from a name, and the cases stand a controller in rather than a
      // derivation.

      it("lands where the reference names once the name is this shuttle's own", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          `cd //${SPACE_NAME}/${HANDLE}/title`,
          shuttle,
          settling({ title: "t" }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["title"],
        });
      });

      it("refuses a name that is not the one this shuttle was opened under", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          `cd //estuary/${HANDLE}`,
          shuttle,
          READS_NOTHING,
        );
        expect(reasonOf(outcome)).toBe(
          "`estuary` is not the space this shuttle is connected to, which " +
            "is `board`. One connection serves one space, so reaching that " +
            "cell means a shuttle started against `estuary`.",
        );
        expect(shuttle.place.place.position.kind).toBe("root");
      });

      it("refuses any name where the connection recorded none, and says what would answer", async () => {
        // A session opened by a DID recorded no name, so whether one names
        // this space is a question the connection cannot answer and the
        // refusal is the honest arm rather than an error path.
        const outcome = await runLine(
          `cd //${SPACE_NAME}/${HANDLE}`,
          shuttleIn(controller(undefined)),
          READS_NOTHING,
        );
        expect(reasonOf(outcome)).toBe(
          "This shuttle names its space by DID, so it cannot say whether " +
            "`board` is that space. One connection serves one space, and a " +
            "shuttle started against `board` by name is what reaches that " +
            "cell.",
        );
      });

      it("compares the name the reference carried, not the piece it named", async () => {
        const shuttle = shuttleIn(controller(HANDLE));
        expect(
          reasonOf(
            await runLine(
              `cd //${SPACE_NAME}/${HANDLE}`,
              shuttle,
              READS_NOTHING,
            ),
          ),
        )
          .toBe(
            "`board` is not the space this shuttle is connected to, which " +
              `is \`${HANDLE}\`. One connection serves one space, so ` +
              "reaching that cell means a shuttle started against `board`.",
          );
      });

      it("compares a name whose separator the reference wrote as `~1` against the one it stands for", async () => {
        // The reader reads the space slot with no escape undone, the grammar
        // admitting no separator in a space name, so `east~1west` is compared
        // in those characters and is not the name `east/west`.
        const shuttle = shuttleIn(controller("east/west"));
        const outcome = await runLine(
          `cd //east~1west/${HANDLE}`,
          shuttle,
          settling(null),
        );
        expect(reasonOf(outcome)).toBe(
          "`east~1west` is not the space this shuttle is connected to, which " +
            "is `east/west`. One connection serves one space, so reaching " +
            "that cell means a shuttle started against `east~1west`.",
        );
      });

      it("refuses a name differing from this shuttle's only in case", async () => {
        // Exact, because the key a named space hangs off is derived from the
        // name's bytes: two spellings that differ at all are two spaces.
        const shuttle = shuttleIn(controller("Board"));
        expect(
          reasonOf(
            await runLine(`cd //board/${HANDLE}`, shuttle, READS_NOTHING),
          ),
        ).toBe(
          "`board` is not the space this shuttle is connected to, which is " +
            "`Board`. One connection serves one space, so reaching that cell " +
            "means a shuttle started against `board`.",
        );
      });

      it("lands the space the connection settled on, which the place then checks", async () => {
        // What the name is held against is the connection's record, and what
        // the place is landed with is the connection's own space — so a
        // connection whose session settled somewhere other than where shuttle
        // stands is refused by the place rather than followed. Nothing puts
        // the two out of step today; the check is the place's own, and this is
        // the door it is reachable through.
        const shuttle = shuttleIn(controller(SPACE_NAME, OTHER_SPACE));
        expect(
          reasonOf(
            await runLine(
              `cd //${SPACE_NAME}/${HANDLE}`,
              shuttle,
              READS_NOTHING,
            ),
          ),
        ).toBe(
          "`board` resolves to space `did:key:z6MkHomeSpace`, and this " +
            "shuttle is connected to `did:key:z6MkConnectedSpace`. One " +
            "connection serves one space, so reaching that cell means a " +
            "shuttle started against that space.",
        );
      });
    });
  });

  describe("ls", () => {
    it("returns the listing at the place, rendered and numbered", async () => {
      expect(await runLine("ls", atPiece(), cellKeys(["title", "body"])))
        .toEqual({
          kind: "text",
          text: "%1 title\n%2 body",
        });
    });

    it("lists where shuttle stands rather than where it started", async () => {
      const shuttle = shuttleIn();
      moved(shuttle.place, "pieces");
      let listed = 0;
      await runLine("ls", shuttle, {
        ...READS_NOTHING,
        listing: {
          ...READS_NOTHING.listing,
          listPieces: () => {
            listed++;
            return Promise.resolve([{ id: HANDLE }]);
          },
        },
      });
      expect(listed).toBe(1);
    });

    it("lists at the place the operand names rather than at the one shuttle stands at", async () => {
      // The whole of what the operand is for: reading a child without
      // standing on it. An `ls` that dropped its operand would list the
      // piece root — `title` and `settings` — and one still declaring it
      // takes none would refuse the line before any read.

      expect(
        textOf(
          await runLine(
            "ls settings",
            atPiece(),
            walking({ title: "a", settings: { depth: 1, note: "n" } }),
          ),
        ),
      ).toBe("%1 depth\n%2 note");
    });

    it("lists a facet the operand names, which is a place and no piece", async () => {
      // `describe` and `verbs` aim through a door that narrows what it finds
      // to a piece, and a facet is refused there. `ls` aims through the door
      // under it, so a facet is a place it lists — listing being what a facet
      // is for, and what `get` turns a facet down with names this verb.

      expect(
        textOf(
          await runLine("ls slugs", shuttleIn(), {
            ...READS_NOTHING,
            listing: {
              ...READS_NOTHING.listing,
              listSpaceSlugs: () =>
                Promise.resolve([{ slug: "board", piece: HANDLE }]),
            },
          }),
        ),
      ).toBe(
        "<the space's slug index names these, and a slug it never recorded " +
          "still resolves>\n%1 board",
      );
    });

    it("numbers the rows of the place it listed, so `cd %n` reaches one of them", async () => {
      // Decision 17 makes `%n` a reference until the next listing, so a
      // listing taken at a target numbers that target's rows. Numbered
      // against where shuttle stands instead, `%1` would name `depth` under
      // the piece root, which is no key there and is refused — rows shown
      // that the next line will not take.

      const shuttle = atPiece();
      const deps = walking({ title: "a", settings: { depth: 1, note: "n" } });
      await runLine("ls settings", shuttle, deps);
      await runLine("cd %1", shuttle, deps);
      expect(shuttle.place.place.position)
        .toMatchObject({ path: ["settings", "depth"] });
    });

    it("leaves the place where it stood, listing a target being a read", async () => {
      // The target is a facet, which is a place a move lands on outright:
      // an `ls <target>` that moved as well as listed would be standing in
      // `slugs/` when this line ended, and a target a move only reaches
      // pending could not tell the two apart.

      const shuttle = shuttleIn();
      const before = shuttle.place.place;
      await runLine("ls slugs", shuttle, {
        ...READS_NOTHING,
        listing: {
          ...READS_NOTHING.listing,
          listSpaceSlugs: () => Promise.resolve([]),
        },
      });
      expect(shuttle.place.place).toBe(before);
    });

    it("refuses the `#argument` member, and lists nothing", async () => {
      // The one spelling `get` takes that this cannot. A place carries no
      // selection between a piece's two cells, and a row is reached from the
      // place it was listed at, so an arguments listing would hand out
      // numbers that walk the result. `READS_NOTHING` is what says the
      // refusal came before any listing was read.

      expect(
        reasonOf(await runLine("ls .#argument", atPiece(), READS_NOTHING)),
      ).toBe(
        "`#argument` selects one of a piece's two cells, and a listing's " +
          "rows are reached from the place they were listed at, which " +
          "carries no such selection. `get` reads that cell.",
      );
    });

    it("refuses the `#argument` member a handle's head selects, and lists nothing", async () => {
      // The member on a `%n` head is read against the row, and a listing of
      // what it selects would number rows that walk the result all the same.
      // Kills a reading door that drops the selection a handle carries back,
      // which would list the row's result instead.

      const shuttle = atPiece();
      await runLine("ls", shuttle, answering());
      expect(
        reasonOf(await runLine("ls %1#argument", shuttle, READS_NOTHING)),
      ).toBe(
        "`#argument` selects one of a piece's two cells, and a listing's " +
          "rows are reached from the place they were listed at, which " +
          "carries no such selection. `get` reads that cell.",
      );
    });

    it("refuses an operand that reaches nothing in the words `get` refuses it in", async () => {
      // Two verbs aiming through one door fail through it, so the sentence a
      // person reads is one sentence rather than two free to drift. Each is
      // pinned as well as compared, since two verbs that both stopped
      // refusing would agree on whatever they returned instead.

      const refusals: readonly (readonly [string, string])[] = [
        [
          "#favorites",
          "`#favorites` names an entry point rather than a cell under this " +
          "place. `wish #favorites` reads what it resolves to.",
        ],
        [
          "%1",
          "`%1` names no row: no listing has numbered one yet. `ls` lists " +
          "what stands here and numbers what it lists.",
        ],
      ];
      for (const [operand, reason] of refusals) {
        for (const verb of ["ls", "get"]) {
          const line = `${verb} ${operand}`;
          expect({
            line,
            reason: reasonOf(await runLine(line, atPiece(), READS_NOTHING)),
          }).toEqual({ line, reason });
        }
      }
    });

    it("raises what a read that failed outright raised", async () => {
      await expect(runLine("ls", atPiece(), READS_NOTHING)).rejects.toThrow(
        "The cell was listed.",
      );
    });

    it("records the rows it numbered, with the place they stand in", async () => {
      // The handle table B2's `call %4` reads. It is minted where the rows
      // are, so a row's kind and its receiver come off one listing rather
      // than off a second read taken later.

      const shuttle = atPiece();
      await runLine(
        "ls",
        shuttle,
        listedCell({ "add-reply": {} }, ["add-reply"]),
      );
      expect(shuttle.session.handles?.rows).toEqual([{
        name: "add-reply",
        kind: "callable",
        operand: "add-reply",
      }]);
      expect(shuttle.session.handles?.place).toEqual(shuttle.place.place);
    });

    it("records the newest listing's rows, a listing resetting the numbering", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, cellKeys(["title"]));
      await runLine("ls", shuttle, cellKeys(["topics"]));
      expect(shuttle.session.handles?.rows.map((row) => row.name))
        .toEqual(["topics"]);
    });

    it("writes one page of the listing and holds the rest", async () => {
      const shuttle = atPiece();
      const outcome = await runLine(
        "ls",
        shuttle,
        screen(4, cellKeys(["a", "b", "c", "d", "e"])),
      );
      expect(textOf(outcome)).toBe(
        "%1 a\n%2 b\n<3 lines not shown — more continues>",
      );
      expect(shuttle.session.continuation?.lines)
        .toEqual(["%3 c", "%4 d", "%5 e"]);
    });

    it("numbers every row, page or no page, so a continuation keeps the numbering", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, screen(4, cellKeys(["a", "b", "c", "d"])));
      expect(shuttle.session.handles?.rows.map((row) => row.name))
        .toEqual(["a", "b", "c", "d"]);
    });

    it("holds nothing where the whole listing fit", async () => {
      const shuttle = atPiece();
      shuttle.session.holding({ lines: ["stale"] });
      await runLine("ls", shuttle, screen(24, cellKeys(["a", "b"])));
      expect(shuttle.session.continuation).toBeUndefined();
    });

    it("writes as many rows as `--limit` names, whatever the screen shows", async () => {
      // The limit overrides the height rather than capping it: a person who
      // asked for three rows on a screen showing twenty asked for three, and
      // one who asked for three on a screen showing two asked for three.

      for (const rows of [2, 24]) {
        expect(
          textOf(
            await runLine(
              "ls --limit 3",
              atPiece(),
              screen(rows, cellKeys(["a", "b", "c", "d"])),
            ),
          ),
        ).toBe("%1 a\n%2 b\n%3 c\n<1 line not shown — more continues>");
      }
    });

    it("writes as many rows as `--limit` names beside a listing that carries a bound", async () => {
      // The bound is not a row of the listing, so it is not one of the rows a
      // limit asks for. Counted among them, `ls --limit 1` at `slugs/` spent
      // its whole allowance on the bound and printed no numbered row at all.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const written = textOf(
        await runLine("ls --limit 1", shuttle, {
          ...READS_NOTHING,
          listing: {
            ...READS_NOTHING.listing,
            listSpaceSlugs: () =>
              Promise.resolve([
                { slug: "alpha", piece: HANDLE },
                { slug: "beta", piece: BOARD },
              ]),
          },
        }),
      ).split("\n");
      expect(written[0]).toBe(
        "<the space's slug index names these, and a slug it never recorded " +
          "still resolves>",
      );
      expect(written[1]).toBe("%1 alpha");
      expect(written[2]).toBe("<1 line not shown — more continues>");
    });

    it("refuses a `--limit` that is no whole number of rows above zero", async () => {
      // The parser's type test is what a number is, not what a count is, so
      // the range is the verb's own. Each of these parses and none of them
      // names a page.

      for (const limit of ["0", "-1", "1.5"]) {
        expect(
          reasonOf(
            await runLine(
              `ls --limit ${limit}`,
              atPiece(),
              cellKeys(["a"]),
            ),
          ),
        ).toBe(
          "`ls --limit` takes a whole number of rows above zero, and was " +
            `given ${limit}.`,
        );
      }
    });

    it("reads nothing for a `--limit` it refuses", async () => {
      // The refusal is a fact about the line, so it is made before the read
      // rather than after one: `READS_NOTHING` throws if the listing is
      // reached.

      expect(
        (await runLine("ls --limit 0", atPiece(), READS_NOTHING)).kind,
      ).toBe("refused");
    });

    it("bounds the page at the height the deps report", async () => {
      // The height is read per line rather than once, so the number a case
      // supplies is the number the page is cut to.

      const outcome = await runLine(
        "ls",
        atPiece(),
        screen(3, cellKeys(["a", "b", "c"])),
      );
      expect(textOf(outcome).split("\n").length).toBe(2);
    });

    it("says so where one row is taller than the whole page", async () => {
      // The rule that something is always shown may not buy silence. A single
      // name wider than the screen is shown whole — a truncated name is not
      // one `cd` takes back — and the page says it ran over. The fixture
      // straddles the budget: one row of 203 columns is three rows of an
      // eighty-column screen, against a page of two.

      const outcome = await runLine(
        "ls",
        atPiece(),
        screen(3, cellKeys(["k".repeat(200)]), 80),
      );
      expect(textOf(outcome).split("\n").at(-1))
        .toBe("<what is above fills more than the screen>");
    });

    it("says nothing of the sort where the row fits the page", async () => {
      // The other side of that boundary: a name the page has room for is
      // written with no status line at all.

      const outcome = await runLine(
        "ls",
        atPiece(),
        screen(3, cellKeys(["k".repeat(50)]), 80),
      );
      expect(textOf(outcome)).toBe(`%1 ${"k".repeat(50)}`);
    });

    it("bounds a listing whose rows wrap onto more than one row each", async () => {
      // The same arithmetic through the other verb: four names each wider
      // than the terminal is four rows of listing and eight rows of screen,
      // and a page that counted lines let all four through.

      const wide = ["a", "b", "c", "d"].map((name) => name.repeat(60));
      const outcome = await runLine(
        "ls",
        atPiece(),
        screen(6, cellKeys(wide), 40),
      );
      expect(textOf(outcome).split("\n").at(-1))
        .toContain("not shown — more continues");
    });

    it("bounds the page at the assumed height where nothing says how tall the screen is", async () => {
      // A verb driven with nothing behind it still bounds what it writes, and
      // so does one whose terminal will not measure itself: a report that is
      // no count of rows leads to the assumption rather than into arithmetic
      // over it.

      const names = Array.from({ length: 100 }, (_, index) => `k${index}`);
      for (const rows of [undefined, () => 0, () => Number.NaN]) {
        const outcome = await runLine("ls", atPiece(), {
          ...cellKeys(names),
          ...(rows === undefined ? {} : { rows }),
        });
        expect(textOf(outcome).split("\n").length).toBe(ASSUMED_ROWS - 1);
      }
    });
  });

  describe("more", () => {
    it("writes the next page of a listing, under the numbers it already gave", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, screen(4, cellKeys(["a", "b", "c", "d"])));
      expect(textOf(await runLine("more", shuttle, screen(4, READS_NOTHING))))
        .toBe("%3 c\n%4 d");
    });

    it("writes the page after that one, and stops holding what it wrote", async () => {
      const shuttle = atPiece();
      await runLine(
        "ls",
        shuttle,
        screen(3, cellKeys(["a", "b", "c", "d", "e"])),
      );
      expect(textOf(await runLine("more", shuttle, screen(3, READS_NOTHING))))
        .toBe("%2 b\n<3 lines not shown — more continues>");
      expect(textOf(await runLine("more", shuttle, screen(3, READS_NOTHING))))
        .toBe("%3 c\n<2 lines not shown — more continues>");
    });

    it("leaves the handles the listing numbered where they were", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, screen(3, cellKeys(["a", "b", "c"])));
      await runLine("more", shuttle, screen(3, READS_NOTHING));
      expect(shuttle.session.handles?.rows.map((row) => row.name))
        .toEqual(["a", "b", "c"]);
    });

    it("refuses where the last rendering fit whole", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, screen(24, cellKeys(["a"])));
      expect(reasonOf(await runLine("more", shuttle, READS_NOTHING))).toBe(
        "`more` writes the rest of a listing or a value that did not fit " +
          "on one page, and nothing is waiting.",
      );
    });

    it("refuses where no line has written a rendering at all", async () => {
      expect(reasonOf(await runLine("more", atPiece(), READS_NOTHING)))
        .toContain("nothing is waiting");
    });

    it("continues a value, carrying the offer the read made beside it", async () => {
      // One mechanism and two producers: what a page held back is lines
      // either way. The hint rides the continuation so that every page of one
      // rendering makes the same offer, rather than the first page alone.

      const shuttle = atPiece();
      await runLine(
        "get",
        shuttle,
        screen(4, cellValue({ a: 1, b: 2, c: 3, d: 4, e: 5 })),
      );
      expect(textOf(await runLine("more", shuttle, screen(4, READS_NOTHING))))
        .toContain("--select narrows the read");
    });
  });

  describe("pwd", () => {
    it("returns both halves of the place, the scope written even at the base", async () => {
      expect(await runLine("pwd", atPiece("title"), READS_NOTHING)).toEqual({
        kind: "text",
        text: `position  //${SPACE}/${HANDLE}@space/title\nscope     @space`,
      });
    });
  });

  describe("where", () => {
    it("returns every dimension of the ambient record, the connection's first", async () => {
      expect(await runLine("where", atPiece("title"), READS_NOTHING)).toEqual({
        kind: "text",
        text: `api       ${CONFIG.apiUrl}\n` +
          `identity  ${CONFIG.identity}\n` +
          `space     ${SPACE}\n` +
          `position  //${SPACE}/${HANDLE}@space/title\n` +
          "scope     @space\n" +
          "external  file:///work/\n" +
          "watches   none",
      });
    });

    it("returns the place's dimensions written exactly as `pwd` writes them", async () => {
      // What makes the two one format rather than two that agree today: the
      // dimensions `pwd` prints stand inside what `where` prints, whole and
      // character for character.

      const shuttle = atPiece("title");
      const whole = await runLine("where", shuttle, READS_NOTHING);
      const place = await runLine("pwd", shuttle, READS_NOTHING);
      expect(whole.kind === "text" && place.kind === "text").toBe(true);
      expect(textOf(whole).includes(`\n${textOf(place)}\n`)).toBe(true);
    });

    it("returns the record over a connection that will not open", async () => {
      // Nothing here reads, and this is what that is worth: a shuttle whose
      // server has gone away can still say what it was connected as and where
      // it stands.

      const shuttle: Shuttle = {
        config: CONFIG,
        place: new CurrentPlace(SPACE),
        external: new ExternalLocation(
          new URL("file:///work/"),
          "/home/someone",
        ),
        connection: new HeldConnection({
          kind: "owned",
          record: CONFIG,
          open: () => Promise.reject(new Error("The server refused.")),
        }),
        session: new ShuttleSession(),
        invocationSession: "a-session",
      };
      expect(textOf(await runLine("where", shuttle, READS_NOTHING)))
        .toBe(
          `api       ${CONFIG.apiUrl}\n` +
            `identity  ${CONFIG.identity}\n` +
            `space     ${SPACE}\n` +
            `position  @${SPACE}/\n` +
            "scope     @space\n" +
            "external  file:///work/\n" +
            "watches   none",
        );
    });

    it("returns the space the connection names beside the one the place settled on", async () => {
      // The two dimensions carry different things and both are worth seeing:
      // a person names a space and the fabric answers with a DID, and the
      // record shows the naming as well as what it denotes.

      const shuttle: Shuttle = {
        config: { ...CONFIG, space: SPACE_NAME },
        place: new CurrentPlace(SPACE),
        external: new ExternalLocation(
          new URL("file:///work/"),
          "/home/someone",
        ),
        connection: new HeldConnection({ kind: "borrowed", pieces: PIECES }),
        session: new ShuttleSession(),
        invocationSession: "a-session",
      };
      expect(textOf(await runLine("where", shuttle, READS_NOTHING))).toContain(
        `space     ${SPACE_NAME}\nposition  @${SPACE}/`,
      );
    });

    it("returns the connection's own values shown as a message is shown", async () => {
      // The three arrive from a launch flag or the environment behind it, so
      // no door has held them to the class a terminal acts on. They are prose
      // somebody reads, which is the glyph rather than the JSON escape.

      const shuttle: Shuttle = {
        config: { ...CONFIG, space: "boa\u009brd", identity: "/k\u007fey" },
        place: new CurrentPlace(SPACE),
        external: new ExternalLocation(
          new URL("file:///work/"),
          "/home/someone",
        ),
        connection: new HeldConnection({ kind: "borrowed", pieces: PIECES }),
        session: new ShuttleSession(),
        invocationSession: "a-session",
      };
      const text = textOf(await runLine("where", shuttle, READS_NOTHING));
      expect(text).toContain("space     boa␦rd");
      expect(text).toContain("identity  /k␡ey");
      expect(/\p{Cc}/u.test(text.replaceAll("\n", ""))).toBe(false);
    });

    it("sets the scope, moving the place as the operand for it does", async () => {
      // One act and not two: what `where scope` reaches is what `cd .@session`
      // reaches, so the outcome is the move the prompt already knows how to
      // show rather than a line of its own.

      const shuttle = atPiece("title");
      const set = await runLine("where scope @session", shuttle, answering());
      const moved = await runLine(
        "cd .@session",
        atPiece("title"),
        answering(),
      );
      expect(set).toEqual(moved);
    });

    it("sets the external location, moving it as `xcd` does", async () => {
      const shuttle = atPiece("title");
      expect(await runLine("where external ../other", shuttle, READS_NOTHING))
        .toEqual({ kind: "text", text: "file:///other/" });
      expect(textOf(await runLine("where", shuttle, READS_NOTHING)))
        .toContain("external  file:///other/");
    });

    it("refuses a heavyweight dimension, naming restart as the switch", async () => {
      for (const dimension of ["api", "identity", "space"]) {
        const reason = reasonOf(
          await runLine(`where ${dimension} x`, shuttleIn(), READS_NOTHING),
        );
        expect({ dimension, says: reason.includes("fixed at launch") })
          .toEqual({ dimension, says: true });
      }
    });

    it("refuses a dimension another verb moves, naming that verb", async () => {
      expect(
        reasonOf(await runLine("where position x", shuttleIn(), READS_NOTHING)),
      )
        .toContain("`cd`");
      expect(
        reasonOf(await runLine("where watches x", shuttleIn(), READS_NOTHING)),
      )
        .toContain("`watch`");
    });

    it("refuses a word that names no dimension, listing the ones it sets", async () => {
      const reason = reasonOf(
        await runLine("where frob x", shuttleIn(), READS_NOTHING),
      );
      expect(reason).toContain("names no dimension");
      expect(reason).toContain("`scope`");
      expect(reason).toContain("`external`");
    });

    it("refuses a dimension written with no value, which is neither act", async () => {
      // The record is one surface, so naming one line of it is not a read of
      // that line. The count is the dispatch's, which is what keeps the
      // refusal the same sentence however the verb grows.

      expect(reasonOf(await runLine("where scope", shuttleIn(), READS_NOTHING)))
        .toBe(
          "`where` takes a dimension and the value to set it to, or no " +
            "operand at all.",
        );
    });
  });

  describe("xpwd", () => {
    it("returns the external working location, whole", async () => {
      expect(await runLine("xpwd", shuttleIn(), READS_NOTHING))
        .toEqual({ kind: "text", text: "file:///work/" });
    });

    it("returns the dimension `where` prints for it, character for character", async () => {
      const shuttle = shuttleIn();
      const one = textOf(await runLine("xpwd", shuttle, READS_NOTHING));
      expect(textOf(await runLine("where", shuttle, READS_NOTHING)))
        .toContain(`external  ${one}`);
    });
  });

  describe("xcd", () => {
    it("moves the location with a plain relative path, and writes where it landed", async () => {
      const shuttle = shuttleIn();
      expect(await runLine("xcd ../other", shuttle, READS_NOTHING))
        .toEqual({ kind: "text", text: "file:///other/" });
    });

    it("moves it to another plane with a whole schemed path", async () => {
      const shuttle = shuttleIn();
      await runLine("xcd https://example.test/a/b/", shuttle, READS_NOTHING);
      expect(textOf(await runLine("xpwd", shuttle, READS_NOTHING)))
        .toBe("https://example.test/a/b/");
    });

    it("refuses a scheme on a path that is not absolute, and moves nowhere", async () => {
      const shuttle = shuttleIn();
      expect(reasonOf(await runLine("xcd file:other", shuttle, READS_NOTHING)))
        .toContain("absolute");
      expect(textOf(await runLine("xpwd", shuttle, READS_NOTHING)))
        .toBe("file:///work/");
    });

    it("leaves the fabric place where it stood", async () => {
      // The two positions move independently, which is what makes the fabric
      // the ambient plane rather than one of two a verb has to choose
      // between.

      const shuttle = atPiece("title");
      const before = textOf(await runLine("pwd", shuttle, READS_NOTHING));
      await runLine("xcd ../other", shuttle, READS_NOTHING);
      expect(textOf(await runLine("pwd", shuttle, READS_NOTHING))).toBe(before);
    });

    it("reads nothing, so it answers over a connection that will not open", async () => {
      const shuttle: Shuttle = {
        config: CONFIG,
        place: new CurrentPlace(SPACE),
        external: new ExternalLocation(
          new URL("file:///work/"),
          "/home/someone",
        ),
        connection: new HeldConnection({
          kind: "owned",
          record: CONFIG,
          open: () => Promise.reject(new Error("The server refused.")),
        }),
        session: new ShuttleSession(),
        invocationSession: "a-session",
      };
      expect(await runLine("xcd ../other", shuttle, READS_NOTHING))
        .toEqual({ kind: "text", text: "file:///other/" });
    });
  });

  describe("get", () => {
    it("returns the value at the cell where shuttle stands", async () => {
      expect(await runLine("get", atPiece(), cellValue({ title: "a" })))
        .toEqual(writtenAs({ title: "a" }));
    });

    it("reads the piece the place stands on", async () => {
      // A slug stands unresolved in the place, so what a read is handed is the
      // slug — the same thing a listing hands on, and what makes a name typed
      // back off one reach the piece it names.
      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      moved(shuttle.place, "board");
      let config: PieceConfig | undefined;
      await runLine("get", shuttle, {
        ...READS_NOTHING,
        getCellValue: (given) => {
          config = given;
          return Promise.resolve(null);
        },
      });
      expect(config?.piece).toBe("board");
    });

    it("reads at the scope the place reads through", async () => {
      const shuttle = atPiece();
      moved(shuttle.place, ".@session");
      let config: PieceConfig | undefined;
      await runLine("get", shuttle, {
        ...READS_NOTHING,
        getCellValue: (given) => {
          config = given;
          return Promise.resolve(null);
        },
      });
      expect(config?.pieceScope).toBe("session");
    });

    it("reads at the path inside the piece the place stands at", async () => {
      let path: (string | number)[] | undefined;
      await runLine("get", atPiece("topics", "3"), {
        ...READS_NOTHING,
        getCellValue: (_config, given) => {
          path = given;
          return Promise.resolve(null);
        },
      });
      expect(path).toEqual(["topics", 3]);
    });

    it("reads without starting the piece", async () => {
      // A computed value is as fresh as the last thing that ran the pattern,
      // and this read is not one: it asks for what the piece serves rather
      // than stepping it first.
      let options: GetCellValueOptions | undefined;
      await runLine("get", atPiece(), {
        ...READS_NOTHING,
        getCellValue: (_config, _path, given) => {
          options = given;
          return Promise.resolve(null);
        },
      });
      expect(options?.step).toBeUndefined();
    });

    it("hands the read the connection this process holds", async () => {
      let loaded: unknown;
      await runLine("get", atPiece(), {
        ...READS_NOTHING,
        getCellValue: async (config, _path, _options, deps) => {
          loaded = await deps?.loadPieces?.(config);
          return null;
        },
      });
      expect(loaded).toBe(PIECES);
    });

    it("reads the cell an operand names, from where shuttle stands", async () => {
      let path: (string | number)[] | undefined;
      await runLine("get topics/3", atPiece(), {
        ...READS_NOTHING,
        getCellValue: (_config, given) => {
          path = given;
          return Promise.resolve(null);
        },
      });
      expect(path).toEqual(["topics", 3]);
    });

    it("reads through `..` the level `cd ..` moves to", async () => {
      // The trail and not the levels: standing at a piece reached through
      // `slugs/`, `..` is the facet it was reached through rather than the
      // space root the piece also sits directly inside. Both doors read the
      // operand from where shuttle actually stands, which is what makes the
      // two agree.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      moved(shuttle.place, "board");
      const refused = await runLine("get ..", shuttle, READS_NOTHING);
      expect(reasonOf(refused)).toBe(
        "`slugs/` is a list of what stands inside it rather than a cell, so " +
          "it holds no value. `ls` lists it.",
      );
      expect(await runLine("cd ..", shuttle, READS_NOTHING)).toEqual({
        kind: "moved",
        place: shuttle.place.place,
      });
      expect(shuttle.place.place.position).toEqual({
        kind: "facet",
        space: SPACE,
        facet: "slugs",
      });
    });

    it("moves nowhere reading the cell an operand names", async () => {
      const shuttle = atPiece();
      const before = shuttle.place.place;
      await runLine("get topics", shuttle, cellValue(null));
      expect(shuttle.place.place).toBe(before);
    });

    it("refuses a space root, naming what lists it", async () => {
      expect(reasonOf(await runLine("get", shuttleIn(), READS_NOTHING))).toBe(
        "A space root is a list of what stands inside it rather than a cell, " +
          "so it holds no value. `ls` lists it.",
      );
    });

    it("refuses a facet, naming it", async () => {
      const shuttle = shuttleIn();
      moved(shuttle.place, "pieces");
      expect(reasonOf(await runLine("get", shuttle, READS_NOTHING))).toBe(
        "`pieces/` is a list of what stands inside it rather than a cell, so " +
          "it holds no value. `ls` lists it.",
      );
    });

    it("refuses a `#name` target, naming the verb that reads one", async () => {
      expect(
        reasonOf(await runLine("get #favorites", atPiece(), READS_NOTHING)),
      ).toBe(
        "`#favorites` names an entry point rather than a cell under this " +
          "place. `wish #favorites` reads what it resolves to.",
      );
    });

    it("settles a space written as a name, and reads where it names", async () => {
      let config: PieceConfig | undefined;
      const outcome = await runLine(
        `get //${SPACE_NAME}/${HANDLE}/title`,
        shuttleIn(),
        {
          ...READS_NOTHING,
          getCellValue: (given) => {
            config = given;
            return Promise.resolve("read");
          },
        },
      );
      expect(outcome).toEqual(writtenAs("read"));
      expect(config?.piece).toBe(HANDLE);
    });

    it("moves nowhere settling a space written as a name", async () => {
      const shuttle = shuttleIn();
      const before = shuttle.place.place;
      await runLine(`get //${SPACE_NAME}/${HANDLE}`, shuttle, cellValue(null));
      expect(shuttle.place.place).toBe(before);
    });

    describe("the `#argument` member", () => {
      // Standing in an arguments cell is what a result-rooted place cannot do,
      // and reading one is a different act — `cf cell get` performs it, and
      // `grammar.md` spells it `get .#argument/title`. So `get`'s door is
      // `cd`'s plus this member, and each case names which of the two cells
      // the read was aimed at.

      /** Helper for the cases below, which is what `line` read, and where. */
      async function reads(
        shuttle: Shuttle,
        line: string,
      ): Promise<
        { config?: PieceConfig; path?: (string | number)[]; input?: boolean }
      > {
        const seen: {
          config?: PieceConfig;
          path?: (string | number)[];
          input?: boolean;
        } = {};
        await runLine(line, shuttle, {
          ...READS_NOTHING,
          getCellValue: (config, path, options) => {
            seen.config = config;
            seen.path = path;
            seen.input = options?.input;
            return Promise.resolve(null);
          },
        });
        return seen;
      }

      it("reads the result cell for an operand carrying no member", async () => {
        expect((await reads(atPiece(), "get title")).input).toBe(false);
      });

      it("reads the arguments cell for an operand whose head selects the member", async () => {
        // The member on the `.` head, which is where a relative operand
        // selects it.

        expect((await reads(atPiece(), "get .#argument/title")).input).toBe(
          true,
        );
      });

      it("reads the result key an operand ending in `#argument` names", async () => {
        // Kills a door that still takes a trailing `#argument` off.

        const seen = await reads(atPiece(), "get title#argument");
        expect(seen.path).toEqual(["title#argument"]);
        expect(seen.input).toBe(false);
      });

      it("reads the arguments cell at the path the operand names", async () => {
        // From the arguments cell's root, whatever path shuttle stands at.

        const seen = await reads(atPiece("topics"), "get .#argument/topics/3");
        expect(seen.path).toEqual(["topics", 3]);
        expect(seen.input).toBe(true);
      });

      it("reads the arguments cell a bare piece designation selects", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        const seen = await reads(shuttle, "get board#argument");
        expect(seen.config?.piece).toBe("board");
        expect(seen.path).toEqual([]);
        expect(seen.input).toBe(true);
      });

      it("reads the arguments cell a rooted reference selects", async () => {
        const seen = await reads(shuttleIn(), `get /${HANDLE}#argument/title`);
        expect(seen.config?.piece).toBe(HANDLE);
        expect(seen.path).toEqual(["title"]);
        expect(seen.input).toBe(true);
      });

      it("reads the arguments cell a rooted walk's piece segment selects, and the result key one names after its path", async () => {
        // The table's two rows. Kills a rooted walk that reads the member off
        // the path rather than the piece segment, which swaps the two.

        const argument = await reads(
          atPiece(),
          "get /slugs/first#argument/label",
        );
        expect(argument).toMatchObject({
          config: { piece: "first" },
          path: ["label"],
          input: true,
        });
        const result = await reads(
          atPiece(),
          "get /slugs/first/label#argument",
        );
        expect(result).toMatchObject({
          config: { piece: "first" },
          path: ["label#argument"],
          input: false,
        });
      });

      it("reads the arguments cell a handle's head selects, against the row it names", async () => {
        // Kills a reading door that drops the selection `resolveHandle`
        // carries back.

        const shuttle = atPiece();
        await runLine("ls", shuttle, answering());
        const seen = await reads(shuttle, "get %1#argument/a");
        expect(seen).toMatchObject({ path: ["a"], input: true });
      });

      it("reads the arguments cell a piece segment after a facet row selects", async () => {
        // Kills a handle walk that drops the selection it finds entering a
        // piece from a facet row.

        const shuttle = shuttleIn();
        await runLine("ls", shuttle, answering());
        const seen = await reads(shuttle, "get %1/board#argument/title");
        expect(seen).toMatchObject({
          config: { piece: "board" },
          path: ["title"],
          input: true,
        });
      });

      it("reads a `#` inside a piece as a character of a key", async () => {
        expect((await reads(atPiece(), "get a#b")).path).toEqual(["a#b"]);
      });

      it("refuses the member written as a whole operand, teaching the spellings that take it", async () => {
        // What it teaches is the two spellings that take the member.

        expect(
          reasonOf(await runLine("get #argument", atPiece(), READS_NOTHING)),
        ).toBe(
          "`#argument` on its own names no piece to select the arguments cell " +
            "of. The member goes on a head or a piece segment, as in " +
            "`get .#argument/title` or `get /slugs/board#argument/title`.",
        );
      });
    });

    it("refuses a space written as a name that is not this shuttle's own", async () => {
      const outcome = await runLine(
        `get //estuary/${HANDLE}`,
        shuttleIn(),
        READS_NOTHING,
      );
      expect(reasonOf(outcome)).toBe(
        "`estuary` is not the space this shuttle is connected to, which is " +
          "`board`. One connection serves one space, so reaching that cell " +
          "means a shuttle started against `estuary`.",
      );
    });

    it("raises what a read that failed raised", async () => {
      await expect(runLine("get", atPiece(), READS_NOTHING)).rejects.toThrow(
        "A cell was read.",
      );
    });

    describe("the projection options", () => {
      // Decision 7 makes these `cf`'s own, so each case asks the parser `cf
      // cell get` reads its flags through for what the read should have been
      // handed, rather than restating a parsed shape here. A projection whose
      // meaning changed on one surface reds these on the other.

      /**
       * Helper for the cases below, which is the selection the read was
       * handed for `line`, and nothing where it was handed none.
       */
      async function selected(
        line: string,
      ): Promise<CellSelection | undefined> {
        let selection: CellSelection | undefined;
        await runLine(line, atPiece(), {
          ...READS_NOTHING,
          getCellValue: (_config, _path, options) => {
            selection = options?.selection;
            return Promise.resolve(null);
          },
        });
        return selection;
      }

      it("hands the read the selection `--filter` parses to", async () => {
        expect(await selected("get --filter .active"))
          .toEqual(await parseCellSelectionOptions({ filter: ".active" }));
      });

      it("hands the read the selection `--select` parses to", async () => {
        expect(await selected("get --select id,title"))
          .toEqual(await parseCellSelectionOptions({ select: "id,title" }));
      });

      it("hands the read the selection `--schema` parses to", async () => {
        expect(await selected(`get --schema '{"type":"object"}'`))
          .toEqual(
            await parseCellSelectionOptions({ schema: '{"type":"object"}' }),
          );
      });

      it("hands the read a selection carrying both where the line wrote both", async () => {
        expect(await selected("get --filter .active --select id"))
          .toEqual(
            await parseCellSelectionOptions({
              filter: ".active",
              select: "id",
            }),
          );
      });

      it("hands the read no selection where the line wrote none", async () => {
        expect(await selected("get")).toBeUndefined();
      });

      it("refuses `--select` and `--schema` written together, as `cf cell get` does", async () => {
        expect(
          reasonOf(
            await runLine(
              "get --select a --schema b",
              atPiece(),
              READS_NOTHING,
            ),
          ),
        )
          .toContain('Option "--schema" conflicts with option "--select".');
      });

      it("raises what the parser threw that is no fact about the line", async () => {
        // The arm beside the refusal, and the reason there are two. A
        // selection the parser refuses is a fact about the line and comes
        // back as a refusal in the parser's own sentence; anything else it
        // throws is a fault in the parser, and a fault reported as a refusal
        // would tell a person their line was wrong when it was not. Only a
        // stand-in can produce one, the real parser wrapping even a missing
        // `@file` as a selection error.

        await expect(runLine("get --select title", atPiece(), {
          ...READS_NOTHING,
          parseCellSelectionOptions: () => {
            throw new TypeError("The parser is broken.");
          },
        })).rejects.toThrow("The parser is broken.");
      });

      it("refuses a projection the parser will not take, in the parser's own words", async () => {
        // A predicate that will not parse is a fact about the line, so it is
        // refused rather than raised — and refused before the read, which
        // `READS_NOTHING` is what shows.

        expect(
          reasonOf(
            await runLine("get --filter '   '", atPiece(), READS_NOTHING),
          ),
        ).toBe("--filter predicate must not be empty");
      });

      it("writes JSON a program can parse, at a width that would wrap it", async () => {
        // The flag's whole point, and the boundary it sits on: a hundred
        // characters at eighty columns is a line the page would break, and a
        // break inside a JSON string is not JSON at all — `JSON.parse`
        // refuses a raw newline there. Nothing was paginated and nothing is
        // waiting; the rewrite alone was enough to make it unreadable.

        const held = "x".repeat(100);
        const written = textOf(
          await runLine(
            "get --json",
            atPiece(),
            screen(24, cellValue(held), 80),
          ),
        );
        expect(written.includes("\n")).toBe(false);
        expect(JSON.parse(written)).toBe(held);
      });

      it("writes the whole value under `--json`, with nothing held back", async () => {
        const shuttle = atPiece();
        const held = Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [`k${index}`, index]),
        );
        const written = textOf(
          await runLine("get --json", shuttle, screen(6, cellValue(held), 80)),
        );
        expect(JSON.parse(written)).toEqual(held);
        expect(shuttle.session.continuation).toBeUndefined();
      });

      it("clears what `more` was continuing, there being nothing to continue", async () => {
        // A `--json` read writes no page, so it holds nothing back — and a
        // `more` after it must not continue the line before it.

        const shuttle = atPiece();
        await runLine(
          "get",
          shuttle,
          screen(4, cellValue({ a: 1, b: 2, c: 3 })),
        );
        expect(shuttle.session.continuation?.lines.length).toBeGreaterThan(0);
        await runLine("get --json", shuttle, screen(4, cellValue({ a: 1 })));
        expect(shuttle.session.continuation).toBeUndefined();
      });

      it("writes the `$UI` node under `--json`, which is a form nothing stands in for", async () => {
        // The elision writes a string where an object was, which reads back
        // as a value the fabric does not hold. A person reading is served by
        // it; a program is misled by it.

        const held = { [UI]: { type: "v" }, title: "a" };
        const written = textOf(
          await runLine("get --json", atPiece(), screen(24, cellValue(held))),
        );
        expect(JSON.parse(written)).toEqual(held);
      });

      it("takes `--json`, and writes what it writes without it", async () => {
        // The flag says the output is machine-readable, which it is either
        // way, exactly as on `cf cell get`. It is declared because a data
        // verb takes `cf`'s read options, and a flag refused here and
        // accepted there is the drift decision 7 exists to stop.

        const value = { title: "a" };
        expect(await runLine("get --json", atPiece(), cellValue(value)))
          .toEqual(await runLine("get", atPiece(), cellValue(value)));
        expect(await runLine("get --json", atPiece(), cellValue(value)))
          .toEqual(writtenAs(value));
      });

      it("declares each option `cf cell get` declares under that name", async () => {
        // The anti-drift half of decision 7, over the four this verb takes:
        // a flag that stopped being `cf cell get`'s stops being one a shuttle
        // page can promise means the same thing.

        const declared = pieceDataCommand("get").getOptions()
          .flatMap((option) => option.flags);
        const page = textOf(
          await runLine("get --help", atPiece(), READS_NOTHING),
        );
        for (const flag of ["--filter", "--select", "--schema", "--json"]) {
          expect(declared).toContain(flag);
          expect(page).toContain(flag);
        }
      });

      it("writes the `$UI` node where the line named the fields it wants", async () => {
        const held = { [UI]: { type: "v" } };
        expect(
          textOf(
            await runLine("get --select '$UI'", atPiece(), cellValue(held)),
          ),
        )
          .toBe(renderValue(held, { ui: true }));
      });

      it("stands in for the node where the line wrote a filter alone", async () => {
        // A filter says which elements come back rather than what each holds,
        // so it is not the line naming the fields it wants. The boundary the
        // elision draws is the projection, and this is the side of it a
        // `--filter` falls on.

        expect(
          textOf(
            await runLine("get --filter .a", atPiece(), cellValue({ [UI]: 1 })),
          ),
        )
          .toContain("<elided");
      });

      it("stands in for the node where the line wrote no option at all", async () => {
        expect(textOf(await runLine("get", atPiece(), cellValue({ [UI]: 1 }))))
          .toContain("<elided");
      });
    });

    describe("the page a value is written on", () => {
      it("writes one page of the value and holds the rest", async () => {
        const shuttle = atPiece();
        const outcome = await runLine(
          "get",
          shuttle,
          screen(4, cellValue({ a: 1, b: 2, c: 3 })),
        );
        expect(textOf(outcome)).toBe(
          '{\n  "a": 1,\n<3 lines not shown — more continues, or --select ' +
            "narrows the read>",
        );
        expect(shuttle.session.continuation?.lines)
          .toEqual(['  "b": 2,', '  "c": 3', "}"]);
      });

      it("bounds a value that is one long line, which wraps onto many rows", async () => {
        // Finding 5's own case, at the shape that counting lines missed. A
        // piece result that is one long string is one line and twenty-six
        // rows on an eighty-column terminal: a page that counted lines wrote
        // the whole of it and said nothing about a continuation, which floods
        // the screen exactly as two hundred lines of vnode tree did.

        const shuttle = atPiece();
        const outcome = await runLine(
          "get",
          shuttle,
          screen(24, cellValue("x".repeat(2000)), 80),
        );
        const written = textOf(outcome).split("\n");
        expect(written.at(-1)).toContain("not shown — more continues");
        expect(shuttle.session.continuation?.lines.length).toBeGreaterThan(0);
      });

      it("holds nothing where the whole value fit", async () => {
        const shuttle = atPiece();
        shuttle.session.holding({ lines: ["stale"] });
        await runLine("get", shuttle, screen(24, cellValue({ a: 1 })));
        expect(shuttle.session.continuation).toBeUndefined();
      });

      it("numbers no rows, a value being no listing", async () => {
        // The two session objects are reset by different lines: a value that
        // did not fit takes over what `more` continues and leaves `%3` naming
        // the row the listing minted it for.

        const shuttle = atPiece();
        await runLine("ls", shuttle, screen(24, cellKeys(["a"])));
        await runLine("get", shuttle, screen(3, cellValue({ a: 1, b: 2 })));
        expect(shuttle.session.handles?.rows.map((row) => row.name))
          .toEqual(["a"]);
      });
    });
  });

  describe("wish", () => {
    // Reading across spaces costs nothing, where standing in one is what a
    // single connection cannot do, so the refusal decision 5 carries is `cd`'s
    // and this verb has none. No case here shows that: what `readWish` answers
    // a value read with says nothing about the space it resolved in, so the
    // absent check has nothing to be seen against.

    it("returns the value the target resolved to", async () => {
      expect(
        await runLine("wish #profileName", shuttleIn(), wishing("Ada")),
      ).toEqual({ kind: "value", value: "Ada" });
    });

    it("returns a resolved object with its handles written as markers", async () => {
      // A resolved object carries its pattern's stream handles, and through
      // them the runtime's whole object graph. The walk that strips them is
      // `cf wish`'s own, so what a target answers here is what it answers
      // there.
      expect(
        await runLine(
          "wish #profile",
          shuttleIn(),
          wishing({
            name: "Ada",
            setName: () => {},
          }),
        ),
      ).toEqual({
        kind: "value",
        value: { name: "Ada", setName: "[stream:setName]" },
      });
    });

    it("asks the wish for the target's value rather than for its address", async () => {
      let asked: WishReadConfig | undefined;
      await runLine("wish #profile", shuttleIn(), {
        ...READS_NOTHING,
        readWish: (config) => {
          asked = config;
          return Promise.resolve({ result: null });
        },
      });
      expect(asked?.query).toBe("#profile");
      expect(asked?.selection).toBeUndefined();
    });

    it("hands the wish the connection this process holds", async () => {
      let loaded: unknown;
      await runLine("wish #profile", shuttleIn(), {
        ...READS_NOTHING,
        readWish: async (config, deps) => {
          loaded = await deps?.loadPieces?.(config);
          return { result: null };
        },
      });
      expect(loaded).toBe(PIECES);
    });

    it("refuses a target that matched nothing, carrying the wish's own error", async () => {
      expect(
        reasonOf(
          await runLine(
            "wish #profile",
            shuttleIn(),
            wishing(null, "no profile yet"),
          ),
        ),
      ).toBe("`#profile` resolved to nothing: no profile yet");
    });

    it("returns the null a target that matched nothing else answers with", async () => {
      expect(
        await runLine("wish #profile", shuttleIn(), wishing(null)),
      ).toEqual({ kind: "value", value: null });
    });
  });

  describe("set", () => {
    it("writes the value at the cell the first operand names", async () => {
      let written: unknown;
      let at: (string | number)[] | undefined;
      await runLine(
        'set title "a"',
        atPiece(),
        answering({
          setCellValue: (_config, path, value) => {
            at = [...path];
            written = value;
            return Promise.resolve({ piece: HANDLE, path: [...path] });
          },
        }),
      );
      expect({ at, written }).toEqual({ at: ["title"], written: "a" });
    });

    it("writes a bare word as the string it spells", async () => {
      let written: unknown;
      await runLine(
        "set title milk",
        atPiece(),
        answering({
          setCellValue: (_config, path, value) => {
            written = value;
            return Promise.resolve({ piece: HANDLE, path: [...path] });
          },
        }),
      );
      expect(written).toBe("milk");
    });

    it("refuses a value opening the way JSON opens one and then not parsing", async () => {
      // The two readings divide on the first character, and this is the half
      // that is a mistake rather than a word: reading it as the string it
      // spells would write a value nobody meant and call it a success.

      expect(
        reasonOf(await runLine("set title [1,", atPiece(), answering()))
          .split(":")[0],
      ).toBe("`[1,` is not JSON");
    });

    it("refuses the standard-input sentinel rather than reading it", async () => {
      expect(reasonOf(await runLine("set title -", atPiece(), answering())))
        .toBe(
          "`-` reads the value from standard input, which the prompt is " +
            "reading keys from. Write the value on the line, or open the " +
            "cell with `edit`.",
        );
    });

    it("refuses a container, which holds no value to write", async () => {
      expect(reasonOf(await runLine('set slugs "a"', shuttleIn(), answering())))
        .toBe(
          "`slugs/` is a list of what stands inside it rather than a cell, " +
            "so `set` has nothing to write there.",
        );
    });

    it("selects the arguments cell where the operand wrote the member", async () => {
      let options: { input?: boolean } | undefined;
      await runLine(
        'set .#argument/title "a"',
        atPiece(),
        answering({
          setCellValue: (_config, path, _value, given) => {
            options = given;
            return Promise.resolve({ piece: HANDLE, path: [...path] });
          },
        }),
      );
      expect(options?.input).toBe(true);
    });

    it("writes the arguments cell a piece segment's member selects, with a walk after it", async () => {
      // The member rides the piece segment, and the path after it is inside
      // the arguments cell. Kills a write door that refuses a member with a
      // walk after it.

      let written: { path?: (string | number)[]; input?: boolean } = {};
      await runLine(
        `set slugs/board#argument/title '"x"'`,
        shuttleIn(),
        answering({
          setCellValue: (_config, path, _value, given) => {
            written = { path: [...path], input: given?.input };
            return Promise.resolve({ piece: BOARD, path: [...path] });
          },
        }),
      );
      expect(written).toEqual({ path: ["title"], input: true });
    });

    it("refuses a write onto a whole piece before the seam is asked", async () => {
      // The operand reached a piece and named no path inside it, which the
      // line settles: refusing it here is what keeps the sentence the one
      // this verb's page carries, `cf`'s address and positional being no
      // spelling a prompt has. Nothing is warmed for it either, a line that
      // cannot write being no reason to start a pattern.

      let warmed = false;
      let wrote = false;
      expect(
        reasonOf(
          await runLine(
            `set . '{"label":"x"}'`,
            atPiece(),
            answering({
              warmPiece: (config) => {
                warmed = true;
                return Promise.resolve({ piece: config.piece });
              },
              setCellValue: () => {
                wrote = true;
                return Promise.resolve({ piece: HANDLE, path: [] });
              },
            }),
          ),
        ),
      ).toBe(
        "A write onto a whole piece is refused. `link` is what writes a " +
          "reference.",
      );
      expect({ warmed, wrote }).toEqual({ warmed: false, wrote: false });
    });

    it("refuses an empty operand in its own name", async () => {
      // The reading every verb aims an operand through is `movePlace`'s, so
      // the name in its refusal is the line's rather than one verb's.

      expect(reasonOf(await runLine(`set '' '"x"'`, atPiece(), answering())))
        .toBe("`set` was given an empty operand, which names no place.");
    });

    it("asks the seam to refuse a write onto a whole piece", async () => {
      // The half of the refusal only resolution can decide: an address naming
      // a collection spends its leading segments reaching the member, so a
      // path the line carried can still resolve to a piece's root, and the
      // seam is what sees that.

      let options: { refuseRootWrite?: boolean } | undefined;
      await runLine(
        'set title "a"',
        atPiece(),
        answering({
          setCellValue: (_config, path, _value, given) => {
            options = given;
            return Promise.resolve({ piece: HANDLE, path: [...path] });
          },
        }),
      );
      expect(options?.refuseRootWrite).toBe(true);
    });

    it("says where the write landed, which is where the seam put it", async () => {
      // Not where the operand pointed: an operand naming a collection's
      // member spends its leading segments getting there, and only the piece
      // the seam reached says what was written.

      expect(
        textOf(
          await runLine(
            'set title "a"',
            atPiece(),
            answering({
              setCellValue: () =>
                Promise.resolve({ piece: BOARD, path: ["deep", "title"] }),
            }),
          ),
        ),
      ).toBe(`Wrote \`deep/title\` on \`${BOARD}\`.`);
    });

    it("says the arguments cell was written where it was", async () => {
      expect(
        textOf(
          await runLine(
            'set .#argument/title "a"',
            atPiece(),
            answering({
              setCellValue: () =>
                Promise.resolve({ piece: BOARD, path: ["title"] }),
            }),
          ),
        ),
      ).toBe(`Wrote \`title\` on \`${BOARD}#argument\`.`);
    });

    it("refuses what the seam turned down, in the seam's own sentence", async () => {
      expect(
        reasonOf(
          await runLine(
            'set title "a"',
            atPiece(),
            answering({
              setCellValue: () => {
                throw new ValidationError("The schema will not take that.");
              },
            }),
          ),
        ),
      ).toBe("The schema will not take that.");
    });

    it("starts the piece before it writes, so a computed value is live", async () => {
      const order: string[] = [];
      await runLine(
        'set title "a"',
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          setCellValue: () => {
            order.push("write");
            return Promise.resolve({ piece: HANDLE, path: ["title"] });
          },
        }),
      );
      expect(order).toEqual(["warm", "write"]);
    });

    it("starts the piece the walk reached, at the path it was aimed at", async () => {
      // A walk into a collection holder reaches a member, and the member is
      // what runs. The path goes over so the seam can spend what the walk
      // needs, which is what decides which piece starts.

      let path: (string | number)[] | undefined;
      await runLine(
        'set title "a"',
        atPiece("inbox"),
        answering({
          warmPiece: (config, given) => {
            path = [...(given ?? [])];
            return Promise.resolve({ piece: config.piece });
          },
        }),
      );
      expect(path).toEqual(["inbox", "title"]);
    });

    /**
     * Helper for the warming cases, which is a `warmPiece` that models the
     * real one: it resolves `path` to a piece the way a collection walk does,
     * honours the caller's memo, and records the starts it actually made.
     *
     * Counting calls would count the wrong thing. The memo's job is to stop a
     * piece being *started* twice, and the resolution in front of the start
     * happens either way — so a case that counted calls would go green for a
     * memo that saved nothing.
     */
    function counting(starts: string[]): VerbDeps {
      return answering({
        warmPiece: (config, path, deps) => {
          // A leading `members` segment stands for the collection walk that
          // makes two paths under one holder two pieces.
          const piece = path?.[0] === "members"
            ? `${config.piece}/${String(path[1])}`
            : config.piece;
          if (deps?.alreadyRunning?.(piece) !== true) starts.push(piece);
          return Promise.resolve({ piece });
        },
      });
    }

    it("starts a piece once for a run, however many fields are written", async () => {
      // The property the memo exists for, and the one a key over the path
      // rather than the piece loses: two lines writing two fields of one piece
      // are two lines reaching one piece.

      const starts: string[] = [];
      const shuttle = atPiece();
      const deps = counting(starts);
      await runLine('set title "a"', shuttle, deps);
      await runLine('set body "b"', shuttle, deps);
      expect(starts).toEqual([HANDLE]);
    });

    it("starts each member a walk reaches, two under one holder being two pieces", async () => {
      // The other side of the same key, and what a key over the piece alone
      // would lose: a walk into a collection reaches a member, and the second
      // member is not the first however alike the operands look.

      const starts: string[] = [];
      const shuttle = atPiece();
      const deps = counting(starts);
      await runLine('set members/1/title "a"', shuttle, deps);
      await runLine('set members/2/title "b"', shuttle, deps);
      expect(starts).toEqual([`${HANDLE}/1`, `${HANDLE}/2`]);
    });

    it("starts one piece for two operands that reach it by different paths", async () => {
      // The repeat the old key paid for and this one does not: the memo is
      // asked with what the resolution reached, so a second operand reaching
      // the same member finds it already running.

      const starts: string[] = [];
      const shuttle = atPiece();
      const deps = counting(starts);
      await runLine('set members/1/title "a"', shuttle, deps);
      await runLine('set members/1/body "b"', shuttle, deps);
      expect(starts).toEqual([`${HANDLE}/1`]);
    });
  });

  describe("link", () => {
    it("writes a reference at the second operand naming the first", async () => {
      let wrote: unknown;
      await runLine(
        "link title latest",
        atPiece(),
        answering({
          linkPieces: (_config, piece, path, onto, at) => {
            wrote = { piece, path: [...path], onto, at: [...at] };
            return Promise.resolve();
          },
        }),
      );
      expect(wrote).toEqual({
        piece: HANDLE,
        path: ["title"],
        onto: HANDLE,
        at: ["latest"],
      });
    });

    it("says which way round it wrote, quoting the line's own words", async () => {
      expect(textOf(await runLine("link title latest", atPiece(), answering())))
        .toBe("Wrote a reference at `latest` naming `title`.");
    });

    it("refuses the arguments member on the endpoint pointed at", async () => {
      expect(
        reasonOf(
          await runLine("link .#argument/title latest", atPiece(), answering()),
        ),
      ).toBe(
        "`.#argument/title` selects a piece's arguments cell, and a link " +
          "endpoint is a cell of a piece's result. Write the endpoint " +
          "without the `#argument` member.",
      );
    });

    it("refuses it on the endpoint written at, which is the other half", async () => {
      expect(
        reasonOf(
          await runLine("link title .#argument/latest", atPiece(), answering()),
        ),
      ).toBe(
        "`.#argument/latest` selects a piece's arguments cell, and a link " +
          "endpoint is a cell of a piece's result. Write the endpoint " +
          "without the `#argument` member.",
      );
    });

    it("refuses a container as an endpoint, which holds no cell to point at", async () => {
      // The endpoint door is `writable`'s plus the member rule, so a place
      // that is no cell is refused before either endpoint is read.

      expect(
        reasonOf(await runLine("link slugs latest", shuttleIn(), answering())),
      )
        .toBe(
          "`slugs/` is a list of what stands inside it rather than a cell, " +
            "so `link` has nothing to write there.",
        );
    });

    it("carries the scope each endpoint was reached through", async () => {
      const shuttle = atPiece();
      moved(shuttle.place, ".@session");
      let scopes: unknown;
      await runLine(
        "link title latest",
        shuttle,
        answering({
          linkPieces: (_c, _p, _pa, _o, _a, given) => {
            scopes = given;
            return Promise.resolve();
          },
        }),
      );
      expect(scopes)
        .toEqual({ sourceScope: "session", targetScope: "session" });
    });

    it("refuses what the seam turned down, in the seam's own sentence", async () => {
      expect(
        reasonOf(
          await runLine(
            "link title latest",
            atPiece(),
            answering({
              linkPieces: () => {
                throw new LinkValidationError(
                  "A link may not point at itself.",
                );
              },
            }),
          ),
        ),
      ).toBe("A link may not point at itself.");
    });

    it("starts the piece before it writes, and starts it once for both ends", async () => {
      // Two endpoints on one piece are one piece. What warms is a piece, so
      // the memo answers for the second end without another start — the same
      // rule two lines writing two fields of one piece meet.

      const order: string[] = [];
      await runLine(
        "link title latest",
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push(`warm ${config.piece}`);
            return Promise.resolve({ piece: config.piece });
          },
          linkPieces: () => {
            order.push("write");
            return Promise.resolve();
          },
        }),
      );
      expect(order).toEqual([`warm ${HANDLE}`, "write"]);
    });
  });

  describe("edit", () => {
    it("refuses where no editor is reachable, rather than guessing at one", async () => {
      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              editText: undefined,
            }),
          ),
        ),
      ).toBe(
        "No editor is reachable from here, so there is nothing to open the " +
          "value in.",
      );
    });

    it("refuses a whole piece before the editor opens", async () => {
      // The sentence `set` gives the same write, said while there is nothing
      // to lose: a person who has typed a document into an editor and saved
      // it is owed the write, and this line could never have made one. It is
      // said in front of the warm as well, for the reason `set` says it
      // there.

      let warmed = false;
      let read = false;
      let opened = false;
      expect(
        reasonOf(
          await runLine(
            "edit .",
            atPiece(),
            answering({
              warmPiece: (config) => {
                warmed = true;
                return Promise.resolve({ piece: config.piece });
              },
              getCellValue: () => {
                read = true;
                return Promise.resolve({ a: 1 });
              },
              editText: (text) => {
                opened = true;
                return Promise.resolve({
                  kind: "edited" as const,
                  text: `${text} `,
                  file: "/tmp/edited",
                  discard: () => Promise.resolve(),
                });
              },
            }),
          ),
        ),
      ).toBe(
        "A write onto a whole piece is refused. `link` is what writes a " +
          "reference.",
      );
      expect({ warmed, read, opened })
        .toEqual({ warmed: false, read: false, opened: false });
    });

    it("opens the value as JSON a person can read", async () => {
      let opened: string | undefined;
      await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => Promise.resolve({ a: 1 }),
          editText: (text) => {
            opened = text;
            return Promise.resolve({
              kind: "edited" as const,
              text,
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            });
          },
        }),
      );
      expect(opened).toBe('{\n  "a": 1\n}');
    });

    it("writes back what the editor saved, parsed", async () => {
      let written: unknown;
      await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => Promise.resolve({ a: 1 }),
          editText: () =>
            Promise.resolve({
              kind: "edited" as const,
              text: '{"a":2}',
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            }),
          setCellValue: (_config, path, value) => {
            written = value;
            return Promise.resolve({ piece: HANDLE, path: [...path] });
          },
        }),
      );
      expect(written).toEqual({ a: 2 });
    });

    it("writes nothing where the text came back unchanged, and says so", async () => {
      let wrote = false;
      const outcome = await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => Promise.resolve({ a: 1 }),
          editText: (text) =>
            Promise.resolve({
              kind: "edited" as const,
              text,
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            }),
          setCellValue: () => {
            wrote = true;
            return Promise.resolve({ piece: HANDLE, path: [] });
          },
        }),
      );
      expect({ wrote, said: textOf(outcome) })
        .toEqual({
          wrote: false,
          said: "Nothing changed, so nothing was written.",
        });
    });

    it("leaves the file behind where the text will not parse, and names it", async () => {
      // The one arm where a person's work exists nowhere else, so the file is
      // not removed and the refusal says where it is.

      let discarded = false;
      const reason = reasonOf(
        await runLine(
          "edit title",
          atPiece(),
          answering({
            getCellValue: () => Promise.resolve({ a: 1 }),
            editText: () =>
              Promise.resolve({
                kind: "edited" as const,
                text: "{ not json",
                file: "/tmp/edited",
                discard: () => {
                  discarded = true;
                  return Promise.resolve();
                },
              }),
          }),
        ),
      );
      expect({
        discarded,
        names: reason.endsWith(
          "Nothing was written, and the text is in `/tmp/edited`.",
        ),
      }).toEqual({ discarded: false, names: true });
    });

    it("removes the file once the write landed", async () => {
      let discarded = false;
      await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => Promise.resolve({ a: 1 }),
          editText: () =>
            Promise.resolve({
              kind: "edited" as const,
              text: '{"a":2}',
              file: "/tmp/edited",
              discard: () => {
                discarded = true;
                return Promise.resolve();
              },
            }),
        }),
      );
      expect(discarded).toBe(true);
    });

    it("opens no editor where the cancel arrived while the value was read", async () => {
      // The read answers whether or not the line was cancelled while it was
      // in flight, so the window after it is a boundary of its own — and
      // opening an editor is an adoption rather than a read, which is why the
      // rows above cannot reach it: they count reads, and this is not one.

      const stopper = new AbortController();
      let opened = false;
      const outcome = await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => {
            stopper.abort();
            return Promise.resolve({ a: 1 });
          },
          editText: (text) => {
            opened = true;
            return Promise.resolve({
              kind: "edited" as const,
              text,
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            });
          },
          signal: stopper.signal,
        }),
      );
      expect({ opened, kind: outcome.kind })
        .toEqual({ opened: false, kind: "interrupted" });
    });

    it("carries the editor's own refusal through", async () => {
      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              editText: () =>
                Promise.resolve({
                  kind: "refused" as const,
                  reason: "`$EDITOR` names nothing.",
                }),
            }),
          ),
        ),
      ).toBe("`$EDITOR` names nothing.");
    });

    /**
     * The values JSON cannot carry, each with where in a cell it sits.
     *
     * They are the losses a serialize-and-parse round trip makes rather than a
     * list of types: each is dropped, turned into something else, or throws,
     * and every one of them is a value a cell legitimately holds.
     */
    const UNWRITABLE: readonly (readonly [string, unknown, string])[] = [
      ["an `undefined`", { a: undefined }, "an `undefined` at a"],
      ["a symbol", { a: Symbol.for("x") }, "a symbol at a"],
      ["a `bigint`", { a: 1n }, "a `bigint` at a"],
      ["a function", { a: () => 1 }, "a function at a"],
      ["an array hole", { a: [, 1] }, "a hole at a/0"],
      [
        "a value that is itself `undefined`",
        undefined,
        "an `undefined` at the value itself",
      ],
      [
        "a nested one, at the path it sits at",
        { a: { b: 1n } },
        "a `bigint` at a/b",
      ],
    ];

    for (const [what, held, at] of UNWRITABLE) {
      it(`refuses ${what} before the editor opens`, async () => {
        let opened = false;
        const reason = reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () => Promise.resolve(held),
              editText: (text) => {
                opened = true;
                return Promise.resolve({
                  kind: "edited" as const,
                  text,
                  file: "/tmp/edited",
                  discard: () => Promise.resolve(),
                });
              },
            }),
          ),
        );
        expect({ opened, says: reason.startsWith(`The cell holds ${at},`) })
          .toEqual({ opened: false, says: true });
      });
    }

    /**
     * The numbers the fabric holds and JSON does not write back.
     *
     * Each was checked against the round trip rather than reasoned about: the
     * fabric admits every `number` (`isValidFabricValueLayer` admits by
     * `typeof`), and these four come back as something else — three as `null`,
     * having no JSON spelling, and the fourth as a positive zero.
     */
    const ALTERED_NUMBERS: readonly (readonly [string, number, string])[] = [
      ["a `NaN`", NaN, "a `NaN`"],
      ["an `Infinity`", Infinity, "an `Infinity`"],
      ["a `-Infinity`", -Infinity, "a `-Infinity`"],
      ["a negative zero", -0, "a negative zero"],
    ];

    for (const [what, held, named] of ALTERED_NUMBERS) {
      it(`refuses ${what} before the editor opens`, async () => {
        let opened = false;
        const reason = reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () => Promise.resolve({ a: held, b: 1 }),
              editText: (text) => {
                opened = true;
                return Promise.resolve({
                  kind: "edited" as const,
                  text,
                  file: "/tmp/edited",
                  discard: () => Promise.resolve(),
                });
              },
            }),
          ),
        );
        expect({
          opened,
          says: reason.startsWith(`The cell holds ${named} at a,`),
        })
          .toEqual({ opened: false, says: true });
      });
    }

    it("opens a value whose numbers JSON writes back unchanged", async () => {
      // The other side of the same line, and what makes the four above a
      // boundary rather than a blanket: an ordinary number, both safe-integer
      // bounds and a positive zero all survive the round trip, so a cell
      // holding them is a cell `edit` opens.

      let opened: string | undefined;
      await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () =>
            Promise.resolve({
              a: 1.5,
              b: 0,
              c: Number.MAX_SAFE_INTEGER,
              d: Number.MIN_SAFE_INTEGER,
              // An array the walk descends and comes back out of, which is
              // the arm that finds nothing rather than one that finds a loss.
              e: [1, "two", { three: 3 }],
            }),
          editText: (text) => {
            opened = text;
            return Promise.resolve({
              kind: "edited" as const,
              text,
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            });
          },
        }),
      );
      expect(opened).toBe(JSON.stringify(
        {
          a: 1.5,
          b: 0,
          c: Number.MAX_SAFE_INTEGER,
          d: Number.MIN_SAFE_INTEGER,
          e: [1, "two", { three: 3 }],
        },
        null,
        2,
      ));
    });

    it("refuses a value JSON cannot carry nested inside an array element", async () => {
      // The walk descends through arrays as well as objects, and the element
      // it descends into is where a loss can sit as readily as at the top.

      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () => Promise.resolve({ rows: [{ n: 1n }] }),
            }),
          ),
        ).startsWith("The cell holds a `bigint` at rows/0/n,"),
      ).toBe(true);
    });

    it("refuses a fabric value whose class a serializer drops", async () => {
      // The arm a walk over `typeof` alone misses entirely. A `FabricBytes`
      // is an object to `typeof` and a class instance in fact: it keeps its
      // bytes where a serializer cannot see them and writes as `{}`, so
      // opening the value would offer an empty object for editing and write
      // that back over the bytes.

      let opened = false;
      const reason = reasonOf(
        await runLine(
          "edit title",
          atPiece(),
          answering({
            getCellValue: () =>
              Promise.resolve({
                payload: new FabricBytes(new Uint8Array([1, 2])),
              }),
            editText: (text) => {
              opened = true;
              return Promise.resolve({
                kind: "edited" as const,
                text,
                file: "/tmp/edited",
                discard: () => Promise.resolve(),
              });
            },
          }),
        ),
      );
      expect({
        opened,
        says: reason.startsWith("The cell holds a `FabricBytes` at payload,"),
      })
        .toEqual({ opened: false, says: true });
    });

    it("refuses one nested inside an array, the walk reaching it there too", async () => {
      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () =>
                Promise.resolve({
                  rows: [new FabricBytes(new Uint8Array([1]))],
                }),
            }),
          ),
        ).startsWith("The cell holds a `FabricBytes` at rows/0,"),
      ).toBe(true);
    });

    it("names one that will not say what class it is for what it is", async () => {
      // The name is read off the prototype, and a class expression given no
      // name has none to read. The refusal still has to say what it found,
      // because a person deciding what to `set` instead is deciding from it.

      const nameless = new (class extends BaseFabricSpecialObject {})();
      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () => Promise.resolve({ payload: nameless }),
            }),
          ),
        ).startsWith("The cell holds a `fabric value` at payload,"),
      ).toBe(true);
    });

    it("refuses a cycle, which a serializer throws on", async () => {
      const held: Record<string, unknown> = {};
      held.self = held;
      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () => Promise.resolve(held),
            }),
          ),
        ).startsWith("The cell holds a cycle at self,"),
      ).toBe(true);
    });

    it("refuses a property a serializer would leave out", async () => {
      // What `Object.entries` leaves out is what `JSON.stringify` leaves out,
      // so a walk over the entries alone would agree with the serializer and
      // miss the loss. Counting the own keys is what notices one.

      const held = {};
      Object.defineProperty(held, "hidden", { value: 1, enumerable: false });
      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () => Promise.resolve(held),
            }),
          ),
        ).startsWith(
          "The cell holds a property JSON does not write at the value itself,",
        ),
      ).toBe(true);
    });
  });

  describe("call", () => {
    /**
     * Helper for the cases below, which runs `line` and is what the seam was
     * handed.
     */
    async function handed(
      line: string,
      shuttle: Shuttle = atPiece(),
      over: VerbDeps = {},
    ): Promise<Record<string, unknown>> {
      let seen: Record<string, unknown> = {};
      await runLine(
        line,
        shuttle,
        answering({
          callFromCommand: (
            options,
            spelling,
            callableArg,
            tailArgs,
            rawArgs,
            literalArgs,
          ) => {
            seen = {
              cell: options.cell,
              invocationSession: options.invocationSession,
              spelling,
              callableArg,
              tailArgs: [...tailArgs],
              rawArgs: [...rawArgs],
              literalArgs: [...literalArgs],
            };
            return Promise.resolve();
          },
          ...over,
        }),
      );
      return seen;
    }

    it("takes the receiver first and the verb name after it", async () => {
      expect(await handed("call . add-reply")).toMatchObject({
        callableArg: "add-reply",
        tailArgs: [],
      });
    });

    it("addresses the receiver as the reference a `--cell` takes", async () => {
      expect((await handed("call . add-reply")).cell)
        .toBe(`/${HANDLE}@space`);
    });

    it("carries the path a walk spent, so a member is what is called on", async () => {
      expect((await handed("call . add-reply", atPiece("inbox"))).cell)
        .toBe(`/${HANDLE}@space/inbox`);
    });

    it("carries the scope the place reads through", async () => {
      const shuttle = atPiece();
      moved(shuttle.place, ".@session");
      expect((await handed("call . add-reply", shuttle)).cell)
        .toBe(`/${HANDLE}@session`);
    });

    it("invokes under the session the run was started with", async () => {
      expect((await handed("call . add-reply")).invocationSession)
        .toBe("a-session");
    });

    it("names the mount a person could run the same call from", async () => {
      // The seam prints it in the corrected line a grammar refusal ends with,
      // and a corrected line is only worth printing where it can be run.

      expect((await handed("call . add-reply")).spelling).toBe("piece call");
    });

    it("hands the callable's own flags over unread", async () => {
      // The verb name opens the callable's section, so what follows it is the
      // callable's grammar and no table here names it.

      expect(await handed("call . search --query milk")).toMatchObject({
        callableArg: "search",
        tailArgs: ["--query", "milk"],
      });
    });

    it("keeps the words past the bare `--` apart, as the read step's own", async () => {
      expect(await handed("call . search --query milk -- --json x"))
        .toMatchObject({
          tailArgs: ["--query", "milk"],
          literalArgs: ["--json", "x"],
        });
    });

    it("hands over the argv a person could have run outside the shell", async () => {
      expect((await handed("call . search --query milk -- x")).rawArgs)
        .toEqual([
          "--cell",
          `/${HANDLE}@space`,
          "search",
          "--query",
          "milk",
          "--",
          "x",
        ]);
    });

    it("writes no `--` into that argv where the line wrote none", async () => {
      expect((await handed("call . search")).rawArgs)
        .toEqual(["--cell", `/${HANDLE}@space`, "search"]);
    });

    it("refuses a receiver with no verb after it, naming the form to write", async () => {
      expect(reasonOf(await runLine("call topics/3", atPiece(), answering())))
        .toBe(
          "`topics/3` names the piece to call on, and the verb to call " +
            "follows it, as in `call topics/3 add-reply`. A path ending in " +
            "a callable names no cell: a verb is interface vocabulary " +
            "rather than a data path.",
        );
    });

    it("takes a walk written after a handle to the cell it reaches", async () => {
      // The path every other verb takes after a handle. `call` reads the
      // receiver through the same grammar, so a handle carrying one is a
      // reference to a cell and the verb name follows it as usual.

      const shuttle = atPiece();
      await runLine("ls", shuttle, answering());
      let handed: unknown;
      await runLine(
        "call %1/deeper search",
        shuttle,
        answering({
          getCellValue: () => Promise.resolve({ title: { deeper: 1 } }),
          callFromCommand: (options, _spelling, name) => {
            handed = { cell: options.cell, name };
            return Promise.resolve();
          },
        }),
      );
      expect(handed)
        .toEqual({ cell: `/${HANDLE}@space/title/deeper`, name: "search" });
    });

    it("refuses a walk written after a callable handle, a callable being no place", async () => {
      // A bare callable handle carries the verb name; one with a walk after it
      // does not, because the walk would have to start at the callable and a
      // callable is not somewhere to stand. So the two spellings part here,
      // and this is the one that is refused rather than invoked.

      const shuttle = atPiece();
      await runLine("verbs", shuttle, answering());
      let dispatched = false;
      const outcome = await runLine(
        "call %1/deeper search",
        shuttle,
        answering({
          callFromCommand: () => {
            dispatched = true;
            return Promise.resolve();
          },
        }),
      );
      expect({ dispatched, reason: reasonOf(outcome) }).toEqual({
        dispatched: false,
        reason: "`%1` names a row no place stands at, it being one of the " +
          "piece's callables. `call` is what invokes one.",
      });
    });

    it("refuses a verb name written in the shape of an option", async () => {
      // It reaches the fabric as a callable of that literal name otherwise,
      // and comes back as a piece that has no such verb — an answer about the
      // piece for a line that was never about the piece.

      let dispatched = false;
      const outcome = await runLine(
        "call . --help",
        atPiece(),
        answering({
          callFromCommand: () => {
            dispatched = true;
            return Promise.resolve();
          },
        }),
      );
      expect({ dispatched, reason: reasonOf(outcome) }).toEqual({
        dispatched: false,
        reason: "`--help` names no verb: a verb name is interface " +
          "vocabulary, and a token opening with `-` is read as an option " +
          "wherever one may be written. `verbs` lists what this piece can be " +
          "asked to do, and `call --help` writes this verb's own page.",
      });
    });

    it("refuses `-h` the same way, it being the other one written on purpose", async () => {
      expect(reasonOf(await runLine("call . -h", atPiece(), answering())))
        .toContain("`verbs` lists what this piece can be asked to do");
    });

    it("refuses an option-shaped name that is asking for nothing, without the offer", async () => {
      // The sentence divides: the shape is refused for every such name, and
      // the pointer is added only for the two a person writes meaning to ask.

      const reason = reasonOf(
        await runLine("call . --nope", atPiece(), answering()),
      );
      expect(reason.startsWith("`--nope` names no verb:")).toBe(true);
      expect(reason).not.toContain("`verbs` lists");
    });

    it("refuses a container, which is no receiver", async () => {
      expect(reasonOf(await runLine("call slugs a", shuttleIn(), answering())))
        .toBe(
          "`slugs/` is a list of what stands inside it rather than a piece, " +
            "and `call` acts on a piece.",
        );
    });

    it("refuses the arguments member, a verb belonging to neither cell", async () => {
      expect(
        reasonOf(await runLine("call .#argument a", atPiece(), answering())),
      )
        .toBe(
          "`#argument` selects one of a piece's two cells, and a verb " +
            "belongs to the piece rather than to either of them. Write the " +
            "piece without the member.",
        );
    });

    it("refuses a call that reads the keyboard, rather than wedging on it", async () => {
      // Standard input is what the prompt reads its keys off, and a read that
      // never reaches end of input would wedge the shell rather than fail.
      // Every spelling arrives at one reader, which is what closes the set.

      let refused: string | undefined;
      await runLine(
        "call . search -",
        atPiece(),
        answering({
          callFromCommand: async (_o, _s, _n, _t, _r, _l, deps = {}) => {
            try {
              await deps.executePieceCallable?.(
                {} as PieceConfig,
                "search",
                [],
                {},
              );
            } catch (thrown) {
              refused = (thrown as Error).message;
            }
          },
          executePieceCallable: async (_config, _name, _args, given) => {
            await given?.readTextInput?.();
            throw new Error("The reader answered instead of refusing.");
          },
        }),
      );
      expect(refused).toBe(
        "`-` reads the input from standard input, which the prompt is " +
          "reading keys from. Write the input on the line, as inline JSON " +
          "or as the verb's own flags.",
      );
    });

    it("tells the call that standard input is a terminal, so nothing reads it", async () => {
      let terminal: boolean | undefined;
      await runLine(
        "call . search",
        atPiece(),
        answering({
          callFromCommand: async (_o, _s, _n, _t, _r, _l, deps = {}) => {
            await deps.executePieceCallable?.(
              {} as PieceConfig,
              "search",
              [],
              {},
            );
          },
          executePieceCallable: (_config, _name, _args, given) => {
            terminal = given?.isStdinTerminal?.();
            return Promise.resolve(undefined as never);
          },
        }),
      );
      expect(terminal).toBe(true);
    });

    it("writes what the call published while it ran out of band, not into the outcome", async () => {
      // It happens before there is an outcome to carry it, which is what an
      // out-of-band line is for.

      const announced: string[] = [];
      const outcome = await runLine(
        "call . search",
        atPiece(),
        answering({
          announce: (text) => announced.push(text),
          callFromCommand: (_o, _s, _n, _t, _r, _l, deps = {}) => {
            deps.announce?.("invocation: 1");
            deps.render?.("done");
            return Promise.resolve();
          },
        }),
      );
      expect({ announced, said: textOf(outcome) })
        .toEqual({ announced: ["invocation: 1"], said: "done" });
    });

    it("drops those lines where a caller offered nowhere to write them", async () => {
      const outcome = await runLine(
        "call . search",
        atPiece(),
        answering({
          callFromCommand: (_o, _s, _n, _t, _r, _l, deps = {}) => {
            deps.announce?.("invocation: 1");
            return Promise.resolve();
          },
        }),
      );
      expect(textOf(outcome)).toBe("");
    });

    it("returns a failed call as a refusal rather than ending the run", async () => {
      expect(
        reasonOf(
          await runLine(
            "call . search",
            atPiece(),
            answering({
              callFromCommand: (_o, _s, _n, _t, _r, _l, deps = {}) => {
                deps.printError?.("The call failed.");
                deps.exit?.(1);
                return Promise.resolve();
              },
            }),
          ),
        ),
      ).toBe("The call failed.");
    });

    it("refuses what the seam's grammar turned down, in its own sentence", async () => {
      expect(
        reasonOf(
          await runLine(
            "call . search",
            atPiece(),
            answering({
              callFromCommand: () => {
                throw new ValidationError("The section is not grammar.");
              },
            }),
          ),
        ),
      ).toBe("The section is not grammar.");
    });

    it("starts the piece before it calls", async () => {
      const order: string[] = [];
      await runLine(
        "call . search",
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          callFromCommand: () => {
            order.push("call");
            return Promise.resolve();
          },
        }),
      );
      expect(order).toEqual(["warm", "call"]);
    });
  });

  describe("verbs", () => {
    /** Helper for the cases below, which is what `verbs` wrote, row by row. */
    async function rowsOf(
      line: string,
      listed: PieceCallableListing[],
    ): Promise<string[]> {
      return textOf(
        await runLine(
          line,
          atPiece(),
          answering({
            listPieceCallables: () =>
              Promise.resolve({ pattern: null, verbs: listed }),
          }),
        ),
      ).split("\n");
    }

    it("numbers every row from one", async () => {
      expect(await rowsOf("verbs", [callable("first"), callable("second")]))
        .toEqual([
          "%1 first <handler on result>",
          "%2 second <handler on result>",
        ]);
    });

    it("writes the author's own prose after what the verb is", async () => {
      expect(
        await rowsOf("verbs", [
          callable("search", { description: "Find things." }),
        ]),
      ).toEqual(["%1 search <handler on result> <Find things.>"]);
    });

    it("writes a description's line break as a space, keeping the row one row", async () => {
      expect(
        await rowsOf("verbs", [
          callable("search", { description: "Find\nthings." }),
        ]),
      ).toEqual(["%1 search <handler on result> <Find things.>"]);
    });

    it("describes a name a terminal would act on rather than writing it", async () => {
      // Writing it would put on the screen what every door refuses to let
      // through, and a rewritten name is no longer the name. The number the
      // row was minted under is what still reaches the verb.

      expect(await rowsOf("verbs", [callable("a\u0001b")]))
        .toEqual([
          "%1 <no name: a verb name holding a control character> " +
          "<handler on result>",
        ]);
    });

    it("marks a wrapper and a deprecated verb where `--all` shows them", async () => {
      expect(
        await rowsOf("verbs --all", [
          callable("old", { tier: "wrapper", deprecated: true }),
        ]),
      ).toEqual([
        "%1 old <handler on result, wrapper, deprecated>",
      ]);
    });

    it("withholds those rows by default, and says how many", async () => {
      const rows = await rowsOf("verbs", [
        callable("shown"),
        callable("old", { tier: "wrapper" }),
      ]);
      expect(rows[0]).toContain("hidden");
      expect(rows.slice(1)).toEqual(["%1 shown <handler on result>"]);
    });

    it("records each row as a callable, so `cd` has nothing to walk to", async () => {
      const shuttle = atPiece();
      await runLine("verbs", shuttle, answering());
      expect(shuttle.session.handles?.rows)
        .toEqual([{ name: "a-verb", kind: "callable" }]);
    });

    it("records the piece as the place the rows stand inside", async () => {
      // The receiver `call %n` wants, recorded once for the listing rather
      // than once per row, where two copies would be free to part.

      const shuttle = atPiece();
      await runLine("verbs", shuttle, answering());
      expect(shuttle.session.handles?.place).toEqual(shuttle.place.place);
    });

    it("refuses an operand the place would not read, before it acts on a piece", async () => {
      // The aim answers first, and a `#name` entry point is not a cell under
      // this place — so the refusal is the place's rather than a sentence
      // about pieces written here.

      expect(
        reasonOf(await runLine("verbs #favorites", atPiece(), answering())),
      )
        .toBe(
          "`#favorites` names an entry point rather than a cell under this " +
            "place. `wish #favorites` reads what it resolves to.",
        );
    });

    it("refuses a container, which holds no callables", async () => {
      expect(reasonOf(await runLine("verbs slugs", shuttleIn(), answering())))
        .toBe(
          "`slugs/` is a list of what stands inside it rather than a piece, " +
            "and `verbs` acts on a piece.",
        );
    });

    it("starts the piece before it lists", async () => {
      const order: string[] = [];
      await runLine(
        "verbs",
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          listPieceCallables: () => {
            order.push("list");
            return Promise.resolve({ pattern: null, verbs: [] });
          },
        }),
      );
      expect(order).toEqual(["warm", "list"]);
    });
  });

  describe("describe", () => {
    it("writes the page the piece describes itself with", async () => {
      const text = textOf(
        await runLine(
          "describe",
          atPiece(),
          answering({
            describePiece: () =>
              Promise.resolve({
                pattern: null,
                name: "A board",
                verbs: [callable("a-verb")],
              }),
          }),
        ),
      );
      expect(text).toContain("A board");
    });

    it("numbers nothing, `verbs` being the listing `call %n` reads", async () => {
      const shuttle = atPiece();
      await runLine("describe", shuttle, answering());
      expect(shuttle.session.handles).toBeUndefined();
    });

    it("refuses a container, which describes nothing", async () => {
      expect(
        reasonOf(await runLine("describe slugs", shuttleIn(), answering())),
      ).toBe(
        "`slugs/` is a list of what stands inside it rather than a piece, " +
          "and `describe` acts on a piece.",
      );
    });

    it("starts the piece before it describes", async () => {
      const order: string[] = [];
      await runLine(
        "describe",
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          describePiece: () => {
            order.push("describe");
            return Promise.resolve({ pattern: null, verbs: [] });
          },
        }),
      );
      expect(order).toEqual(["warm", "describe"]);
    });
  });
  describe("watch, watches and unwatch", () => {
    // The three read one session object, so what the cases turn on is the pair
    // of lifetimes: a lens cancels its own subscription on the way out and the
    // watch's goes on firing, and only `unwatch` stops that one.
    //
    // Every subscription is stood in for, so a case drives a settle by calling
    // what the seam was handed rather than by waiting for a runtime.

    /** What driving the subscriptions produced. */
    interface Watching {
      /** Every settle callback the line took, in the order it took them. */
      readonly settles: ((value: unknown) => void)[];

      /** How many of those subscriptions have been cancelled. */
      readonly cancelled: boolean[];

      /** Every line the run wrote above the prompt, in order. */
      readonly announced: string[];
    }

    /**
     * Helper for the cases below, which is a deps bag whose subscription is
     * this case's to drive, recording each one.
     */
    function watching(): { deps: VerbDeps; watched: Watching } {
      const watched: Watching = {
        settles: [],
        cancelled: [],
        announced: [],
      };
      return {
        watched,
        deps: answering({
          sinkCellValue: (_config, _path, onSettled) => {
            const at = watched.settles.length;
            watched.settles.push(onSettled);
            watched.cancelled.push(false);
            return Promise.resolve(() => {
              watched.cancelled[at] = true;
            });
          },
          announce: (text) => {
            watched.announced.push(text);
          },
          columns: () => 200,
        }),
      };
    }

    /** Helper for the cases below, which is the lens a `watch` line opened. */
    function lensOf(outcome: Outcome): ValueLens {
      if (outcome.kind !== "watching") {
        throw new Error(`The line opened no lens: ${outcome.kind}.`);
      }
      return outcome.lens;
    }

    /** Helper for the cases below, which is what a `watch` line listed. */
    function armedOf(outcome: Outcome): string {
      return outcome.kind === "watching"
        ? outcome.armed
        : `not watching: ${outcome.kind}`;
    }

    it("arms a watch on the cell the operand names", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      expect(shuttle.session.watches.map((armed) => armed.label))
        .toEqual([`${HANDLE}/title @space`]);
    });

    it("arms a watch on a result key named like the member, `#` being data in a path", async () => {
      // Kills a watch door that still reads a trailing `#argument` as the
      // arguments cell, which would refuse this line instead of arming it.

      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title#argument", shuttle, deps);
      expect(shuttle.session.watches.map((armed) => armed.key))
        .toEqual([`/${HANDLE}@space/title#argument`]);
    });

    it("arms a watch on where shuttle stands where the line names nothing", async () => {
      const shuttle = atPiece("title");
      const { deps } = watching();
      await runLine("watch", shuttle, deps);
      expect(shuttle.session.watches.map((armed) => armed.key))
        .toEqual([`/${HANDLE}@space/title`]);
    });

    it("refuses a piece's arguments cell, naming the verb that reads one", async () => {
      // A subscription there reports the link stored at the member rather than
      // the value behind it, and a write through that link settles nothing it
      // can see — so a watch armed on one would draw a link marker and then
      // say nothing ever again. A refusal is what a person can act on, where a
      // silent watch reads as a cell nobody is changing.

      const shuttle = atPiece();
      const { deps, watched } = watching();
      expect(
        reasonOf(await runLine("watch .#argument/title", shuttle, deps)),
      )
        .toBe(
          "`watch` does not serve a piece's arguments cell, so the " +
            "`#argument` member is refused here. `get .#argument/title` or " +
            "`get /slugs/board#argument/title` reads one, and `watch <ref>` " +
            "watches the result the pattern computes from it.",
        );
      expect({
        armed: shuttle.session.watches.length,
        subscriptions: watched.settles.length,
      }).toEqual({ armed: 0, subscriptions: 0 });
    });

    it("hands back an operand's own refusal, having armed nothing", async () => {
      // The refusal is the place's, in the words of the thing that was wrong
      // with the operand, and it arrives before anything is armed and before
      // anything is subscribed to: a line that named nowhere leaves the
      // session exactly as it found it.

      const shuttle = atPiece();
      const { deps, watched } = watching();
      const outcome = await runLine("watch #argument", shuttle, deps);
      expect({
        reason: reasonOf(outcome),
        armed: shuttle.session.watches.length,
        subscriptions: watched.settles.length,
      }).toEqual({
        reason: "`#argument` on its own names no piece to select the " +
          "arguments cell of. The member goes on a head or a piece segment, " +
          "as in `get .#argument/title` or `get /slugs/board#argument/title`.",
        armed: 0,
        subscriptions: 0,
      });
    });

    it("opens a lens onto the cell it armed the watch on", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      const outcome = await runLine("watch title", shuttle, deps);
      expect(lensOf(outcome).label).toBe(`${HANDLE}/title @space`);
    });

    it("takes a subscription for the watch and one for the lens", async () => {
      // Two lifetimes, so two subscriptions: a lens cancels its own on the way
      // out and the watch's goes on firing, which one subscription could not
      // express.

      const { deps, watched } = watching();
      await runLine("watch title", atPiece(), deps);
      expect(watched.settles.length).toBe(2);
    });

    it("draws in the lens what the lens's own subscription settled at", async () => {
      // The second subscription is the lens's, and what it does with a settle
      // is the other half of the pair: the watch writes a line above the
      // prompt, and the lens redraws the value it is holding the screen for.

      const { deps, watched } = watching();
      const outcome = await runLine("watch title", atPiece(), deps);
      watched.settles[1]!("a title");
      expect(lensOf(outcome).frame(6, 40).join("\n")).toContain('"a title"');
    });

    it("leaves the watch armed when the lens closes, and cancels the lens's own", async () => {
      const shuttle = atPiece();
      const { deps, watched } = watching();
      const outcome = await runLine("watch title", shuttle, deps);
      lensOf(outcome).close();
      expect({
        cancelled: watched.cancelled,
        armed: shuttle.session.watches.length,
      }).toEqual({ cancelled: [false, true], armed: 1 });
    });

    it("writes an event line above the prompt for a settled change", async () => {
      const { deps, watched } = watching();
      await runLine("watch title", atPiece(), deps);
      const settle = watched.settles[0]!;
      settle(14);
      settle(15);
      expect(watched.announced)
        .toEqual([`watch ${HANDLE}/title @space: changed`]);
    });

    it("writes no event line once the watch is disarmed", async () => {
      const shuttle = atPiece();
      const { deps, watched } = watching();
      await runLine("watch title", shuttle, deps);
      const settle = watched.settles[0]!;
      settle(14);
      await runLine("unwatch %1", shuttle, deps);
      settle(15);
      expect(watched.announced).toEqual([]);
    });

    it("numbers what is armed as it arms one, so `unwatch %n` needs no listing first", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      const outcome = await runLine("watch title", shuttle, deps);
      expect(armedOf(outcome)).toBe(`%1 ${HANDLE}/title @space`);
      expect(textOf(await runLine("unwatch %1", shuttle, deps)))
        .toBe(`Disarmed the watch on \`${HANDLE}/title @space\`.`);
    });

    it("refuses a cell it is already watching, naming what is armed", async () => {
      // Two watches on one cell write two of every line, and the second says
      // nothing the first did not.

      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      expect(reasonOf(await runLine("watch title", shuttle, deps))).toBe(
        `\`${HANDLE}/title @space\` is watched already. \`watches\` numbers ` +
          "what is armed, and `unwatch %n` disarms one.",
      );
    });

    it("refuses a second spelling of a cell it is already watching", async () => {
      // The question is asked of the cell rather than of the operand, so the
      // two spellings that reach one cell are one watch.

      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      expect(
        reasonOf(await runLine(`watch /${HANDLE}/title`, shuttle, deps))
          .endsWith(
            "disarms one.",
          ),
      ).toBe(true);
    });

    it("takes no subscription for a cell it is already watching", async () => {
      const shuttle = atPiece();
      const { deps, watched } = watching();
      await runLine("watch title", shuttle, deps);
      await runLine("watch title", shuttle, deps);
      expect(watched.settles.length).toBe(2);
    });

    it("refuses a container, which holds no value to watch", async () => {
      expect(reasonOf(await runLine("watch", shuttleIn(), READS_NOTHING)))
        .toBe(
          "A space root is a list of what stands inside it rather than a " +
            "cell, so there is nothing to watch. `ls` lists it.",
        );
    });

    it("starts the piece before it subscribes", async () => {
      // What a sink reports is what a running pattern holds, or what was last
      // committed if nothing is running it.

      const order: string[] = [];
      const shuttle = atPiece();
      await runLine(
        "watch title",
        shuttle,
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          sinkCellValue: () => {
            order.push("subscribe");
            return Promise.resolve(() => {});
          },
        }),
      );
      expect(order).toEqual(["warm", "subscribe", "subscribe"]);
    });

    it("disarms the watch it armed where the lens's subscription was cancelled", async () => {
      // An interrupted line leaves the session as it found it, and a
      // subscription nothing holds a cancel for is one nothing could stop.

      const stopper = new AbortController();
      const shuttle = atPiece();
      const cancelled: boolean[] = [];
      const outcome = await runLine(
        "watch title",
        shuttle,
        answering({
          sinkCellValue: () => {
            const at = cancelled.length;
            cancelled.push(false);
            if (at === 1) stopper.abort();
            return Promise.resolve(() => {
              cancelled[at] = true;
            });
          },
          signal: stopper.signal,
        }),
      );
      expect({
        kind: outcome.kind,
        cancelled,
        armed: shuttle.session.watches.length,
      }).toEqual({ kind: "interrupted", cancelled: [true, true], armed: 0 });
    });

    it("disarms the watch it armed where the lens's subscription failed", async () => {
      // The other way out of that stretch. A read that failed raises rather
      // than coming back as an outcome, and a watch left armed behind it is a
      // sink nothing can reach: the session never took it, so `watches` does
      // not list it and the run's own disarm passes it by.

      const shuttle = atPiece();
      const cancelled: boolean[] = [];
      await expect(runLine(
        "watch title",
        shuttle,
        answering({
          sinkCellValue: () => {
            const at = cancelled.length;
            if (at === 1) return Promise.reject(new Error("The server went."));
            cancelled.push(false);
            return Promise.resolve(() => {
              cancelled[at] = true;
            });
          },
        }),
      )).rejects.toThrow("The server went.");
      expect({ cancelled, armed: shuttle.session.watches.length })
        .toEqual({ cancelled: [true], armed: 0 });
    });

    it("takes no subscription and arms nothing where handing over its lens throws", async () => {
      // The lens is made and handed over before anything is held, so a
      // handover that throws leaves nothing to undo: no subscription taken,
      // and no watch armed. Handed over any later, the throw would leave the
      // watch's own subscription running with nothing holding its cancel.
      //
      // Kills: handing the lens over after the watch's first subscription,
      // which leaves that subscription taken and uncancelled.

      const shuttle = atPiece();
      const { deps, watched } = watching();
      await expect(runLine("watch title", shuttle, {
        ...deps,
        adoptLens: () => {
          throw new Error("The lens had nowhere to go.");
        },
      })).rejects.toThrow("The lens had nowhere to go.");
      expect({
        taken: watched.settles.length,
        armed: shuttle.session.watches.length,
      }).toEqual({ taken: 0, armed: 0 });
    });

    it("lists what is armed, numbering each", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      await runLine("watch body", shuttle, deps);
      expect(textOf(await runLine("watches", shuttle, deps)))
        .toBe(
          `%1 ${HANDLE}/title @space\n%2 ${HANDLE}/body @space`,
        );
    });

    it("says so where nothing is armed", async () => {
      expect(textOf(await runLine("watches", shuttleIn(), READS_NOTHING)))
        .toBe("<no watches are armed>");
    });

    it("disarms the watch a row numbered and cancels its subscription", async () => {
      const shuttle = atPiece();
      const { deps, watched } = watching();
      await runLine("watch title", shuttle, deps);
      await runLine("unwatch %1", shuttle, deps);
      expect({
        armed: shuttle.session.watches.length,
        cancelled: watched.cancelled,
      }).toEqual({ armed: 0, cancelled: [true, false] });
    });

    it("disarms the watch the row was minted for, not whichever is second now", async () => {
      // What a bound reference buys: the row carries the cell its watch is
      // armed on, so a listing read against a session that has changed since
      // still names the watch it showed.

      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      await runLine("watch body", shuttle, deps);
      await runLine("watches", shuttle, deps);
      await runLine("unwatch %1", shuttle, deps);
      await runLine("unwatch %2", shuttle, deps);
      expect(shuttle.session.watches.map((armed) => armed.label)).toEqual([]);
    });

    it("refuses a token that names no handle at all", async () => {
      // The handle's own refusal, handed back as it stands: what is wrong with
      // `title` is that it is not a handle, and `unwatch` has nothing to add
      // to a reading that already says so.

      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      expect(reasonOf(await runLine("unwatch title", shuttle, deps))).toBe(
        "`title` names no handle. A handle is `%` and the number a listing " +
          "printed beside a row, as in `%3`.",
      );
    });

    it("refuses a handle naming a row of some other listing", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      await runLine("ls", shuttle, deps);
      expect(reasonOf(await runLine("unwatch %1", shuttle, deps))).toBe(
        "`%1` names a row of a listing rather than a watch. `watches` lists " +
          "what is armed and numbers each of them.",
      );
    });

    it("refuses a handle naming a watch that is no longer armed", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      await runLine("unwatch %1", shuttle, deps);
      expect(reasonOf(await runLine("unwatch %1", shuttle, deps))).toBe(
        "`%1` names a watch that is no longer armed. `watches` lists what is.",
      );
    });

    it("refuses a `cd` onto a watch row, naming the verb that disarms one", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      expect(reasonOf(await runLine("cd %1", shuttle, deps))).toBe(
        "`%1` names a row no place stands at, it being a watch. `unwatch` " +
          "is what disarms one.",
      );
    });

    it("names what is armed in the ambient record", async () => {
      const shuttle = atPiece();
      const { deps } = watching();
      await runLine("watch title", shuttle, deps);
      expect(textOf(await runLine("where", shuttle, deps)).split("\n").at(-1))
        .toBe(`watches   ${HANDLE}/title @space`);
    });
  });

  describe("a numbered handle", () => {
    // The other half of a handle: `%n` is printed by a listing and read here.
    // What every case turns on is that the row and the place it was listed at
    // come back together, since a row's name is a name inside that place.

    it("moves to the row the last listing numbered", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, answering());
      await runLine("cd %1", shuttle, answering());
      expect(shuttle.place.place.position).toMatchObject({ path: ["title"] });
    });

    it("reads the row a listing numbered, without moving", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, answering());
      const at = shuttle.place.place;
      const outcome = await runLine(
        "get %1",
        shuttle,
        answering({
          getCellValue: (_config, path) => Promise.resolve(path.join("/")),
        }),
      );
      expect({ read: textOf(outcome), moved: shuttle.place.place !== at })
        .toEqual({ read: renderValue("title"), moved: false });
    });

    it("walks the segments written after the handle, from where the row stands", async () => {
      const shuttle = atPiece();
      const nested = answering({
        getCellValue: () => Promise.resolve({ title: { deeper: 1 } }),
        listing: {
          getCellValue: () => Promise.resolve({ title: {} }),
          listCallableKeys: () => Promise.resolve(new Set<string>()),
        },
      });
      await runLine("ls", shuttle, nested);
      await runLine("cd %1/deeper", shuttle, nested);
      expect(shuttle.place.place.position)
        .toMatchObject({ path: ["title", "deeper"] });
    });

    it("names the row against the place the listing was read at, not where shuttle now stands", async () => {
      // A handle is a bound reference, which is what keeps `%3` naming the row
      // it was minted for after the place has moved on.

      const shuttle = atPiece();
      await runLine("ls", shuttle, answering());
      await runLine("cd /", shuttle, answering());
      let read: (string | number)[] | undefined;
      await runLine(
        "get %1",
        shuttle,
        answering({
          getCellValue: (config, path) => {
            read = [config.piece, ...path];
            return Promise.resolve(null);
          },
        }),
      );
      expect(read).toEqual([HANDLE, "title"]);
    });

    it("reaches a row whose name has to be quoted to be typed", async () => {
      // The round trip a listing promises: what it prints is what `cd` takes.
      // A name holding a space prints quoted, and the quoting is the line's
      // rather than the row's — a walk of the printed characters would look
      // for a key whose name holds the quotes.

      const shuttle = atPiece();
      const spaced = answering({
        getCellValue: () => Promise.resolve({ "first name": {} }),
        listing: {
          getCellValue: () => Promise.resolve({ "first name": {} }),
          listCallableKeys: () => Promise.resolve(new Set<string>()),
        },
      });
      const listing = textOf(await runLine("ls", shuttle, spaced));
      expect(listing).toBe("%1 'first name'");
      await runLine("cd %1", shuttle, spaced);
      expect(shuttle.place.place.position)
        .toMatchObject({ path: ["first name"] });
    });

    it("refuses a handle where no listing has numbered a row", async () => {
      expect(reasonOf(await runLine("cd %1", atPiece(), answering())))
        .toBe(
          "`%1` names no row: no listing has numbered one yet. `ls` lists " +
            "what stands here and numbers what it lists.",
        );
    });

    it("refuses a callable row for a verb that walks, and says what invokes one", async () => {
      const shuttle = atPiece();
      await runLine("verbs", shuttle, answering());
      expect(reasonOf(await runLine("cd %1", shuttle, answering())))
        .toBe(
          "`%1` names a row no place stands at, it being one of the piece's " +
            "callables. `call` is what invokes one.",
        );
    });

    it("invokes a callable row without the name being written again", async () => {
      const shuttle = atPiece();
      await runLine("verbs", shuttle, answering());
      let called: string | undefined;
      await runLine(
        "call %1",
        shuttle,
        answering({
          callFromCommand: (_options, _spelling, name) => {
            called = name;
            return Promise.resolve();
          },
        }),
      );
      expect(called).toBe("a-verb");
    });

    it("takes the verb name after a row that is a place rather than a callable", async () => {
      const shuttle = atPiece();
      await runLine("ls", shuttle, answering());
      let handed: unknown;
      await runLine(
        "call %1 add-reply",
        shuttle,
        answering({
          callFromCommand: (options, _spelling, name) => {
            handed = { cell: options.cell, name };
            return Promise.resolve();
          },
        }),
      );
      expect(handed)
        .toEqual({ cell: `/${HANDLE}@space/title`, name: "add-reply" });
    });

    it("reads the sigil in a later segment as an ordinary character of a key", async () => {
      // It heads an operand and nothing else, so a key named with it is
      // reached by a walk that passes through something first.

      const shuttle = atPiece();
      await runLine(
        "cd title/%3",
        shuttle,
        answering({
          getCellValue: () => Promise.resolve({ title: { "%3": 1 } }),
        }),
      );
      expect(shuttle.place.place.position)
        .toMatchObject({ path: ["title", "%3"] });
    });
  });

  describe("more of what a cancel stops", () => {
    // The guard checks before the act and again with its answer, so a cancel
    // that arrived while an act was in flight stops the adoption that follows.
    // One case per adoption, because each is a different thing being written.

    it("writes nothing where the cancel arrived while the value was written", async () => {
      const stopper = new AbortController();
      const outcome = await runLine(
        'set title "a"',
        atPiece(),
        answering({
          setCellValue: () => {
            stopper.abort();
            return Promise.resolve({ piece: HANDLE, path: ["title"] });
          },
          signal: stopper.signal,
        }),
      );
      expect(outcome.kind).toBe("interrupted");
    });

    it("writes nothing where the cancel arrived while the editor was open", async () => {
      let wrote = false;
      const stopper = new AbortController();
      const outcome = await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => Promise.resolve({ a: 1 }),
          editText: () => {
            stopper.abort();
            return Promise.resolve({
              kind: "edited" as const,
              text: '{"a":2}',
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            });
          },
          setCellValue: () => {
            wrote = true;
            return Promise.resolve({ piece: HANDLE, path: [] });
          },
          signal: stopper.signal,
        }),
      );
      expect({ kind: outcome.kind, wrote })
        .toEqual({ kind: "interrupted", wrote: false });
    });

    it("writes nothing where the cancel arrived while `edit`'s write was in flight", async () => {
      const stopper = new AbortController();
      const outcome = await runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => Promise.resolve({ a: 1 }),
          editText: () =>
            Promise.resolve({
              kind: "edited" as const,
              text: '{"a":2}',
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            }),
          setCellValue: () => {
            stopper.abort();
            return Promise.resolve({ piece: HANDLE, path: [] });
          },
          signal: stopper.signal,
        }),
      );
      expect(outcome.kind).toBe("interrupted");
    });

    it("links nothing where the cancel arrived while the second piece warmed", async () => {
      // `link` warms both endpoints, so the second warm is a boundary the
      // first one's cases do not reach.

      let linked = false;
      const stopper = new AbortController();
      let warms = 0;
      const outcome = await runLine(
        "link title latest",
        atPiece(),
        answering({
          warmPiece: (config) => {
            warms += 1;
            if (warms === 2) stopper.abort();
            return Promise.resolve({ piece: `${config.piece}/${warms}` });
          },
          linkPieces: () => {
            linked = true;
            return Promise.resolve();
          },
          signal: stopper.signal,
        }),
      );
      expect({ kind: outcome.kind, linked, warms })
        .toEqual({ kind: "interrupted", linked: false, warms: 2 });
    });

    it("moves nowhere where the cancel arrived while the settle warmed", async () => {
      // The property is about the move, not about which check holds it: a
      // cancel that arrives while the settle is warming leaves the place
      // where it was. The line chosen is the one with the least between the
      // warm and the adoption — a move onto the piece already stood at has no
      // path left to walk — so what the case reads is close to the boundary.
      // Two checks stand behind it, the one the warm's answer meets and the
      // one in front of the confirm, and the case asks for the outcome rather
      // than for either of them.

      const order: string[] = [];
      const stopper = new AbortController();
      const shuttle = atPiece();
      const at = shuttle.place.place;
      const outcome = await runLine(
        `cd /${HANDLE}`,
        shuttle,
        answering({
          warmPiece: (config) => {
            order.push("warm");
            stopper.abort();
            return Promise.resolve({ piece: config.piece });
          },
          getCellValue: () => {
            order.push("walk");
            return Promise.resolve({ title: "a" });
          },
          signal: stopper.signal,
        }),
      );
      expect({ kind: outcome.kind, order, moved: shuttle.place.place !== at })
        .toEqual({ kind: "interrupted", order: ["warm"], moved: false });
    });
  });

  describe("what a seam raised rather than refused", () => {
    // Every verb here draws one line twice: a failure the seam reports as a
    // fact about the line is a refusal, and anything else is a fault and
    // raises. The pair is what makes the first half a decision — a verb that
    // caught everything would turn an unreachable server into a refusal about
    // the person's typing.

    /** The seams that turn a `ValidationError` into a refusal. */
    const REFUSING: readonly (readonly [string, string, keyof VerbDeps])[] = [
      ['set title "a"', "set", "setCellValue"],
      ["link title latest", "link", "linkPieces"],
      ["verbs", "verbs", "listPieceCallables"],
      ["describe", "describe", "describePiece"],
      ["call . a-verb", "call", "callFromCommand"],
    ];

    for (const [line, verb, seam] of REFUSING) {
      it(`refuses what \`${verb}\`'s seam turned down, in the seam's own words`, async () => {
        expect(
          reasonOf(
            await runLine(
              line,
              atPiece(),
              answering({
                [seam]: () => {
                  throw new ValidationError("The seam said no.");
                },
              }),
            ),
          ),
        ).toBe("The seam said no.");
      });

      it(`raises what \`${verb}\`'s seam threw that was no refusal`, async () => {
        // The other half. A server that cannot be reached is not a fact about
        // the line, and a verb that answered for it would report it as one.

        await expect(runLine(
          line,
          atPiece(),
          answering({
            [seam]: () => {
              throw new Error("The server cannot be reached.");
            },
          }),
        )).rejects.toThrow("The server cannot be reached.");
      });
    }

    it("refuses what `edit`'s write turned down, in the seam's own words", async () => {
      expect(
        reasonOf(
          await runLine(
            "edit title",
            atPiece(),
            answering({
              getCellValue: () => Promise.resolve({ a: 1 }),
              editText: () =>
                Promise.resolve({
                  kind: "edited" as const,
                  text: '{"a":2}',
                  file: "/tmp/edited",
                  discard: () => Promise.resolve(),
                }),
              setCellValue: () => {
                throw new ValidationError("The schema will not take that.");
              },
            }),
          ),
        ),
      ).toBe("The schema will not take that.");
    });

    it("raises what `edit`'s write threw that was no refusal", async () => {
      // `edit` reads before it writes, so its write is reached through the
      // editor rather than directly, and the arm is its own.

      await expect(runLine(
        "edit title",
        atPiece(),
        answering({
          getCellValue: () => Promise.resolve({ a: 1 }),
          editText: () =>
            Promise.resolve({
              kind: "edited" as const,
              text: '{"a":2}',
              file: "/tmp/edited",
              discard: () => Promise.resolve(),
            }),
          setCellValue: () => {
            throw new Error("The server cannot be reached.");
          },
        }),
      )).rejects.toThrow("The server cannot be reached.");
    });
  });

  describe("what a call publishes past its outcome", () => {
    it("writes the next steps the seam offered under what it returned", async () => {
      const outcome = await runLine(
        "call . search",
        atPiece(),
        answering({
          callFromCommand: (_o, _s, _n, _t, _r, _l, deps = {}) => {
            deps.render?.("the answer");
            deps.hint?.("try `--wait` next time");
            return Promise.resolve();
          },
        }),
      );
      expect(textOf(outcome)).toBe("the answer\ntry `--wait` next time");
    });

    it("refuses a call that reads standard input as JSON, the other reader", async () => {
      // Two readers reach the same stream and both are bound, which is what
      // makes the refusal a property of the stream rather than of one
      // spelling.

      let refused: string | undefined;
      await runLine(
        "call . search",
        atPiece(),
        answering({
          callFromCommand: async (_o, _s, _n, _t, _r, _l, deps = {}) => {
            try {
              await deps.executePieceCallable?.(
                {} as PieceConfig,
                "search",
                [],
                {},
              );
            } catch (thrown) {
              refused = (thrown as Error).message;
            }
          },
          executePieceCallable: async (_config, _name, _args, given) => {
            await given?.readJsonInput?.();
            throw new Error("The reader answered instead of refusing.");
          },
        }),
      );
      expect(refused).toContain("reads the input from standard input");
    });

    it("refuses a call whose handle names no row, before anything is read", async () => {
      let dispatched = false;
      const outcome = await runLine(
        "call %9 search",
        atPiece(),
        answering({
          callFromCommand: () => {
            dispatched = true;
            return Promise.resolve();
          },
        }),
      );
      expect({ dispatched, reason: reasonOf(outcome) }).toEqual({
        dispatched: false,
        reason: "`%9` names no row: no listing has numbered one yet. `ls` " +
          "lists what stands here and numbers what it lists.",
      });
    });
  });

  describe("reaching in warms", () => {
    // Decision 10: every read shuttle serves is live, so there is no unlabeled
    // stored-state path. The verbs that write were never the whole of reaching
    // in — navigating to a piece and reading one are reaching in too, and a
    // read served by a pattern that is not running is the thing the decision
    // rules out.

    /** Helper for these cases, which is the pieces a line started. */
    function warming(started: string[]): VerbDeps {
      return answering({
        warmPiece: (config) => {
          started.push(config.piece);
          return Promise.resolve({ piece: config.piece });
        },
      });
    }

    it("warms the piece a `cd` landed on", async () => {
      const started: string[] = [];
      await runLine("cd title", atPiece(), warming(started));
      expect(started).toEqual([HANDLE]);
    });

    it("warms nothing where the `cd` reached no piece to warm", async () => {
      // A move the place itself turns down never reaches a piece, so there is
      // nothing to start. An unknown scope is such a move: the readings refuse
      // it with no read behind them.

      const started: string[] = [];
      const outcome = await runLine("cd .@bogus", atPiece(), warming(started));
      expect({ kind: outcome.kind, started })
        .toEqual({ kind: "refused", started: [] });
    });

    it("warms the piece before judging its path, so a cold walk cannot refuse a live one", async () => {
      // Where the warm belongs and why. The walk that says whether the fabric
      // holds the path is a read, and a read against a piece that is not
      // running is a read of what was last committed — so the piece runs
      // first, and a path the running piece has is a path `cd` finds.

      const order: string[] = [];
      const outcome = await runLine(
        "cd nowhere",
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          getCellValue: () => {
            order.push("walk");
            return Promise.resolve({ title: "a" });
          },
        }),
      );
      expect({ kind: outcome.kind, order })
        .toEqual({ kind: "refused", order: ["warm", "walk"] });
    });

    it("warms the piece a `get` reads, before it reads it", async () => {
      // The order is the whole point: a read served before the pattern runs is
      // a read of what was last committed.

      const order: string[] = [];
      await runLine(
        "get title",
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          getCellValue: () => {
            order.push("read");
            return Promise.resolve("a");
          },
        }),
      );
      expect(order).toEqual(["warm", "read"]);
    });

    it("warms the piece an `ls` lists, before it lists it", async () => {
      const order: string[] = [];
      await runLine(
        "ls",
        atPiece(),
        answering({
          warmPiece: (config) => {
            order.push("warm");
            return Promise.resolve({ piece: config.piece });
          },
          listing: {
            getCellValue: () => {
              order.push("list");
              return Promise.resolve({ title: "a" });
            },
            listCallableKeys: () => Promise.resolve(new Set<string>()),
          },
        }),
      );
      expect(order).toEqual(["warm", "list"]);
    });

    it("warms nothing for a place that is no piece, there being no pattern behind one", async () => {
      // A space root and a facet are lists of what stands inside them. The
      // absence of a warm is the position's claim rather than a verb reaching
      // in less than another one does.

      const started: string[] = [];
      const shuttle = shuttleIn();
      await runLine("ls", shuttle, warming(started));
      moved(shuttle.place, "slugs");
      await runLine("ls", shuttle, warming(started));
      expect(started).toEqual([]);
    });
  });

  describe("a line the prompt cancelled", () => {
    // What an `AbortSignal` on the deps bag buys, which is a check at each
    // boundary between a verb's phases rather than anything that reaches a
    // read already sent. Two properties follow and both are pinned here: a
    // cancelled line sends no read it had not sent, and it adopts no place.
    //
    // `cd` is the verb with boundaries to check, and it has three reads to
    // sit between: the resolution, the handle lookup, and the walk of the
    // path. Every case below aborts from inside one of them, which is where a
    // `ctrl-c` really arrives — while something is in flight. A signal
    // aborted before the line starts is the one case that does not need a
    // read to arrange it.
    //
    // A place is not the only thing a line adopts. The session beside it —
    // what the last listing numbered, and what `more` writes next — is shared
    // between lines just as the place is, so writing it after an await is an
    // adoption and answers to the same check. The two cases at the end of
    // this block are that: they let a cancelled read answer late and ask what
    // it did to a session a newer line already owns.

    /** Helper for the cases below, which is a signal already aborted. */
    function cancelled(): AbortSignal {
      const stopper = new AbortController();
      stopper.abort();
      return stopper.signal;
    }

    /**
     * Every read this module can issue, by the name a case knows it by.
     *
     * It is the whole set rather than a selection, and what closes it is that
     * each is a seam a case stands in for: a read this module makes through
     * anything else is a read no case could have stood in for, which is a
     * different defect and one `READS_NOTHING` catches on every case in this
     * file. The one await that reaches the world and is not here is
     * `connection.pieces()`, which answers off the holder's memo — shuttle
     * opens its connection before the prompt reads its first line
     * (`run.ts`), so within a line it sends nothing.
     */
    const READS = [
      "getCellValue",
      "readWish",
      "resolvePieceReference",
      "listSpaceSlugs",
      "listPieces",
      "listing.getCellValue",
      "listing.listCallableKeys",
      "entityIdExists",
      "warmPiece",
      "setCellValue",
      "linkPieces",
      "listPieceCallables",
      "describePiece",
      "callFromCommand",
      "sinkCellValue",
    ] as const;

    /** One of {@link READS}. */
    type Read = typeof READS[number];

    /** Where a case puts the cancel. */
    type Cancel =
      /** Inside that read, as it is issued. */
      | Read
      /**
       * The moment the line first gives up control, whatever it was waiting
       * on. A verb runs synchronously to its first `await`, so the abort
       * lands in that window without a case having to name what opens it —
       * which is what lets these cases cover a boundary nobody enumerated.
       */
      | "suspend";

    /** What a cancelled line was seen to do. */
    interface Watched {
      /** Every read it issued, in order. */
      readonly reached: Read[];

      /** Every read it issued after the cancel, which must be none. */
      readonly afterCancel: Read[];
    }

    /**
     * Helper for the cases below, which runs `line` against the shuttle
     * `standing` builds, cancels it at `at`, and returns what it read.
     *
     * Every read is stood in for and every one is counted, so what comes back
     * is the whole of what the line asked the world for. A read is recorded
     * as after the cancel when the signal was already aborted as it was
     * issued — the read that carries the cancel is not one of those, the
     * abort being raised as it is entered rather than before.
     */
    async function cancelling(
      line: string,
      standing: (pieces: PiecesController) => Shuttle,
      at: Cancel,
    ): Promise<Watched> {
      const stopper = new AbortController();
      const reached: Read[] = [];
      const afterCancel: Read[] = [];
      const note = (name: Read) => {
        reached.push(name);
        if (stopper.signal.aborted) afterCancel.push(name);
        if (name === at) stopper.abort();
      };
      const shuttle = standing(
        {
          dispose: () => Promise.resolve(),
          getSpace: () => SPACE,
          getSpaceName: () => SPACE_NAME,
          entityIdExists: () => {
            note("entityIdExists");
            return Promise.resolve(true);
          },
        } as unknown as PiecesController,
      );
      const running = runLine(line, shuttle, {
        getCellValue: () => {
          note("getCellValue");
          return Promise.resolve({ title: "a" });
        },
        readWish: () => {
          note("readWish");
          return Promise.resolve({
            result: { [LINK_MARKER_KEY]: `/${HANDLE}` },
          });
        },
        resolvePieceReference: (_pieces, token, path) => {
          note("resolvePieceReference");
          return Promise.resolve({
            piece: token === "board" ? BOARD : token,
            pathAfter: [...path],
          });
        },
        listing: {
          listSpaceSlugs: () => {
            note("listSpaceSlugs");
            return Promise.resolve([]);
          },
          listPieces: () => {
            note("listPieces");
            return Promise.resolve([]);
          },
          // A key, so that the listing goes on to its second read, which a
          // cancel inside the first has to stop.
          getCellValue: () => {
            note("listing.getCellValue");
            return Promise.resolve({ title: "a" });
          },
          listCallableKeys: () => {
            note("listing.listCallableKeys");
            return Promise.resolve(new Set<string>());
          },
        },
        warmPiece: (config) => {
          note("warmPiece");
          return Promise.resolve({ piece: config.piece });
        },
        setCellValue: () => {
          note("setCellValue");
          return Promise.resolve({ piece: HANDLE, path: ["title"] });
        },
        linkPieces: () => {
          note("linkPieces");
          return Promise.resolve(undefined as never);
        },
        listPieceCallables: () => {
          note("listPieceCallables");
          return Promise.resolve({ verbs: [] } as never);
        },
        describePiece: () => {
          note("describePiece");
          return Promise.resolve({ verbs: [] } as never);
        },
        callFromCommand: () => {
          note("callFromCommand");
          return Promise.resolve();
        },
        sinkCellValue: () => {
          note("sinkCellValue");
          return Promise.resolve(() => {});
        },
        editText: (text) =>
          Promise.resolve({
            kind: "edited" as const,
            text: `${text} `,
            file: "/tmp/edit",
            discard: () => Promise.resolve(),
          }),
        signal: stopper.signal,
      });
      if (at === "suspend") stopper.abort();
      await running;
      return { reached, afterCancel };
    }

    /** Helper for the cases below, which stands at the space root. */
    const atRoot = (pieces: PiecesController) => shuttleIn(pieces);

    /** Helper for the cases below, which stands at the facet `facet`. */
    const atFacet = (facet: string) => (pieces: PiecesController) => {
      const shuttle = shuttleIn(pieces);
      moved(shuttle.place, facet);
      return shuttle;
    };

    /** Helper for the cases below, which stands on a piece. */
    const onPiece = (pieces: PiecesController) => {
      const shuttle = shuttleIn(pieces);
      moved(shuttle.place, `/${HANDLE}`);
      return shuttle;
    };

    /**
     * Every line and cancel these cases drive, which is what closes the claim
     * they make.
     *
     * The claim is a universal — *no* read is issued after a cancel — and the
     * risk in one is a case that samples the boundaries somebody thought of.
     * So the rows are not boundaries at all: each names a read to cancel from
     * inside, or asks for the cancel at the line's first suspension without
     * naming what that is. A boundary nobody enumerated still fails here,
     * provided a row reaches it, and the case below the table is what holds
     * the rows to reaching every read there is.
     */
    const CANCELLED: readonly (readonly [
      string,
      (pieces: PiecesController) => Shuttle,
      Cancel,
    ])[] = [
      ["cd board/title", atFacet("slugs"), "suspend"],
      ["cd board/title", atFacet("slugs"), "resolvePieceReference"],
      ["cd board/title", atFacet("slugs"), "getCellValue"],
      [`cd /${BOARD}/title`, atRoot, "resolvePieceReference"],
      [`cd /${BOARD}/title`, atRoot, "entityIdExists"],
      ["cd #favorites", atRoot, "suspend"],
      ["cd #favorites", atRoot, "readWish"],
      ["cd .@session", onPiece, "suspend"],
      ["get title", onPiece, "suspend"],
      ["get", onPiece, "suspend"],
      ["wish #favorites", atRoot, "suspend"],
      ["ls", atFacet("slugs"), "suspend"],
      ["get title", onPiece, "getCellValue"],
      ["wish #favorites", atRoot, "readWish"],
      ["ls", atFacet("slugs"), "listSpaceSlugs"],
      ["ls", atFacet("pieces"), "listPieces"],
      ["ls", onPiece, "listing.getCellValue"],
      ["ls", onPiece, "listing.listCallableKeys"],
      ['set title "a"', onPiece, "suspend"],
      ['set title "a"', onPiece, "warmPiece"],
      ['set title "a"', onPiece, "setCellValue"],
      ["edit title", onPiece, "suspend"],
      ["edit title", onPiece, "getCellValue"],
      ["link title other", onPiece, "suspend"],
      ["link title other", onPiece, "linkPieces"],
      ["call . a-verb", onPiece, "suspend"],
      ["call . a-verb", onPiece, "callFromCommand"],
      ["verbs", onPiece, "suspend"],
      ["verbs", onPiece, "listPieceCallables"],
      ["describe", onPiece, "suspend"],
      ["describe", onPiece, "describePiece"],
      ["watch title", onPiece, "suspend"],
      ["watch title", onPiece, "warmPiece"],
      ["watch title", onPiece, "sinkCellValue"],
    ];

    it("issues no read after the cancel, on any line and from any read", async () => {
      // The contract's universal half, driven rather than enumerated. Each
      // row is reported with the line and the cancel that produced it, so a
      // row that fails names the boundary that lost its guard rather than
      // leaving the whole table red with nothing said.

      for (const [line, standing, at] of CANCELLED) {
        const watched = await cancelling(line, standing, at);
        expect({ line, at, after: watched.afterCancel })
          .toEqual({ line, at, after: [] });
      }
    });

    /**
     * The verbs that read nothing, and so have no read for a cancel to stop.
     *
     * It is asserted rather than asserted about: the case below runs each
     * with every read standing in as a throw, so a verb listed here that
     * reaches one fails instead of being excused by this list.
     */
    const READS_NOTHING_AT_ALL = [
      "help",
      "more",
      "pwd",
      "unwatch",
      "watches",
      "where",
      "xcd",
      "xpwd",
    ];

    it("cancels a line of every verb, or says why the verb has no read", async () => {
      // What closes the set of verbs, which is the gap the rows above had:
      // `wish` and `ls` reach `guarded` with nothing awaited in front of it,
      // so a cancel at the first suspension is the only cancel that can catch
      // a guard that has drifted — and neither had a row.
      //
      // The list is the module's own answer rather than a list kept here: a
      // word that is no verb is refused with the verbs named, so a verb added
      // to the dispatch is a verb this case demands a row for.

      const refusal = await runLine("frob", shuttleIn(), READS_NOTHING);
      const named = [...reasonOf(refusal).matchAll(/`([a-z]+)`/g)]
        .map((found) => found[1])
        .filter((word) => word !== "frob");
      const suspended = CANCELLED
        .filter(([, , at]) => at === "suspend")
        .map(([line]) => line.split(" ")[0]);
      expect([...new Set(named)].sort())
        .toEqual([...new Set([...suspended, ...READS_NOTHING_AT_ALL])].sort());

      // And the excused ones are excused truthfully: every read throws, so a
      // verb that reached one would raise rather than answer. What each of
      // them answers with is its own — `more` with nothing waiting refuses,
      // where the other three write — so what is asserted is that the verb
      // answered at all, which is what reaching no read buys it.
      for (const verb of READS_NOTHING_AT_ALL) {
        const outcome = await runLine(verb, shuttleIn(), READS_NOTHING);
        expect({ verb, answered: outcome.kind !== "interrupted" })
          .toEqual({ verb, answered: true });
      }
    });

    it("adopts nothing where the cancel arrived while the act was in flight", async () => {
      // The window the guard's first check cannot see. A read already sent
      // finishes whatever the person did, so the answer arrives either way;
      // what must not happen is the line acting on it. Here the acting is
      // `paged` replacing what `more` writes next, and a continuation left by
      // an earlier line is what would be erased.

      const stopper = new AbortController();
      const shuttle = atPiece();
      shuttle.session.holding({ lines: ["what the line before left"] });
      const outcome = await runLine(
        "describe",
        shuttle,
        answering({
          describePiece: () => {
            stopper.abort();
            return Promise.resolve({ pattern: null, verbs: [] });
          },
          signal: stopper.signal,
        }),
      );
      expect({
        kind: outcome.kind,
        waiting: shuttle.session.continuation?.lines,
      }).toEqual({
        kind: "interrupted",
        waiting: ["what the line before left"],
      });
    });

    it("records no warm where the cancel arrived while the piece was starting", async () => {
      // The same window over the other kind of adoption: a memo entry claiming
      // a piece is running, written for a start the person stopped waiting
      // for, would keep every later line from starting it.

      const stopper = new AbortController();
      const shuttle = atPiece();
      const outcome = await runLine(
        'set title "a"',
        shuttle,
        answering({
          warmPiece: (config) => {
            stopper.abort();
            return Promise.resolve({ piece: config.piece });
          },
          signal: stopper.signal,
        }),
      );
      expect({
        kind: outcome.kind,
        remembered: shuttle.session.hasWarmed(HANDLE, "space"),
      }).toEqual({ kind: "interrupted", remembered: false });
    });

    it("drives every read there is, which is what closes the case above", async () => {
      // Without this the table would be a sample wearing a universal's
      // words: rows reaching six of the seven reads would pass while the
      // seventh went unguarded. A read added to the module is added to
      // `READS`, and this fails until a row reaches it.

      const reached = new Set<Read>();
      for (const [line, standing, at] of CANCELLED) {
        for (const read of (await cancelling(line, standing, at)).reached) {
          reached.add(read);
        }
      }
      expect([...reached].sort()).toEqual([...READS].sort());
    });

    it("sends no wish where the cancel arrived while the selection parsed", async () => {
      // `resolveTarget` parses the selection `--select @` spells before it
      // sends the wish, and the parse is an await. So a cancel lands in that
      // window, and what it must stop is the read the parse was preparing.

      const watched = await cancelling("cd #favorites", atRoot, "suspend");
      expect(watched.reached).toEqual([]);
    });

    it("resolves no piece where the cancel arrived while the connection was asked for", async () => {
      // The settle asks the holder for the connection before it resolves
      // anything, and that ask is an await of its own. The resolution behind
      // it is a read, so the window the ask opens is a boundary.

      const watched = await cancelling(
        "cd board/title",
        atFacet("slugs"),
        "suspend",
      );
      expect(watched.reached).toEqual([]);
    });

    it("reads no cell where the cancel arrived while the operand was placed", async () => {
      // Where a `get`'s operand points can itself be a read — a space
      // written as a name is asked of the connection — so placing the
      // operand and reading the cell are two phases, and this is the
      // boundary between them.

      const watched = await cancelling("get title", onPiece, "suspend");
      expect(watched.reached).toEqual([]);
    });

    it("runs no verb at all for a line already cancelled", async () => {
      // The check at the dispatch, which is the only one a verb that reads
      // nothing ever meets: `pwd` composes its answer out of what the process
      // is already holding, so no guarded read stands between the cancel and
      // an answer, and without this check a cancelled line would get one.

      expect(
        await runLine("pwd", shuttleIn(), {
          ...READS_NOTHING,
          signal: cancelled(),
        }),
      ).toEqual({ kind: "interrupted" });
    });

    it("sends no read for a line already cancelled", async () => {
      let read = 0;
      const outcome = await runLine("get", atPiece(), {
        ...READS_NOTHING,
        getCellValue: () => {
          read += 1;
          return Promise.resolve(null);
        },
        signal: cancelled(),
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(read).toBe(0);
    });

    /**
     * Helper for the two cases below, which is a read a case starts and
     * answers, and the event either side of it.
     *
     * The window these cases are about opens *after* a read is sent and
     * closes when it answers: the guard in front of the read has already let
     * it through, so what stops the answer taking effect is the guard on the
     * adoption. A case that cancelled before the read started would be caught
     * by the first guard and would say nothing about the second — which is
     * what the first spelling of these cases did, and what the mutation on
     * the adoption guard caught by surviving it.
     */
    function inFlight<T>(): {
      started: Promise<void>;
      answer(value: T): void;
      read(): Promise<T>;
    } {
      const started = Promise.withResolvers<void>();
      const answered = Promise.withResolvers<T>();
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
     * Helper for the case below, which is a signal that reports itself
     * un-aborted for the first `reads` questions and aborted after that.
     *
     * The window it stands for is the one a real `AbortController` cannot be
     * made to show on demand: a cancel arriving between the dispatch's check
     * and the guard's, which today are two questions with no suspension
     * between them. `guarded`'s whole argument is that the next author cannot
     * know which two statements those are — an await added in front of the
     * read opens the window for real — so the arm behind it is driven here
     * rather than left for that edit to discover.
     */
    function abortingAfter(reads: number): AbortSignal {
      let asked = 0;
      return {
        get aborted() {
          return asked++ >= reads;
        },
      } as unknown as AbortSignal;
    }

    it("numbers nothing where its guarded read came back cancelled", async () => {
      // The arm the guard exists to have: a read it would not send comes back
      // interrupted, and the verb stops there — no rows numbered, and the
      // interruption handed on rather than tested for.

      const shuttle = atPiece();
      const outcome = await runLine("ls", shuttle, {
        ...cellKeys(["a"]),
        signal: abortingAfter(1),
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(shuttle.session.handles).toBeUndefined();
    });

    it("numbers nothing where the listing it read was cancelled", async () => {
      // The race the guard exists for, run in the order it really happens: a
      // first `ls` is left in flight and cancelled, a second completes and
      // owns the session, and only then does the first read answer. Unguarded
      // the late answer wrote its rows over the newer ones, and `%1` named a
      // row nobody could see.

      const shuttle = atPiece();
      const stopper = new AbortController();
      const gate = inFlight<Record<string, string>>();
      const first = runLine("ls", shuttle, {
        ...READS_NOTHING,
        listing: {
          ...READS_NOTHING.listing,
          getCellValue: gate.read,
          listCallableKeys: () => Promise.resolve(new Set<string>()),
        },
        signal: stopper.signal,
      });
      await gate.started;
      stopper.abort();
      await runLine("ls", shuttle, screen(24, cellKeys(["new"])));
      expect(shuttle.session.handles?.rows.map((row) => row.name))
        .toEqual(["new"]);
      gate.answer({ old: "a value" });
      expect((await first).kind).toBe("interrupted");
      expect(shuttle.session.handles?.rows.map((row) => row.name))
        .toEqual(["new"]);
    });

    it("holds nothing back where the value it read was cancelled", async () => {
      // The same race through the other verb that writes the session. A
      // cancelled `get` answering late replaced what `more` continues, so the
      // next `more` wrote the tail of a value the person had abandoned.

      const shuttle = atPiece();
      const stopper = new AbortController();
      const gate = inFlight<unknown>();
      const first = runLine("get", shuttle, {
        ...READS_NOTHING,
        getCellValue: gate.read,
        signal: stopper.signal,
      });
      await gate.started;
      stopper.abort();
      await runLine("get", shuttle, screen(24, cellValue({ a: 1 })));
      expect(shuttle.session.continuation).toBeUndefined();
      gate.answer({ b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7, i: 8 });
      expect((await first).kind).toBe("interrupted");
      expect(shuttle.session.continuation).toBeUndefined();
    });

    it("still refuses a line that was wrong, cancelled or not", async () => {
      // The reading of the words happens before the check, and it is worth
      // making either way: a line that named no verb is not a verb that was
      // interrupted, and telling a person their line was cancelled when it
      // was misspelled would send them back to a line that never could run.

      expect(
        await runLine("frob", shuttleIn(), {
          ...READS_NOTHING,
          signal: cancelled(),
        }),
      ).toEqual({
        kind: "refused",
        reason: `\`frob\` is not a verb. ${THE_VERBS}`,
      });
    });

    it("walks no path where the cancel arrived during the resolution", async () => {
      // The first boundary a settle has: the resolution has answered and the
      // walk has not been asked for. The slug resolves to a piece other than
      // the one it was spelled as, which is what proves it held — so this
      // move has no lookup between the two, and the check after the
      // resolution is the one that stops the walk.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const stopper = new AbortController();
      let walked = 0;
      const outcome = await runLine("cd board/title", shuttle, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, _token, path) => {
          stopper.abort();
          return Promise.resolve({ piece: BOARD, pathAfter: [...path] });
        },
        getCellValue: () => {
          walked += 1;
          return Promise.resolve({ title: "a" });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(walked).toBe(0);
    });

    it("looks no handle up where the cancel arrived during the resolution", async () => {
      // The lookup's own guard, which the walk's guard would otherwise stand
      // in for: a cancel arriving during the resolution must stop the lookup,
      // not merely the walk behind it. The piece is spelled as a handle, so
      // the resolution proves nothing and the lookup is the read that would
      // have gone out next.

      const shuttle = shuttleIn(lookingUp(true));
      const stopper = new AbortController();
      let looked = 0;
      const outcome = await runLine(`cd /${BOARD}/title`, {
        ...shuttle,
        connection: new HeldConnection({
          kind: "borrowed",
          pieces: {
            dispose: () => Promise.resolve(),
            getSpace: () => SPACE,
            getSpaceName: () => SPACE_NAME,
            entityIdExists: () => {
              looked += 1;
              return Promise.resolve(true);
            },
          } as unknown as PiecesController,
        }),
      }, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, token, path) => {
          stopper.abort();
          return Promise.resolve({ piece: token, pathAfter: [...path] });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(looked).toBe(0);
    });

    it("walks no path where the cancel arrived during the handle lookup", async () => {
      // The second boundary, and the one only a move with a handle to look up
      // reaches: `entityIdExists` has answered and the walk has not been asked
      // for. A handle is a spelling that proves nothing, so this is the move
      // that pays for the lookup — and a lookup is a round trip a person is as
      // likely to be waiting on as any other.

      const shuttle = shuttleIn();
      const stopper = new AbortController();
      let walked = 0;
      const outcome = await runLine(`cd /${BOARD}/title`, {
        ...shuttle,
        connection: new HeldConnection({
          kind: "borrowed",
          pieces: {
            dispose: () => Promise.resolve(),
            getSpace: () => SPACE,
            getSpaceName: () => SPACE_NAME,
            entityIdExists: () => {
              stopper.abort();
              return Promise.resolve(true);
            },
          } as unknown as PiecesController,
        }),
      }, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, token, path) =>
          Promise.resolve({ piece: token, pathAfter: [...path] }),
        getCellValue: () => {
          walked += 1;
          return Promise.resolve({ title: "a" });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(walked).toBe(0);
    });

    it("moves nowhere where the cancel arrived during the last read", async () => {
      // The check before the place is adopted, which is the one that matters:
      // `cd` is the verb whose success means something, and a line the person
      // stopped waiting for must not go on to promise a place.
      //
      // The cancel arrives during the walk, which is the settle's last read
      // and the one no check inside the settle follows — it answers, the path
      // is found, and the settle says the fabric holds the place. So nothing
      // but the check at the adoption stands between this cancel and a move,
      // which is why the case aims here rather than at an earlier read: an
      // earlier one is stopped by a check of its own, and would pass with the
      // adoption unguarded.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const stopper = new AbortController();
      const outcome = await runLine("cd board/title", shuttle, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, _token, path) =>
          Promise.resolve({ piece: BOARD, pathAfter: [...path] }),
        getCellValue: () => {
          stopper.abort();
          return Promise.resolve({ title: "a" });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(shuttle.place.place.position).toEqual({
        kind: "facet",
        space: SPACE,
        facet: "slugs",
      });
    });

    it("changes no scope where the cancel arrived during a scope's own settle", async () => {
      // A scope on its own settles, because a scope selects which document a
      // piece's id names and the place at the new one is a place nothing has
      // read. So it reaches the fabric like any other move onto a piece, and
      // a person waiting on it can stop waiting — and what a cancel has to
      // leave alone here is the scope rather than the position, which is the
      // half of a place the other cases do not assert.

      const shuttle = shuttleIn();
      await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
      const stopper = new AbortController();
      const outcome = await runLine("cd .@session", shuttle, {
        ...settling({ topics: 1 }),
        getCellValue: () => {
          stopper.abort();
          return Promise.resolve({ topics: 1 });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(shuttle.place.place.scope).toBe("space");
    });

    it("enters no target where the cancel arrived while it was resolving", async () => {
      // The same check on the arm a `#name` target takes: the fabric answered
      // with an address, and the place is not moved into it.

      const shuttle = shuttleIn();
      const stopper = new AbortController();
      const outcome = await runLine("cd #favorites", shuttle, {
        ...READS_NOTHING,
        readWish: () => {
          stopper.abort();
          return Promise.resolve({
            result: { [LINK_MARKER_KEY]: `/${HANDLE}` },
          });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(shuttle.place.place.position).toEqual({
        kind: "root",
        space: SPACE,
      });
    });

    it("runs the line to the end where nothing cancelled it", async () => {
      // The other side of every case above: a signal that is merely present
      // stops nothing, so what the checks cost a line nobody interrupted is
      // nothing at all.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const outcome = await runLine("cd board", shuttle, {
        ...settling(null, { board: BOARD }),
        signal: new AbortController().signal,
      });
      expect(outcome.kind).toBe("moved");
      expect(shuttle.place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: BOARD,
        name: "board",
        path: [],
      });
    });
  });
});
