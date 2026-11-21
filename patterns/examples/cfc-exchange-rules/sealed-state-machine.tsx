/**
 * The card game Memory as a sealed state machine: a table whose whole state
 * no person can read, one handler that is its only writer, and one projection
 * the policy releases to the table's readers.
 *
 * The state (which card is at which slot, what is face-up, who captured what,
 * whose turn it is) is confidential to this module's policy and to nothing
 * else, so no principal reads it, the table's owner included. `move` is the
 * only code that may write it, and takes the proposer of a move from the
 * runtime, never from the event. `observe` is the only function whose output
 * the policy releases, and only when everything confidential it read was
 * written by `move`.
 *
 * SEALED-STATE-MACHINE-FINDINGS.md beside this file records what of this the
 * runtime enforces and what it does not.
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
  cfcPattern,
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";

//
// The policy
//

// The one release. A reader of the table's space may see what this module's
// `observe` computed, when every confidential location `observe` read was
// written by this module's `move`. The identity alone would release `observe`
// over a state any other code wrote, such as one with every card face-up.
export const releaseObserverView = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "observe",
        },
        inputWitness: {
          type: "https://commonfabric.org/cfc/atom/TransformedBy",
          identity: {
            kind: "verified",
            moduleIdentity: THIS_POLICY.moduleIdentity,
            symbol: "move",
          },
        },
      },
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: { addAlternatives: [cfcPattern.user(v("reader"))] },
});

export const tableRules = exchangeRules([releaseObserverView]);

/** A value only this module's policy may release. */
export type Sealed<T> = Confidential<
  T,
  readonly [PolicyOf<typeof tableRules>]
>;

//
// The sealed state
//

/** The most pairs a table deals: one per face letter. */
export const MAX_PAIRS = 12;

/** How many moves the history keeps. */
export const HISTORY_LIMIT = 8;

const FACES = "ABCDEFGHIJKL";

/**
 * Everything the table knows. It is stored as one string, its JSON form
 * (`StoredGame`), and this is the shape `move` and `observe` parse it into.
 */
export interface GameState {
  /** The pair each slot holds, by slot; empty until the cards are dealt. */
  layout: number[];

  /** The slots face-up and not yet resolved, in the order revealed. */
  faceUp: number[];

  /** The seat that captured each slot, by slot, or -1 for none. */
  capturedBy: number[];

  /** The principal in each seat, by seat. */
  players: string[];

  /** The seat whose turn it is, or -1 before the cards are dealt. */
  turn: number;

  /** How many moves have been applied. */
  version: number;

  /** The last `HISTORY_LIMIT` moves, as `version:seat:kind:slot`. */
  history: string[];
}

/**
 * The stored state: the JSON form of a `GameState`, sealed, and written only
 * by `move`. It is one string rather than a record because the release's
 * input witness holds for a scalar its writer read and then set, and does not
 * hold for a record written that way
 * (SEALED-STATE-MACHINE-FINDINGS.md, gap A).
 */
export type StoredGame = WriteAuthorizedBy<Sealed<string>, typeof move>;

const numbers = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * The state `stored` holds. It is total: text that is not a state's JSON
 * form, `undefined` and the empty string included, parses as the table before
 * anyone sat down, so what it throws depends on nothing it read.
 */
function parsed(stored: string | undefined): GameState {
  let raw: Partial<Record<keyof GameState, unknown>> = {};
  try {
    const value: unknown = JSON.parse(stored || "{}");
    if (typeof value === "object" && value !== null) raw = value;
  } catch {
    raw = {};
  }
  return {
    layout: numbers(raw.layout),
    faceUp: numbers(raw.faceUp),
    capturedBy: numbers(raw.capturedBy),
    players: strings(raw.players),
    turn: typeof raw.turn === "number" ? raw.turn : -1,
    version: typeof raw.version === "number" ? raw.version : 0,
    history: strings(raw.history),
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
   * `sit` takes the next seat, before the deal. `setup` deals, and is the
   * table owner's. `reveal` turns `slot` face-up, and `resolve` settles the
   * two face-up cards; both are the current player's.
   */
  kind: "sit" | "setup" | "reveal" | "resolve";

  /** The slot a `reveal` turns over. */
  slot?: number;

  /** How many pairs a `setup` deals, from 1 to `MAX_PAIRS`. */
  pairs?: number;
}

/** `state` with `change` applied as its next move, by `seat`. */
function advanced(
  state: GameState,
  seat: number,
  kind: Move["kind"],
  slot: number,
  change: Partial<GameState>,
): GameState {
  const version = state.version + 1;
  return {
    ...state,
    ...change,
    version,
    history: [...state.history, `${version}:${seat}:${kind}:${slot}`].slice(
      -HISTORY_LIMIT,
    ),
  };
}

/** `count` pairs in an order drawn from `random`, by Fisher-Yates. */
function shuffled(count: number, random: () => number): number[] {
  const cards: number[] = [];
  for (let pair = 0; pair < count; pair++) cards.push(pair, pair);
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
  const dealt = state.layout.length > 0;
  const seat = state.players.indexOf(actor);
  switch (proposed?.kind) {
    case "sit": {
      if (dealt || seat >= 0) return undefined;
      return advanced(state, state.players.length, "sit", -1, {
        players: [...state.players, actor],
      });
    }
    case "setup": {
      const pairs = proposed.pairs ?? 4;
      if (
        dealt || !isOwner || state.players.length < 1 ||
        !Number.isInteger(pairs) || pairs < 1 || pairs > MAX_PAIRS
      ) return undefined;
      const layout = shuffled(pairs, random);
      return advanced(state, seat, "setup", -1, {
        layout,
        faceUp: [],
        capturedBy: layout.map(() => -1),
        turn: 0,
      });
    }
    case "reveal": {
      const slot = proposed.slot;
      if (
        !dealt || seat < 0 || seat !== state.turn ||
        typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 ||
        slot >= state.layout.length || state.faceUp.length >= 2 ||
        state.faceUp.includes(slot) || state.capturedBy[slot] !== -1
      ) return undefined;
      return advanced(state, seat, "reveal", slot, {
        faceUp: [...state.faceUp, slot],
      });
    }
    case "resolve": {
      if (!dealt || seat < 0 || seat !== state.turn) return undefined;
      if (state.faceUp.length !== 2) return undefined;
      const [first, second] = state.faceUp;
      if (state.layout[first] === state.layout[second]) {
        return advanced(state, seat, "resolve", -1, {
          faceUp: [],
          capturedBy: state.capturedBy.map((owner, slot) =>
            slot === first || slot === second ? seat : owner
          ),
        });
      }
      return advanced(state, seat, "resolve", -1, {
        faceUp: [],
        turn: (state.turn + 1) % state.players.length,
      });
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
}

/**
 * The table's one writer. It applies the move the rules allow and writes
 * nothing for one they refuse: a refused move neither changes the state nor
 * throws, so a refusal tells its sender only that the version did not move.
 *
 * The proposer is `currentPrincipal()`, and the table's owner is whoever the
 * runtime says owns the space the state lives in. No field of the event is
 * read for either.
 */
export const move = handler<Move, MoveState>((event, { state }) => {
  const actor = currentPrincipal();
  if (actor === undefined) return;
  // A labeled scalar's type is not `string`, though its value is one.
  const next = applyMove(
    parsed(String(state.get() ?? "")),
    event,
    actor,
    spaceAccess(state) === "OWNER",
    Math.random,
  );
  if (next !== undefined) state.set(JSON.stringify(next));
});

//
// The released projection
//

/**
 * What anyone at the table may see. Every field is a scalar: the display
 * boundary releases a scalar `observe` wrote, and refuses a read that covers
 * a list or a record of them (SEALED-STATE-MACHINE-FINDINGS.md, gap C). So a
 * list is written as one string.
 */
export interface ObserverView {
  /** `seating` before the deal, `over` once every slot is captured. */
  phase: "seating" | "playing" | "over";

  /**
   * One character a slot, in slot order: the card's face when it is face-up
   * or captured, and `?` otherwise. A slot's position is its name, the same
   * whatever it holds, and is what `reveal` takes.
   */
  board: string;

  /**
   * One character a slot, in slot order: the seat that captured it, as a
   * digit, or `-` for none.
   */
  owners: string;

  /** The principal in each seat, in seat order, separated by spaces. */
  players: string;

  /** The pairs each seat has captured, in seat order, separated by spaces. */
  scores: string;

  /** The seat whose turn it is, or -1 before the deal. */
  turn: number;

  /** How many slots are face-up and waiting for `resolve`. */
  faceUpCount: number;

  /** How many moves have been applied. */
  version: number;
}

/** The observer's view of `state`. It is total, as `parsed` is. */
function project(state: GameState): ObserverView {
  const { layout, faceUp, capturedBy, players } = state;
  const scores = players.map(() => 0);
  let board = "";
  let owners = "";
  let captured = 0;
  layout.forEach((pair, slot) => {
    const owner = capturedBy[slot] ?? -1;
    if (owner >= 0) captured++;
    if (owner >= 0 && owner < scores.length) scores[owner] += 0.5;
    const shown = owner >= 0 || faceUp.includes(slot);
    board += shown ? FACES[pair] ?? "?" : "?";
    owners += owner >= 0 ? String(owner) : "-";
  });
  return {
    phase: layout.length === 0
      ? "seating"
      : captured === layout.length
      ? "over"
      : "playing",
    board,
    owners,
    players: players.join(" "),
    scores: scores.join(" "),
    turn: state.turn,
    faceUpCount: faceUp.length,
    version: state.version,
  };
}

/**
 * The table's one released function. It is a module-scope `lift` because
 * `TransformedBy` names a function by its module and its export name.
 *
 * Before the first move it returns nothing. The state then holds its default,
 * which `move` did not write, so a view of it would carry no input witness,
 * and a field whose value the first move leaves as it was would keep that
 * view's stamp and stay sealed.
 */
export const observe = lift((
  stored: string | undefined,
): ObserverView | undefined => stored ? project(parsed(stored)) : undefined);

/**
 * Every card's face, in slot order. Defined beside `observe` and named by no
 * rule, so what it computes stays sealed.
 */
export const peek = lift((stored: string | undefined): string =>
  parsed(stored).layout.map((pair) => FACES[pair] ?? "").join("")
);

//
// The table
//

interface SealedStateMachineInput {
  /** The table's state, which starts as the table before anyone sat down. */
  state: Writable<Default<StoredGame, "">>;
}

/** A table of Memory. */
export interface SealedStateMachineOutput {
  [NAME]: string;
  [UI]: VNode;

  /**
   * What the policy releases to the table's readers; `undefined` until the
   * first move.
   */
  view: ObserverView | undefined;

  /** Propose a move as whoever sends it. */
  move: Stream<Move>;
}

/** Sends a move to the table for a button, whose own event carries none. */
const propose = handler<
  unknown,
  { table: Stream<Move>; kind: Move["kind"]; slot: number }
>((_, { table, kind, slot }) => {
  table.send(kind === "reveal" ? { kind, slot } : { kind });
});

// One reveal button for every slot a table can deal. The buttons are not
// drawn from the view: a list derived from it is computed by code the policy
// does not name, so the display boundary would seal it.
const SLOTS = Array.from({ length: 2 * MAX_PAIRS }, (_, slot) => slot);

const SealedStateMachine = pattern<
  SealedStateMachineInput,
  SealedStateMachineOutput
>(({ state }) => {
  const view = observe(state);
  const table = move({ state });
  return {
    [NAME]: "Sealed state machine: Memory",
    [UI]: (
      <cf-screen title="Memory">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <div id="memory-status">
            {view?.phase}, move {view?.version}, seat {view?.turn} to play
          </div>
          <cf-hstack gap="1">
            <cf-button onClick={propose({ table, kind: "sit", slot: -1 })}>
              Sit
            </cf-button>
            <cf-button onClick={propose({ table, kind: "setup", slot: -1 })}>
              Deal
            </cf-button>
            <cf-button
              onClick={propose({ table, kind: "resolve", slot: -1 })}
            >
              Resolve
            </cf-button>
          </cf-hstack>
          <div id="memory-board">{view?.board}</div>
          <cf-hstack gap="1">
            {SLOTS.map((slot) => (
              <cf-button onClick={propose({ table, kind: "reveal", slot })}>
                {slot}
              </cf-button>
            ))}
          </cf-hstack>
          <div id="memory-players">{view?.players}</div>
          <div id="memory-scores">{view?.scores}</div>
        </cf-vstack>
      </cf-screen>
    ),
    view,
    move: table,
  };
});

export default SealedStateMachine;
