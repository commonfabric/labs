/**
 * One principal at a table of Memory: the game played alone, the moves the
 * rules refuse, and what a public store takes of the table.
 *
 * The table's rule releases the observer view to a reader of the table's
 * space, on evidence the runtime mints at a display boundary, which a pattern
 * test does not have. So nothing here shows the release firing;
 * `runtime/html/test/worker-display-fit-sealed-state-machine.test.ts` does.
 * What this file shows of the policy is that no public store takes anything
 * of the table, the released view included.
 *
 * Pattern under test: ./sealed-state-machine.tsx
 */
import {
  action,
  assert,
  type Default,
  handler,
  type MaxConfidentiality,
  pattern,
  TESTS,
  UI,
  type Writable,
} from "commonfabric";
import SealedStateMachine, {
  type ObserverView,
  peek,
  type StoredGame,
} from "./sealed-state-machine.tsx";

/** A store anyone may read: it admits only public values. */
type PublicText = MaxConfidentiality<string, readonly []>;

const UNTOUCHED = "untouched";

/** The view's board into `to`. */
const publishBoard = handler<
  void,
  { from: ObserverView | undefined; to: Writable<PublicText> }
>((_, { from, to }) => {
  to.set(from?.board ?? "");
});

/** A string read as it is into `to`. */
const publishText = handler<void, { from: string; to: Writable<PublicText> }>(
  (_, { from, to }) => {
    to.set(String(from ?? ""));
  },
);

/** A literal into `to`: the control that the store takes a write at all. */
const publishLiteral = handler<void, { to: Writable<PublicText> }>(
  (_, { to }) => {
    to.set("literal");
  },
);

/** Not the table's writer: deals a board with every card face-up. */
const forge = handler<void, { state: Writable<StoredGame> }>(
  (_, { state }) => {
    state.set(JSON.stringify({
      layout: [0, 0],
      faceUp: [0, 1],
      capturedBy: [-1, -1],
      players: [],
      turn: 0,
      version: 99,
      history: [],
    }));
  },
);

/**
 * Whether the board shows a face for exactly the slots that are captured or
 * face-up: as many faces as there are captured slots and cards turned.
 */
function showsOnlyTurnedCards(view: ObserverView | undefined): boolean {
  const board = [...(view?.board ?? "")];
  const owners = view?.owners ?? "";
  const shown = board.filter((face) => face !== "?").length;
  const captured = board.filter((_, slot) => owners[slot] !== "-").length;
  return view !== undefined &&
    shown === captured + view.faceUpCount &&
    board.every((face, slot) => owners[slot] === "-" || face !== "?");
}

type Room = Writable<Default<PublicText, typeof UNTOUCHED>>;

interface Rooms {
  /** The state of a table this test lends its state to, to probe it raw. */
  lentState: Writable<Default<StoredGame, "">>;
  roomLiteral: Room;
  roomBoard: Room;
  roomState: Room;
  roomPeek: Room;
}

export default pattern<Rooms>(
  ({ lentState, roomLiteral, roomBoard, roomState, roomPeek }) => {
    const table = SealedStateMachine(
      {} as Parameters<typeof SealedStateMachine>[0],
    );
    const lent = SealedStateMachine({ state: lentState });
    const peeked = peek(lentState);

    const resolve = action(() => table.move.send({ kind: "resolve" }));

    // The partner of slot 0 is slot 1, 2 or 3, and the test cannot read
    // which. It turns slot 0 with each in turn: a pair is captured, a miss is
    // hidden again. Once slot 0 is captured the later tries do nothing, and
    // the two slots left are the other pair.
    const tryPartner2 = action(() => {
      if (table.view?.owners[0] !== "-") return;
      table.move.send({ kind: "reveal", slot: 0 });
      table.move.send({ kind: "reveal", slot: 2 });
    });
    const tryPartner3 = action(() => {
      if (table.view?.owners[0] !== "-") return;
      table.move.send({ kind: "reveal", slot: 0 });
      table.move.send({ kind: "reveal", slot: 3 });
    });
    const revealRest = action(() => {
      const owners = table.view?.owners ?? "";
      for (let slot = 0; slot < owners.length; slot++) {
        if (owners[slot] === "-") table.move.send({ kind: "reveal", slot });
      }
    });

    return {
      [TESTS]: [
        // Before the first move there is no view at all.
        { assertion: assert(() => table.view === undefined) },

        // A reveal before the deal, and a deal with nobody seated, are
        // refused: the state does not move.
        { action: table.move, event: { kind: "reveal", slot: 0 } },
        { action: table.move, event: { kind: "setup", pairs: 2 } },
        { assertion: assert(() => table.view === undefined) },

        { action: table.move, event: { kind: "sit" } },
        { assertion: assert(() => table.view?.version === 1) },
        { assertion: assert(() => table.view?.phase === "seating") },
        // Sitting twice is refused.
        { action: table.move, event: { kind: "sit" } },
        { assertion: assert(() => table.view?.version === 1) },

        // A deal of more pairs than there are faces is refused.
        { action: table.move, event: { kind: "setup", pairs: 13 } },
        { assertion: assert(() => table.view?.version === 1) },

        // The deal: every slot hidden, nothing captured.
        { action: table.move, event: { kind: "setup", pairs: 2 } },
        { assertion: assert(() => table.view?.version === 2) },
        { assertion: assert(() => table.view?.board === "????") },
        { assertion: assert(() => table.view?.owners === "----") },
        { assertion: assert(() => table.view?.phase === "playing") },
        { assertion: assert(() => table.view?.turn === 0) },
        // A second deal is refused.
        { action: table.move, event: { kind: "setup", pairs: 2 } },
        { assertion: assert(() => table.view?.version === 2) },

        // Illegal reveals: off the board, a fraction, and no slot at all.
        { action: table.move, event: { kind: "reveal", slot: 4 } },
        { action: table.move, event: { kind: "reveal", slot: -1 } },
        { action: table.move, event: { kind: "reveal", slot: 0.5 } },
        { action: table.move, event: { kind: "reveal" } },
        // A resolve with nothing face-up.
        { action: resolve },
        { assertion: assert(() => table.view?.version === 2) },

        // One card face-up: its face shows, the other three do not.
        { action: table.move, event: { kind: "reveal", slot: 0 } },
        { assertion: assert(() => table.view?.version === 3) },
        { assertion: assert(() => table.view?.board[0] !== "?") },
        { assertion: assert(() => table.view?.board.slice(1) === "???") },
        { assertion: assert(() => showsOnlyTurnedCards(table.view)) },
        // The same slot again, and a resolve with one card up, are refused.
        { action: table.move, event: { kind: "reveal", slot: 0 } },
        { action: resolve },
        { assertion: assert(() => table.view?.version === 3) },
        { action: table.move, event: { kind: "reveal", slot: 1 } },
        { assertion: assert(() => table.view?.faceUpCount === 2) },
        // A third card is refused.
        { action: table.move, event: { kind: "reveal", slot: 2 } },
        { assertion: assert(() => table.view?.version === 4) },
        { assertion: assert(() => table.view?.board.slice(2) === "??") },
        { action: resolve },
        { assertion: assert(() => table.view?.version === 5) },
        { assertion: assert(() => table.view?.faceUpCount === 0) },
        { assertion: assert(() => showsOnlyTurnedCards(table.view)) },

        // Slot 0's partner is slot 1, 2 or 3. Each try that finds slot 0
        // still on the table turns it with the next candidate.
        { action: tryPartner2 },
        { assertion: assert(() => showsOnlyTurnedCards(table.view)) },
        { action: resolve },
        { assertion: assert(() => showsOnlyTurnedCards(table.view)) },
        { action: tryPartner3 },
        { assertion: assert(() => showsOnlyTurnedCards(table.view)) },
        { action: resolve },
        { assertion: assert(() => table.view?.owners[0] === "0") },
        { assertion: assert(() => table.view?.scores === "1") },
        // A captured slot cannot be revealed again.
        { action: table.move, event: { kind: "reveal", slot: 0 } },
        { assertion: assert(() => table.view?.faceUpCount === 0) },

        // The two slots left are the other pair.
        { action: revealRest },
        { action: resolve },
        { assertion: assert(() => table.view?.phase === "over") },
        { assertion: assert(() => table.view?.scores === "2") },
        { assertion: assert(() => table.view?.owners === "0000") },
        { assertion: assert(() => !table.view?.board.includes("?")) },

        // The view renders.
        { render: table[UI] },

        //
        // What a public store takes
        //

        { action: publishLiteral({ to: roomLiteral }) },
        { assertion: assert(() => roomLiteral.get() === "literal") },
        // The released view is released to the table's readers, not to
        // everyone, so a public store refuses it.
        { action: publishBoard({ from: table.view, to: roomBoard }) },
        { assertion: assert(() => roomBoard.get() === UNTOUCHED) },

        // A table lent its state plays as one that holds it.
        { action: lent.move, event: { kind: "sit" } },
        { action: lent.move, event: { kind: "setup", pairs: 3 } },
        { assertion: assert(() => lent.view?.board === "??????") },
        // The state read raw, and every face as a function no rule names
        // computes them, are refused.
        { assertion: assert(() => peeked.length === 6) },
        { action: publishText({ from: lentState, to: roomState }) },
        { action: publishText({ from: peeked, to: roomPeek }) },
        { assertion: assert(() => roomState.get() === UNTOUCHED) },
        { assertion: assert(() => roomPeek.get() === UNTOUCHED) },
        // Code that is not `move` cannot write the state.
        { action: forge({ state: lentState }) },
        { assertion: assert(() => lent.view?.version === 2) },
        { assertion: assert(() => lent.view?.board === "??????") },
      ],
      // Each refused publish, and the refused forgery, logs a CFC refusal.
      allowConsoleWarnings: true,
      allowConsoleErrors: true,
      table,
      lent,
      peeked,
    };
  },
);
