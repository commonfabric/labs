/**
 * The vocabulary a verb is written in: the shuttle it acts on, the deps it
 * reads through, what it hands back, and the acts every verb shares.
 *
 * What a verb *does* is not here — the dispatch, the table it reads and each
 * verb's body are `verbs.ts`'s, and a completion reads the same shuttle
 * through the same deps (`completion.ts`). What those two have in common is
 * this.
 *
 * Nothing here touches a terminal. Where an operand points is `place.ts`'s to
 * decide, and what is left to this module is the part of that answer a read
 * settles: a space written as a name is asked of the connection this process
 * holds, and a `%n` handle is looked up in what the last listing numbered.
 */

import type { CellScope } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { resolvePieceReference } from "@commonfabric/piece";

import type { callFromCommand } from "../../commands/piece.ts";
import type { parseCellSelectionOptions } from "../cell-selection.ts";
import type {
  describePiece,
  executePieceCallable,
  getCellValue,
  linkPieces,
  listPieceCallables,
  PieceConfig,
  setCellValue,
  sinkCellValue,
  SpaceConfig,
  warmPiece,
} from "../piece.ts";
import type { readWish } from "../wish.ts";
import { type Announce } from "./announce.ts";
import { type HeldConnection } from "./connection.ts";
import { type Editing } from "./editor.ts";
import { type ExternalLocation } from "./external.ts";
import { resolveHandle } from "./handles.ts";
import type { ValueLens } from "./lens.ts";
import { type ListingDeps, type RowKind } from "./listing.ts";
import { type VerbOptions } from "./options.ts";
import {
  ASSUMED_COLUMNS,
  ASSUMED_ROWS,
  heightFit,
  type Page,
  type PageBound,
  pageOf,
  statusLine,
} from "./page.ts";
import {
  type Aim,
  CurrentPlace,
  type FacetPosition,
  type HandleMove,
  type PiecePlace,
  type PiecePosition,
  type Place,
  type SpaceRootPosition,
} from "./place.ts";
import { ShuttleSession } from "./session.ts";

/** What running a line did. */
export type Outcome =
  /** The line named no verb, which is not a mistake and did nothing. */
  | { readonly kind: "nothing" }
  /** The place moved, and `place` is where shuttle now stands. */
  | { readonly kind: "moved"; readonly place: Place }
  /** The verb composed `text`, which is the whole of what it produced. */
  | { readonly kind: "text"; readonly text: string }
  /** The verb read `value` out of the fabric. */
  | { readonly kind: "value"; readonly value: unknown }
  /**
   * The verb armed a watch and opened `lens` onto it, having composed `armed`
   * — the listing of what is now armed — on the way.
   *
   * The two are one outcome and not two because they happened in one line and
   * in that order, and because only the caller that owns the keyboard can open
   * a lens: a verb composes what it did and hands the frame over, exactly as
   * it hands back the text of a line it merely wrote (`prompt.ts`).
   */
  | {
    readonly kind: "watching";
    readonly lens: ValueLens;
    readonly armed: string;
  }
  /** The line is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string }
  | Interruption;

/**
 * What a line that was cancelled comes back as: it stopped where it was, and
 * whatever it had not done yet it did not do.
 *
 * It is neither a refusal nor a failure. A refusal is a fact about the line —
 * it would have been wrong whenever it ran — and a failure is a fact about the
 * read; this is a fact about the person, who stopped waiting.
 */
export type Interruption = { readonly kind: "interrupted" };

/**
 * The running shuttle a verb acts on: where it stands, what it connects as,
 * and the connection it holds.
 */
export interface Shuttle {
  /** What this process connects as, which every read rides. */
  readonly config: SpaceConfig;

  /** Where shuttle stands, which `cd` moves and every other verb reads. */
  readonly place: CurrentPlace;

  /**
   * The one working position outside the fabric, which `xcd` moves.
   *
   * It stands beside the place rather than inside it because the two move
   * independently: the fabric is the ambient plane, so a bare relative
   * operand is read against the place and never against this one
   * (`external.ts`).
   */
  readonly external: ExternalLocation;

  /** The one connection this process holds. */
  readonly connection: HeldConnection;

  /**
   * What the lines before this one left behind: the handles the last listing
   * numbered, what `more` writes next, and which pieces this run has started.
   * It stands beside the place because `cd` neither resets nor carries any of
   * them (`session.ts`).
   */
  readonly session: ShuttleSession;

  /**
   * The session every call this run makes is invoked under, minted once at
   * startup and passed rather than derived.
   *
   * It is what makes an invocation id replayable, and one shuttle is one run —
   * exactly the span over which repeating an id should mean repeating a call.
   * A call that minted its own would be its own session, which is the same
   * thing as having none.
   */
  readonly invocationSession: string;
}

/**
 * What a verb reads through. A caller supplies its own to drive this module
 * with nothing behind it.
 */
export interface VerbDeps {
  /** Reads the value at a cell path, which is what `get` returns. */
  readonly getCellValue?: typeof getCellValue;

  /** Writes a value at a cell path, which is what `set` and `edit` do. */
  readonly setCellValue?: typeof setCellValue;

  /** Writes a reference at a cell path, which is what `link` does. */
  readonly linkPieces?: typeof linkPieces;

  /**
   * Subscribes to a cell and reports what it settles at, which is what a
   * watch and the lens onto it are each built from.
   *
   * It is one seam serving both because the two want the same thing and differ
   * only in how long they want it: the settling discipline is the seam's
   * (`sinkCellValue`, `lib/piece.ts`), and which of them cancels when is the
   * caller's.
   */
  readonly sinkCellValue?: typeof sinkCellValue;

  /**
   * Starts the piece a verb is about to act on, which is reaching in warms
   * (decision 10). It is a read like the ones beside it: it resolves the
   * piece and syncs it, and it is what makes a computed value a verb reads
   * the value a running pattern holds.
   */
  readonly warmPiece?: typeof warmPiece;

  /** Lists a piece's callables, which is what `verbs` writes. */
  readonly listPieceCallables?: typeof listPieceCallables;

  /** Describes a piece, which is what `describe` writes. */
  readonly describePiece?: typeof describePiece;

  /**
   * Runs a call, which is `cf piece call`'s own action taken as a function.
   * What it contributes past intake is what `call` would otherwise write
   * again: the grammar of a callable's section, the invocation identity, the
   * wait control, the settlement bound, and the outcome rendering
   * (`docs/plans/shuttle/runtime-integration.md`).
   */
  readonly callFromCommand?: typeof callFromCommand;

  /**
   * Dispatches the callable the call resolved, which rides inside
   * {@link VerbDeps.callFromCommand} rather than beside it: it is where the
   * connection this process holds is handed down, and where the standard
   * input a prompt is reading keys off is refused.
   */
  readonly executePieceCallable?: typeof executePieceCallable;

  /**
   * Opens the person's editor on a value and returns what they saved, which
   * is the whole of what `edit` does that no other verb does.
   *
   * A caller that supplies none has no editor, and `edit` says so rather than
   * guessing at one: what runs an editor has to take the terminal's raw mode
   * off around it and put it back after, and only what opened the terminal
   * can (`run.ts`).
   */
  readonly editText?: (text: string) => Promise<Editing>;

  /**
   * Where a line's out-of-band writing goes: what a call publishes while it
   * is still in flight, which happens before there is an outcome to carry it.
   *
   * It is the sink a connection's own output already goes to (`announce.ts`),
   * so a call's dispatch announcement and a pattern's console reach one place
   * in the order they happened. A caller that supplies none drops them, which
   * is what a caller with no screen has to do with a line written above a
   * prompt that is not there.
   */
  readonly announce?: Announce;

  /** Resolves a named entry point, for `wish` and for `cd` into one. */
  readonly readWish?: typeof readWish;

  /**
   * Reads the projection options a data verb takes, which is the parser
   * `cf cell get` reads its own through (`lib/cell-selection.ts`).
   *
   * It is a seam like the reads beside it rather than a call, because what a
   * verb does with what it throws is a decision worth driving: a selection
   * this parser refuses is a fact about the line, and anything else it throws
   * is a fault, which `get` raises rather than turning into a refusal.
   */
  readonly parseCellSelectionOptions?: typeof parseCellSelectionOptions;

  /**
   * Resolves the piece and path an operand named, which is what `cd` settles.
   * It is the resolution a read makes too (`pieceReferenceResolver`,
   * `lib/piece.ts`), so the two verbs reach the same cell for one reference.
   */
  readonly resolvePieceReference?: typeof resolvePieceReference;

  /** The reads `ls` composes. */
  readonly listing?: ListingDeps;

  /**
   * How many rows the terminal shows, which is half of what bounds a page a
   * verb writes (`page.ts`). It is a function rather than a number so that a
   * window resized between two lines bounds the second one at the size it has
   * now, and it is a dep rather than a field of the shuttle because the screen
   * is something a verb writes to rather than part of where shuttle stands.
   *
   * A caller that supplies none gets {@link ASSUMED_ROWS}, which is what a
   * terminal that will not measure itself gets too, so a verb driven with
   * nothing behind it still bounds what it writes.
   */
  readonly rows?: () => number;

  /**
   * How many columns it shows, which is the other half: a line wider than the
   * terminal wraps, so what a page has to count is rows and what it is handed
   * is lines. A bound that took the width for granted would let one long value
   * fill the screen without ever reaching it.
   *
   * A caller that supplies none gets {@link ASSUMED_COLUMNS}, on the terms
   * {@link VerbDeps.rows} takes its assumption on.
   */
  readonly columns?: () => number;

  /**
   * Cancels the line, which the prompt aborts on `ctrl-c`.
   *
   * What it can stop is what has not started, and the rule that makes that
   * a property rather than a list is: **every read has a check in front of
   * it with nothing awaited in between**, and so does every adoption. An
   * await between the two is a window the cancel lands in and the read goes
   * out of anyway, which is why the settle asks the holder for its
   * connection once and hands it down rather than asking again before each
   * read.
   *
   * The rule is what a caller can check, and it is checked: a case cancels
   * from inside each read there is and at each line's first suspension, and
   * asserts that nothing was read afterwards (`shuttle-verbs.serial.test.ts`).
   * That observes the property instead of enumerating the boundaries, so a
   * boundary nobody thought of fails it too.
   *
   * What it cannot stop is a read already sent: the runtime's reads take no
   * signal, so one in flight finishes and its answer is dropped, and the
   * checks are what stop it taking effect on the way back.
   */
  readonly signal?: AbortSignal;

  /**
   * Takes charge of a lens the line has opened, from the moment it is opened.
   *
   * What runs the line closes, as the line settles, every lens it opened that
   * its outcome does not carry, and on the way out every lens it opened at all.
   * A lens holds a subscription from the moment it adopts one, so it needs an
   * owner before there is an outcome to find it in: an outcome can lose its
   * race to a cancel, or arrive after nothing is left to take it (`prompt.ts`).
   */
  readonly adoptLens?: (lens: ValueLens) => void;
}

/**
 * Whether the line running under `deps` has been cancelled, as the outcome
 * that says so.
 *
 * A cancelled line's phases are checked rather than raced, so what comes back
 * from a verb is always something the verb actually decided. Racing is the
 * prompt's to do and it does it one layer up, where abandoning a line costs
 * nothing that a place could later be moved by.
 */
export function stopped(deps: VerbDeps): Interruption | undefined {
  return deps.signal?.aborted === true ? { kind: "interrupted" } : undefined;
}

/** What an act guarded against a cancel did, where it was allowed to run. */
export type Ran<T> = { readonly kind: "ran"; readonly answer: T };

/**
 * Performs `act` over `args` unless the line has been cancelled, and is what
 * it answered where it was allowed to.
 *
 * Every read a line sends and every move it adopts goes through here — this
 * module's, and the completion's beside it (`completion.ts`) — and the reason
 * is that the rule they are held to is not one discipline can keep. The rule is that **nothing is awaited between the check and the act
 * it guards** — an await there is a window the cancel lands in and the act
 * happens anyway — and a rule of that shape is invisible: the code reads
 * correctly whether or not the window is there, no case can see it, and the
 * next author to insert a line between two statements has no way to know
 * which two they are.
 *
 * So the two are one expression here instead. The arguments are evaluated
 * before this is entered, so a caller that awaits while composing them still
 * has the check on the far side of its own await; and there is no statement
 * position between the check and the call for an await to occupy, because
 * there are no statements between them. Passing `act` and its arguments
 * separately rather than as a closure is what leaves nowhere to hide one: a
 * closure has a body, and a body can await.
 *
 * What that is worth, stated at its actual size: it stops an await written as
 * a *statement*, which is how one gets written. It does not stop every
 * insertion an expression admits — `await (await something(), act(...args))`
 * reopens the window inside this very line, and nothing here would notice.
 * So this is a guarantee against the edit somebody makes, not against the
 * edit somebody constructs, and the cases are what cover the second: a line
 * cancelled at its first suspension reaches this function before its read,
 * and every verb that reads has such a case (`shuttle-verbs.serial.test.ts`).
 *
 * There are two checks and not one, and the second is what a caller relies on
 * without knowing it. The first stops the act; the second stops its *answer*,
 * because an act that was already in flight when the cancel arrived finishes
 * anyway — the runtime's reads take no signal — and everything a caller then
 * does with what it returned is an adoption. A `ran` therefore means the line
 * was live when the answer arrived, which is the reading the next author will
 * take from the name whether or not it were true; where it is false the
 * interruption comes back and the answer is dropped.
 *
 * What is left to the caller is which arm it returns, and the arms are the
 * outcome's own, so a cancelled act is handed back rather than tested for.
 * What it does *not* say is which of the two checks stopped an act — a caller
 * that has something to undo where the act ran needs that, and the one there
 * is spells the pair out itself ({@link edit}).
 */
export async function guarded<A extends readonly unknown[], T>(
  deps: VerbDeps,
  act: (...args: A) => T | Promise<T>,
  ...args: A
): Promise<Ran<T> | Interruption> {
  // One expression, so that the check and the act it guards have no statement
  // position between them here either. This is the one place the rule lives
  // now, which is the point of it living somewhere rather than at every site.
  const before = stopped(deps);
  if (before !== undefined) return before;
  const answer = await act(...args);
  // And one after, which is what makes `ran` mean live. Everything a caller
  // does with an answer is an adoption, and an adoption is exactly what a
  // cancel must stop; a caller holding a `ran` that had gone stale while the
  // act was in flight would write it into the session anyway.
  return stopped(deps) ?? { kind: "ran", answer };
}

/**
 * What a line said past the verb that named it: the options it set, by the
 * names the verb declared, and the operands after them.
 *
 * The two halves arrive together because they are one reading — `readOptions`
 * divides a line into exactly this pair — and because a verb that reads one
 * usually reads the other. Handing them over as one value is what keeps a
 * verb's signature still while verbs gain flags: `ls` grew an option without
 * `pwd` growing a parameter, and the call section a `call` will carry
 * (`docs/plans/shuttle/grammar.md`) is a third member of this rather than a
 * fourth argument.
 */
export interface VerbLine {
  /** What the line's options set, by name. */
  readonly options: VerbOptions;

  /** The operands after them, in the order they were written. */
  readonly operands: readonly string[];

  /**
   * The words past the bare `--`, for a verb that opens a section, and absent
   * for a verb that does not.
   *
   * Absent is the claim that the verb reads no section, so a verb that opens
   * one and was written no `--` carries an empty array instead: the two are
   * different lines, and only the second is a call whose section ran to the
   * end of what was typed.
   */
  readonly section?: readonly string[];
}

/** What a verb does with the line written after its name. */
export type Verb = (
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
) => Outcome | Promise<Outcome>;

/**
 * Where `operand` points, read from where shuttle stands and settling
 * nothing, `verb` naming the verb whose line the operand was written on.
 *
 * This is the one door every reading verb aims through, and a line that wrote
 * no operand comes through it too: an absent operand is where shuttle stands,
 * which is the same answer for each of them and so is given once here rather
 * than by each verb reading the place for itself. What a verb still decides
 * is what it does with the answer — `get` reads the cell, `ls` lists it, and
 * {@link receiver} narrows it to a piece.
 *
 * The verb reaches the place's reading rather than anything here: an operand
 * every verb aims through is refused in the name of the one that wrote it
 * ({@link CurrentPlace.aim}).
 */
export async function aimed(
  shuttle: Shuttle,
  operand: string | undefined,
  verb: string,
  deps: VerbDeps,
): Promise<Aiming> {
  if (operand === undefined) {
    return { kind: "place", place: shuttle.place.place, input: false };
  }
  return await reading(shuttle, shuttle.place.aim(operand, verb), verb, deps);
}

/** Where a handle's row stands, or the reason it stands nowhere. */
export type Rowed =
  | {
    /** Names this arm of {@link Rowed}. */
    readonly kind: "row";

    /** The place the listing that minted the handle was read at. */
    readonly at: Place;

    /** The operand that reaches the row from there. */
    readonly toward: string;
  }
  | Refusal;

/**
 * What a row of each kind that no place stands at is reached by instead, as
 * the clause a refusal adds, and nothing for a kind that stands somewhere.
 *
 * A projection over every kind rather than a test for the two that carry a
 * clause, closed by the compiler: a kind added to {@link RowKind} without a
 * line here does not compile, so whether it names a verb of its own is a
 * decision somebody made rather than an absence nobody noticed. Three kinds
 * stand at a place and one that does not is a row a listing gave no operand,
 * which is what the sentence in front of the clause already says.
 */
const REACHED_BY = {
  container: undefined,
  value: undefined,
  callable: ", it being one of the piece's callables. `call` is what " +
    "invokes one",
  piece: undefined,
  slug: undefined,
  watch: ", it being a watch. `unwatch` is what disarms one",
} satisfies Record<RowKind, string | undefined>;

/**
 * Helper for {@link landing} and {@link reading}, which is the row `move`
 * names and the operand that reaches it, or the reason it reaches nothing.
 *
 * It reads the session rather than the fabric, so it is not a read and needs
 * no guard: what the last listing numbered is a value this process already
 * holds.
 *
 * A row with no operand is a row no place stands at, and the refusal says that
 * rather than that the handle named nothing — the handle named a row, and the
 * row is the part that is not somewhere to go. Two kinds are always so and
 * each has a verb of its own, which {@link REACHED_BY} is what names.
 */
export function rowFor(shuttle: Shuttle, move: HandleMove): Rowed {
  const bound = resolveHandle(shuttle.session.handles, move.handle);
  if (bound.kind === "refused") return bound;
  const toward = bound.row.operand;
  const instead: string | undefined = REACHED_BY[bound.row.kind];
  return toward === undefined
    ? refuse(
      `\`${move.handle}\` names a row no place stands at${instead ?? ""}.`,
    )
    : { kind: "row", at: bound.at, toward };
}

/** A refusal, which is an arm of every outcome this module has. */
export type Refusal = { readonly kind: "refused"; readonly reason: string };

/**
 * Where an operand points and which of the piece's two cells it names, or the
 * reason it names nothing to read.
 */
export type Aiming =
  | {
    readonly kind: "place";
    readonly place: Place;
    /** The arguments cell rather than the result, which `#argument` spells. */
    readonly input: boolean;
  }
  | Refusal;

/**
 * Helper for {@link aimed}, which finishes `aim` without moving, `verb` naming
 * the verb whose line it came off.
 *
 * A space written as a name is settled the way {@link landing} settles one,
 * and keeps the selection its reference carried. A handle is looked up, and
 * which cell it selects comes back with the row it reached, since a member on
 * a handle's head, or on a piece segment the path after it enters, is read
 * against that row. A `#name` target is not settled: `cf cell get` takes no
 * such target and `cf wish` does, and a data verb here means what it means
 * there, so the refusal names the verb that reads one. Resolving it here would
 * answer a second way as well as a second time — `wish` hands back what the
 * fabric resolved with its handles written as markers, and a cell read of the
 * same address hands back the raw value.
 *
 * That is the `#argument` member's opposite and for a reason that is not
 * arbitrary. The member says which of a piece's two cells to read and the
 * piece it rides is reachable either way, so refusing it would put a cell out
 * of reach; a `#name` is a whole target with a verb of its own, so taking it
 * would put a second answer in reach. The two share the character and nothing
 * else (`docs/plans/shuttle/grammar.md`).
 */
async function reading(
  shuttle: Shuttle,
  aim: Aim,
  verb: string,
  deps: VerbDeps,
): Promise<Aiming> {
  const move = aim.move;
  switch (move.kind) {
    case "moved":
      return { kind: "place", place: move.place, input: aim.input };
    case "refused":
      return move;
    case "wish":
      return {
        kind: "refused",
        reason: `\`${move.target}\` names an entry point rather than a cell ` +
          `under this place. \`wish ${move.target}\` reads what it resolves ` +
          `to.`,
      };
    case "space-by-name": {
      const named = await connectedSpace(shuttle, move.name);
      return named.kind === "refused" ? named : await reading(
        shuttle,
        {
          input: aim.input,
          move: shuttle.place.resolveNamedSpace(move, named.space),
        },
        verb,
        deps,
      );
    }
    case "handle": {
      const row = rowFor(shuttle, move);
      return row.kind === "refused" ? row : await reading(
        shuttle,
        shuttle.place.resolveHandle(move, row.at, row.toward, verb),
        verb,
        deps,
      );
    }
  }
}

/** What asking the connection about a space name produced. */
export type Named =
  /** The name is this shuttle's own, and `space` is the space it holds. */
  | { readonly kind: "connected"; readonly space: MemorySpace }
  | Refusal;

/**
 * Helper for {@link landing} and {@link reading}, which is whether `name` is
 * the space this shuttle holds a connection to.
 *
 * The connection is asked rather than the name derived. A session opened by
 * name records it (`PiecesController.getSpaceName`), and one connection serves
 * one space, so the only thing a reference naming a space can want to know is
 * whether it names this one — for which the recorded name is the answer and a
 * key derivation on a navigation keystroke is a longer way round to it.
 *
 * The comparison is exact, and that is not an approximation of the derivation
 * but its own answer. A named space's key hangs off the name's bytes and
 * nothing else, so two names denote one space when they are one string. The
 * reference reader reads the space slot as written, with no escape undone —
 * the grammar admits no separator in a space name — so a name is compared in
 * the characters the operand wrote.
 *
 * A session opened by a DID recorded no name, and then there is no answer to
 * give: what the name denotes would take the derivation, and whether it
 * denotes this space is exactly what was asked. The refusal says so and says
 * what would answer it.
 */
export async function connectedSpace(
  shuttle: Shuttle,
  name: string,
): Promise<Named> {
  const pieces = await shuttle.connection.pieces();
  const connected = pieces.getSpaceName() ?? "";
  const asked = name;
  if (pieces.getSpaceName() === undefined) {
    return refuse(
      `This shuttle names its space by DID, so it cannot say whether ` +
        `\`${asked}\` is that space. One connection serves one space, and a ` +
        `shuttle started against \`${asked}\` by name is what reaches that ` +
        `cell.`,
    );
  }
  if (pieces.getSpaceName() !== name) {
    return refuse(
      `\`${asked}\` is not the space this shuttle is connected to, which is ` +
        `\`${connected}\`. One connection serves one space, so reaching ` +
        `that cell means a shuttle started against \`${asked}\`.`,
    );
  }
  return { kind: "connected", space: pieces.getSpace() };
}

/**
 * Helper for {@link read}, which names a container as a refusal opens with
 * it. A root and a facet are the only positions that are not a cell.
 */
export function container(position: SpaceRootPosition | FacetPosition): string {
  return position.kind === "root" ? "A space root" : `\`${position.facet}/\``;
}

/**
 * Helper for the verbs that reach a piece, which is the config a read or a
 * write of `position` at `scope` rides: what this process connects as, plus
 * the piece and the scope the place holds.
 *
 * The piece goes over as the place holds it, which is the handle where a read
 * resolved one and the operand's own spelling where the place is where an
 * operand *points* rather than where shuttle stands ({@link PiecePosition}).
 * Either way the resolution is the seam's own, which is what makes a name
 * typed back off a listing reach its piece.
 */
export function pieceConfigOf(
  shuttle: Shuttle,
  position: PiecePosition,
  scope: CellScope,
): PieceConfig {
  return { ...shuttle.config, piece: position.piece, pieceScope: scope };
}

/**
 * Helper for {@link listVerbs} and {@link describe}, which is
 * {@link pieceConfigOf} with the path carried as `piecePath`.
 *
 * That is what lets a place standing inside a collection holder describe the
 * member it reaches: the seam spends what the walk needs and refuses whatever
 * is left, in the words it refuses a cell path on a piece-only command with.
 */
export function pieceConfigAt(
  shuttle: Shuttle,
  place: PiecePlace,
): PieceConfig {
  return {
    ...pieceConfigOf(shuttle, place.position, place.scope),
    piecePath: [...place.position.path],
  };
}

/**
 * Helper for the verbs that write a rendering, which is one page of `lines`
 * within `bound`, with the rest left on the session for `more`.
 *
 * `hint` is what the status line offers beside `more`, and it rides the
 * continuation so that every page of one rendering makes the same offer: a
 * `get` whose value ran to four pages says `--select` on all four, because it
 * is as true on the fourth as on the first.
 *
 * Every rendering passes through here, including one that fit whole, which is
 * what clears a continuation the line before it left: `more` after a listing
 * that fit is `more` with nothing waiting, not `more` writing the tail of the
 * listing before it.
 *
 * It comes back as the one arm of {@link Outcome} a rendering can be rather
 * than as the union, so a caller that wants the lines rather than the outcome
 * — one composing a page into a line of its own — reads them without a test
 * that could not fail.
 */
export function paged(
  shuttle: Shuttle,
  header: readonly string[],
  entries: readonly string[],
  bound: PageBound,
  hint?: string,
): { readonly kind: "text"; readonly text: string } {
  const page: Page = pageOf(
    header,
    entries,
    bound,
    (left, overran) => statusLine(left, hint, overran),
  );
  shuttle.session.holding(
    page.rest.length === 0
      ? undefined
      : { lines: page.rest, ...(hint === undefined ? {} : { hint }) },
  );
  return { kind: "text", text: page.text };
}

/**
 * Helper for {@link paged}'s callers, which is the bound the screen puts on a
 * page: both of its dimensions, each what the deps say and each assumed where
 * they say nothing.
 */
export function screenFit(deps: VerbDeps): PageBound {
  return heightFit(
    measured(deps.rows?.(), ASSUMED_ROWS),
    measured(deps.columns?.(), ASSUMED_COLUMNS),
  );
}

/**
 * Helper for {@link screenFit}, which is `reported` where it is a usable count
 * and `assumed` where it is not.
 *
 * A terminal that cannot measure itself reports a dimension that is no count
 * at all, and a caller driving a verb with nothing behind it reports none.
 * Both mean the same thing here — nothing said how big the screen is — so both
 * take the assumption rather than one of them reaching arithmetic over it.
 */
export function measured(
  reported: number | undefined,
  assumed: number,
): number {
  return reported !== undefined && Number.isFinite(reported) && reported > 0
    ? reported
    : assumed;
}

/**
 * Helper for the verbs, which builds a refusal carrying `reason`.
 *
 * A reason is free to hold text the fabric wrote — a wish's error, an address
 * a target resolved to, the space that address named — none of which passed a
 * door. Holding it to the class a terminal acts on is the prompt's, at the one
 * point a reason becomes a line (`report`, `prompt.ts`), because a refusal
 * built as a literal rather than through here is still a refusal and reaches
 * the same place.
 */
export function refuse(reason: string): Refusal {
  return { kind: "refused", reason };
}
