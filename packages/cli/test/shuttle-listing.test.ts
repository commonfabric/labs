/**
 * Unit tests for what `ls` finds at a place and how it writes each row back.
 *
 * Every read a listing makes is `packages/cli`'s, and every case that makes
 * one stands its own in through the deps bag, so what is under test is the
 * composing —
 * which read a position takes, what a row carries, and how a row prints — with
 * no socket, no server and no piece behind any of it. What those reads do once
 * called is not this file's subject; that a listing hands each of them the
 * connection this process holds is, and four cases pin it.
 *
 * The connection is a borrowed one throughout. A listing never opens or closes
 * one, so which arm a case stands it up through decides nothing here, and the
 * borrowed arm is the one that needs no opener behind it.
 *
 * The property the file exists for is the last group's: a name `ls` prints is
 * a name `cd` takes back to the row it was printed for. It is driven over a
 * construction rather than a hand-listed few, because the interesting names
 * are the ones nobody thinks to list — and its other half matters as much,
 * that a row it has no operand for prints no name at all.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";
import { linkPathSegmentToCellPathSegment } from "@commonfabric/runner/shared";

import type { SlugSummary, SpaceConfig } from "../lib/piece.ts";
import { HeldConnection } from "../lib/shuttle/connection.ts";
import { quoteToken, splitLine } from "../lib/shuttle/line.ts";
import { readsAsOption } from "../lib/shuttle/options.ts";
import {
  handleFor,
  type Listing,
  type ListingDeps,
  listingLines,
  type ListingRow,
  listPlace,
  type RowKind,
} from "../lib/shuttle/listing.ts";
import { CurrentPlace, type Facet, type Place } from "../lib/shuttle/place.ts";
import { moved } from "./shuttle-place-helpers.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";
const OTHER_HANDLE = "of:fid1:qrstuvwxyz012345";

/** The spelling a piece reports its own id as, which carries no scheme. */
const BARE_HANDLE = "fid1:abcdefghijklmnop";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/** Helper for the cases below, which fails whichever read a case reaches. */
const READS_NOTHING: ListingDeps = {
  listSpaceSlugs: () => {
    throw new Error("The slug index was read.");
  },
  listPieces: () => {
    throw new Error("The pieces were read.");
  },
  getCellValue: () => {
    throw new Error("The cell was read.");
  },
  listCallableKeys: () => {
    throw new Error("The cell's callables were read.");
  },
};

/** Helper for the cases below, which stands at the space's root. */
function atSpaceRoot(): CurrentPlace {
  return new CurrentPlace(SPACE);
}

/** Helper for the cases below, which stands inside `facet`. */
function inFacet(facet: Facet): CurrentPlace {
  const place = atSpaceRoot();
  moved(place, facet);
  return place;
}

/** Helper for the cases below, which stands at a piece, at `path` inside it. */
function atPiece(...path: string[]): CurrentPlace {
  const place = atSpaceRoot();
  moved(place, `/${HANDLE}`);
  for (const segment of path) moved(place, segment);
  return place;
}

/**
 * Helper for the cases below, which is a connection over a controller nothing
 * reads. A listing hands the controller to a read and never touches it, so
 * what a case can see is which read was handed it.
 */
function heldConnection(): {
  connection: HeldConnection;
  pieces: PiecesController;
} {
  const pieces = {
    dispose: () => Promise.resolve(),
  } as unknown as PiecesController;
  return {
    connection: new HeldConnection({ kind: "borrowed", pieces }),
    pieces,
  };
}

/** Helper for the cases below, which stands `rows` in for the slug index. */
function slugIndex(rows: SlugSummary[]): ListingDeps {
  return { ...READS_NOTHING, listSpaceSlugs: () => Promise.resolve(rows) };
}

/** Helper for the cases below, which stands `rows` in for the space's pieces. */
function spacePieces(
  rows: { id: string; name?: string; error?: string }[],
): ListingDeps {
  return { ...READS_NOTHING, listPieces: () => Promise.resolve(rows) };
}

/**
 * Helper for the cases below, which stands a cell holding `keys` in for the
 * one a listing reads, each key holding an ordinary value.
 *
 * A listing reads the level's value rather than a list of names, so a case
 * stands in a value: `keysOf` is what names the rows off it, which is the same
 * seam `listCellKeys` names its own off.
 */
function cellKeys(keys: string[]): ListingDeps {
  return cellHolding(Object.fromEntries(keys.map((key) => [key, "a value"])));
}

/**
 * Helper for the cases below, which stands `value` in for a cell's value and
 * `callables` in for the keys whose stored links declare a stream.
 */
function cellHolding(
  value: unknown,
  callables: readonly string[] = [],
): ListingDeps {
  return {
    ...READS_NOTHING,
    getCellValue: () => Promise.resolve(value),
    listCallableKeys: () => Promise.resolve(new Set(callables)),
  };
}

/** Helper for the cases below, which is `names` with no name written twice. */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/** Helper for the cases below, which lists `place` over `deps`. */
function list(place: CurrentPlace, deps: ListingDeps): Promise<Listing> {
  return listPlace(CONFIG, place.place, heldConnection().connection, deps);
}

describe("listing", () => {
  describe("listPlace()", () => {
    describe("a space root", () => {
      it("returns one row per facet the root lists", async () => {
        const listing = await list(atSpaceRoot(), READS_NOTHING);
        expect(listing.rows.map((row) => row.name)).toEqual([
          "slugs",
          "pieces",
        ]);
      });

      it("returns a facet row carrying the operand `cd` takes to it", async () => {
        const listing = await list(atSpaceRoot(), READS_NOTHING);
        expect(listing.rows.map((row) => row.operand)).toEqual([
          "slugs",
          "pieces",
        ]);
      });

      it("returns the facets without reading anything", async () => {
        let reads = 0;
        await list(atSpaceRoot(), {
          listSpaceSlugs: () => {
            reads++;
            return Promise.resolve([]);
          },
          listPieces: () => {
            reads++;
            return Promise.resolve([]);
          },
          getCellValue: () => {
            reads++;
            return Promise.resolve({});
          },
        });
        expect(reads).toBe(0);
      });

      it("returns no bound, a root listing its whole facet set", async () => {
        const listing = await list(atSpaceRoot(), READS_NOTHING);
        expect(listing.bound).toBeUndefined();
      });
    });

    describe("`slugs/`", () => {
      it("returns one row per slug the index named", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([
            { slug: "board", piece: HANDLE },
            { slug: "topics", piece: OTHER_HANDLE },
          ]),
        );
        expect(listing.rows.map((row) => row.name)).toEqual([
          "board",
          "topics",
        ]);
      });

      it("returns a slug row carrying the operand `cd` takes to its piece", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([{ slug: "board", piece: HANDLE }]),
        );
        expect(listing.rows[0].operand).toBe("board");
      });

      it("returns the row of a slug that resolved to nothing, carrying its error", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([{ slug: "board", error: "Slug redirects to no piece." }]),
        );
        expect(listing.rows).toEqual([{
          name: "board",
          kind: "slug",
          operand: "board",
          error: "Slug redirects to no piece.",
        }]);
      });

      it("returns the rows beside a slug that resolved to nothing", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([
            { slug: "board", error: "Slug redirects to no piece." },
            { slug: "topics", piece: HANDLE },
          ]),
        );
        expect(listing.rows.map((row) => row.name)).toEqual([
          "board",
          "topics",
        ]);
      });

      it("returns no operand for an index name that is no slug", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([{ slug: "Board", piece: HANDLE }]),
        );
        expect(listing.rows).toEqual([{ name: "Board", kind: "slug" }]);
      });

      it("returns a bound saying the index is what was listed", async () => {
        const listing = await list(inFacet("slugs"), slugIndex([]));
        expect(listing.bound).toBe(
          "the space's slug index names these, and a slug it never recorded " +
            "still resolves",
        );
      });
    });

    describe("`pieces/`", () => {
      it("returns one row per piece", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE }, { id: OTHER_HANDLE }]),
        );
        expect(listing.rows.map((row) => row.name)).toEqual([
          HANDLE,
          OTHER_HANDLE,
        ]);
      });

      it("returns a piece row carrying the operand `cd` takes to it", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE }]),
        );
        expect(listing.rows[0].operand).toBe(HANDLE);
      });

      it("returns a piece row carrying as its operand the bare hash it was listed under", async () => {
        // A piece reports its own id with no entity scheme, so that is the
        // spelling this facet is handed and the one a row hands back. The
        // case is the row a real listing mints, where the ones around it are
        // written in the `of:` spelling the rest of this file uses.

        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: BARE_HANDLE }]),
        );
        expect(listing.rows[0].operand).toBe(BARE_HANDLE);
      });

      it("returns a piece row carrying the name the read found for it", async () => {
        // The name is what the piece calls itself and the id is what reaches
        // it, so the row carries both: the operand is the id whether a name
        // was found or not, which is what keeps the row one `cd` takes back.

        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE, name: "Thermostat" }]),
        );
        expect(listing.rows).toEqual([{
          name: HANDLE,
          kind: "piece",
          operand: HANDLE,
          ownName: "Thermostat",
        }]);
      });

      it("returns a piece row carrying no name where the read found none", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE }]),
        );
        expect(listing.rows).toEqual([{
          name: HANDLE,
          kind: "piece",
          operand: HANDLE,
        }]);
      });

      it("returns the row of a piece that would not load, carrying its error", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE, error: "The piece would not load." }]),
        );
        expect(listing.rows).toEqual([{
          name: HANDLE,
          kind: "piece",
          operand: HANDLE,
          error: "The piece would not load.",
        }]);
      });

      it("returns no bound, a piece listing naming every piece registered", async () => {
        const listing = await list(inFacet("pieces"), spacePieces([]));
        expect(listing.bound).toBeUndefined();
      });
    });

    describe("inside a piece", () => {
      it("returns one row per key the cell has", async () => {
        const listing = await list(atPiece(), cellKeys(["title", "body"]));
        expect(listing.rows.map((row) => row.name)).toEqual(["title", "body"]);
      });

      it("returns a key row carrying the operand `cd` takes to it", async () => {
        const listing = await list(atPiece(), cellKeys(["title"]));
        expect(listing.rows[0].operand).toBe("title");
      });

      it("reads the piece the place stands on", async () => {
        // A slug stands unresolved in the place, so what a listing hands on is
        // the slug — which is what makes a name typed back off a listing reach
        // the piece it names, the read resolving it the way `--cell` does.
        const place = inFacet("slugs");
        moved(place, "board");
        let piece: string | undefined;
        await list(place, {
          ...READS_NOTHING,
          getCellValue: (config) => {
            piece = config.piece;
            return Promise.resolve({});
          },
        });
        expect(piece).toBe("board");
      });

      it("reads at the scope the place reads through", async () => {
        const place = atPiece();
        moved(place, ".@session");
        let scope: string | undefined;
        await list(place, {
          ...READS_NOTHING,
          getCellValue: (config) => {
            scope = config.pieceScope;
            return Promise.resolve({});
          },
        });
        expect(scope).toBe("session");
      });

      it("reads at the path inside the piece the place stands at", async () => {
        let path: (string | number)[] | undefined;
        await list(atPiece("topics", "3"), {
          ...READS_NOTHING,
          getCellValue: (_config, given) => {
            path = given;
            return Promise.resolve({});
          },
        });
        expect(path).toEqual(["topics", 3]);
      });

      it("returns no bound, a cell's keys being all of them", async () => {
        const listing = await list(atPiece(), cellKeys(["title"]));
        expect(listing.bound).toBeUndefined();
      });
    });

    describe("what a row turned out to be", () => {
      // A row's kind is recorded where the row is made, which is what lets a
      // handle minted off a listing say what it stands for. Each case drives
      // the read that produces the kind rather than constructing a row, so
      // what is pinned is the classification and not the type.

      it("returns a facet row as a container", async () => {
        const listing = await list(atSpaceRoot(), READS_NOTHING);
        expect(listing.rows.map((row) => row.kind)).toEqual([
          "container",
          "container",
        ]);
      });

      it("returns an index row as a slug", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([{ slug: "board", piece: HANDLE }]),
        );
        expect(listing.rows[0].kind).toBe("slug");
      });

      it("returns a piece row as a piece", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{
            id: HANDLE,
          }]),
        );
        expect(listing.rows[0].kind).toBe("piece");
      });

      it("returns a key by what the cell holds at it", async () => {
        // The boundary the classification draws, from both sides at once: a
        // stream is the piece's callable, an array and an object are walked
        // into, and everything else is where a path ends. `null` is the pair
        // that straddles the object test, being an object to `typeof` and not
        // a container to anything else. A stream holds nothing at its
        // position; what makes it a callable is what its links declare.

        const listing = await list(
          atPiece(),
          cellHolding({
            "add-reply": {},
            topics: [1, 2],
            author: { name: "a" },
            title: "a",
            replies: 14,
            done: false,
            nothing: null,
          }, ["add-reply"]),
        );
        expect(
          Object.fromEntries(listing.rows.map((row) => [row.name, row.kind])),
        ).toEqual({
          "add-reply": "callable",
          topics: "container",
          author: "container",
          title: "value",
          replies: "value",
          done: "value",
          nothing: "value",
        });
      });

      it("returns a key holding a `$stream` that is not the marker as a container", async () => {
        // The sentinel is the whole marker and not the key: a stored object
        // that happens to carry the name is data, and calling it a callable
        // would mint a handle `call` cannot use. `isStreamValue` is what
        // draws that line, and this is the value on the far side of it.

        const listing = await list(
          atPiece(),
          cellHolding({ notes: { $stream: "later" } }),
        );
        expect(listing.rows[0].kind).toBe("container");
      });

      it("returns a key still holding the retired stream sentinel as a callable", async () => {
        // A document written before streams were declared by schema holds
        // `{ $stream: true }` where a stream stands, and its links say
        // nothing. That is a callable all the same, until no such document
        // remains.

        const listing = await list(
          atPiece(),
          cellHolding({ "add-reply": { $stream: true } }),
        );
        expect(listing.rows[0].kind).toBe("callable");
      });

      it("asks which keys are callables of exactly the keys it lists", async () => {
        const asked: string[][] = [];
        const listing = await list(atPiece(), {
          ...cellHolding({ a: 1, b: [1] }),
          listCallableKeys: (_config, _path, keys) => {
            asked.push([...keys]);
            return Promise.resolve(new Set<string>());
          },
        });
        expect(asked).toEqual([["a", "b"]]);
        expect(listing.rows.map((row) => row.kind)).toEqual([
          "value",
          "container",
        ]);
      });

      it("returns an array's indices as rows of what each element is", async () => {
        const listing = await list(atPiece(), cellHolding([{ a: 1 }, "b"]));
        expect(listing.rows.map((row) => [row.name, row.kind]))
          .toEqual([["0", "container"], ["1", "value"]]);
      });
    });

    describe("the held connection", () => {
      // Each read takes its connection through `deps.loadPieces`, and what
      // each case reads back is what that returns: the one controller this
      // process holds, rather than one the read would have opened.

      it("hands the slug index the connection this process holds", async () => {
        const held = heldConnection();
        let loaded: PiecesController | undefined;
        await listPlace(CONFIG, inFacet("slugs").place, held.connection, {
          ...READS_NOTHING,
          listSpaceSlugs: async (config, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return [];
          },
        });
        expect(loaded).toBe(held.pieces);
      });

      it("hands the piece listing the connection this process holds", async () => {
        const held = heldConnection();
        let loaded: PiecesController | undefined;
        await listPlace(CONFIG, inFacet("pieces").place, held.connection, {
          ...READS_NOTHING,
          listPieces: async (config, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return [];
          },
        });
        expect(loaded).toBe(held.pieces);
      });

      it("hands the cell listing the connection this process holds", async () => {
        const held = heldConnection();
        let loaded: PiecesController | undefined;
        await listPlace(CONFIG, atPiece().place, held.connection, {
          ...READS_NOTHING,
          getCellValue: async (config, _path, _options, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return {};
          },
        });
        expect(loaded).toBe(held.pieces);
      });

      it("hands the callable listing the connection this process holds", async () => {
        const held = heldConnection();
        let loaded: PiecesController | undefined;
        await listPlace(CONFIG, atPiece().place, held.connection, {
          ...READS_NOTHING,
          getCellValue: () => Promise.resolve({ title: 1 }),
          listCallableKeys: async (config, _path, _keys, _options, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return new Set();
          },
        });
        expect(loaded).toBe(held.pieces);
      });
    });

    describe("a read that failed outright", () => {
      it("raises what the read raised", async () => {
        await expect(list(atPiece(), READS_NOTHING)).rejects.toThrow(
          "The cell was read.",
        );
      });
    });
  });

  describe("listingLines()", () => {
    // A row's line opens with the handle a person types to name it again and
    // the name comes next, so every expectation here reads the two together.
    // What the handle is written as is `handleFor`'s, read from the module
    // rather than restated, so a case pins the layout and not the spelling.

    /**
     * Helper for the cases below, which is the row lines `listing` prints as.
     * The bound comes back beside them and the cases that care ask for it.
     */
    function lines(listing: Listing): readonly string[] {
      return listingLines(listing).rows;
    }

    /** Helper for the cases below, which is a row of `kind` called `name`. */
    function row(
      name: string,
      kind: RowKind = "value",
      rest: Partial<ListingRow> = {},
    ): ListingRow {
      return { name, kind, operand: name, ...rest };
    }

    it("returns one line per row", () => {
      expect(lines({ rows: [row("title"), row("body")] }))
        .toEqual(["%1 title", "%2 body"]);
    });

    it("returns the rows numbered from one, in the order listed", () => {
      // The numbers are written out rather than read back from `handleFor`,
      // which is what keeps the case able to fail: a numbering that started
      // at zero, or ran backwards, would move both sides of an assertion
      // that asked the module what it numbers by.

      const listing = { rows: ["a", "b", "c"].map((name) => row(name)) };
      expect(lines(listing).map((line) => line.split(" ")[0]))
        .toEqual(["%1", "%2", "%3"]);
    });

    it("numbers a row by the handle `handleFor` spells", () => {
      // The other half, and the one that may read the module: what a listing
      // numbers with is the spelling B2 reads `%n` back through, so the two
      // are held to one another rather than each to a literal of its own.

      const listing = { rows: [row("a")] };
      expect(lines(listing)[0]).toBe(`${handleFor(1)} a`);
    });

    it("returns every handle in a column the widest of them sets", () => {
      // Ten rows is where the widest handle grows a character, so the names
      // of the first nine start one column further right than they would in
      // a listing of nine. A column measured off the count rather than off
      // each handle is what puts them all in one place.

      const listing = { rows: Array.from({ length: 10 }, () => row("a")) };
      expect(lines(listing)[0]).toBe(" %1 a");
      expect(lines(listing)[9]).toBe("%10 a");
    });

    it("returns the operand as the name, not the name itself", () => {
      expect(lines({
        rows: [{
          name: "..",
          kind: "value",
          operand: "./..",
        }],
      })).toEqual(["%1 ./.."]);
    });

    it("returns a marker in place of a name for a row with no operand", () => {
      expect(lines({ rows: [{ name: "#b", kind: "value" }] }))
        .toEqual(["%1 <no operand: '#b'>"]);
    });

    it("returns a marker that writes no name where the name holds a line break", () => {
      expect(lines({ rows: [{ name: "a\nb", kind: "value" }] }))
        .toEqual(["%1 <no operand: a name holding a line break>"]);
    });

    it("returns a callable row annotated as callable, after its name", () => {
      expect(lines({ rows: [row("add-reply", "callable")] }))
        .toEqual(["%1 add-reply <callable>"]);
    });

    it("returns a row's own name as a marker, after the operand", () => {
      // The operand keeps the column a reader copies out of, and the name
      // stands beside it as shuttle's own words about the row. A name written
      // in the operand's place would be a spelling `cd` does not take, printed
      // where every other row prints one it does.

      expect(lines({
        rows: [row(HANDLE, "piece", { ownName: "Thermostat" })],
      })).toEqual([`%1 ${HANDLE} <Thermostat>`]);
    });

    it("returns a name holding an acted-on character shown as its glyph", () => {
      // A name is a value a read served rather than one this module made, so
      // it answers to the one-line rule an error answers to: the break stays
      // one row, and the escape prints as the glyph naming it.

      const line = lines({
        rows: [row(HANDLE, "piece", { ownName: "two\nlines\u001b[31m" })],
      })[0];
      expect(line).toBe(`%1 ${HANDLE} <two lines␛[31m>`);
      expect(/\p{Cc}/u.test(line)).toBe(false);
    });

    it("returns no annotation on a row of any other kind", () => {
      // A projection over every kind rather than a spot check: the module
      // annotates from a table closed against `RowKind`, and this is the
      // reading of that table from outside. A kind added without a decision
      // reds the module; a kind that started being annotated reds this.

      const annotated: Record<RowKind, boolean> = {
        container: false,
        value: false,
        callable: true,
        piece: false,
        slug: false,
        watch: false,
      };
      for (const [kind, marked] of Object.entries(annotated)) {
        expect(lines({ rows: [row("a", kind as RowKind)] })[0])
          .toBe(marked ? "%1 a <callable>" : "%1 a");
      }
    });

    it("returns a row's error with each acted-on character shown as its glyph", () => {
      // A message is read rather than typed back, so it arrives whole and
      // merely inert: nothing is dropped and nothing is described away. This
      // is the live one — an error is the fabric's text, not shuttle's.

      const line = lines({
        rows: [row("board", "slug", {
          error: "gone\u001b[31m: \u007f and \u009b too",
        })],
      })[0];
      expect(line).toBe("%1 board <error: gone␛[31m: ␡ and ␦ too>");
      expect(/\p{Cc}/u.test(line)).toBe(false);
    });

    it("returns a bound with one shown the same way", () => {
      // No bound the module builds can hold one — `SLUG_INDEX_BOUND` is a
      // constant — so this case is constructed rather than found. What it
      // guards is `listingLines`'s contract, which takes any listing a caller
      // hands it, rather than the one call the module makes.

      expect(listingLines({ rows: [], bound: "412 items\u001b[31m" }).bound)
        .toBe("<412 items␛[31m>");
    });

    it("returns an error's angle brackets as they stand", () => {
      // Escaping the acted-on class is not the marker's own decision, which
      // is that brackets delimit for a reader and not for a parser. A payload
      // may hold one, and this stays true beside the escaping.

      expect(lines({ rows: [row("board", "slug", { error: "<gone>" })] }))
        .toEqual(["%1 board <error: <gone>>"]);
    });

    it("returns a message holding a line break with it written as a space", () => {
      // The other rewrite, and a different decision: a break becomes a space
      // so a message stays one row, where the rest become glyphs so a message
      // cannot instruct the terminal.

      expect(lines({ rows: [row("board", "slug", { error: "two\nlines" })] }))
        .toEqual(["%1 board <error: two lines>"]);
    });

    it("returns a marker that writes no name where the name holds a control character", () => {
      // The doors refuse such a name, so no operand reaches the row — and the
      // marker is then the one place left where it would still be written.
      // Writing it there would put back on the screen exactly what refusing
      // the name kept off it.

      const line =
        lines({ rows: [{ name: "ti\u001b[31mtle", kind: "value" }] })[0];
      expect(line).toBe("%1 <no operand: a name holding a control character>");
      expect(line.includes("\u001b")).toBe(false);
    });

    it("returns a row's error after its name", () => {
      expect(lines({
        rows: [row("board", "slug", { error: "No piece there." })],
      })).toEqual(["%1 board <error: No piece there.>"]);
    });

    it("returns a bound's line breaks written as spaces", () => {
      // Nothing reaches this through `listPlace`, whose only bound is a module
      // constant holding no break. `Listing` is a public type and this a
      // public door, so the case drives the door rather than the path, and
      // what it holds is that a bound answers to the same one-line rule an
      // error does.

      expect(listingLines({ rows: [], bound: "Two lines.\nboard" }).bound)
        .toBe("<Two lines. board>");
    });

    it("returns the bound beside the rows rather than among them", () => {
      // Beside rather than among, because a page treats the two differently:
      // it cuts rows and always shows the bound, and `--limit` counts rows
      // and never counts the bound. A bound folded in with the rows was one
      // a limit of one spent its whole allowance on.

      expect(listingLines({
        rows: [row("board", "slug")],
        bound: "these are the ones the index names",
      })).toEqual({
        bound: "<these are the ones the index names>",
        rows: ["%1 board"],
      });
    });

    it("returns no bound where the listing carries none", () => {
      expect(listingLines({ rows: [row("board", "slug")] }))
        .toEqual({ rows: ["%1 board"] });
    });
  });

  describe("naming a row back", () => {
    // The property, over a construction rather than a list: what a listing
    // prints as a name, `cd` takes back to the row it was printed for; and a
    // row it has no operand for prints no name at all, so nothing on the
    // surface invites a reader to type a string that reaches somewhere else.
    //
    // A named row's name column never opens with `<`, which is what keeps a
    // name and a marker apart on one surface. `quoteToken` is the whole of that
    // mechanism and it lives a module away: `<` is one of the characters the
    // grammar reserves, so a name holding one is printed quoted and can never
    // open with it. Nothing in this module would notice if that stopped being
    // true, which is why the assertion is here and the mutation that reds it
    // is in `line.ts`.
    //
    // The property is over the name column of a printed line and not over the
    // whole of it. A line opens with the row's handle, and a row that carries
    // an error prints a marker after the name, so the name is the whole of the
    // line for no row at all; and an error is text the fabric wrote, which may
    // hold an odd quote and leave the line as a whole refusing to split. What
    // holds of every named row is that the name column holds one token `cd`
    // takes back to the row, and that anything after it is separated from it —
    // which is what "copied out of the name column" means and all it can
    // mean.
    //
    // A name is read twice on the way back, and both readings are asked. The
    // option grammar reads it first — a token opening with `-` reaches a verb
    // as a flag and never as an operand — and the place reads what is left. A
    // name the first reading takes therefore fails the property however well
    // it moves, which is why the operand is held against `readsAsOption`
    // beside being moved with.
    //
    // What varies is as load-bearing as the property. Both kinds of row a
    // listing can name vary — the piece a facet lists and the key a piece
    // holds — and each candidate is driven through the read that produces that
    // kind, so a rule that held for one kind and not the other cannot pass.
    // The marks are the characters a reading is spelled with, at each of the
    // three places within a name where one can sit, and alone.

    const MARKS = [
      " ",
      "\t",
      "\n",
      "\r",
      "\u00a0",
      "\u2028",
      "\u2029",
      "/",
      "~",
      "#",
      "@",
      "-",
      ".",
      "<",
      ">",
      "%",
      "!",
      "|",
      "'",
      '"',
      "\\",
    ];

    /**
     * Helper for the cases below, which is every awkward spelling of a name
     * whose ordinary spelling is `head` followed by `tail`.
     */
    function candidates(head: string, tail: string): string[] {
      // The digit spellings sit here rather than among the marks: what they
      // exercise is the conversion a path segment goes through, where a
      // canonical index becomes a number and everything else stays a string.
      // `-x y` is the one that separates the two readings of a token: it
      // needs quoting, and its quoted form opens with a quote where the token
      // itself opens with a dash. A row offered by name would be eaten by the
      // option grammar, so the reference is what must be offered — and only an
      // assertion about the *decoded* token can tell the two apart.
      const values = [
        "",
        "3",
        "0",
        "01",
        "1e21",
        "-1",
        "1.5",
        "..",
        "-",
        "-x y",
      ];
      for (const mark of MARKS) {
        values.push(
          mark + head + tail,
          head + tail + mark,
          head + mark + tail,
          mark,
        );
      }
      return values;
    }

    /**
     * Helper for the case below, which is what a listing reports against the
     * candidate at `index`, and nothing where it reports nothing.
     *
     * A row carrying one is the only shape where the printed line and the
     * operand are different strings, so a construction with none of them says
     * nothing about the rows the naming rule has most to say about. Two of
     * these are chosen for what they do to a line rather than for what they
     * say: one holds an odd quote, so the line as a whole does not split and
     * only its front can be copied, and one holds a line break, which would
     * open a second line with a name on it if the renderer wrote it as it
     * stands.
     *
     * The break is written as an escape, and deliberately.
     * `check-control-characters` governs a literal control codepoint below
     * `0x20` other than the newline, so a literal break passes it; and the
     * characters `MARKS` above spells — a no-break space and the Unicode line
     * and paragraph separators — sit outside that range altogether. An awkward
     * character in a fixture is written as an escape on its own account rather
     * than on a gate's.
     */
    const REPORTED = [
      undefined,
      "No piece carries that name.",
      "It's gone.",
      "Two lines.\nboard",
    ];

    /**
     * Helper for the case below, which is the place one level inside `place`
     * called `name` — the row's own cell, built from the levels a position
     * names rather than from any operand.
     */
    function childOf(place: Place, name: string): Place {
      const position = place.position;
      switch (position.kind) {
        case "root":
          return {
            ...place,
            position: { kind: "facet", space: SPACE, facet: name as Facet },
          };
        case "facet":
          return {
            ...place,
            position: { kind: "piece", space: SPACE, piece: name, path: [] },
          };
        case "piece":
          return {
            ...place,
            position: {
              ...position,
              path: [
                ...position.path,
                linkPathSegmentToCellPathSegment(name),
              ],
            },
          };
      }
    }

    it("prints a name `cd` takes back to the row, and no name for a row it has no operand for", async () => {
      let named = 0;
      let unnamed = 0;
      let reported = 0;
      let reportedWithOperand = 0;
      let reportedWithoutOperand = 0;

      /**
       * Helper for this case, which holds the property over one row and the
       * line it printed, `standing` being a place at the row's own level.
       */
      function check(
        standing: CurrentPlace,
        row: ListingRow,
        line: string,
        handle: string,
      ) {
        // Everything true of every line goes above the branch. A row's error
        // is printed whether or not the row has an operand, and this branch
        // has twice been where a dimension reached one arm and not the other:
        // the arm that returns early reads whatever someone remembered to add
        // to it. Asserting the common half first is what stops the next
        // dimension from landing on one side.
        expect(/ <error: [^\n]*>$/.test(line)).toBe(row.error !== undefined);
        if (row.error !== undefined) reported++;

        // The handle column comes off first, and the property is over what is
        // left. Reading it off the line rather than assuming its width is what
        // makes the case say the same thing at every listing length.
        expect(line.startsWith(`${handle} `)).toBe(true);
        const printed = line.slice(handle.length + 1);

        if (row.operand === undefined) {
          expect(printed.startsWith("<")).toBe(true);
          unnamed++;
          if (row.error !== undefined) reportedWithoutOperand++;
          return;
        }
        expect(printed.startsWith("<")).toBe(false);
        // The row carries the operand `cd` reads and the line carries the
        // token that spells it, so the property runs through the pair rather
        // than around it: what is printed splits back to what the row holds,
        // and what the row holds reaches the row. A name needing quotes is
        // where the two differ, and where a walk of the printed characters
        // would look for a key whose name holds the quotes.
        // The line opens with the row's own token, and the markers follow it.
        // Only that token is meant to be typed back — the rest is prose for a
        // reader — so the properties below are asked of it alone.
        const token = quoteToken(row.operand);
        expect(printed.startsWith(token)).toBe(true);
        const rest = printed.slice(token.length);
        expect(rest === "").toBe(row.error === undefined);
        if (rest !== "") expect(rest.startsWith(" <")).toBe(true);

        // And they are asked of what the token *becomes*, not of how it looks.
        // A line is split before its options are read (`runLine`), so what the
        // option grammar receives is the decoded token: asking `readsAsOption`
        // about the quoted spelling would pass a name like `-x`, whose quoted
        // form opens with a quote, while the token the parser gets opens with
        // the dash and is eaten.
        const from = standing.place;
        const split = splitLine(token);
        expect(split.kind).toBe("split");
        const tokens = split.kind === "split" ? split.tokens : [];
        expect(tokens.length).toBe(1);
        expect(tokens[0]).toBe(row.operand);
        expect(readsAsOption(tokens[0])).toBe(false);
        expect(moved(standing, tokens[0]).kind).toBe("moved");
        expect(standing.place).toEqual(childOf(from, row.name));
        named++;
        if (row.error !== undefined) reportedWithOperand++;
      }

      const sources: {
        standing: () => CurrentPlace;
        deps: (names: string[]) => ListingDeps;
        names: string[];
      }[] = [
        {
          standing: () => inFacet("slugs"),
          deps: (names) =>
            slugIndex(names.map((slug, index) => ({
              slug,
              error: REPORTED[index % REPORTED.length],
            }))),
          names: candidates("boa", "rd"),
        },
        {
          standing: () => inFacet("pieces"),
          deps: (names) =>
            spacePieces(names.map((id, index) => ({
              id,
              error: REPORTED[index % REPORTED.length],
            }))),
          names: candidates(HANDLE.slice(0, 10), HANDLE.slice(10)),
        },
        {
          // A cell holds each name once, so the candidates are deduplicated
          // for the two sources that stand names in as a cell's keys. The
          // property is over each name rather than over the list, so a name
          // written twice adds nothing to it either way.
          standing: () => atPiece(),
          deps: (names) => cellKeys(names),
          names: unique(candidates("b", "c")),
        },
        {
          standing: () => atPiece("topics"),
          deps: (names) => cellKeys(names),
          names: unique(candidates("b", "c")),
        },
      ];

      for (const source of sources) {
        const listing = await list(
          source.standing(),
          source.deps(source.names),
        );
        const lines = listingLines(listing).rows;
        expect(new Set(listing.rows.map((row) => row.name)))
          .toEqual(new Set(source.names));
        expect(listing.rows.length).toBe(source.names.length);
        expect(lines.length).toBe(listing.rows.length);
        const column = handleFor(listing.rows.length).length;
        for (const [index, row] of listing.rows.entries()) {
          check(
            source.standing(),
            row,
            lines[index],
            handleFor(index + 1).padStart(column),
          );
        }
      }

      // Every outcome has to occur, or the property holds for want of anything
      // to hold over. The error clause above the branch is the strong one: it
      // holds of every line, named or not, so a row that prints an error it
      // does not carry, or drops one it does, reds it in either arm. What the
      // counts add is that both arms are reached and that an error reaches
      // each — `named` and `unnamed` for the arms, `reported` for an error
      // anywhere, and one guard per arm for an error inside it, since the
      // arms are where a row and its error are printed together.
      //
      // Two arms means two guards, and neither stands for the other: an
      // error counted in the marker arm leaves the strong clause free to hold
      // over a set with no named row carrying an error in it, and a clause
      // with nothing to hold over is the want these counts exist to refuse.
      expect(named).toBeGreaterThan(0);
      expect(unnamed).toBeGreaterThan(0);
      expect(reported).toBeGreaterThan(0);
      expect(reportedWithOperand).toBeGreaterThan(0);
      expect(reportedWithoutOperand).toBeGreaterThan(0);
    });
  });
});
