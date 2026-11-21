/**
 * A card table with hidden hands: a sealed state, one handler that writes it,
 * and one view per seat that the policy releases to whoever is listed as that
 * seat's occupant.
 *
 * The state (the deck, every hand, who sits where) is confidential to this
 * module's policy and to nothing else, so no principal reads it, the table's
 * owner included. `move` is the only code that may write it, and it is also
 * the only writer of each seat's key and each seat's occupant list. `seatView`
 * is the only function whose output the policy releases, and only when
 * everything confidential it read was written by `move`.
 *
 * The release is the list release of commonfabric/specs#59 as drafted in
 * labs#8608: a seat's key names that seat's occupant list (`ifc.members`),
 * the capture check at commit adds `[User(owner) ∨ Members(list, table)]` to
 * the key, a view computed from the key carries that clause, and the one rule
 * below adds the same `Members` alternative to the policy's clause.
 *
 * SEAT-VIEWS-FINDINGS.md beside this file records what of this the runtime
 * does, and what it refuses.
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
  type Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  type Cfc,
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
// confidential location `seatView` read was written by `move`. The rule
// names no list and no person: the list comes from the label, where the
// capture check put it.
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

//
// The sealed state
//

/** How many seats a table has. */
export const SEATS = 3;

/** How many cards a deal gives each occupied seat. */
export const HAND_SIZE = 3;

const RANKS = "A23456789TJQK";

/** Everything the table knows, as `move` and `seatView` parse it. */
export interface GameState {
  /** Whether the owner has set the table up. */
  ready: boolean;

  /** The principal in each seat, by seat, or the empty string for none. */
  occupants: string[];

  /** The cards each seat holds, by seat. */
  hands: string[][];

  /** The cards not yet dealt, top first. */
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

/** The list of principals who occupy one seat. */
export type Occupants = WriteAuthorizedBy<
  RepresentsCurrentUser<Sealed<string[]>>,
  typeof move
>;

/**
 * A seat's key: the seat's index, written by `move` at setup, carrying the
 * list its views are released to.
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
  const occupants = strings(raw.occupants);
  const hands = Array.isArray(raw.hands) ? raw.hands.map(strings) : [];
  return {
    ready: raw.ready === true,
    occupants: Array.from(
      { length: SEATS },
      (_, seat) => occupants[seat] ?? "",
    ),
    hands: Array.from({ length: SEATS }, (_, seat) => hands[seat] ?? []),
    deck: strings(raw.deck),
    version: typeof raw.version === "number" ? raw.version : 0,
  };
}

//
// Moves
//

/**
 * One proposed move. It carries no proposer: `move` takes that from the
 * runtime.
 */
export interface Move {
  /**
   * `setup` readies the table and is the owner's. `sit` puts a principal in
   * `seat`. `deal` shuffles and gives every occupied seat a hand, and is the
   * owner's.
   */
  kind: "setup" | "sit" | "deal";

  /** The seat a `sit` takes. */
  seat?: number;

  /**
   * Who a `sit` seats, when it is not the proposer. Only the table's owner
   * may seat somebody else.
   */
  occupant?: string;
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
 * The state after `actor` makes `proposed`, or `undefined` when the rules
 * refuse it. `isOwner` is whether `actor` owns the table.
 */
function applyMove(
  state: GameState,
  proposed: Move,
  actor: string,
  isOwner: boolean,
  random: () => number,
): GameState | undefined {
  const dealt = state.deck.length > 0;
  const version = state.version + 1;
  switch (proposed?.kind) {
    case "setup":
      if (state.ready || !isOwner) return undefined;
      return { ...state, ready: true, version };
    case "sit": {
      const seat = proposed.seat;
      const occupant = proposed.occupant ?? actor;
      if (
        !state.ready || dealt || typeof seat !== "number" ||
        !Number.isInteger(seat) || seat < 0 || seat >= SEATS ||
        typeof occupant !== "string" || occupant === "" ||
        (occupant !== actor && !isOwner) ||
        state.occupants[seat] !== "" || state.occupants.includes(occupant)
      ) return undefined;
      return {
        ...state,
        occupants: state.occupants.map((held, at) =>
          at === seat ? occupant : held
        ),
        version,
      };
    }
    case "deal": {
      if (
        !state.ready || dealt || !isOwner ||
        state.occupants.every((held) => held === "")
      ) return undefined;
      const deck = shuffled(random);
      const hands = state.occupants.map((held) =>
        held === "" ? [] : deck.splice(0, HAND_SIZE)
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

  /** Each seat's occupant list. */
  occupants0: Writable<Occupants>;
  occupants1: Writable<Occupants>;
  occupants2: Writable<Occupants>;

  /** Each seat's key. */
  key0: Writable<SeatKey0>;
  key1: Writable<SeatKey1>;
  key2: Writable<SeatKey2>;
}

/**
 * The table's one writer. It applies the move the rules allow and writes
 * nothing for one they refuse. The proposer is `currentPrincipal()`, and the
 * table's owner is whoever the runtime says owns the space the state lives
 * in. No field of the event is read for either.
 *
 * Setup is a move, so the seat keys and the seat lists have the same writer
 * as the state: everything `seatView` reads is written here.
 */
export const move = handler<Move, MoveState>((event, bound) => {
  const actor = currentPrincipal();
  if (actor === undefined) return;
  const before = parsed(String(bound.state.get() ?? ""));
  const next = applyMove(
    before,
    event,
    actor,
    spaceAccess(bound.state) === "OWNER",
    Math.random,
  );
  if (next === undefined) return;
  bound.state.set(JSON.stringify(next));
  const lists = [bound.occupants0, bound.occupants1, bound.occupants2];
  if (event.kind === "setup") {
    bound.key0.set(0);
    bound.key1.set(1);
    bound.key2.set(2);
    lists.forEach((list) => list.set([]));
  }
  if (event.kind === "sit") {
    next.occupants.forEach((occupant, seat) => {
      if (occupant !== before.occupants[seat]) lists[seat].set([occupant]);
    });
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

interface SeatViewsInput {
  /** The table's state, which starts as the table before its setup. */
  state: Writable<Default<StoredGame, "">>;

  /** Each seat's occupant list. */
  occupants0: Writable<Default<Occupants, []>>;
  occupants1: Writable<Default<Occupants, []>>;
  occupants2: Writable<Default<Occupants, []>>;

  /** Each seat's key. */
  key0: Writable<SeatKey0>;
  key1: Writable<SeatKey1>;
  key2: Writable<SeatKey2>;
}

/** A card table with hidden hands. */
export interface SeatViewsOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Each seat's occupant list, which that seat's view is released to. */
  occupants0: Occupants;
  occupants1: Occupants;
  occupants2: Occupants;

  /** Each seat's view; `undefined` until the setup. */
  view0: SeatView | undefined;
  view1: SeatView | undefined;
  view2: SeatView | undefined;

  /** Propose a move as whoever sends it. */
  move: Stream<Move>;
}

const SeatViews = pattern<SeatViewsInput, SeatViewsOutput>((
  { state, occupants0, occupants1, occupants2, key0, key1, key2 },
) => {
  const view0 = seatView({ stored: state, key: key0 });
  const view1 = seatView({ stored: state, key: key1 });
  const view2 = seatView({ stored: state, key: key2 });
  const table = move({
    state,
    occupants0,
    occupants1,
    occupants2,
    key0,
    key1,
    key2,
  });
  return {
    [NAME]: "Seat views: a card table with hidden hands",
    [UI]: (
      <cf-screen title="Card table">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <div id="seat-0">Seat 0: {view0?.hand}</div>
          <div id="seat-1">Seat 1: {view1?.hand}</div>
          <div id="seat-2">Seat 2: {view2?.hand}</div>
        </cf-vstack>
      </cf-screen>
    ),
    occupants0,
    occupants1,
    occupants2,
    view0,
    view1,
    view2,
    move: table,
  };
});

export default SeatViews;
