/**
 * Two players and a watcher at one card table, each in their own runtime
 * under their own principal. Alice owns the table and takes seat 0, Bob
 * takes seat 1, and Carol only watches. A setup, a deal and a close of
 * seating by someone who does not own the table, and a seat taken in
 * somebody else's name, are refused.
 *
 * A pattern test has no display boundary, so every participant here reads
 * every seat's view, whoever it is released to. What each principal is
 * shown is decided in
 * `runtime/html/test/worker-display-fit-seat-views.test.ts`. What this file
 * shows is that the table works when each principal's requests are run for
 * that principal, with server execution on and off: the owner's setup passes
 * the capture check, and a player's own request seats that player.
 *
 * Pattern under test: ./seat-views.tsx
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import SeatViews, {
  HAND_SIZE,
  type Seating,
  type SeatViewsOutput,
} from "./seat-views.tsx";

interface Setup {
  table: SeatViewsOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  table: SeatViews({} as Parameters<typeof SeatViews>[0]),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  return {
    [TESTS]: [
      // The setup is the owner's, and Alice is the owner. Its seat keys pass
      // the capture check, or no view would follow it.
      { action: table.move, event: { kind: "setup" } },
      { assertion: assert(() => table.view0?.version === 1) },
      { assertion: assert(() => table.view1?.seat === 1) },
      { action: table.seating, event: { kind: "open" } },
      { assertion: assert(() => table.phase === "open") },
      { label: "open" },
      { await: "carol-tried" },
      // Bob seated himself, and nobody was seated in his name.
      { assertion: assert(() => table.roster[1] !== "") },
      { assertion: assert(() => table.roster[2] === "") },
      { assertion: assert(() => table.phase === "open") },
      { assertion: assert(() => table.view0?.version === 1) },
      { action: table.seating, event: { kind: "sit", seat: 0 } },
      { assertion: assert(() => table.roster[0] !== "") },
      { assertion: assert(() => table.roster[0] !== table.roster[1]) },
      { action: table.seating, event: { kind: "close" } },
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view0?.version === 2) },
      { assertion: assert(() => table.view0?.hand.length === HAND_SIZE) },
      { assertion: assert(() => table.view1?.hand.length === HAND_SIZE) },
      { assertion: assert(() => table.view2?.hand.length === 0) },
      { label: "dealt" },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  return {
    [TESTS]: [
      { await: "open" },
      // The setup, the deal and the close of seating are the owner's, and
      // Bob is not the owner.
      { action: table.move, event: { kind: "setup" } },
      { action: table.move, event: { kind: "deal" } },
      { action: table.seating, event: { kind: "close" } },
      { assertion: assert(() => table.view0?.version === 1) },
      { assertion: assert(() => table.phase === "open") },
      // Bob sits, and his seat's list names him.
      { action: table.seating, event: { kind: "sit", seat: 1 } },
      { assertion: assert(() => table.roster[1] !== "") },
      {
        assertion: assert(() =>
          table.occupants1[0]?.principal === table.roster[1]
        ),
      },
      { label: "bob-sat" },
      { await: "dealt" },
      // The deal reaches Bob, and a deal of his own is refused.
      { assertion: assert(() => table.view1?.hand.length === HAND_SIZE) },
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view1?.version === 2) },
    ],
  };
});

export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  // A seat for Bob, who is the principal in seat 1. `Seating` lets a request
  // name its occupant, and `seating` refuses one that names anybody but its
  // proposer.
  const sitForBob = action(() => {
    const request: Seating = {
      kind: "sit",
      seat: 2,
      occupant: table.roster[1],
    };
    table.seating.send(request);
  });
  return {
    [TESTS]: [
      { await: "bob-sat" },
      { action: sitForBob },
      { assertion: assert(() => table.roster[2] === "") },
      { assertion: assert(() => table.occupants2.length === 0) },
      { label: "carol-tried" },
      { await: "dealt" },
      // Seating has closed, so Carol cannot sit for herself either.
      { action: table.seating, event: { kind: "sit", seat: 2 } },
      { assertion: assert(() => table.roster[2] === "") },
      { assertion: assert(() => table.view2?.hand.length === 0) },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    carol: { pattern: carol, access: "WRITE" },
  },
});
