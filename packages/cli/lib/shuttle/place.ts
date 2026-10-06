/**
 * A place is where shuttle stands: the position it reads from and the scope it
 * reads through. Both halves stick across navigation and both render, so they
 * travel as one pair and `cd` is the single door to either.
 *
 * Everything here is a value and a decision about a value — no connection, and
 * nothing read. The address grammar belongs to the fabric and this module
 * consumes it: a rooted or complete reference is read by
 * `normalizeLLMFriendlyRef` over the runner's `parseCellReference`, a relative
 * one by `parseRelativeReference`, a piece segment by `parsePieceSegment`, and
 * a piece position is written by `renderCellReference`. What this module adds
 * is what that grammar has no room for, which is everything above a piece: the
 * route a head's climbs walk back through, `-` and `/`, the `%n` a listing's
 * numbered row is named back by, the facets a space root lists and a rooted
 * operand reserves, the refusals a place is subject to, the operand that
 * reaches a child, which is those same readings asked in the other direction,
 * and the one reading that differs between moving somewhere and reading it: a
 * place cannot stand in an arguments cell, and an operand may still name one.
 *
 * Where a value stops is the moves that reach a piece, and the spellings that
 * name something no value here holds. Whether the fabric holds a piece, and
 * what a slug names, are reads, so those come back pending and `verbs.ts`
 * settles them: `cd` is the one verb whose success is a promise that the place
 * is there, so the read happens before the place is adopted. A `%n` is the
 * other: what a listing numbered is the session's to say, so it comes back for
 * `verbs.ts` to look up and hand back with the place and the operand the row
 * carries.
 */

import type { CellScope, LinkScope, ReferenceMember } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { glyphFor } from "../view/display.ts";
import {
  CELL_SCOPE_VALUES,
  encodeJsonPointer,
  linkPathSegmentToCellPathSegment,
  parsePieceSegment,
  parseRelativeReference,
  type RelativeReferenceParts,
  renderCellReference,
} from "@commonfabric/runner/shared";
import { isSlugAddress } from "@commonfabric/runner/slugs";

import {
  type NormalizedLLMFriendlyRef,
  normalizeLLMFriendlyRef,
  validatePieceSegment,
} from "../llm-friendly-ref.ts";
import { readsAsOption } from "./options.ts";
import { type RecordEntry, renderRecord } from "./record.ts";

/** One segment of a path inside a piece, in the form cell traversal takes. */
export type PathSegment = string | number;

/**
 * The facets a space root lists. A populated space is too large for a flat
 * root, so the root offers these and never pieces directly.
 *
 * These names are reserved wherever a walk from the root begins: as a segment
 * at the root, and as the first segment of a rooted reference, so that
 * `/slugs/board` is the walk `cd /` and `cd slugs/board` make. Inside a piece
 * no name is reserved at all and a facet name is an ordinary data key.
 *
 * The second half of that is a divergence from the canonical grammar and
 * `docs/plans/shuttle/grammar.md` says so. A rooted reference is the runner's
 * `parseCellReference` form rather than shuttle's, and `packages/cli` resolves
 * its piece segment by slug, so shuttle reads `/slugs/x` and `/pieces/x`
 * differently from the way `cf` reads them — at these two values and no
 * others. Issue #6992 retires it by refusing them as slugs at `set-slug`.
 */
export const FACETS = ["slugs", "pieces"] as const;

/** One of the {@link FACETS}. */
export type Facet = (typeof FACETS)[number];

/** Standing at a space's root, whose children are its facets. */
export interface SpaceRootPosition {
  /** Names this arm of {@link Position}. */
  readonly kind: "root";

  /** The space, which one connection fixes for a shuttle's whole run. */
  readonly space: MemorySpace;
}

/** Standing inside one facet of a space, whose children are pieces. */
export interface FacetPosition {
  /** Names this arm of {@link Position}. */
  readonly kind: "facet";

  /** The space, which one connection fixes for a shuttle's whole run. */
  readonly space: MemorySpace;

  /** Which facet is open. */
  readonly facet: Facet;
}

/** Standing at a piece, or at a path inside its result. */
export interface PiecePosition {
  /** Names this arm of {@link Position}. */
  readonly kind: "piece";

  /** The space, which one connection fixes for a shuttle's whole run. */
  readonly space: MemorySpace;

  /**
   * The piece, by the handle a read resolved it to.
   *
   * A slug is a redirect, so a place holding one would follow the index to
   * another piece without moving, and the write a later verb makes would land
   * where the index points now. {@link CurrentPlace.confirm} is where the
   * resolution lands, and every position shuttle stands at came through it.
   * The exception is a position that says where an operand *points* rather
   * than where shuttle stands ({@link CurrentPlace.aim}): nothing resolved
   * that one, so it carries the operand's own spelling and the read it feeds
   * resolves it the way `--cell` does.
   */
  readonly piece: string;

  /**
   * The name the index confirmed for {@link PiecePosition.piece}, absent
   * where the operand named the piece by handle.
   *
   * It is what the prompt shows and what nothing addresses: decision 13
   * (`docs/plans/shuttle/README.md`) shows a slug an index confirms, and the
   * handle beside it is what `pwd` prints and what every read goes to. A
   * piece named by handle keeps no name here even where the space has a slug
   * for it — a name is shown because a read confirmed it, and no read asked.
   */
  readonly name?: string;

  /**
   * Path inside the piece's result; empty while standing at the piece.
   *
   * Every door into this module refuses a segment a rendering would not name
   * back, or would put on a terminal as an instruction — one holding a line
   * break or another control character, and a number no digits name back —
   * for the reasons {@link unnameableSegment} gives. An empty key and one
   * ending in whitespace are keys like any other. That is an invariant the
   * doors establish rather than one this structural type enforces, so a
   * position reached any other way is outside it.
   */
  readonly path: readonly PathSegment[];
}

/**
 * Where in a space shuttle stands. A position is which cell this is and
 * nothing else, so two arrivals at one cell are one position however
 * differently they were reached; how shuttle got there is the trail
 * {@link CurrentPlace} keeps.
 */
export type Position = SpaceRootPosition | FacetPosition | PiecePosition;

/**
 * The cwd pair: the position shuttle reads from, and the scope it reads
 * through. A scope applies at every position rather than nesting inside one,
 * which is why it sits beside the position instead of among its levels — and
 * the pair is what names a cell, each half deciding which: one id read at
 * `@space` and at `@session` is two documents, so a move that changes either
 * half reaches a cell of its own.
 */
export interface Place {
  /** Where shuttle stands. */
  readonly position: Position;

  /** The overlay every read goes through while this place holds. */
  readonly scope: CellScope;
}

/**
 * A place standing on a piece, which is what a move a read has still to
 * confirm lands on: a root and a facet are decided by the value readings
 * alone, and only a piece and a path inside one are things the fabric may not
 * hold.
 */
export interface PiecePlace {
  /** Where shuttle would stand. */
  readonly position: PiecePosition;

  /** The overlay every read goes through while this place holds. */
  readonly scope: CellScope;
}

/**
 * The levels walked through to reach a place, outermost first, each the
 * position one descent came from.
 *
 * A relative head's climbs walk back out through it, one level per `..`,
 * which is what lets `cd slugs`, `cd board`, `cd ..` return to `slugs/` while
 * the piece itself stays one position however it was reached. Three moves
 * replace it wholesale rather than pushing: a reference and a resolved target
 * carry no route, and `-` restores the route that came with the place it
 * returns to.
 */
export type Trail = readonly Position[];

/**
 * A move that reached a piece the fabric has still to be asked about: what a
 * slug names, whether the space holds the piece, and whether a path inside it
 * is there. Reading that and handing this back to
 * {@link CurrentPlace.confirm} with the {@link ResolvedPlace} it resolved to
 * is what lands it.
 *
 * It carries the route as well as the place, which a landed move does not. A
 * trail is how shuttle reached where it stands, so it stops at
 * {@link CurrentPlace} for a move that is over; this one is a step still being
 * taken, and dropping the route would land `cd slugs/board` with no way back
 * to `slugs/`.
 */
export interface PendingMove {
  /** Names this arm of {@link Move}. */
  readonly kind: "pending";

  /** Where the move lands, with the piece as the operand spelled it. */
  readonly place: PiecePlace;

  /** The operand that named it, which a refusal quotes. */
  readonly operand: string;

  /** The levels walked to reach it, which `confirm` lands beside the place. */
  readonly route: Trail;
}

/**
 * What a read resolved a {@link PendingMove} to, which
 * {@link CurrentPlace.confirm} lands.
 *
 * The path is the resolution's own and not the move's, because a slug naming a
 * collection spends leading segments reaching its member: `/tasks/first/title`
 * resolves to the member's piece with `title` left inside it. That is the
 * resolution every read here already makes (`resolvePieceReference`,
 * `packages/piece/src/slugs.ts`), so a place lands on the cell a read of the
 * same reference reaches, and `cd` and `get` cannot disagree about whether a
 * reference names anything.
 */
export interface ResolvedPlace {
  /** The piece, by the handle it resolved to. */
  readonly piece: string;

  /** The path left inside that piece once the resolution spent what it spent. */
  readonly path: readonly PathSegment[];

  /**
   * The scope the piece was reached through, where that narrows the place's.
   *
   * A member held through a narrowed link is a different document from the one
   * its id alone names, so a place keeping the ambient scope would denote a
   * cell the read does not.
   */
  readonly scope?: CellScope;
}

/**
 * A move whose reference named its space by name rather than by DID, which no
 * value can tell apart from the space this place holds. Settling that name
 * against a connection and handing this back to {@link CurrentPlace.settle}
 * with the space it stands for is what lands it.
 *
 * It carries what the reference determined and no space, because whether the
 * name denotes the connected space is the one thing not yet known: an arm
 * with no space in it has none to be wrong about, and `settle` builds the
 * place from the space it already holds.
 */
export interface SpaceNamedMove {
  /** Names this arm of {@link Move}. */
  readonly kind: "space-by-name";

  /** The space name the reference carried. */
  readonly name: string;

  /** The reference that named it, which a refusal quotes. */
  readonly operand: string;

  /** The piece as the reference spelled it: a handle or a slug. */
  readonly piece: string;

  /** Path inside the piece's result; empty for the piece itself. */
  readonly path: readonly PathSegment[];

  /** The scope the reference asked for, or the place's where it asked none. */
  readonly scope: CellScope;
}

/**
 * A move whose operand opens with a numbered handle, which names a row of a
 * listing rather than a level anything here can walk to. Looking the row up
 * and handing this back to {@link CurrentPlace.reach} with the place the
 * listing was read at and the operand that row prints is what lands it.
 *
 * The handle is a head, read as the `.` head is: a member and a qualifier ride
 * it, and what follows its separator is a literal path, so `%1/..` is the key
 * `..` under the row and never a climb out of it. The member and the scope
 * are read against the row's own position once the row is known.
 */
export interface HandleMove {
  /** Names this arm of {@link Move}. */
  readonly kind: "handle";

  /**
   * The handle as the operand wrote it, `%` included and the head's member and
   * qualifiers left off, because what it names is the handle table's to say
   * and the reason it names nothing is the table's to give.
   */
  readonly handle: string;

  /** The member the head selects, where it selects one. */
  readonly member?: ReferenceMember;

  /** The scope the head moves to, absent where it names none or `@inherit`. */
  readonly scope?: CellScope;

  /**
   * The literal keys written after the head, decoded. Empty where nothing
   * follows the handle, and `[""]` where only its separator does, so `%1` and
   * `%1/` are two moves.
   */
  readonly path: readonly string[];

  /**
   * The whole operand, as the person wrote it. A refusal about the walk after
   * the handle quotes this rather than the handle: the handle is the part
   * that was right, and naming it alone would put the fault somewhere it is
   * not.
   */
  readonly operand: string;
}

/** The arms of a {@link Move} that leave shuttle where it stood. */
type Unlanded =
  /** The move is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The operand is a wish target, which the connected space resolves. */
  | { readonly kind: "wish"; readonly target: string }
  | HandleMove
  | SpaceNamedMove
  | PendingMove;

/**
 * What a move did. It either lands, is refused, or names something only the
 * connection can settle: a wish target to resolve, a space written as a name,
 * or a piece and a path the fabric has still to be asked about.
 */
export type Move =
  /** The move landed, and `place` is where shuttle now stands. */
  | { readonly kind: "moved"; readonly place: Place }
  | Unlanded;

/**
 * What an operand named for a door that says where it points rather than
 * going there: every arm of a {@link Move} but the pending one.
 *
 * A pending move is where the operand points already. What the read behind it
 * settles is whether the fabric holds anything there, and that is a question
 * about standing somewhere rather than about reading it — a read of a cell
 * that is not there fails on its own account, and says so in its own words.
 */
export type Aimed = Exclude<Move, PendingMove>;

/**
 * What an operand named when it was read rather than moved to: where it
 * points, and which of a piece's two cells it selects.
 */
export interface Aim {
  /**
   * True where the operand selected the `#argument` member, which is the
   * piece's arguments cell — the same selection `--input` spells as a flag.
   * The move beside it carries the path inside that cell, read from the cell's
   * root, so this is the whole of what tells the two cells apart.
   *
   * It is false for a handle, whose selection is read against the row it
   * names and so is known only once the row is: {@link CurrentPlace.resolveHandle}
   * says which. A reference naming its space by name carries its selection
   * already, and it is true here for one that selected the member.
   */
  readonly input: boolean;

  /** Where the operand points. */
  readonly move: Aimed;
}

/** What resolving a named entry point against the fabric produced. */
export interface ResolvedTarget {
  /** The space the target resolved in, which need not be the place's. */
  readonly space: MemorySpace;

  /** The piece the target resolved to. */
  readonly piece: string;

  /**
   * Path inside that piece, absent or empty for the piece itself, with each
   * segment as the resolution spelled it. This is `NormalizedLink.path`'s
   * own component type, so a resolution hands over what it is already
   * holding; {@link CurrentPlace.enter} converts each segment to the
   * number-or-string form a cell path takes.
   */
  readonly path?: readonly string[];
}

/**
 * Whether `text` holds a character a terminal acts on rather than prints.
 *
 * It is the question a door and a printing surface both ask. A place refuses a
 * part holding one — {@link ACTED_ON} carries which characters those are and
 * why — and a listing with no name left to offer for such a row describes it
 * rather than writing it, which is the one place a refusal still leaves the
 * name to be shown.
 */
export function holdsControlCharacter(text: string): boolean {
  return ACTED_ON.test(text);
}

/**
 * `text` with every character a terminal acts on shown as the glyph that names
 * it, and everything else as it stands.
 *
 * This is the opposite treatment from a name, and what each is for is the
 * difference. A name is something a person types back, so one that cannot be
 * printed safely is better replaced by a description of why it is missing. A
 * message is something a person reads, so it has to arrive whole and merely
 * inert: every character survives, and the ones a terminal would act on
 * survive as the picture of themselves.
 *
 * The glyph is `lib/view/display.ts`'s, which is this package's answer to the
 * question already and draws exactly this class — C0 as `U+2400` plus the
 * code, `DEL` as its own picture, and C1 as the substitute. A glyph is what a
 * message wants and an escape is what a value wants;
 * {@link escapeControlCharactersInJson} is the other of the pair and carries
 * why the two differ.
 *
 * The class is walked a character at a time rather than replaced through a
 * global expression, because a global one carries a `lastIndex` between calls
 * and {@link holdsControlCharacter} tests the same class.
 */
export function escapeControlCharacters(text: string): string {
  return [...text].map((character) =>
    holdsControlCharacter(character) ? glyphFor(character) : character
  ).join("");
}

/**
 * `json` with every character a terminal acts on written as the escape JSON
 * spells it with, except the line feed, which is left alone.
 *
 * Two surfaces escape this class and they use different conventions, which is
 * a decision rather than an oversight. A message is prose somebody reads, so
 * {@link escapeControlCharacters} shows each character as one glyph naming
 * it. A serialized value is text somebody may parse or paste back, so it stays
 * JSON: `\uXXXX` is what JSON already writes an escape with, and extending it
 * to the rest of the class leaves output that still parses and still reads
 * back as the same value.
 *
 * The line feed is exempt because of what it can be by then. `JSON.stringify`
 * escapes every C0 character that came out of a value, the line feed among
 * them, so one still standing raw in its output is the pretty printer's own
 * formatting. Escaping that would fold the whole value onto one line.
 */
export function escapeControlCharactersInJson(json: string): string {
  return [...json].map((character) =>
    character !== "\n" && holdsControlCharacter(character)
      ? `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
      : character
  ).join("");
}

/** The place a shuttle starts in: the space's root, read at the base scope. */
export function placeAtSpaceRoot(space: MemorySpace): Place {
  return { position: { kind: "root", space }, scope: "space" };
}

/**
 * The operand `cd` takes from `place` to the child of its position called
 * `child`, and nothing where no spelling it offers reaches that child.
 *
 * Inside a piece the child is a key, and the first spelling offered is the
 * shared renderer's against the place as a context: the bare path where the
 * reference grammar reads it as one, and the `.` head in front of a key the
 * grammar would otherwise read as a head — `./..` for a key called `..`, and
 * `./` for the empty key. Shuttle reads more of a bare operand than that
 * grammar does, so where one of its own readings takes the renderer's form —
 * `-` on its own, a `%n` head, a `#name` wish target — the same form with the
 * `.` head in front is offered next, and reads none of them. Above a piece the
 * child is a facet or a piece, and the two spellings are the name on its own
 * and the complete reference a piece renders as.
 *
 * An absent answer means no candidate reaches the child. Inside a piece the
 * reason is always the part itself, which no door admits — a key holding a
 * line break or a control character — since the `.` head reads every other
 * key literally.
 *
 * Each spelling is answered by making the move rather than by a second copy of
 * the readings, so what comes back is an operand `cd` took. The move is made
 * from a standing with no trail and no previous place, which bounds the answer
 * in one direction only: `-` is never offered, even where shuttle's own
 * history would make it reach the child, and what is offered reaches the child
 * whatever that history holds.
 *
 * One reading is asked rather than made, being one layer above a place: a
 * token opening with `-` reaches a verb as an option and never as an operand
 * (`readsAsOption`, `options.ts`), so a candidate the option grammar takes is
 * not offered and the next one is what names such a child.
 *
 * A move a read would confirm counts as reaching the child. What that read
 * decides is whether the fabric holds anything there, and a listing is asking
 * about a row it has just read: the question here is which spelling names the
 * row, not whether the row is one.
 */
export function operandForChild(
  place: Place,
  child: string,
): string | undefined {
  const position = childPosition(place.position, child);
  if (position === undefined) return undefined;
  const goal: Place = { ...place, position };
  const from: Standing = { place, trail: [] };
  for (const candidate of candidatesFor(place, goal, child)) {
    if (readsAsOption(candidate)) continue;
    const reach = reached(movePlace(from, candidate, MOVING_VERB).step);
    if (reach !== undefined && samePlace(reach.place, goal)) return candidate;
  }
  return undefined;
}

/**
 * Helper for {@link operandForChild}, which is the spellings tried for the
 * child of `place` standing at `goal`, in the order they are offered.
 */
function candidatesFor(
  place: Place,
  goal: Place,
  child: string,
): readonly string[] {
  const position = place.position;
  if (position.kind !== "piece" || goal.position.kind !== "piece") {
    return [child, renderPosition(goal)];
  }
  const rendered = renderCellReference(
    cellOf({ ...goal, position: goal.position }),
    {
      space: position.space,
      id: position.piece,
      scope: place.scope,
      path: position.path.map(String),
    },
  );
  return [rendered, `${RELATIVE_HEAD}/${rendered}`];
}

/**
 * The place's two dimensions, as the ambient record prints one (`record.ts`):
 * what `pwd` prints whole, and what `where` prints under the connection's.
 *
 * A leading `/` is what makes a string a reference, so it marks the one
 * position that is a cell. A piece therefore renders as a complete reference
 * with its scope written — the form that supplies every level, and so the one
 * that denotes the same cell read from anywhere — while a root and a facet are
 * containers and render without one, which is what keeps a container's own
 * rendering from resolving as a piece whose slug happens to match. What holds
 * of a rendering is one property and not a list: `cd` may refuse it, but it
 * never reads one as some other cell. A piece or segment holding a newline
 * would break the second half, by splitting the position line into a shorter
 * reference, which is why one is refused before it can reach a place rather
 * than handled here.
 *
 * The scope is written even when it is the base, which is what makes "read
 * from anywhere" true rather than nearly so. Scope is part of a cell's
 * identity, and an omitted qualifier is filled from wherever the reader
 * stands, so a rendering without one denotes whatever cell the reader's own
 * scope selects. Writing it absolutely and reading it ambiently is the
 * asymmetry a shell has between what `pwd` prints and what a relative path
 * means. The shared renderer writes it for this reason when it is handed the
 * empty context, which has no scope of its own to leave one to.
 */
function placeEntries(place: Place): readonly RecordEntry[] {
  return [
    { label: "position", value: renderPosition(place) },
    { label: "scope", value: renderScope(place.scope) },
  ];
}

/**
 * The one owner of a shuttle's place: it holds where shuttle stands, where it
 * stood before, and the levels it walked through to get there, moves between
 * them, answers where an operand points without going there, and refuses what
 * the design refuses.
 *
 * Per instance rather than per process, so that several places — tabs, split
 * views, an agent holding more than one — stay reachable.
 */
export class CurrentPlace {
  #here: Standing;
  #previous: Standing | undefined;

  /**
   * Constructs an instance standing at the root of `space`, with no previous
   * place.
   *
   * A space is all a shuttle has when it starts, and taking one rather than a
   * whole {@link Place} is what keeps {@link PiecePosition}'s invariant a
   * property of every door rather than of whoever remembered it. It is not a
   * property of the type: `Place` is a structural interface anyone can write
   * a literal for. What holds is narrower and is what matters — no door into
   * this module admits a position the invariant rules out. Restoring a saved
   * place is a named entry point with checking of its own, for whenever
   * something needs one.
   */
  constructor(space: MemorySpace) {
    this.#here = { place: placeAtSpaceRoot(space), trail: [] };
  }

  /** Where shuttle stands. */
  get place(): Place {
    return this.#here.place;
  }

  /** Where it stood before its last landed move, once there has been one. */
  get previous(): Place | undefined {
    return this.#previous?.place;
  }

  /**
   * Moves as `operand` says, and returns what that did. The place changes only
   * where the move lands, so a refusal and an unsettled operand both leave
   * shuttle where it was.
   *
   * An operand that reaches a piece comes back pending rather than landed,
   * because whether the fabric holds that place is what no value knows. What
   * `cd` promises is that the place it moved to is there, so the read that
   * says so has to happen before the move is adopted and not on the next
   * line; {@link CurrentPlace.confirm} is where it lands. A scope on its own
   * is such an operand: it reaches a place at a scope nothing read, the same
   * id under two scopes being two cells. What lands here is a move that
   * reaches a container, and one that returns to a place already stood at —
   * `..`, `-`, and `/` — nothing about either being a read's to decide.
   */
  cd(operand: string): Move {
    return this.#commit(
      movePlace(this.#here, operand, MOVING_VERB, this.#previous).step,
    );
  }

  /**
   * Where `operand` points and which of a piece's two cells it selects,
   * without going there, `verb` naming the verb whose line it was read from.
   *
   * It differs from {@link CurrentPlace.cd} in the two ways a read differs
   * from a move. Nothing moves, so shuttle stays where it stood whatever
   * comes back. And the `#argument` member is read rather than refused: a
   * place is result-rooted and cannot *stand* in an arguments cell, which is
   * why `cd` turns the member down in every spelling it is written in, but
   * reading one is a different act and the member is how an operand asks for
   * it.
   *
   * Everything else is `cd`'s reading exactly, asked from where shuttle
   * actually stands rather than from a standing built for the occasion. That
   * is what makes the two agree about `..`, which walks the trail shuttle
   * took and not the levels a position happens to name.
   *
   * There is a third way it differs and it follows from the first: nothing
   * comes back pending. A `cd` waits on a read because standing somewhere the
   * fabric does not hold is a promise the prompt would go on making; a read
   * aimed at such a cell fails on its own account, in the read's own words,
   * and there is nothing left for a check in front of it to add.
   */
  aim(operand: string, verb: string): Aim {
    if (operand === ARGUMENT_MEMBER) {
      return { input: false, move: pointing(refuse(MEMBER_NAMES_NO_PIECE)) };
    }
    const { step, input } = movePlace(
      this.#here,
      operand,
      verb,
      this.#previous,
    );
    return { input, move: pointing(step) };
  }

  /**
   * Moves into a target the fabric resolved, `operand` being the spelling that
   * named it. A target that resolved in another space is refused: one
   * connection serves one space.
   */
  enter(target: ResolvedTarget, operand: string): Move {
    return this.#commit(enterTarget(this.#here.place, target, operand));
  }

  /**
   * Settles a {@link SpaceNamedMove}, `confirmed` being the space its name
   * resolved to. A name that resolved to any space but the connected one is
   * refused here, so the comparison the reference deferred is made where the
   * place would be adopted rather than left to the caller. The place is built
   * from the connected space and the move's own piece, path and scope, which
   * is what carries a qualifier through a reference that named its space by
   * name.
   *
   * What comes back is a {@link PendingMove} rather than a landing: the place
   * it names stands on a piece, which is a place a read has still to confirm
   * like any other, so {@link CurrentPlace.confirm} is where it lands. The
   * name being settled and the place being settled are two questions, and this
   * answers the first.
   */
  settle(move: SpaceNamedMove, confirmed: MemorySpace): Move {
    return this.#commit(this.#settled(move, confirmed));
  }

  /**
   * Like {@link CurrentPlace.settle}, except that it moves nothing: what comes
   * back is where the settled move names, and shuttle stays where it stood.
   *
   * Nothing comes back pending, for {@link CurrentPlace.aim}'s reason: this is
   * the door a read goes through, and where a read points is not a thing
   * another read decides.
   */
  resolveNamedSpace(move: SpaceNamedMove, confirmed: MemorySpace): Aimed {
    return pointing(this.#settled(move, confirmed));
  }

  /**
   * Moves as a {@link HandleMove} says, `at` being the place the listing that
   * minted the handle was read at, `toward` the operand its row prints, and
   * `verb` the verb whose line the handle was written on.
   *
   * The row's operand is walked from the listing's place, and then the head's
   * member and scope and the literal path after it from wherever that
   * reached. The first is the walk a person could have typed: a handle is a
   * way of not retyping a row's operand rather than a second way of reaching
   * it, so a row naming a piece comes back pending here exactly as the typed
   * operand does, and is confirmed by the same read.
   *
   * The walk starts with no trail, as one from a reference does. A handle
   * carries no route: it was minted from a row of a listing, and a listing is
   * a view rather than a path shuttle took.
   */
  reach(move: HandleMove, at: Place, toward: string, verb: string): Move {
    return this.#commit(this.#reached(move, at, toward, verb).step);
  }

  /**
   * Like {@link CurrentPlace.reach}, except that it moves nothing: what comes
   * back is where the handle and the path after it point, and which of the
   * row's piece's two cells the head selects, and shuttle stays where it
   * stood.
   *
   * Nothing comes back pending, for {@link CurrentPlace.aim}'s reason.
   */
  resolveHandle(
    move: HandleMove,
    at: Place,
    toward: string,
    verb: string,
  ): Aim {
    const { step, input } = this.#reached(move, at, toward, verb);
    return { input, move: pointing(step) };
  }

  /**
   * Lands a {@link PendingMove} a read confirmed, `resolved` being what the
   * read resolved it to.
   *
   * The handle is what the place adopts and the operand's own spelling stays
   * beside it as the name, where the two differ — which is what makes the
   * prompt show a slug an index confirmed while every read goes to the piece
   * that index pointed at, and not to whichever piece it points at next.
   *
   * The route is landed with the same piece, not only the place on top of it.
   * A trail is made of positions `..` walks back through and `-` restores, so
   * every one of them is a place shuttle can stand at, and a position holding
   * an unresolved slug is one a later read would follow to wherever the index
   * points then. Resolving the destination alone would put the invariant one
   * level deep.
   *
   * The handle came from the fabric rather than from an operand, so it is held
   * to the rules a piece is held to at every other door: a name no rendering
   * would give back, and a name in neither vocabulary, are refused here as
   * they are on the way in. It is not held to being a handle, where
   * {@link CurrentPlace.enter} holds a target's piece to one, and the
   * difference is what each is handed. A target's piece comes out of a parse
   * of an address, a grammar that reads a slug as readily as a handle; this
   * one comes out of a resolution, whose answer is a piece's own id.
   */
  confirm(move: PendingMove, resolved: ResolvedPlace): Move {
    return this.#commit(confirmed(move, resolved));
  }

  /**
   * This place written short, for the prompt to carry: its position without
   * the space, and its scope after a space.
   *
   * The space is the one thing left out, and leaving it out costs nothing: one
   * connection serves one space, so the omitted part is the same on every line
   * of a run and `where` prints it. Nothing else is shortened — no id is cut
   * down to a prefix that would print exactly as a whole one, and no name is
   * shown that this process did not read — so what is here is what the place
   * holds. It is not an address for all that: the space is missing, a
   * container is written with the trailing separator that says it is one, and
   * the scope sits last rather than where a reference carries it.
   */
  label(): string {
    return labelForPlace(this.#here.place);
  }

  /**
   * The two dimensions of this place, for `where` to print under the ones the
   * connection contributes.
   */
  entries(): readonly RecordEntry[] {
    return placeEntries(this.#here.place);
  }

  /** What `pwd` prints for this place. */
  render(): string {
    return renderRecord(this.entries());
  }

  /**
   * Helper for the movers, which adopts a step that landed and reduces every
   * step to the outcome a caller sees. The trail is navigation history rather
   * than part of the place, so it stops here.
   */
  #commit(step: Step): Move {
    if (step.kind === "moved") {
      this.#previous = this.#here;
      this.#here = step.to;
    }
    return outcomeOf(step);
  }

  /**
   * Helper for {@link CurrentPlace.reach} and
   * {@link CurrentPlace.resolveHandle}, which is where `move` reaches once the
   * row it names is known.
   *
   * A row's operand that reached nowhere is the answer already, and is the
   * answer whether the walk after the handle is empty or not: nothing walks on
   * from a step that never arrived.
   *
   * No previous place goes into the walk to the row, so a row whose operand is
   * `-` reaches nothing rather than reaching wherever shuttle last stood. It
   * is not a row a listing mints — `operandForChild` never offers that word —
   * and refusing it here is what keeps that a property of this walk rather
   * than of what a listing happens to offer.
   *
   * The row counts as unread where its own walk came back pending, so what is
   * written after the handle cannot land a piece row nothing has confirmed.
   */
  #reached(
    move: HandleMove,
    at: Place,
    toward: string,
    verb: string,
  ): Walked {
    const row = movePlace({ place: at, trail: [] }, toward, verb);
    const from = reached(row.step);
    if (from === undefined) return row;
    if (
      move.member === undefined && move.scope === undefined &&
      move.path.length === 0
    ) {
      return row;
    }
    return walkFrom(
      from,
      {
        climbs: 0,
        path: [...move.path],
        member: move.member,
        scope: move.scope,
      },
      move.operand,
      verb,
      row.step.kind === "pending",
    );
  }

  /**
   * Helper for {@link CurrentPlace.settle} and
   * {@link CurrentPlace.resolveNamedSpace}, which is where `move` reaches once
   * `confirmed` is known. The comparison the reference deferred is made here
   * rather than left to the caller, so a name that resolved to any space but
   * the connected one is refused whichever of the two asked.
   *
   * What it reaches is a piece, so the step comes back pending: `settle` hands
   * that on for a read, and `resolveNamedSpace` reads it as where the operand
   * points, neither of which is a landing this makes.
   */
  #settled(move: SpaceNamedMove, confirmed: MemorySpace): Step {
    const connected = this.#here.place.position.space;
    if (confirmed !== connected) {
      return refuseOtherSpace(
        `\`${move.name}\` resolves to space \`${confirmed}\``,
        connected,
      );
    }
    const fault = unnameablePiece(move.piece) ??
      firstUnnameableSegment(move.path);
    if (fault !== undefined) {
      return refuse(
        `The reference naming space \`${move.name}\` has ${fault.what}, ` +
          `so ${fault.so}.`,
      );
    }
    const outside = outsideVocabulary(move.piece);
    if (outside !== undefined) return outside;
    return pend(
      {
        position: {
          kind: "piece",
          space: connected,
          piece: move.piece,
          // Normalized the way every other door normalizes, so that a
          // position names its cell the same however it was reached, which is
          // what {@link Position} promises. A move `cd` minted carries a path
          // the reference grammar already converted; one a caller built does
          // not, and this is a public door.
          path: move.path.map((segment) =>
            typeof segment === "number"
              ? segment
              : linkPathSegmentToCellPathSegment(segment)
          ),
        },
        scope: move.scope,
      },
      [],
      move.operand,
    );
  }
}

/** Where shuttle stands, and the trail it walked to get there. */
interface Standing {
  /** The place itself. */
  readonly place: Place;

  /** How shuttle reached it. */
  readonly trail: Trail;
}

/**
 * A move as the movers pass it around, a landing carrying its trail.
 *
 * A pending move carries one too, in the fields {@link PendingMove} declares,
 * so a walk composes a pending step with the steps around it the way it
 * composes a landed one.
 */
type Step =
  /** The move landed on `to`. */
  | { readonly kind: "moved"; readonly to: Standing }
  | Unlanded;

/**
 * A step, and whether the operand that made it selected the `#argument`
 * member.
 *
 * The selection travels beside the step rather than inside the place, because
 * a place holds none: a move that selected the member is refused before it
 * becomes one, and only a read carries the selection on to where it is used.
 */
interface Walked {
  /** What the operand did. */
  readonly step: Step;

  /** True where it selected the arguments cell; false for every refusal. */
  readonly input: boolean;
}

/** Helper for the movers, which is `step` with `input` beside it. */
function walked(step: Step, input = false): Walked {
  return { step, input: step.kind === "refused" ? false : input };
}

/** Helper for the movers, which is a refusal carrying `reason`. */
function refusing(reason: string): Walked {
  return walked(refuse(reason));
}

/**
 * Where `operand` moves `from` to, `verb` naming the verb whose line it was
 * read from and `previous` being the standing `-` returns to.
 *
 * The verb is carried for one sentence: an empty operand names no place, and
 * every verb aims through this reading, so the refusal for one names the verb
 * whose line it is reading rather than a verb of its own.
 *
 * The operand is read in the order the spellings can be told apart: `-` and
 * `/` are shuttle's own whole operands, a rooted string whose first segment
 * names a facet is a walk from the space root, any other string starting with
 * `/` is a reference for the fabric's grammar to parse, whichever level of it,
 * a leading `#` is a wish target, a leading `%` is a numbered handle, and
 * anything else is a relative reference, read by the shared reader and walked
 * from where shuttle stands.
 *
 * Each reading is matched against the operand as it was written, edges
 * included, so none of them reads a string that merely resembles the
 * spelling: `cd " -"` walks to the key `" -"` rather than returning to the
 * previous place. Whitespace reaches an edge only through a quote, the split
 * that produced the operand separating on it (`line.ts`), so it is a
 * character of the part it sits in and the part is held to the rule that part
 * answers to.
 */
function movePlace(
  from: Standing,
  operand: string,
  verb: string,
  previous?: Standing,
): Walked {
  const place = from.place;
  if (operand === "") {
    return refusing(
      `\`${verb}\` was given an empty operand, which names no place.`,
    );
  }
  if (operand === "-") {
    return previous === undefined
      ? refusing("There is no previous place to return to.")
      : walked(land(previous.place, previous.trail));
  }

  // A leading `/` roots a reference, and `/` alone roots one and names
  // nothing further: the space's own root, which the grammar has no id
  // segment to spell.
  const root: Standing = {
    place: {
      ...place,
      position: { kind: "root", space: place.position.space },
    },
    trail: [],
  };
  if (operand === "/") return walked(land(root.place, root.trail));

  // Before the parse, because the parse would read the facet name as a piece
  // and the walk is what the segment means. A rooted operand and a walk from
  // the root read the same literal keys here, so `/slugs/board` is what `cd
  // /` and `cd slugs/board` are together, down to the trail it leaves.
  const keys = rootedFacetWalk(operand);
  if (keys !== undefined) {
    return walkFrom(root, { climbs: 0, path: keys }, operand, verb, false);
  }

  const edged = rootedOnlyByTrim(operand);
  if (edged !== undefined) return walked(edged);

  let reference;
  try {
    reference = normalizeLLMFriendlyRef(operand, {
      space: place.position.space,
      scope: place.scope,
    });
  } catch (error) {
    return refusing(messageOf(error));
  }
  if (reference !== undefined) {
    return moveByReference(place, reference, operand, verb);
  }

  if (operand.startsWith("#")) {
    return walked({ kind: "wish", target: operand });
  }
  // At the head of a relative operand and nowhere else, as the other
  // spellings above are. A handle names a row of a listing, which is not a
  // level this module can walk to, so it comes back for the handle table the
  // way a wish target comes back for the connection. In any later segment `%`
  // is an ordinary character of a data key.
  if (operand.startsWith(HANDLE_SIGIL)) return readHandle(operand);

  let parts;
  try {
    parts = parseRelativeReference(operand);
  } catch (error) {
    return refusing(messageOf(error));
  }
  return walkFrom(from, parts, operand, verb, false);
}

/**
 * Helper for {@link movePlace}, which reads an operand opening with
 * {@link HANDLE_SIGIL} as the head it is.
 *
 * The handle runs to the first `#`, `@` or separator, and what follows it is
 * read as it would be after the `.` head — by the shared reader, with the
 * handle standing in for `.` — so a member, a qualifier and a literal path
 * mean after `%1` exactly what they mean after `.`, and a climb is never read
 * there: `%1/..` is the key `..` under the row.
 */
function readHandle(operand: string): Walked {
  const end = operand.search(/[#@/]/);
  const handle = end === -1 ? operand : operand.slice(0, end);
  let parts;
  try {
    parts = parseRelativeReference(
      RELATIVE_HEAD + (end === -1 ? "" : operand.slice(end)),
    );
  } catch (error) {
    return refusing(messageOf(error));
  }
  if (parts.pin !== undefined) return refusing(refusePin(operand));
  const scope = placeScope(parts.scope);
  return walked({
    kind: "handle",
    handle,
    ...(parts.member === undefined ? {} : { member: parts.member }),
    ...(scope === undefined ? {} : { scope }),
    path: parts.path,
    operand,
  });
}

/**
 * Helper for {@link movePlace}, which is the literal keys a rooted operand
 * walks from the space root where its first segment names a facet, and
 * nothing where it names none.
 *
 * A rooted operand has no head, so every segment after the leading `/` is read
 * literally and decoded: the facet, then a piece segment, then data keys. So
 * `/slugs/first/a/../b` is the piece `first` with the path `a`, `..`, `b`, the
 * place `cd slugs/first/a/../b` reaches from the root, and a rooted operand
 * never climbs.
 *
 * The rooted form only. A complete reference carries its own space and is the
 * canonical grammar's outright, so `//did:key:…/slugs/board` still names a
 * piece slugged `slugs` — which is what leaves such a piece reachable by name
 * at all while one can exist, the rooted spelling being the walk
 * ({@link FACETS} carries what that costs and what retires it).
 *
 * The operand is matched as it was written, as every reading here is, so an
 * operand that would be rooted only once trimmed is not one this reads.
 * {@link rootedOnlyByTrim} refuses that operand rather than letting it fall
 * to a reading of its own.
 */
function rootedFacetWalk(operand: string): string[] | undefined {
  if (!operand.startsWith("/")) return undefined;
  const walk = operand.slice(1);
  if (!isFacet(walk.split("/", 1)[0])) return undefined;
  // The `.` head in front reads nothing of the walk's own but its keys: the
  // first segment is a facet name, which no head reading could take.
  return parseRelativeReference(`${RELATIVE_HEAD}/${walk}`).path;
}

/**
 * Helper for {@link movePlace}, which refuses an operand that is rooted only
 * once its leading whitespace comes off, and returns nothing for any other.
 *
 * Such an operand has two readings that name different cells. Every reading
 * here matches the operand as written, so as written this one is a relative
 * walk whose first segment is whitespace; the reference grammar trims what it
 * is given (`isReference`, `packages/cli/lib/llm-friendly-ref.ts`), so to that
 * grammar it is rooted. Left to fall through, the rooted reading takes it —
 * and the facet names a rooted spelling reserves ({@link FACETS}) are not
 * reserved in that one, so `cd " /slugs/todo"` would reach a piece slugged
 * `slugs`. Reaching it is not the point; reaching it *silently* is. A wrong
 * place a `cd` adopts is a promise the prompt goes on making, which is what
 * decision 11 ends, and a refusal cannot make it.
 *
 * The rule is exactly as wide as that and no wider. Leading whitespace costs a
 * name nothing anywhere else — `cd " foo"` reaches the key `" foo"` — so only
 * an operand that trimming would *root* is refused, and an operand trimming
 * leaves relative is read as it is written.
 *
 * The trim here is a test and never a strip, which is the distinction a search
 * for one in this module wants: no reading consumes what it produces. An
 * operand this returns nothing for goes on to every later reading as it was
 * written, and the trimmed spelling leaves only inside the refusal, as the
 * thing to type instead.
 */
function rootedOnlyByTrim(operand: string): Step | undefined {
  const trimmed = operand.trim();
  if (operand.startsWith("/") || !trimmed.startsWith("/")) return undefined;
  return refuse(
    `\`${operand}\` is rooted only with its leading whitespace taken off, ` +
      `and the two readings name different cells. \`${trimmed}\` is the one ` +
      `that reaches the place it names.`,
  );
}

/**
 * Helper for the movers, which is the scope a head or a piece segment moves a
 * place to, and nothing where it leaves the place's own.
 *
 * `@inherit` is the context's scope, and the context a place reads an operand
 * against is the place, so it moves nothing.
 */
function placeScope(scope: LinkScope | undefined): CellScope | undefined {
  return scope === undefined || scope === "inherit" ? undefined : scope;
}

/**
 * Where a parsed reference moves `place` to.
 *
 * A rooted reference fixes the piece and the path and takes both its space
 * and its scope from the place; a `//did:key:…/` prefix supplies the space, an
 * `@scope` qualifier the scope, and an `#argument` member which of the piece's
 * two cells the path is in. The place is the reader's context, so `@inherit`
 * is the place's scope. A `@pin=` is refused, a place holding no pin. The
 * parse refuses a space whose DID differs from the place's, and hands one
 * written as a name back for a session to settle, since deriving a DID from a
 * name needs one.
 */
function moveByReference(
  place: Place,
  reference: NormalizedLLMFriendlyRef,
  operand: string,
  verb: string,
): Walked {
  if (reference.pin !== undefined) return refusing(refusePin(operand));
  const input = reference.input === true;
  if (input && verb === MOVING_VERB) return walked(refuseArgumentMember());
  const badPiece = unnameablePiece(reference.pieceId);
  if (badPiece !== undefined) {
    return walked(refuseUnnameable(operand, badPiece));
  }
  const badSegment = firstUnnameableSegment(reference.path);
  if (badSegment !== undefined) {
    return walked(refuseUnnameable(operand, badSegment));
  }
  const scope = reference.scope ?? place.scope;
  if (reference.embeddedSpace !== undefined) {
    return walked({
      kind: "space-by-name",
      name: reference.embeddedSpace,
      operand,
      piece: reference.pieceId,
      path: reference.path,
      scope,
    }, input);
  }
  return walked(
    pend(
      {
        position: {
          kind: "piece",
          space: place.position.space,
          piece: reference.pieceId,
          path: reference.path,
        },
        scope,
      },
      [],
      operand,
    ),
    input,
  );
}

/**
 * Where a relative head and the literal path after it move `from` to, `parts`
 * being what the shared reader read of the operand, or what a rooted walk and
 * a handle stand in for it.
 *
 * The head is applied first. Its climbs are taken one at a time through the
 * trail, so a climb leaves a piece for the facet or the root it was reached
 * through. Its member is the `#argument` member or the default: selecting the
 * arguments cell reads the path from that cell's root rather than from where
 * the head stood, so it has nothing for a climb to leave and a head that
 * climbs and selects it is refused, and a move is refused it outright, a place
 * being result-rooted. Its scope moves the place's, `@inherit` leaving it
 * where it was, and a `@pin=` is refused, a place holding no pin.
 *
 * The path is then descended one decoded key at a time, each read against the
 * level the one before it reached: at the root a key names a facet, in a facet
 * a piece segment, and inside a piece a data key. Above a piece there are no
 * keys, so a final empty key where the walk stands at the root or a facet is
 * the separator that ended the operand and names nothing, while an empty key
 * anywhere else above a piece is refused by the level it reaches.
 *
 * `operand` is what was written, which a refusal quotes.
 *
 * The walk is one move and comes back pending once, not per key: a descent
 * into or inside a piece is a level nothing has read, and so is a piece at a
 * scope the head moved to, so the whole walk waits on the read the last of
 * them needs. A walk that climbed out of a piece and descended nowhere has no
 * piece left to ask about, and lands. `unread` says the walk starts at a level
 * nothing has read, which a handle's row can be; otherwise a walk that ends
 * exactly where it started reaches a place already stood at, settled when
 * shuttle arrived there, and lands.
 */
function walkFrom(
  from: Standing,
  parts: RelativeReferenceParts,
  operand: string,
  verb: string,
  unread: boolean,
): Walked {
  if (parts.pin !== undefined) return refusing(refusePin(operand));
  const selects = parts.member === "argument";
  if (selects && parts.climbs > 0) {
    return refusing(refuseClimbWithMember(operand));
  }

  let moved = from;
  for (let climb = 0; climb < parts.climbs; climb++) moved = moveUp(moved);

  if (selects) {
    const position = moved.place.position;
    if (position.kind !== "piece") {
      return refusing(refuseMemberOfContainer(operand));
    }
    if (verb === MOVING_VERB) return walked(refuseArgumentMember());
    moved = {
      place: { ...moved.place, position: { ...position, path: [] } },
      trail: moved.trail,
    };
  }

  const scope = placeScope(parts.scope);
  let descended = unread ||
    (scope !== undefined && scope !== moved.place.scope);
  if (scope !== undefined) {
    moved = { place: { ...moved.place, scope }, trail: moved.trail };
  }

  let input = selects;
  for (const [index, key] of parts.path.entries()) {
    if (
      key === "" && index === parts.path.length - 1 &&
      moved.place.position.kind !== "piece"
    ) {
      break;
    }
    // No fault check here: which rule a key answers to depends on what it is
    // about to become, and only `moveDown` knows that. A key naming a piece is
    // held to the piece rules and told the piece's reason, which is not the
    // reason a data key gets.
    const next = moveDown(moved, key, operand, verb);
    const reach = reached(next.step);
    if (reach === undefined) return next;
    moved = reach;
    input ||= next.input;
    descended ||= next.step.kind === "pending";
  }
  const position = moved.place.position;
  return walked(
    descended && position.kind === "piece" &&
      (unread || !samePlace(moved.place, from.place))
      ? pend({ ...moved.place, position }, moved.trail, operand)
      : land(moved.place, moved.trail),
    input,
  );
}

/**
 * Where one climb moves `from` to: back out through the trail where there is
 * one, and out of the level it stands in where the trail is empty, which is
 * how a position a reference named outright backs out.
 */
function moveUp(from: Standing): Standing {
  const top = from.trail.at(-1);
  return top === undefined
    ? {
      place: { ...from.place, position: enclosing(from.place.position) },
      trail: [],
    }
    : {
      place: { ...from.place, position: top },
      trail: from.trail.slice(0, -1),
    };
}

/**
 * Helper for {@link moveUp}, which is the level `position` sits inside: the
 * path one segment shorter where the position is one, and the space root
 * otherwise, since a facet and a piece alike sit directly inside it.
 */
function enclosing(position: Position): Position {
  return position.kind === "piece" && position.path.length > 0
    ? { ...position, path: position.path.slice(0, -1) }
    : { kind: "root", space: position.space };
}

/**
 * Where one decoded key moves `from` to: a facet at a space root, a piece
 * inside a facet, and a data key or index inside a piece. A descent pushes the
 * level it left onto the trail, which is what a head's climbs walk back out.
 *
 * A facet is a closed set and lands; the other two reach the fabric and come
 * back pending, a piece having still to resolve and a key having still to be
 * found.
 */
function moveDown(
  from: Standing,
  key: string,
  operand: string,
  verb: string,
): Walked {
  const place = from.place;
  const position = place.position;
  const trail = [...from.trail, position];
  switch (position.kind) {
    case "root":
      return isFacet(key)
        ? walked(land({
          ...place,
          position: { kind: "facet", space: position.space, facet: key },
        }, trail))
        : refusing(
          `A space root lists facets, and \`${key}\` names none. The ` +
            `facets are \`slugs/\` and \`pieces/\`.` +
            scopeMoveHint(operand),
        );
    case "facet":
      return moveIntoPiece(place, position, key, trail, operand, verb);
    case "piece": {
      const fault = unnameableSegment(key);
      if (fault !== undefined) return walked(refuseUnnameable(operand, fault));
      return walked(pend(
        {
          ...place,
          position: {
            ...position,
            path: [...position.path, linkPathSegmentToCellPathSegment(key)],
          },
        },
        trail,
        operand,
      ));
    }
  }
}

/**
 * Where a key naming a piece inside `facet` moves `place` to.
 *
 * The key is a piece segment, so it is read by the shared reader's piece
 * segment reading and not as data: an `#argument` member and qualifiers ride
 * it as they ride the piece segment of a reference. The key arrives decoded,
 * and is encoded again for that reading, which decodes the id itself — so an
 * escape in the operand is read once.
 *
 * The member is the `#argument` member or the default, and selecting it is
 * refused for a move for the reason a reference is refused one: a place is
 * result-rooted, which holds however the member is written. A read carries
 * the selection on. The scope moves the place's, `@inherit` leaving it where
 * it was, and a `@pin=` is refused, a place holding no pin. Every other
 * refusal is the reader's, relayed as it gave it.
 */
function moveIntoPiece(
  place: Place,
  facet: FacetPosition,
  key: string,
  trail: Trail,
  operand: string,
  verb: string,
): Walked {
  if (key.startsWith("@")) {
    return refusing(
      `\`${key}\` names no piece. A qualifier rides a piece id, and a ` +
        `facet holds pieces rather than keys.` + scopeMoveHint(operand),
    );
  }
  const empty = unnameablePiece(key);
  if (key === "" && empty !== undefined) {
    return walked(refuseUnnameable(operand, empty));
  }
  let segment;
  try {
    segment = parsePieceSegment(encodeJsonPointer([key]));
  } catch (error) {
    return refusing(messageOf(error));
  }
  if (segment.pin !== undefined) return refusing(refusePin(operand));
  const fault = unnameablePiece(segment.id);
  if (fault !== undefined) return walked(refuseUnnameable(operand, fault));
  const outside = outsideVocabulary(segment.id);
  if (outside !== undefined) return walked(outside);
  const selects = segment.member === "argument";
  if (selects && verb === MOVING_VERB) return walked(refuseArgumentMember());
  return walked(
    pend(
      {
        position: {
          kind: "piece",
          space: facet.space,
          piece: segment.id,
          path: [],
        },
        scope: placeScope(segment.scope) ?? place.scope,
      },
      trail,
      operand,
    ),
    selects,
  );
}

/**
 * Where a resolved target moves `place` to, `operand` being the spelling that
 * named it. A target that resolved in another space — which is what a
 * home-anchored entry point does whenever the reading identity's home space
 * is not the connected one — is refused: one connection serves one space.
 *
 * The path is normalized the way a reference's and a relative walk's are, so
 * that a position names its cell the same however it was reached, which is
 * what {@link Position} promises.
 *
 * It lands rather than coming back for a read, alone among the doors that
 * reach a piece: the fabric resolved this target, so the piece and the path
 * are what a read would have gone and asked it. A piece named by slug is
 * refused for the same reason — a place holds the handle a name resolved to,
 * and an address the fabric wrote carries one — which is what keeps that
 * true of a position reached this way as well as of one `confirm` landed.
 */
function enterTarget(
  place: Place,
  target: ResolvedTarget,
  operand: string,
): Step {
  if (target.space !== place.position.space) {
    return refuseOtherSpace(
      `\`${operand}\` resolves in space \`${target.space}\``,
      place.position.space,
    );
  }
  const badPiece = unnameablePiece(target.piece);
  if (badPiece !== undefined) {
    return refuse(
      `\`${operand}\` resolves to ${badPiece.what}, so ${badPiece.so}.`,
    );
  }
  const badSegment = firstUnnameableSegment(target.path ?? []);
  if (badSegment !== undefined) {
    return refuse(
      `\`${operand}\` resolves to a path with ${badSegment.what}, so ` +
        `${badSegment.so}.`,
    );
  }
  const outside = outsideVocabulary(target.piece);
  if (outside !== undefined) return outside;
  if (isSlugAddress(target.piece)) {
    return refuse(
      `\`${operand}\` resolves to slug \`${target.piece}\`, and a place holds ` +
        `the handle a name resolved to. An address the fabric wrote names ` +
        `its piece by handle.`,
    );
  }
  return land({
    ...place,
    position: {
      kind: "piece",
      space: target.space,
      piece: target.piece,
      path: target.path?.map(linkPathSegmentToCellPathSegment) ?? [],
    },
  }, []);
}

/** Whether `segment` names one of the facets a space root lists. */
function isFacet(segment: string): segment is Facet {
  return (FACETS as readonly string[]).includes(segment);
}

/**
 * Helper for {@link operandForChild}, which is the position one level inside
 * `position` called `child`, and nothing where that level has no child of
 * that name.
 *
 * A root's children are its facets and are a closed set, so a name outside it
 * denotes nothing. A facet's and a piece's are whatever the space holds, so
 * this builds the position and leaves whether an operand reaches it to the
 * move that tries one.
 */
function childPosition(
  position: Position,
  child: string,
): Position | undefined {
  switch (position.kind) {
    case "root":
      return isFacet(child)
        ? { kind: "facet", space: position.space, facet: child }
        : undefined;
    case "facet":
      return { kind: "piece", space: position.space, piece: child, path: [] };
    case "piece":
      return {
        ...position,
        path: [...position.path, linkPathSegmentToCellPathSegment(child)],
      };
  }
}

/**
 * Helper for {@link operandForChild}, which is whether two places are the same
 * place: both halves of the pair, since a scope is half of what a place is and
 * two scopes select two cells at one position.
 */
function samePlace(one: Place, other: Place): boolean {
  return one.scope === other.scope &&
    samePosition(one.position, other.position);
}

/**
 * Helper for {@link samePlace}, which is whether two positions of one space
 * are the same cell. It is {@link Position}'s own promise read as a
 * comparison: the levels a position names and nothing about how either was
 * reached.
 *
 * The space is not among the levels it compares. One connection fixes the
 * space for a shuttle's whole run and every door refuses a position outside
 * it, so the pair this is handed carries one space and a comparison of it
 * could only ever hold.
 *
 * The name is not among them either, and for the opposite reason: it is not a
 * level. A piece reached by slug and the same piece reached by handle are one
 * cell, which is exactly what resolving the piece before adopting it is for.
 */
function samePosition(one: Position, other: Position): boolean {
  switch (one.kind) {
    case "root":
      return other.kind === "root";
    case "facet":
      return other.kind === "facet" && one.facet === other.facet;
    case "piece":
      return other.kind === "piece" && one.piece === other.piece &&
        one.path.length === other.path.length &&
        one.path.every((segment, index) => segment === other.path[index]);
  }
}

/**
 * The head of a relative reference that climbs nothing: the context's own
 * cell, which the shared reader reads a member and a qualifier on.
 *
 * This module writes it and never reads it — the reader does that — in two
 * places: in front of a key a bare path would not reach, and in front of what
 * follows a handle, which is read as what follows this head is.
 *
 * It is exported because a verb writes it too. `where scope <value>` sets the
 * scope by moving the place the way `cd` moves it, which means composing the
 * operand that carries a qualifier and no walk, and one spelling of the head
 * is what keeps that operand the same operand a person types.
 */
export const RELATIVE_HEAD = ".";

/**
 * The character a numbered handle opens with, which a listing prints in front
 * of a row and an operand writes to name that row back.
 *
 * It heads an operand and nothing else. A key called `%3` is reached by a
 * later segment of a walk, and by a reference outright.
 *
 * The grammar owns it rather than the listing that prints it, because what a
 * character means in an operand is decided here for every other spelling too.
 * A listing mints what this reads (`handleFor`, `listing.ts`) and a table
 * resolves it (`handles.ts`), so the three agree by reading one constant
 * rather than by three authors spelling one character the same way.
 */
export const HANDLE_SIGIL = "%";

/**
 * The sentence a refusal adds where `operand` is a scope word written with no
 * head, and nothing for every other operand.
 *
 * It is a hint on a refusal rather than a reading of its own, and the
 * difference is the point: `@session` is an ordinary key name, so a place that
 * holds one reaches it and never sees this. What the hint answers is the
 * operand that named no key *and* looks like an attempt at the scope.
 */
export function scopeMoveHint(operand: string): string {
  return isScopeWord(operand)
    ? ` \`${RELATIVE_HEAD}${operand}\` is what moves the scope.`
    : "";
}

/**
 * Whether `operand` is a scope word and nothing else: the sigil, and one of
 * the scopes the runtime knows, with no path after it.
 *
 * It is the whole of what a setter for the scope may take. Composing an
 * operand out of anything wider would hand the caller the navigation grammar
 * under a name that says it sets one dimension — `where scope /pieces` would
 * move the position — so the check is here beside the words rather than at
 * each caller.
 */
export function isScopeWord(operand: string): boolean {
  return operand.startsWith("@") && CELL_SCOPE_VALUES.has(operand.slice(1));
}

/** The scope words, in the spelling an operand and the record both write. */
export const SCOPE_WORDS: readonly string[] = [...CELL_SCOPE_VALUES]
  .map((scope) => `@${scope}`);

/**
 * The member an operand writes to select a piece's arguments cell, which is
 * the selection `--input` spells as a flag.
 *
 * Exported because it is written as well as read: a verb that says where a
 * write landed and a watch that names the cell it watches each spell the
 * selection back, and one string is what keeps the spelling a person types
 * and the spelling they are shown the same one.
 */
export const ARGUMENT_MEMBER = "#argument";

/**
 * The spellings a refusal about the member teaches, each one a read the
 * grammar takes: the member on the `.` head, and on a piece segment.
 */
export const MEMBER_SPELLINGS = "`get .#argument/title` or " +
  "`get /slugs/board#argument/title`";

/**
 * The verb whose operand this module reads to stand somewhere rather than to
 * point at something, which is what decides that selecting the arguments cell
 * is refused rather than carried: only a move can be wrong about what a place
 * may be.
 */
const MOVING_VERB = "cd";

/**
 * The reason {@link ARGUMENT_MEMBER} written as a whole operand is refused.
 * The member is read on a head or a piece segment, and on its own it has
 * neither, so what it wants is the piece it selects the arguments cell of.
 */
const MEMBER_NAMES_NO_PIECE = `\`${ARGUMENT_MEMBER}\` on its own names no ` +
  `piece to select the arguments cell of. The member goes on a head or a ` +
  `piece segment, as in ${MEMBER_SPELLINGS}.`;

/**
 * Helper for the movers, which refuses a move that selected the `#argument`
 * member, in every spelling the member is written in.
 *
 * A place is result-rooted, and one rooted at the arguments cell would leave
 * every later relative read ambiguous about which side of the piece it
 * addressed (`docs/plans/shuttle/grammar.md`). That reason is about what a
 * place may be, so it holds wherever the member sits in the operand, and a
 * read, which stands nowhere, is not refused it.
 */
function refuseArgumentMember(): Step {
  return refuse(
    "A place is result-rooted, so `cd` selects no `#argument` member. A " +
      "place rooted at the arguments cell would leave every later relative " +
      "read ambiguous about which side of the piece it addressed. Reach " +
      `arguments per operand instead, as in ${MEMBER_SPELLINGS}.`,
  );
}

/**
 * Helper for the movers, which is the reason a head that climbs and selects
 * the `#argument` member in one is refused.
 *
 * Selecting the member reads the path from the arguments cell's root, so the
 * position the climbs would have left is not one the reading keeps, and the
 * shared reader refuses the same head for the same reason.
 */
function refuseClimbWithMember(operand: string): string {
  return `\`${operand}\` climbs and selects the \`${ARGUMENT_MEMBER}\` ` +
    `member in one head. The member reads the path from the arguments ` +
    `cell's root, so there is no level for a climb to leave: ` +
    `\`.${ARGUMENT_MEMBER}\` is the head that selects it.`;
}

/**
 * Helper for the movers, which is the reason the `#argument` member is refused
 * on a head standing at a space root or a facet, which hold no arguments cell.
 */
function refuseMemberOfContainer(operand: string): string {
  return `\`${operand}\` selects the \`${ARGUMENT_MEMBER}\` member where ` +
    `no piece stands: a space root and a facet are lists of what stands ` +
    `inside them. Name the piece the member is on, as in ` +
    `\`get /slugs/board#argument/title\`.`;
}

/**
 * Helper for the movers, which is the reason an operand carrying a `@pin=`
 * qualifier on a head or a piece segment is refused.
 *
 * A place holds no pin, and a read shuttle makes is of the piece as it runs,
 * so a pin would be dropped without a word, which is what a refusal is for.
 */
function refusePin(operand: string): string {
  return `\`${operand}\` carries a \`@pin=\` qualifier, and shuttle reads a ` +
    `piece as it runs rather than at a pinned version. Write the operand ` +
    `without the qualifier.`;
}

/**
 * Helper for the movers, which refuses something that named a space other
 * than `connected`. `clause` says what named it and which space it named; the
 * rest is the same fact whichever route reached it, so it is written once.
 */
function refuseOtherSpace(clause: string, connected: MemorySpace): Step {
  return refuse(
    `${clause}, and this shuttle is connected to \`${connected}\`. One ` +
      `connection serves one space, so reaching that cell means a shuttle ` +
      `started against that space.`,
  );
}

/**
 * What is wrong with one part of a place, and why that is refused. The two
 * reasons are not interchangeable and a message is built from both, so a part
 * carries the one that actually applies to it.
 */
interface Fault {
  /** The part and its flaw, as a noun phrase. */
  readonly what: string;

  /** Why it is refused, as a clause completing "so". */
  readonly so: string;
}

/**
 * The reason a part whose rendering would denote some other cell is
 * refused.
 */
const NAMES_ANOTHER = "a rendering of the place would name a different cell";

/**
 * The reason a piece the fabric could not have produced is refused. It holds
 * of every rule that uses it; the mechanism behind it turns on the piece's
 * shape rather than on which rule caught it.
 *
 * For a handle-shaped piece — a colon, and twenty characters — `isPieceHandle`
 * is a length rule rather than an alphabet one, so the parse accepts a
 * "handle" the `fid1` encoding cannot make and hands it back verbatim: a
 * rendering that round-trips exactly and denotes nothing, neither a wrong
 * address nor a dead one, so the reason it is refused cannot be either. An
 * empty piece and a slug-shaped one the parse refuses on its own account, and
 * this door reaches them first.
 */
const NO_SUCH_NAME = "no piece carries that name: a slug is lowercase " +
  "letters, numbers, and single hyphens between words, and a handle is " +
  "`of:fid1:` and unpadded base64url";

/**
 * The reason a part a terminal would act on rather than print is refused.
 *
 * Every surface a place is written into today is read on a terminal — the
 * prompt carrying it, the listing offering it, the rendering `pwd` prints —
 * and a terminal reads these characters as instructions rather than as text.
 * One moves the cursor, one opens a sequence that colors or clears what
 * follows. So the screen stops saying what the fabric holds, and a name read
 * off it is not the name that was printed.
 *
 * This is the one refusal here that turns on where a rendering is read. The
 * others turn on what one reads back as, which is a fact about addresses and
 * holds of any destination; that difference is what a second destination
 * would make matter (`docs/plans/shuttle/build-sequence.md`, B4).
 */
const ACTS_ON_A_TERMINAL = "a terminal would act on it rather than print it";

/**
 * The characters a terminal acts on: Unicode's `Cc` category, which is C0
 * (`U+0000`–`U+001F`), `DEL`, and C1 (`U+0080`–`U+009F`).
 *
 * The category is the rule rather than a list of the ones anybody has seen
 * misbehave, because what makes them one class is what a terminal does with
 * them and not which of them a person has met. C1 is in it for a reason worth
 * naming: `U+009B` is the single-character form of the sequence introducer,
 * so a name holding one opens a sequence with no escape in front of it.
 *
 * What is not here is as decided as what is. `U+00A0` prints as a space and
 * instructs nothing. `U+2028` and `U+2029` separate lines for a reader of text
 * rather than for a terminal, and the printer quotes both, being whitespace to
 * the split. Refusing either would take a name away for no harm.
 */
const ACTED_ON = /\p{Cc}/u;

/**
 * Helper for the movers, which names what stops a rendering of a path holding
 * `segment` from naming that path back, and returns nothing when nothing
 * does.
 *
 * Writing a rendering separates its lines with a newline, so a segment
 * holding one splits the position line and leaves a shorter reference naming
 * another cell. Reading one back loses nothing a key holds: the reference
 * reader keeps an empty key and a key ending in whitespace, and a rendering
 * escapes the separator and the escape, so every other key is admitted.
 *
 * A control character survives the round trip and is refused all the same,
 * for a reason the round trip cannot see ({@link ACTS_ON_A_TERMINAL}): a
 * rendering is read on a terminal, where these are instructions rather than
 * text. That is what divides the line break's refusal from this one — that one
 * holds of a rendering wherever it goes, since a reference that reads back as
 * another cell does that in a file as readily as on a screen, and this one is
 * about the screen. That the reference reads back whole is what makes them
 * dangerous rather than what excuses them — the screen no longer shows the
 * name, so what a person copies off it is what the terminal did.
 */
function unnameableSegment(segment: PathSegment): Fault | undefined {
  if (typeof segment !== "number") {
    if (segment.includes("\n")) {
      return { what: "a segment holding a line break", so: NAMES_ANOTHER };
    }
    if (holdsControlCharacter(segment)) {
      return {
        what: "a segment holding a control character",
        so: ACTS_ON_A_TERMINAL,
      };
    }
    return undefined;
  }
  // A number renders as its digits, and only a canonical array index reads
  // back as the number it was: `1e21`, `-1` and `1.5` all print as something
  // the conversion leaves a string. The canonical rule decides, rather than a
  // second copy of it here.
  return linkPathSegmentToCellPathSegment(String(segment)) === segment
    ? undefined
    : { what: "a segment that is no canonical index", so: NAMES_ANOTHER };
}

/**
 * The characters the reference grammar reads inside a piece segment: the `@`
 * a qualifier rides on and the `#` a member does (`parsePieceSegment`).
 * Neither vocabulary holds one — a slug is lowercase letters, numbers and
 * hyphens, and a handle is base64url — but `isPieceHandle` is a length rule
 * rather than an alphabet one, so a long enough piece carries either past the
 * vocabulary check at a door that reads no piece segment: a resolved target,
 * a settled move, and a confirmed resolution.
 *
 * The separator and the escape are deliberately not here. A rendering escapes
 * both, `/` becoming `~1` and `~` becoming `~0`, so a piece holding one is
 * read back whole; refusing it would be an alphabet this module does not own,
 * against a canonical check that owns one and declines to apply it.
 */
const READ_INSIDE_AN_ID = ["@", "#"];

/**
 * Helper for the movers, which names what stops a piece from being one a place
 * may stand on, and returns nothing when nothing does.
 *
 * Of what a rendering loses, only the newline costs a piece its name, by
 * splitting the position line. An empty piece renders as a piece segment with
 * no id in it, which the reader refuses whole rather than reading back as
 * anything.
 *
 * The rules that are not the newline answer to {@link NO_SUCH_NAME} instead,
 * which is a weaker claim than the segment rules make and the honest one.
 * {@link outsideVocabulary} runs after this door and refuses an empty piece
 * and every colon-less name that is no slug on its own account. What this door
 * adds is the handle-shaped piece: `isPieceHandle` is a length rule, so a
 * trailing space and either of {@link READ_INSIDE_AN_ID} ride past it and are
 * refused here, and so does a control character, which no vocabulary holds
 * either: no slug carries one and base64url has none. Other characters no
 * vocabulary holds ride past it too — a `.` or an escaped separator — and are
 * admitted, their renderings reading back whole; what is refused here is what
 * a rendering would lose, what a reading would take, and what no name the
 * fabric made could have held.
 */
function unnameablePiece(piece: string): Fault | undefined {
  if (piece.includes("\n")) {
    return { what: "a piece holding a line break", so: NAMES_ANOTHER };
  }
  if (piece === "") return { what: "an empty piece", so: NO_SUCH_NAME };
  if (piece !== piece.trimEnd()) {
    return { what: "a piece ending in whitespace", so: NO_SUCH_NAME };
  }
  for (const character of READ_INSIDE_AN_ID) {
    if (piece.includes(character)) {
      return { what: `a piece holding \`${character}\``, so: NO_SUCH_NAME };
    }
  }
  if (holdsControlCharacter(piece)) {
    return { what: "a piece holding a control character", so: NO_SUCH_NAME };
  }
  return undefined;
}

/** Helper for the movers, which is the first fault in `path`, if it has one. */
function firstUnnameableSegment(
  path: readonly PathSegment[],
): Fault | undefined {
  for (const segment of path) {
    const fault = unnameableSegment(segment);
    if (fault !== undefined) return fault;
  }
  return undefined;
}

/**
 * Helper for the movers, which refuses `operand` for a part no rendering
 * names back, `fault` saying which part and why.
 */
function refuseUnnameable(operand: string, fault: Fault): Step {
  return refuse(`\`${operand}\` has ${fault.what}, so ${fault.so}.`);
}

/**
 * Helper for the movers, which refuses `piece` where it is in neither
 * vocabulary a piece is named by, and returns nothing where it is in one of
 * them. Every door runs it after its own rendering rules, so a part no
 * rendering names back is reported as that rather than as a name outside a
 * vocabulary.
 *
 * The rule is `validatePieceSegment`'s
 * (`packages/cli/lib/llm-friendly-ref.ts`), called rather than copied, so that
 * a piece is held to the same two vocabularies whichever door admits it and
 * one name gets one reason whichever door refused it. Its sentence reaches the
 * reader unaltered.
 */
function outsideVocabulary(piece: string): Step | undefined {
  try {
    validatePieceSegment(piece);
  } catch (error) {
    return refuse(messageOf(error));
  }
  return undefined;
}

/** Helper for the movers, which builds a refusal carrying `reason`. */
function refuse(reason: string): Step {
  return { kind: "refused", reason };
}

/** Helper for the movers, which builds a step landing on `place`. */
function land(place: Place, trail: Trail): Step {
  return { kind: "moved", to: { place, trail } };
}

/**
 * Helper for the movers, which builds a step that reached `place` and waits on
 * the read that says the fabric holds it, `operand` being what named it.
 */
function pend(place: PiecePlace, trail: Trail, operand: string): Step {
  return { kind: "pending", place, operand, route: trail };
}

/**
 * Helper for the movers, which is where `step` reached, and nothing where it
 * reached nowhere. A step that landed and one waiting on a read have both
 * reached somewhere; what divides them is whether anything may yet turn them
 * down.
 */
function reached(step: Step): Standing | undefined {
  switch (step.kind) {
    case "moved":
      return step.to;
    case "pending":
      return { place: step.place, trail: step.route };
    default:
      return undefined;
  }
}

/**
 * Helper for the movers, which is what a caller sees of `step`. The trail is
 * navigation history rather than part of a place, so it stops here whether or
 * not the step was adopted.
 */
function outcomeOf(step: Step): Move {
  return step.kind === "moved" ? { kind: "moved", place: step.to.place } : step;
}

/**
 * Helper for the doors that say where an operand points rather than going
 * there, which is what a caller of one sees of `step`.
 *
 * It is {@link outcomeOf} with the one difference those doors have: a step
 * waiting on a read has already said where the operand points, so it comes
 * back as the answer it is rather than as a question for the caller to
 * settle.
 */
function pointing(step: Step): Aimed {
  if (step.kind === "pending") return { kind: "moved", place: step.place };
  return step.kind === "moved" ? { kind: "moved", place: step.to.place } : step;
}

/**
 * Helper for {@link CurrentPlace.confirm}, which is where `move` lands once
 * `piece` is known: the handle in the position, and the operand's own
 * spelling beside it as the name where the two differ.
 *
 * The two differ exactly when the operand named the piece by slug, a handle
 * resolving to itself. So the name is a name a read confirmed and never one
 * this made up, and there is no vocabulary test here for a rule the
 * resolution already answered.
 */
function confirmed(move: PendingMove, resolved: ResolvedPlace): Step {
  const fault = unnameablePiece(resolved.piece) ??
    firstUnnameableSegment(resolved.path);
  if (fault !== undefined) {
    return refuse(
      `\`${move.operand}\` resolves to ${fault.what}, so ${fault.so}.`,
    );
  }
  const outside = outsideVocabulary(resolved.piece);
  if (outside !== undefined) return outside;
  const spelled = move.place.position.piece;
  // A resolution that spent path segments walked through something else to
  // find the piece — a slug naming a collection reaching its member — so the
  // operand's own name is not this piece's name, and the levels the walk
  // recorded are the way into the collection rather than into what it held.
  // A move that carries no route already behaves this way, and a reference is
  // where such a resolution mostly arrives.
  // How many leading segments the resolution spent reaching the piece. A slug
  // naming a collection spends the ones that select its member; every other
  // resolution spends none, and then the arithmetic below is the identity.
  const spent = move.place.position.path.length - resolved.path.length;
  const named = spelled === resolved.piece || spent > 0
    ? {}
    : { name: spelled };
  const landed = (position: PiecePosition): PiecePosition => ({
    ...position,
    ...named,
    piece: resolved.piece,
  });
  return land(
    {
      position: landed({
        ...move.place.position,
        path: resolved.path.map((segment) =>
          typeof segment === "number"
            ? segment
            : linkPathSegmentToCellPathSegment(segment)
        ),
      }),
      scope: resolved.scope ?? move.place.scope,
    },
    // A route entry the resolution walked *through* is a level of the
    // collection rather than of what it held, and goes; one at or below the
    // member is a level of the member, and lands with the member's own piece
    // and the spent segments off its path. The levels above the piece — the
    // root, the facet — are how shuttle reached the collection at all, and
    // are nobody's to drop.
    move.route.flatMap((position) => {
      if (position.kind !== "piece" || position.piece !== spelled) {
        return [position];
      }
      return position.path.length < spent
        ? []
        : [landed({ ...position, path: position.path.slice(spent) })];
    }),
  );
}

/**
 * The message a thrown value carries, for every surface that reports one.
 *
 * Total, which the obvious spelling is not. `String` throws on a value with no
 * `toString` — `Object.create(null)` is the reachable one, out of a rejection
 * built from a bare record — and on one whose conversion throws; an `Error`
 * may carry a `message` that is a getter which throws, or that is not a string
 * at all, which the next reader of it would be the one to fail on. Every
 * caller is already on its way to reporting a failure, so a throw raised here
 * replaces the failure being reported with itself: at the prompt that ends the
 * session on the read that failed, rather than answering the line and reading
 * the next one.
 *
 * A value that will not describe itself gets the sentence below instead. It
 * tells a reader less than a real message would and a great deal more than a
 * run that stopped.
 */
export function messageOf(thrown: unknown): string {
  try {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (typeof message === "string") return message;
  } catch {
    // The conversion is what failed, which is the case this exists for.
  }
  return "The failure carries nothing that can be written as a message.";
}

/**
 * The cell `place` names written short, which is the form the prompt carries
 * for the place shuttle stands at and a watch carries for the cell it watches.
 *
 * It is one rendering rather than two because it makes one promise: the piece
 * is written by the name the space's index confirmed for it and by its handle
 * otherwise, nothing is cut down to a prefix, and the scope is written out.
 * A reader who has learned to read the prompt reads a watch's name with no
 * second convention, and neither is an address — {@link referenceForPlace} is
 * what a seam takes and `pwd` is what a person copies.
 *
 * `input` selects the piece's arguments cell, which is the one thing a place
 * cannot carry: a place is result-rooted, so nothing here writes the member
 * for a *place*. What this names is a cell, and a piece has two — so a caller
 * naming the arguments one says which, and it is written where an operand
 * selects it, on the piece segment ({@link ARGUMENT_MEMBER}): `board#argument/title`.
 * Written after the path it would name the result key `title#argument`, which
 * is a cell of its own. Without it two cells of one piece are one name, and a
 * listing of them says the same thing twice.
 */
export function labelForPlace(place: Place, input = false): string {
  return `${labelPosition(place.position, input)} ${renderScope(place.scope)}`;
}

/**
 * The space-relative reference naming the cell `place` stands on, which is
 * what a `cf` seam reading a `--cell` takes.
 *
 * It is the shared renderer's form against a context holding the space alone:
 * the piece as the place holds it — a handle, or the operand's own spelling
 * where nothing resolved it — carrying the place's scope, and the path after it
 * as a pointer. The space is left out because the seam is handed one already:
 * shuttle connects to one space and every config it builds names that space,
 * so writing it here would say a second time what the config says once. The
 * scope is written because that context has none to leave it to.
 *
 * A place is result-rooted, so a seam is handed no `#argument` member: an
 * operand that selects the arguments cell says so through the flag the seam
 * reads it on, which is where the selection is a parameter rather than part of
 * the address. `input` writes the member on the piece segment for a caller
 * that names a piece's arguments cell for itself rather than for a seam — a
 * watch keying the cell it watches — where writing it after the path would
 * name a result key instead.
 */
export function referenceForPlace(place: PiecePlace, input = false): string {
  return renderCellReference(
    { ...cellOf(place), ...(input ? { member: "argument" as const } : {}) },
    { space: place.position.space },
  );
}

/**
 * Helper for the renderings, which is the cell `place` names, in the shape the
 * shared renderer writes one from.
 */
function cellOf(place: PiecePlace): {
  readonly space: MemorySpace;
  readonly id: string;
  readonly scope: CellScope;
  readonly path: readonly PathSegment[];
} {
  return {
    space: place.position.space,
    id: place.position.piece,
    scope: place.scope,
    path: place.position.path,
  };
}

/**
 * Helper for {@link placeEntries}, which writes the position.
 *
 * A piece is a cell, so it renders through the shared renderer against the
 * empty context, which writes the space and the scope. A container is not a
 * cell and is no reference: it renders its own name after the space, with no
 * leading `/`, and leaves the scope to the line below.
 */
function renderPosition(place: Place): string {
  const position = place.position;
  const space = `@${position.space}`;
  switch (position.kind) {
    case "root":
      return encodeJsonPointer([space, ""]);
    case "facet":
      return encodeJsonPointer([space, position.facet, ""]);
    case "piece":
      return renderCellReference(cellOf({ ...place, position }));
  }
}

/**
 * Helper for {@link CurrentPlace.label}, which writes the position half of the
 * short form: everything the position holds except the space.
 *
 * A piece is written by the name the index confirmed for it, and by its handle
 * where no name was confirmed. That is decision 13
 * (`docs/plans/shuttle/README.md`) read as a rendering: a name is shown
 * because a read said the space knows the piece by it, and the alternative is
 * the id itself rather than a guess.
 *
 * The separator is escaped in every segment, as it is in the rendering `pwd`
 * prints, so a key holding one is one segment here too. What differs is the
 * leading separator: it marks a cell in a place's rendering and marks nothing
 * here, a short form being no reference for it to mark one in, so a container
 * takes it and reads as the walk down from the root that it is.
 */
function labelPosition(position: Position, input = false): string {
  switch (position.kind) {
    case "root":
      return encodeJsonPointer(["", ""]);
    case "facet":
      return encodeJsonPointer(["", position.facet, ""]);
    case "piece": {
      // The member rides the piece segment, where an operand selects it.
      const piece = encodeJsonPointer([position.name ?? position.piece]) +
        (input ? ARGUMENT_MEMBER : "");
      return position.path.length === 0
        ? piece
        : `${piece}/${encodeJsonPointer(position.path.map(String))}`;
    }
  }
}

/** Helper for the renderings, which writes the scope. */
function renderScope(scope: CellScope): string {
  return `@${scope}`;
}
