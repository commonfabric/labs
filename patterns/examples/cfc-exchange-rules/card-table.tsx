/**
 * A card table with hidden hands: one sealed record, one handler that writes
 * it, and one view that each principal is shown their own instance of.
 *
 * The state (who sits where, the deck and every hand) is confidential to this
 * module's policy and to nothing else, so no principal reads it, the table's
 * owner included. `move` is the only code that may write it. Setting the
 * table up, sitting down, leaving, dealing and drawing are all moves, and the
 * proposer of each is the principal the runtime says sent it.
 *
 * `viewFor` is the only function whose output the policy releases. It reads
 * the state and asks the runtime who it is computed for, and returns what
 * that principal may see: their own hand if they hold a seat, and the same
 * public facts either way. The runtime computes it once for each principal
 * who is looking, in an instance of their own, and the one rule below
 * releases each instance to the principal it was computed for.
 *
 * Nothing here is per seat. The table keeps no list of who may read what, no
 * key for a seat and no copy of a view: who holds a seat is a fact inside the
 * sealed state, and the release follows it.
 *
 * The release needs the `viewerBoundRelease` experimental option.
 * MODULE-NAMED-AUDIENCE-PROPOSAL.md beside this file is the specification
 * change it rests on.
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
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";

//
// The policy
//

// The one release. What `viewFor` computed is released to the principal it
// was computed for, when every confidential location it read was written by
// `move`. The rule names no person and no seat: the principal comes from the
// stamp the runtime put on the value, and which seat is theirs is `viewFor`'s
// to decide from the state.
export const releaseOwnView = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "viewFor",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "move",
        },
      },
      viewer: v("viewer"),
    }],
  },
  post: {
    addAlternatives: [{
      type: "https://commonfabric.org/cfc/atom/User",
      subject: v("viewer"),
    }],
  },
});

export const tableRules = exchangeRules([releaseOwnView]);

/** A value only this module's policy may release. */
export type Sealed<T> = Confidential<
  T,
  readonly [PolicyOf<typeof tableRules>]
>;

//
// The sealed state
//

/** How many cards a deal gives each occupied seat. */
export const HAND_SIZE = 3;

/** The most seats a table may be set up with. */
export const MAX_SEATS = 12;

const RANKS = "A23456789TJQK";

/** Where the table is in its life. */
export type Phase = "new" | "seating" | "playing";

/** Everything the table keeps sealed. */
export interface Game {
  /** Seats are taken while this is `seating`, and cards move in `playing`. */
  phase: Phase;

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
 * The stored state: sealed, and written only by `move`. It is `null` until
 * the table's setup, which is the first move.
 *
 * TODO(cfc): the state starts as `null` and not as an empty table. The
 * runtime names `move` as the writer of the whole record only when every
 * value a write left in place is one `move` wrote before, and a default is
 * nobody's: a record default whose `deck: []` the setup left as it found it
 * would keep the table's views sealed
 * (`docs/specs/cfc-transformed-by-input-witnesses.md`, "What the endorsed
 * writer's stamp covers"). Nothing of `null` outlives the setup.
 */
export type StoredGame = WriteAuthorizedBy<Sealed<Game | null>, typeof move>;

/** One proposed move. It carries no proposer. */
export interface Move {
  /**
   * `setup` gives the table `seats` empty seats, and `deal` shuffles and
   * gives every occupied seat a hand; both are the table owner's. `sit` puts
   * the proposer in `seat`, and `leave` takes them out of theirs and discards
   * their hand. `draw` gives the proposer the deck's top card.
   */
  kind: "setup" | "sit" | "leave" | "deal" | "draw";

  /** How many seats a `setup` makes. */
  seats?: number;

  /** The seat a `sit` takes. */
  seat?: number;
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

/** A plain copy of the stored state, with every field in place. */
function gameOf(stored: Partial<Game> | null | undefined): Game {
  return {
    phase: stored?.phase ?? "new",
    occupants: [...(stored?.occupants ?? [])],
    hands: (stored?.hands ?? []).map((hand) => [...hand]),
    deck: [...(stored?.deck ?? [])],
    version: stored?.version ?? 0,
  };
}

/**
 * The state after `actor` makes `proposed`, or `undefined` when the rules
 * refuse it. `owns` is whether `actor` owns the table's space.
 */
function applyMove(
  state: Game,
  proposed: Move,
  actor: string,
  owns: boolean,
  random: () => number,
): Game | undefined {
  const version = state.version + 1;
  const seatOf = state.occupants.indexOf(actor);
  switch (proposed?.kind) {
    case "setup": {
      const seats = proposed.seats;
      if (
        !owns || state.phase !== "new" || typeof seats !== "number" ||
        !Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS
      ) return undefined;
      return {
        phase: "seating",
        occupants: Array.from({ length: seats }, () => ""),
        hands: Array.from({ length: seats }, () => []),
        deck: [],
        version,
      };
    }
    case "sit": {
      const seat = proposed.seat;
      if (
        state.phase !== "seating" || typeof seat !== "number" ||
        !Number.isInteger(seat) || seat < 0 ||
        seat >= state.occupants.length || state.occupants[seat] !== "" ||
        seatOf !== -1
      ) return undefined;
      return {
        ...state,
        occupants: state.occupants.map((held, at) =>
          at === seat ? actor : held
        ),
        version,
      };
    }
    case "leave":
      if (seatOf === -1) return undefined;
      return {
        ...state,
        occupants: state.occupants.map((held, at) => at === seatOf ? "" : held),
        hands: state.hands.map((hand, at) => at === seatOf ? [] : hand),
        version,
      };
    case "deal": {
      if (
        !owns || state.phase !== "seating" ||
        !state.occupants.some((held) => held !== "")
      ) return undefined;
      const deck = shuffled(random);
      const hands = state.occupants.map((held) =>
        held === "" ? [] : deck.splice(0, HAND_SIZE)
      );
      return { ...state, phase: "playing", hands, deck, version };
    }
    case "draw": {
      if (
        state.phase !== "playing" || seatOf === -1 || state.deck.length === 0
      ) return undefined;
      const [card, ...deck] = state.deck;
      return {
        ...state,
        hands: state.hands.map((hand, at) =>
          at === seatOf ? [...hand, card] : hand
        ),
        deck,
        version,
      };
    }
    default:
      return undefined;
  }
}

/**
 * What `move` is bound to: the state, and nothing else. An interface, unlike
 * an inline type, may name the handler it belongs to.
 */
export interface MoveState {
  /** The table's state. */
  state: Writable<StoredGame>;
}

/**
 * The sealed state's one writer. It applies the move the rules allow and
 * writes nothing for one they refuse. The proposer is `currentPrincipal()`,
 * and the table's owner is whoever the runtime says owns the space the state
 * lives in. Everything else it works from is the state itself, so binding it
 * anywhere else runs the same rules over the same table for the same
 * proposer.
 */
export const move = handler<Move, MoveState>((event, bound) => {
  const actor = currentPrincipal();
  if (actor === undefined) return;
  const next = applyMove(
    gameOf(bound.state.get()),
    event,
    actor,
    spaceAccess(bound.state) === "OWNER",
    Math.random,
  );
  if (next !== undefined) bound.state.set(next);
});

//
// The released projection
//

/** What one principal may see of the table. */
export interface TableView {
  /** The seat the principal holds, or -1 when they hold none. */
  seat: number;

  /** The cards the principal holds; empty for a principal with no seat. */
  hand: string[];

  /** Whether each seat is taken, by seat. */
  taken: boolean[];

  /** How many cards each seat holds, by seat. */
  counts: number[];

  /** How many cards are left in the deck. */
  deck: number;

  /** Where the table is in its life. */
  phase: Phase;

  /** How many moves have been applied. */
  version: number;
}

/**
 * The table's one released function: what the principal it is computed for
 * may see. It is a module-scope `lift` because `TransformedBy` names a
 * function by its module and its export name. It takes the state and nothing
 * else, so there is nothing a caller can choose but which table to look at.
 */
export const viewFor = lift((
  { state }: { state: Game | null | undefined },
): TableView => {
  const viewer = currentPrincipal();
  const game = gameOf(state);
  const seat = viewer === undefined ? -1 : game.occupants.indexOf(viewer);
  return {
    seat,
    hand: seat === -1 ? [] : game.hands[seat] ?? [],
    taken: game.occupants.map((held) => held !== ""),
    counts: game.hands.map((hand) => hand.length),
    deck: game.deck.length,
    phase: game.phase,
    version: game.version,
  };
});

/**
 * Every hand. Defined beside `viewFor` and named by no rule, so what it
 * computes stays sealed.
 */
export const peek = lift((
  { state }: { state: Game | null | undefined },
): string => gameOf(state).hands.map((hand) => hand.join(" ")).join(" | "));

//
// The table
//

export interface CardTableInput {
  /** The table's state, which starts as the table before its setup. */
  state: Writable<Default<StoredGame, null>>;
}

/** A card table with hidden hands. */
export interface CardTableOutput {
  [NAME]: string;
  [UI]: VNode;

  /** What the principal looking may see of the table. */
  view: TableView;

  /** Every hand, which nobody is shown. */
  peek: string;

  /** Propose a move, as whoever sends it. */
  move: Stream<Move>;
}

const CardTable = pattern<CardTableInput, CardTableOutput>(({ state }) => {
  const view = viewFor({ state });
  return {
    [NAME]: "Card table: hidden hands, one view per viewer",
    [UI]: (
      <cf-screen title="Card table">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <div id="table-phase">The table is {view.phase}</div>
          <div id="table-seat">Your seat: {view.seat}</div>
          <div id="table-hand">Your hand: {view.hand}</div>
          <div id="table-deck">Cards left: {view.deck}</div>
        </cf-vstack>
      </cf-screen>
    ),
    view,
    peek: peek({ state }),
    move: move({ state }),
  };
});

export default CardTable;
