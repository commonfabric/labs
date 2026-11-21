/**
 * A card table with hidden hands: a sealed state, one handler that writes it,
 * and one view per seat that the policy releases to whoever is listed as that
 * seat's occupant.
 *
 * The state (the deck and every hand) is confidential to this module's policy
 * and to nothing else, so no principal reads it, the table's owner included.
 * `move` is the only code that may write it, and is also the only writer of
 * each seat's key. `seatView` is the only function whose output the policy
 * releases, and only when everything confidential it read was written by
 * `move`.
 *
 * The release is the list release of commonfabric/specs#59 as drafted in
 * labs#8608. A seat's key names that seat's occupant list (`ifc.members`).
 * When the table's owner sets the table up, the capture check at commit adds
 * `[User(owner) ∨ Members(list, table)]` to the key. A view computed from the
 * key carries that clause, and the one rule below adds the same `Members`
 * alternative to the policy's clause.
 *
 * Who sits where is public, and is not part of the sealed state: `seating`
 * writes it, and writes each seat's occupant list beside it.
 *
 * SEAT-VIEWS-FINDINGS.md beside this file records what of this the runtime
 * does and what it refuses, including why seating is not a move.
 */
import {
  type Confidential,
  currentPrincipal,
  type Default,
  handler,
  lift,
  NAME,
  pattern,
  spaceAccess,
  type Stream,
  UI,
  type VNode,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  type Cfc,
  type CurrentPrincipal,
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  type RepresentsCurrentUser,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";

//
// The policy
//

// The one release. A value `seatView` computed is released to the members of
// a list when its label already names that list for this table, and every
// confidential location `seatView` read was written by `move`. The rule names
// no list and no person: the list comes from the label, where the capture
// check put it.
//
// TODO(cfc): the `Members` pattern is written as a raw atom because the
// compiler refuses `cfcPattern.members()`, which labs#8608 adds to the API
// and not to the transformer (SEAT-VIEWS-FINDINGS.md, port note 3).
export const releaseSeatView = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    confidentiality: [{
      type: "https://commonfabric.org/cfc/atom/Members",
      list: v("list"),
      subject: THIS_POLICY.subject,
    }],
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "seatView",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "move",
        },
      },
    }],
  },
  preConfScope: "anywhere",
  post: {
    addAlternatives: [{
      type: "https://commonfabric.org/cfc/atom/Members",
      list: v("list"),
      subject: THIS_POLICY.subject,
    }],
  },
});

export const tableRules = exchangeRules([releaseSeatView]);

/** A value only this module's policy may release. */
export type Sealed<T> = Confidential<
  T,
  readonly [PolicyOf<typeof tableRules>]
>;

/** A value only the principal who writes it may read. */
export type OnlyMe<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

//
// Seating
//

/** How many seats a table has. */
export const SEATS = 3;

/**
 * Where the table is in its life. Seats are taken while it is `open`, and
 * cards are dealt once it is `closed`.
 */
export type Phase = "new" | "open" | "closed";

/** The table's phase, written only by `seating`. */
export type StoredPhase = WriteAuthorizedBy<Phase, typeof seating>;

/**
 * The principal in each seat, by seat, or the empty string for none. Public,
 * and written only by `seating`.
 */
export type Roster = WriteAuthorizedBy<string[], typeof seating>;

/**
 * One entry of a seat's occupant list: the principal it pins, in a record
 * only that principal reads. The runtime stores a record in a list as a
 * document of its own, which is what lets its label name whoever wrote it.
 */
export type Occupant = WriteAuthorizedBy<
  OnlyMe<{ principal: string }>,
  typeof seating
>;

/**
 * The list one seat's views are released to. The list is the table owner's,
 * who is the first to write it, and only `seating` writes it.
 *
 * TODO(cfc): this repeats the roster. List resolution counts an entry only
 * when the entry's own label names the principal it pins, and the roster is
 * public (SEAT-VIEWS-FINDINGS.md, finding 2).
 */
export type Occupants = WriteAuthorizedBy<
  RepresentsCurrentUser<{ principal: string }[]>,
  typeof seating
>;

/** One request about who sits where. It carries no proposer. */
export interface Seating {
  /**
   * `open` lets principals sit and `close` stops them; both are the table
   * owner's. `sit` puts the proposer in `seat`.
   */
  kind: "open" | "sit" | "close";

  /** The seat a `sit` takes. */
  seat?: number;

  /**
   * Who a `sit` seats. Nobody may seat anyone but themselves, so a `sit`
   * that names another principal is refused.
   *
   * TODO(cfc): the table's owner cannot seat a player, because an entry is
   * labeled for whoever writes it (SEAT-VIEWS-FINDINGS.md, finding 3).
   */
  occupant?: string;
}

/** What `seating` is bound to. */
export interface SeatingState {
  phase: Writable<StoredPhase>;
  roster: Writable<Roster>;
  occupants0: Writable<Occupants>;
  occupants1: Writable<Occupants>;
  occupants2: Writable<Occupants>;
}

/**
 * The one writer of who sits where. It reads nothing sealed, so what it
 * writes is public, apart from the list entries, which are labeled for the
 * principal who sat. The proposer is `currentPrincipal()`.
 */
export const seating = handler<Seating, SeatingState>((event, bound) => {
  const actor = currentPrincipal();
  if (actor === undefined) return;
  const phase = bound.phase.get();
  const isOwner = spaceAccess(bound.phase) === "OWNER";
  switch (event?.kind) {
    case "open":
      if (isOwner && phase === "new") bound.phase.set("open");
      return;
    case "close":
      if (isOwner && phase === "open") bound.phase.set("closed");
      return;
    case "sit": {
      const seat = event.seat;
      const roster = Array.from(
        { length: SEATS },
        (_, at) => bound.roster.get()[at] ?? "",
      );
      if (
        phase !== "open" || typeof seat !== "number" ||
        !Number.isInteger(seat) || seat < 0 || seat >= SEATS ||
        (event.occupant !== undefined && event.occupant !== actor) ||
        roster[seat] !== "" || roster.includes(actor)
      ) return;
      bound.roster.set(roster.map((held, at) => at === seat ? actor : held));
      const entry = new Writable<Occupant>({ principal: actor });
      [bound.occupants0, bound.occupants1, bound.occupants2][seat].set([
        entry,
      ]);
      return;
    }
  }
});

//
// The sealed state
//

/** How many cards a deal gives each occupied seat. */
export const HAND_SIZE = 3;

const RANKS = "A23456789TJQK";

/** Everything the table keeps sealed, as `move` and `seatView` parse it. */
export interface GameState {
  /** Whether the owner has set the table up. */
  ready: boolean;

  /** The cards each seat holds, by seat. */
  hands: string[][];

  /** The cards not yet dealt, top first; empty until the deal. */
  deck: string[];

  /** How many moves have been applied. */
  version: number;
}

/**
 * The stored state: the JSON form of a `GameState`, sealed, and written only
 * by `move`.
 *
 * TODO(cfc): one string and not a record, because a record its writer reads
 * and then sets keeps no input witness
 * (SEALED-STATE-MACHINE-FINDINGS.md, gap A).
 */
export type StoredGame = WriteAuthorizedBy<Sealed<string>, typeof move>;

/**
 * A seat's key: the seat's index, written by `move` at setup, carrying the
 * list the seat's views are released to.
 *
 * TODO(cfc): one type a seat, because `ifc.members` is a pointer written
 * into the schema, so the number of seats is fixed in the source
 * (SEAT-VIEWS-FINDINGS.md, finding 4).
 */
type SeatKey<Pointer extends string> = Cfc<
  WriteAuthorizedBy<Sealed<number>, typeof move>,
  { members: Pointer }
>;
export type SeatKey0 = SeatKey<"/occupants0">;
export type SeatKey1 = SeatKey<"/occupants1">;
export type SeatKey2 = SeatKey<"/occupants2">;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * The state `stored` holds. It is total: text that is not a state's JSON
 * form parses as the table before its setup, so what it throws depends on
 * nothing it read.
 */
function parsed(stored: string | undefined): GameState {
  let raw: Partial<Record<keyof GameState, unknown>> = {};
  try {
    const value: unknown = JSON.parse(stored || "{}");
    if (typeof value === "object" && value !== null) raw = value;
  } catch {
    raw = {};
  }
  const hands = Array.isArray(raw.hands) ? raw.hands.map(strings) : [];
  return {
    ready: raw.ready === true,
    hands: Array.from({ length: SEATS }, (_, seat) => hands[seat] ?? []),
    deck: strings(raw.deck),
    version: typeof raw.version === "number" ? raw.version : 0,
  };
}

/** One proposed move. It carries no proposer. */
export interface Move {
  /**
   * `setup` readies the table and writes each seat's key. `deal` shuffles
   * and gives every occupied seat a hand, once seating has closed. Both are
   * the table owner's.
   */
  kind: "setup" | "deal";
}

/** A full deck in an order drawn from `random`, by Fisher-Yates. */
function shuffled(random: () => number): string[] {
  const cards = [..."SHDC"].flatMap((suit) =>
    [...RANKS].map((rank) => rank + suit)
  );
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/**
 * The state after the table's owner makes `proposed`, or `undefined` when
 * the rules refuse it. `seated` is whether each seat is occupied, and
 * `closed` whether seating has closed.
 */
function applyMove(
  state: GameState,
  proposed: Move,
  seated: boolean[],
  closed: boolean,
  random: () => number,
): GameState | undefined {
  const version = state.version + 1;
  switch (proposed?.kind) {
    case "setup":
      if (state.ready) return undefined;
      return { ...state, ready: true, version };
    case "deal": {
      if (
        !state.ready || state.deck.length > 0 || !closed ||
        !seated.some((taken) => taken)
      ) return undefined;
      const deck = shuffled(random);
      const hands = seated.map((taken) =>
        taken ? deck.splice(0, HAND_SIZE) : []
      );
      return { ...state, hands, deck, version };
    }
    default:
      return undefined;
  }
}

/**
 * What `move` is bound to. An interface, unlike an inline type, may name the
 * handler it belongs to.
 */
export interface MoveState {
  /** The table's state. */
  state: Writable<StoredGame>;

  /** Each seat's key. */
  key0: Writable<SeatKey0>;
  key1: Writable<SeatKey1>;
  key2: Writable<SeatKey2>;

  /** Who sits where, and whether seating has closed. `move` only reads them. */
  phase: StoredPhase;
  roster: Roster;
}

/**
 * The sealed state's one writer. It applies the move the rules allow and
 * writes nothing for one they refuse. Only the table's owner moves: the
 * proposer is `currentPrincipal()`, and the owner is whoever the runtime
 * says owns the space the state lives in.
 *
 * Setup is a move, so each seat's key has the same writer as the state, and
 * everything confidential `seatView` reads is written here.
 */
export const move = handler<Move, MoveState>((event, bound) => {
  if (
    currentPrincipal() === undefined || spaceAccess(bound.state) !== "OWNER"
  ) return;
  const next = applyMove(
    parsed(String(bound.state.get() ?? "")),
    event,
    Array.from({ length: SEATS }, (_, seat) => !!bound.roster?.[seat]),
    bound.phase === "closed",
    Math.random,
  );
  if (next === undefined) return;
  bound.state.set(JSON.stringify(next));
  if (event.kind === "setup") {
    bound.key0.set(0);
    bound.key1.set(1);
    bound.key2.set(2);
  }
});

//
// The released projection
//

/** What the occupant of one seat may see. */
export interface SeatView {
  /** The seat this is the view of. */
  seat: number;

  /** The cards the seat holds. */
  hand: string[];

  /** How many cards each seat holds, by seat. */
  counts: number[];

  /** How many moves have been applied. */
  version: number;
}

/**
 * The table's one released function: the view of the seat `key` names. It is
 * a module-scope `lift` because `TransformedBy` names a function by its
 * module and its export name.
 *
 * Before the setup it returns nothing: the state then holds its default,
 * which `move` did not write (SEALED-STATE-MACHINE-FINDINGS.md, gap B).
 */
export const seatView = lift((
  { stored, key }: { stored: string | undefined; key: number | undefined },
): SeatView | undefined => {
  if (!stored || typeof key !== "number") return undefined;
  const state = parsed(stored);
  if (!state.ready) return undefined;
  return {
    seat: key,
    hand: state.hands[key] ?? [],
    counts: state.hands.map((hand) => hand.length),
    version: state.version,
  };
});

/**
 * Every hand. Defined beside `seatView` and named by no rule, so what it
 * computes stays sealed.
 */
export const peek = lift((stored: string | undefined): string =>
  parsed(stored).hands.map((hand) => hand.join(" ")).join(" | ")
);

//
// The table
//

export interface SeatViewsInput {
  /** The table's state, which starts as the table before its setup. */
  state: Writable<Default<StoredGame, "">>;

  /**
   * Each seat's key. A key has no default: the capture check runs on every
   * write of one, the write that seeds a default included
   * (SEAT-VIEWS-FINDINGS.md, finding 5).
   */
  key0: Writable<SeatKey0>;
  key1: Writable<SeatKey1>;
  key2: Writable<SeatKey2>;

  /** Where the table is in its life. */
  phase: Writable<Default<StoredPhase, "new">>;

  /** The principal in each seat. */
  roster: Writable<Default<Roster, []>>;
}

/** A card table with hidden hands. */
export interface SeatViewsOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Where the table is in its life. */
  phase: Phase;

  /** The principal in each seat, by seat, or the empty string for none. */
  roster: string[];

  /** Each seat's occupant list, which that seat's view is released to. */
  occupants0: Occupants;
  occupants1: Occupants;
  occupants2: Occupants;

  /** Each seat's view; `undefined` until the setup. */
  view0: SeatView | undefined;
  view1: SeatView | undefined;
  view2: SeatView | undefined;

  /** Propose a move, as the table's owner. */
  move: Stream<Move>;

  /** Ask to open or close seating, or to sit, as whoever sends it. */
  seating: Stream<Seating>;
}

const SeatViews = pattern<SeatViewsInput, SeatViewsOutput>((
  { state, key0, key1, key2, phase, roster },
) => {
  // Each seat's occupant list is a cell of its own. Storing a record in a
  // list reads the document that holds the list, and the table's argument
  // holds the sealed state, so a list kept there would make `seating` a
  // reader of it (SEAT-VIEWS-FINDINGS.md, finding 6).
  const occupants0 = new Writable<Occupants>([]).for("occupants0");
  const occupants1 = new Writable<Occupants>([]).for("occupants1");
  const occupants2 = new Writable<Occupants>([]).for("occupants2");
  const view0 = seatView({ stored: state, key: key0 });
  const view1 = seatView({ stored: state, key: key1 });
  const view2 = seatView({ stored: state, key: key2 });
  return {
    [NAME]: "Seat views: a card table with hidden hands",
    [UI]: (
      <cf-screen title="Card table">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <div id="table-phase">Seating is {phase}</div>
          <div id="seat-0">Seat 0: {view0?.hand}</div>
          <div id="seat-1">Seat 1: {view1?.hand}</div>
          <div id="seat-2">Seat 2: {view2?.hand}</div>
        </cf-vstack>
      </cf-screen>
    ),
    phase,
    roster,
    occupants0,
    occupants1,
    occupants2,
    view0,
    view1,
    view2,
    move: move({ state, key0, key1, key2, phase, roster }),
    seating: seating({ phase, roster, occupants0, occupants1, occupants2 }),
  };
});

export default SeatViews;
