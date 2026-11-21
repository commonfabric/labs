/**
 * Two players and a watcher at one table of Memory, each in their own runtime
 * under their own principal. Alice owns the table and takes seat 0, Bob takes
 * seat 1, and Carol only watches. A move out of turn, a deal by someone who
 * does not own the table, and a move whose payload names someone else as its
 * proposer are refused. Then the two play the game out and agree on the
 * score.
 *
 * Neither player can read the layout, so neither can be scripted: each plays
 * from the observer view and from notes of the faces it has shown. A round
 * gives each player one step, in which the player whose turn it is makes one
 * move and the other makes none, so every player sees the table after every
 * move. Every step checks that the view shows a face only for a card that is
 * captured or turned.
 *
 * Pattern under test: ./sealed-state-machine.tsx
 */
import {
  action,
  assert,
  multiUserTest,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import SealedStateMachine, {
  type Move,
  type ObserverView,
  type SealedStateMachineOutput,
} from "./sealed-state-machine.tsx";

const PAIRS = 3;

/**
 * Rounds enough to finish any game of `PAIRS` pairs. A turn is at most three
 * moves, and either captures a pair or turns a card nobody had seen, so there
 * are at most `3 * PAIRS` turns. Every round in which the game is not over
 * makes one move.
 */
const ROUNDS = 9 * PAIRS;

interface Setup {
  table: SealedStateMachineOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  table: SealedStateMachine(
    {} as Parameters<typeof SealedStateMachine>[0],
  ),
}));

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

/** `seen` with every face `view` shows written at its slot. */
function noted(seen: string, view: ObserverView): string {
  return [...view.board].map((face, slot) =>
    face !== "?" ? face : seen[slot] ?? "?"
  ).join("");
}

/**
 * The move a player with a perfect memory makes, given the faces it has
 * `seen`, or `undefined` when `view` leaves `seat` nothing to do.
 */
function nextMove(
  view: ObserverView,
  seen: string,
  seat: number,
): Move | undefined {
  if (view.phase !== "playing" || view.turn !== seat) return undefined;
  if (view.faceUpCount === 2) return { kind: "resolve" };
  const slots = [...view.board].map((_, slot) => slot);
  const hidden = slots.filter((slot) => view.board[slot] === "?");
  const unseen = hidden.filter((slot) => (seen[slot] ?? "?") === "?");
  if (view.faceUpCount === 1) {
    const turned = slots.find((slot) =>
      view.board[slot] !== "?" && view.owners[slot] === "-"
    );
    const partner = hidden.find((slot) =>
      turned !== undefined && seen[slot] === view.board[turned]
    );
    return { kind: "reveal", slot: partner ?? unseen[0] ?? hidden[0] };
  }
  const known = hidden.find((slot) =>
    seen[slot] !== "?" && seen[slot] !== undefined &&
    hidden.some((other) => other !== slot && seen[other] === seen[slot])
  );
  return { kind: "reveal", slot: known ?? unseen[0] ?? hidden[0] };
}

/** Whether `view` has two cards turned that match. */
function pairTurned(view: ObserverView): boolean {
  const turned = [...view.board].filter((face, slot) =>
    face !== "?" && view.owners[slot] === "-"
  );
  return turned.length === 2 && turned[0] === turned[1];
}

/** The steps of one player's rounds, each waiting for the other's step. */
function rounds(
  step: Stream<void>,
  sound: ReturnType<typeof assert>,
  me: string,
  other: string,
  first: boolean,
) {
  const steps = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const before = first ? `${other}-${round - 1}` : `${other}-${round}`;
    steps.push(
      { await: before },
      { action: step },
      { assertion: sound },
      { label: `${me}-${round}` },
    );
  }
  return steps;
}

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  const seen = new Writable("");
  const captures = new Writable(0);
  const step = action(() => {
    const view = table.view;
    if (view === undefined) return;
    seen.set(noted(seen.get(), view));
    const proposed = nextMove(view, seen.get(), 0);
    if (proposed === undefined) return;
    if (proposed.kind === "resolve" && pairTurned(view)) {
      captures.set(captures.get() + 1);
    }
    table.move.send(proposed);
  });
  const sound = assert(() => showsOnlyTurnedCards(table.view));
  return {
    [TESTS]: [
      // The first move of the table: Alice takes seat 0.
      { action: table.move, event: { kind: "sit" } },
      { assertion: assert(() => table.view?.version === 1) },
      { assertion: assert(() => table.view?.phase === "seating") },
      { label: "alice-sat" },
      { await: "bob-sat" },
      { assertion: assert(() => table.view?.version === 2) },
      // The deal is the owner's, and Alice is the owner.
      { action: table.move, event: { kind: "setup", pairs: PAIRS } },
      { assertion: assert(() => table.view?.version === 3) },
      { assertion: assert(() => table.view?.board === "??????") },
      { assertion: assert(() => table.view?.turn === 0) },
      { label: "dealt" },
      { await: "bob-refused" },
      // Nothing Bob tried moved the table.
      { assertion: assert(() => table.view?.version === 3) },
      { assertion: assert(() => table.view?.board === "??????") },
      { label: "bob-0" },
      ...rounds(step, sound, "alice", "bob", true),
      { await: `bob-${ROUNDS}` },
      { assertion: assert(() => table.view?.phase === "over") },
      { assertion: assert(() => !table.view?.board.includes("?")) },
      // Alice's score is the pairs she captured, and the two scores are
      // every pair.
      {
        assertion: assert(() =>
          table.view?.scores.split(" ")[0] === String(captures.get())
        ),
      },
      {
        assertion: assert(() =>
          (table.view?.scores ?? "").split(" ").map(Number).reduce(
            (sum, score) => sum + score,
            0,
          ) === PAIRS
        ),
      },
      { label: "alice-done" },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  const seen = new Writable("");
  const captures = new Writable(0);
  const step = action(() => {
    const view = table.view;
    if (view === undefined) return;
    seen.set(noted(seen.get(), view));
    const proposed = nextMove(view, seen.get(), 1);
    if (proposed === undefined) return;
    if (proposed.kind === "resolve" && pairTurned(view)) {
      captures.set(captures.get() + 1);
    }
    table.move.send(proposed);
  });
  // A reveal that names Alice, whose turn it is, as its proposer. `Move` has
  // no such field, so the payload is not a `Move`.
  const forgeProposer = action(() => {
    const forged = {
      kind: "reveal",
      slot: 0,
      proposer: (table.view?.players ?? "").split(" ")[0],
      acting: (table.view?.players ?? "").split(" ")[0],
    };
    table.move.send(forged as Move);
  });
  const sound = assert(() => showsOnlyTurnedCards(table.view));
  return {
    [TESTS]: [
      { await: "alice-sat" },
      // The view Alice's first move released reaches Bob.
      { assertion: assert(() => table.view?.version === 1) },
      // The deal is the owner's, and Bob is not the owner.
      { action: table.move, event: { kind: "setup", pairs: PAIRS } },
      { assertion: assert(() => table.view?.phase === "seating") },
      { action: table.move, event: { kind: "sit" } },
      { assertion: assert(() => table.view?.version === 2) },
      { assertion: assert(() => table.view?.players.split(" ").length === 2) },
      { label: "bob-sat" },
      { await: "dealt" },
      // The first deal reaches Bob, with every card hidden.
      { assertion: assert(() => table.view?.board === "??????") },
      { assertion: sound },
      // It is Alice's turn: Bob's reveal, his reveal in her name, and his
      // resolve are refused.
      { action: table.move, event: { kind: "reveal", slot: 0 } },
      { action: forgeProposer },
      { action: table.move, event: { kind: "resolve" } },
      { assertion: assert(() => table.view?.version === 3) },
      { assertion: assert(() => table.view?.board === "??????") },
      { label: "bob-refused" },
      ...rounds(step, sound, "bob", "alice", false),
      { await: "alice-done" },
      { assertion: assert(() => table.view?.phase === "over") },
      {
        assertion: assert(() =>
          table.view?.scores.split(" ")[1] === String(captures.get())
        ),
      },
      { label: "bob-done" },
    ],
  };
});

export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  return {
    [TESTS]: [
      { await: "dealt" },
      // Carol has no seat, so nothing she proposes moves the table.
      { action: table.move, event: { kind: "reveal", slot: 0 } },
      { action: table.move, event: { kind: "sit" } },
      { assertion: assert(() => table.view?.players.split(" ").length === 2) },
      { assertion: assert(() => showsOnlyTurnedCards(table.view)) },
      { await: "bob-done" },
      // Carol sees the table the players see.
      { assertion: assert(() => table.view?.phase === "over") },
      { assertion: assert(() => !table.view?.board.includes("?")) },
      { assertion: assert(() => table.view?.owners.length === 2 * PAIRS) },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    carol: { pattern: carol, access: "READ" },
  },
});
