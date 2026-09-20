/**
 * What `ls` finds where shuttle stands, what each row turns out to be, and how
 * each is written back.
 *
 * A listing prints names a person then types, so a row carries the operand
 * `cd` takes to reach it and not only the name it goes by. The two are the
 * same string for nearly every row and differ wherever a name's own characters
 * are readings — a key called `..`, one holding the separator — which is a
 * question about the place rather than about the listing, so
 * `operandForChild` answers it and this module asks.
 *
 * A row also carries what it is. The kind is recorded as the row is made
 * rather than worked out again by whoever reads it, which is what lets a
 * handle minted off a listing say what it stands for without a second read
 * (decision 27, `docs/plans/shuttle/README.md`) and what lets a callable be
 * annotated where it is listed rather than found by asking a piece for its
 * verbs.
 *
 * The reads are `packages/cli`'s, over the connection this process holds: a
 * space root has nothing to read, the two facets are `listSpaceSlugs` and
 * `listPieces`, and the cell inside a piece is `getCellValue` for what its
 * keys hold and `listCallableKeys` for which of them are verbs. Each takes
 * the connection through `deps.loadPieces`, which is the seam a held
 * connection fills.
 *
 * The cell is read for its value where a listing of keys alone would do, and
 * that costs nothing: `listCellKeys` (`lib/cell-listing.ts`) is `keysOf` over
 * exactly this read, so what a kind costs is the classification and not a
 * round trip. `keysOf` is still what names the rows, so a listing lists what
 * that seam lists.
 */

import { idStringForEntityAddress, isStreamValue } from "@commonfabric/runner";
import { renderCellReference } from "@commonfabric/runner/shared";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { keysOf } from "../cell-listing.ts";
import {
  getCellValue,
  listCallableKeys,
  listPieces,
  listSpaceSlugs,
  type PieceConfig,
  type SpaceConfig,
} from "../piece.ts";
import type { HeldConnection } from "./connection.ts";
import { quoteToken } from "./line.ts";
import { marker } from "./page.ts";
import {
  escapeControlCharacters,
  type Facet,
  FACETS,
  HANDLE_SIGIL,
  holdsControlCharacter,
  operandForChild,
  type PiecePosition,
  type Place,
} from "./place.ts";

/**
 * What a listing of `slugs/` is a listing of. `listSlugs`
 * (`@commonfabric/piece`) is where that bound is stated and where the reason
 * for it lives; what this carries is the part a reader of the listing needs,
 * which is that the rows are not every name the space answers to.
 */
const SLUG_INDEX_BOUND = "the space's slug index names these, and a slug it " +
  "never recorded still resolves";

/**
 * What a row turned out to be, recorded where the row is made.
 *
 * Six kinds and no seventh, closed by the projection {@link ANNOTATED} makes
 * of them: what stands at a space root is a facet, which is a `container`;
 * what stands in the two facets is a `slug` or a `piece`; what stands inside a
 * piece is a `container` where a walk continues through it, a `callable` where
 * the position is a verb's dispatch surface, and a `value` otherwise; and a
 * `watch` is what `watches` numbers, which is a session object rather than
 * anything standing at a place.
 *
 * A link is not among them, and its absence is a fact about the read rather
 * than a gap in the vocabulary: a cell read resolves a link on the way past,
 * so what a listing is handed at a position holding one is what it points at.
 * Marking such a row is the open question `docs/plans/shuttle/pathref.md`
 * leaves for `ls`, and answering it means a read that stops before a crossing
 * rather than another arm here.
 */
export type RowKind =
  | "container"
  | "value"
  | "callable"
  | "piece"
  | "slug"
  | "watch";

/** One thing a listing found standing where it was read. */
export interface ListingRow {
  /** What the row is called where it stands. */
  readonly name: string;

  /** What the row turned out to be. */
  readonly kind: RowKind;

  /**
   * The operand `cd` takes to reach it, as `cd` reads it, and absent where
   * `operandForChild` offers none. Absent is the narrower claim it makes:
   * that no spelling `operandForChild` tries names the row, not that nothing
   * reaches it.
   *
   * It is the decoded operand rather than the quoted token a line writes it
   * as. A row is read back by two consumers that want different forms — a
   * line prints it, and a `%n` walks it — and quoting is the printer's step
   * ({@link listingLines}). Storing the printed form instead would leave the
   * walker undoing it, which is one grammar written twice and the pair free
   * to disagree: a key called `first name` prints as `'first name'`, and a
   * walk of those characters looks for a key whose name holds the quotes.
   */
  readonly operand?: string;

  /**
   * What the row calls itself, where the read found it a name of its own, and
   * absent where it found none.
   *
   * It is what the fabric holds rather than anything to type: a piece carries
   * a name and no address is made of it, so it is written beside the operand
   * rather than in place of one. What reaches the row is the operand, whether
   * a line prints it or a `%n` walks it.
   */
  readonly ownName?: string;

  /** What the read said is wrong with what the name points at. */
  readonly error?: string;

  /**
   * The watch a `watch` row stands for, by the key that names one
   * (`watch.ts`), and absent on every other kind of row.
   *
   * It is here because a handle is a bound reference rather than a row number
   * (decision 27), and what binds a watch row is neither of the two things
   * every other row is bound by: a watch stands at no place, and its name is a
   * rendering rather than an identifier. The key is the complete reference of
   * the cell it watches, so a row read back names the watch it was minted for
   * whatever has been armed or disarmed since.
   */
  readonly watch?: string;
}

/** What `ls` found at a place. */
export interface Listing {
  /** The rows, in the order the read listed them. */
  readonly rows: readonly ListingRow[];

  /**
   * What the rows are, where they are not everything standing there. A
   * listing that said nothing would be read as complete.
   */
  readonly bound?: string;
}

/**
 * The handles one listing minted: its rows, numbered from `%1` in the order
 * they were listed, and the place they were listed at.
 *
 * The place is what makes a handle a bound reference rather than a row number
 * (decision 27): a row's name is a name inside that place, so the pair names a
 * cell from anywhere and goes on naming it after the place has moved. For a
 * callable row the same pair is the receiver and the verb name `call` wants —
 * the place being the receiver and the name the verb — so neither is recorded
 * a second time on the row, where the two copies would be free to part.
 */
export interface ListingHandles {
  /** Where the listing was read, which its rows stand inside. */
  readonly place: Place;

  /** The rows in the order they were numbered: `%1` is the first. */
  readonly rows: readonly ListingRow[];
}

/**
 * What a listing prints as: its rows, one line each, and the bound's line
 * where it carries one.
 *
 * They are two fields rather than one array because a page treats them
 * differently. The rows are what a page cuts and what `--limit` counts; the
 * bound is shown whatever either says, being the listing's own account of what
 * it is a listing of.
 */
export interface ListingRendering {
  /** The bound's line, where the listing carries a bound. */
  readonly bound?: string;

  /** One line per row, numbered, in the order the listing lists them. */
  readonly rows: readonly string[];
}

/**
 * The reads a listing is made of, each `packages/cli`'s own. A caller supplies
 * its own to drive this module with nothing behind it.
 */
export interface ListingDeps {
  /** Lists the slugs the space's index records. */
  readonly listSpaceSlugs?: typeof listSpaceSlugs;

  /** Lists the space's pieces. */
  readonly listPieces?: typeof listPieces;

  /** Reads the cell a listing inside a piece names its keys off. */
  readonly getCellValue?: typeof getCellValue;

  /** Names which of that cell's keys stand at a verb's dispatch surface. */
  readonly listCallableKeys?: typeof listCallableKeys;

  /**
   * The line's cancel. A listing inside a piece is two reads, and it is one
   * act to the guard the verb runs it under, so the rule that every read has
   * a check in front of it with nothing awaited between (`VerbDeps.signal`,
   * `vocabulary.ts`) reaches the second read only through this. A listing
   * cancelled between its reads comes back empty, which that guard drops on
   * the way back.
   */
  readonly signal?: AbortSignal;
}

/**
 * What `ls` finds at `place`, read over `connection` with `config` saying what
 * to connect as.
 *
 * A row the read reported a failure against is still a row: a name the space
 * has and nothing resolves is a name the space has, so it comes back carrying
 * what went wrong rather than being dropped, and it never takes the listing
 * down with it. A read that failed outright is no listing, and raises.
 *
 * @throws Whatever the read throws — an unreachable server, an identity that
 * will not load, a path the piece refuses.
 */
export async function listPlace(
  config: SpaceConfig,
  place: Place,
  connection: HeldConnection,
  deps: ListingDeps = {},
): Promise<Listing> {
  const position = place.position;
  switch (position.kind) {
    case "root":
      return {
        rows: FACETS.map((facet) => rowFor(place, facet, "container")),
      };
    case "facet":
      return await listFacet(config, place, position.facet, connection, deps);
    case "piece":
      return await listKeys(config, place, position, connection, deps);
  }
}

/**
 * What `ls` prints for `listing`: one line per row, and the bound's own line
 * beside them.
 *
 * The lines come back as lines rather than as one string, because how many of
 * them fit is `page.ts`'s question and not this module's. What this decides is
 * what each line says, and which of them are rows.
 *
 * A row opens with the handle a person types to reach it again, in a column
 * the widest of them sets, and its name comes next in a column of its own. The
 * name is written as a token, so what a reader copies out of the name column
 * is what `cd` takes; a name a row has none for stands as a marker in that
 * column instead — and `quoteToken` is what keeps the two apart, not anything
 * here: `<` is one of the characters the grammar reserves, so a name holding
 * one is printed quoted and a name never opens with it. The name column
 * therefore opens with `<` exactly where the row has no name.
 *
 * Everything else on a line — the row with no operand, the name a row calls
 * itself by, a callable's annotation, a row's error, and the bound — is
 * written as a marker. Those brackets delimit for a reader and not for a
 * parser: a payload may hold an angle bracket of its own and nothing escapes
 * it. Nothing parses a listed line, and a form that could be parsed is a
 * second output form rather than a rule for this one
 * (`docs/plans/shuttle/futures.md`).
 *
 * The bound comes back beside the rows rather than among them, because it is
 * not one of them: a page cuts rows and always shows the bound, and `--limit`
 * counts rows and never counts the bound. What it says — that these rows are
 * not everything standing here — is what a reader of a partial listing most
 * needs, so it is the one line a page may not drop.
 *
 * A row is one line, and lines are separated by a newline, so nothing written
 * on a line may put one inside it: a message and a bound each have their
 * newlines written as spaces, and a name carrying one is described rather than
 * written. What a message does with the rest of the class a terminal acts on,
 * and why a name cannot do the same, is with {@link oneLine}. Rewriting one
 * inside a name would leave a token `cd` no longer takes back to the row,
 * which is the guarantee the name is printed for, so what a terminal makes of
 * it is not something this can spend that on.
 */
export function listingLines(listing: Listing): ListingRendering {
  const rows = numbered(listing.rows.map(lineFor));
  return listing.bound === undefined
    ? { rows }
    : { bound: marker(oneLine(listing.bound)), rows };
}

/**
 * `lines` with the handle each one is named back by in front of it, right
 * aligned so that every line's own text opens in the same column.
 *
 * Alignment is over the whole listing rather than over a page of it, so a row
 * sits in the same column on the page it first appeared on and on the page
 * `more` writes: the widest number the listing will hand out is known once the
 * rows are, and it is what every page is padded to.
 *
 * Every listing shuttle writes goes through here, so a verb that composes its
 * own lines numbers them the way `ls` numbers its rows without restating how.
 * The numbering is positional in the array, which is also how a handle table
 * reads a row back (`handles.ts`), so the two agree by construction rather
 * than by carrying a number apiece.
 */
export function numbered(lines: readonly string[]): readonly string[] {
  const column = handleFor(lines.length).length;
  return lines.map((line, index) =>
    `${handleFor(index + 1).padStart(column)} ${line}`
  );
}

/**
 * The handle a listing's `number`th row is reached by, which is what a person
 * types to name it again.
 *
 * Numbering runs from one rather than from zero: these are read off a screen
 * and typed back, which is what a shell's job numbers and a printed list's
 * items do, and neither starts at zero.
 */
export function handleFor(number: number): string {
  return `${HANDLE_SIGIL}${number}`;
}

/**
 * Helper for {@link listPlace}, which is what `facet` lists at `place`.
 *
 * The two facets read different things and are written out one arm each rather
 * than chosen from a table, so that a facet added to {@link FACETS} fails to
 * compile here instead of silently taking the other one's read.
 *
 * A piece stands as its id and carries the name it holds beside it, where
 * `listPieces` read one. An id alone is the operand only when its complete
 * reference names the local document at the current scope. Otherwise the
 * registered reference is the operand, preserving a foreign space, scope,
 * or path instead of resolving that id against the listing's space.
 */
async function listFacet(
  config: SpaceConfig,
  place: Place,
  facet: Facet,
  connection: HeldConnection,
  deps: ListingDeps,
): Promise<Listing> {
  const loadPieces = () => connection.pieces();
  switch (facet) {
    case "slugs": {
      const slugs = await (deps.listSpaceSlugs ?? listSpaceSlugs)(config, {
        loadPieces,
      });
      return {
        rows: slugs.map((row) =>
          rowFor(place, row.slug, "slug", { error: row.error })
        ),
        bound: SLUG_INDEX_BOUND,
      };
    }
    case "pieces": {
      const pieces = await (deps.listPieces ?? listPieces)(config, {
        loadPieces,
      });
      return {
        rows: pieces.map((row) => {
          const entry = rowFor(place, row.id, "piece", {
            ownName: row.name,
            error: row.error,
          });
          const localReference = renderCellReference({
            space: place.position.space,
            id: idStringForEntityAddress(row.id),
            scope: place.scope,
            path: [],
          });
          return row.reference === localReference
            ? entry
            : { ...entry, operand: row.reference };
        }),
      };
    }
  }
}

/**
 * Helper for {@link listPlace}, which is what the cell `position` names lists
 * at `place`.
 *
 * The piece and the scope ride the config and the path is the read's operand,
 * which is where `getCellValue` takes one: the config's own `piecePath` is
 * dropped by the resolution, so a path written in both places would be walked
 * once whichever way it arrived. A place stands on the piece as an operand
 * named it, a slug included, so what makes a slug typed back off a listing
 * reach its piece is the read's own resolution step
 * (`PieceResolutionDeps.resolvePieceAddress`).
 *
 * An empty listing means the path names a leaf, and nothing here says which:
 * `keysOf` gives a leaf no keys and gives an empty container none either, and
 * telling the two apart is not something this read can do.
 *
 * Which keys are callables is a second read, of the cell rather than of its
 * value: a stream's position holds nothing, and what says it is a stream is
 * the schema its stored links carry, which is what `listCallableKeys` reads
 * for each key the first read named.
 */
async function listKeys(
  config: SpaceConfig,
  place: Place,
  position: PiecePosition,
  connection: HeldConnection,
  deps: ListingDeps,
): Promise<Listing> {
  const pieceConfig: PieceConfig = {
    ...config,
    piece: position.piece,
    pieceScope: place.scope,
  };
  const pieceDeps = { loadPieces: () => connection.pieces() };
  const level = await (deps.getCellValue ?? getCellValue)(
    pieceConfig,
    [...position.path],
    {},
    pieceDeps,
  );
  const keys = keysOf(level);
  // The check in front of the second read: the first was awaited, and a
  // cancel that landed meanwhile is one this read must not go out after.
  if (deps.signal?.aborted) return { rows: [] };
  const callables = keys.length === 0
    ? new Set<string>()
    : await (deps.listCallableKeys ?? listCallableKeys)(
      pieceConfig,
      [...position.path],
      keys,
      {},
      pieceDeps,
    );
  return {
    rows: keys.map((key) =>
      rowFor(
        place,
        key,
        kindOf(childOf(level, key), callables.has(key)),
      )
    ),
  };
}

/**
 * Helper for {@link listKeys}, which is what the cell holds at `key`, and
 * nothing where it holds nothing there.
 *
 * `keysOf` names only the keys of an array or an object, so the cast is over a
 * value already known to be one of those; a key holding `undefined` is a key
 * all the same, and what it stands for is a value rather than a container.
 */
function childOf(level: unknown, key: string): unknown {
  return (level as Record<string, unknown>)[key];
}

/**
 * Helper for {@link listKeys}, which is what a position holding `value` is,
 * given whether the piece's stored links say it is a `callable`.
 *
 * A stream is a dispatch surface rather than a value — nothing is stored at
 * it to read, and a read aimed at one is refused (`classifyReadPathVerb`,
 * `lib/piece.ts`) — so it is the piece's callable and is marked as one. That
 * is decided off the same link-derived schema the refusing read decides off
 * (`listCallableKeys`), so a listing and the read that refuses such a
 * position agree about which positions those are. A position that still
 * reads as the retired `{ $stream: true }` sentinel is a callable too, until
 * no stored document holds one.
 *
 * Everything else divides by whether a walk continues through it: an array or
 * an object holds keys and `cd` descends into it, and anything else is where a
 * path ends.
 */
function kindOf(value: unknown, callable: boolean): RowKind {
  if (callable || isStreamValue(value)) return "callable";
  return isObjectOrArray(value) ? "container" : "value";
}

/**
 * Helper for {@link listPlace}, which is the row `name` stands as at `place`,
 * being a `kind` and carrying whatever else the read `found` against it: the
 * name the row calls itself by, and what went wrong where something did.
 *
 * The two arrive in one argument because they are one thing to a caller — the
 * part of a row a read supplies rather than the place — and because two bare
 * strings at the end of a call are two a caller can hand over the wrong way
 * round with nothing to say so.
 */
function rowFor(
  place: Place,
  name: string,
  kind: RowKind,
  found: { readonly ownName?: string; readonly error?: string } = {},
): ListingRow {
  const operand = operandForChild(place, name);
  return {
    name,
    kind,
    ...(operand === undefined ? {} : { operand }),
    ...(found.ownName === undefined ? {} : { ownName: found.ownName }),
    ...(found.error === undefined ? {} : { error: found.error }),
  };
}

/**
 * Which kinds a listed line annotates, and with what.
 *
 * A projection over every kind rather than a test for the one that is marked,
 * closed by the compiler: a kind added to {@link RowKind} without a line here
 * does not compile, so whether it is annotated is a decision somebody made
 * rather than an absence nobody noticed.
 *
 * Only the callable is marked, and what marks it is what `grammar.md`
 * promises: a piece's callables surface inline in listings, annotated as
 * callable, rather than behind a reserved name. The rest are not marked
 * because the annotation would be on every row and would say what the next
 * `ls` says anyway — a container lists, and a value does not. A watch is that
 * case at its plainest: every row of the one listing that mints one is a
 * watch, so the mark would be on all of them and distinguish none.
 */
const ANNOTATED = {
  container: undefined,
  value: undefined,
  callable: "callable",
  piece: undefined,
  slug: undefined,
  watch: undefined,
} satisfies Record<RowKind, string | undefined>;

/**
 * Helper for {@link listingLines}, which is the line `row` prints as, without
 * the number {@link numbered} puts in front of it.
 *
 * A row's own name is written as a marker, which is what keeps it off the
 * column a reader types back: a name the fabric holds is not an address, and
 * one printed where the operand goes would offer a spelling no verb takes. It
 * goes through {@link oneLine} for the reason an error's text does — it is a
 * value a read served rather than a name this module made — so a name holding
 * a break stays one row, and one holding a character a terminal acts on prints
 * as the glyph naming it.
 */
function lineFor(row: ListingRow): string {
  const annotation: string | undefined = ANNOTATED[row.kind];
  return [
    row.operand === undefined
      ? marker(noOperandFor(row.name))
      : quoteToken(row.operand),
    ...(row.ownName === undefined ? [] : [marker(oneLine(row.ownName))]),
    ...(annotation === undefined ? [] : [marker(annotation)]),
    ...(row.error === undefined
      ? []
      : [marker(`error: ${oneLine(row.error)}`)]),
  ].join(" ");
}

/**
 * Helper for {@link listingLines}, which says that a row called `name` has no
 * operand, showing the name where a line has room for it.
 *
 * It says no operand rather than that nothing reaches the row, which is the
 * wider claim and a false one: a key whose first character is `#` is reached
 * by a multi-segment operand, `#` being data in a segment that names a data
 * key.
 * What holds of every row this is written for is that neither the name nor the
 * reference names it, and a name is what a listing prints.
 *
 * Two names are described rather than written, and for the same reason the
 * doors refuse them: one holding a line break would make a second row out of
 * one wherever the row is written, and one holding a control character is an
 * instruction on a terminal the row is read on. Writing either would put
 * back, in the marker, exactly what
 * refusing the name kept off the screen. The name is shown
 * as it is written and not as something to type — it sits inside a marker,
 * which by the rule above carries no name.
 *
 * A name holding a newline is described rather than shown, because a row is
 * one line. That row is also one nothing reaches at all, a segment holding a
 * break being refused at every door, so what the description withholds is a
 * string no operand would have carried anyway.
 */
function noOperandFor(name: string): string {
  return name.includes("\n")
    ? "no operand: a name holding a line break"
    : holdsControlCharacter(name)
    ? "no operand: a name holding a control character"
    : `no operand: ${quoteToken(name)}`;
}

/**
 * Helper for {@link listingLines}, which is `text` fit to be written on a
 * line and acted on by nothing: each newline as a space, so that what is
 * written on a line takes one line, and each remaining character a terminal
 * acts on as the glyph that names it.
 *
 * The payloads that are a caller's own text go through it, the bound as much
 * as an error — the two agreeing is what keeps "a row is one line" a rule
 * rather than a habit of one of them. The marker for a row with no operand
 * builds its own text and answers a break, or a character a terminal acts on,
 * by describing the name instead of showing it.
 *
 * The two rewrites are two decisions. A newline becomes a space so that a
 * message stays one row; the rest become glyphs so that a message a person
 * reads cannot instruct the terminal it is read on. Escaping is what a message
 * gets and a name does not, because a message is read where a name is typed
 * back.
 *
 * Nothing else is touched, an angle bracket included: those delimit a marker
 * for a reader rather than for a parser, and a payload holding one is that
 * decision rather than this one.
 *
 * A verb composing rows of its own writes the prose on them through here, so
 * one rule holds for every annotation shuttle prints beside a row rather than
 * one per producer.
 */
export function oneLine(text: string): string {
  return escapeControlCharacters(text.replaceAll("\n", " "));
}
