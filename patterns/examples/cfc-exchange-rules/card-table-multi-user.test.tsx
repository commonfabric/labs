/**
 * Two players and a watcher at one card table, each in their own runtime
 * under their own principal. Alice owns the table and takes seat 0, Bob takes
 * seat 2 of four, and Carol only watches.
 *
 * The table's view is computed once for each principal who looks, so each
 * participant here reads their own instance of it: Alice's holds Alice's
 * hand, Bob's holds Bob's, and Carol's holds none. A participant has no way
 * to read another's instance, which is why no assertion here compares two
 * hands. What each principal is shown of an instance is decided at the
 * display boundary, in
 * `runtime/html/test/worker-display-fit-card-table.test.ts`.
 *
 * Run with `EXPERIMENTAL_VIEWER_BOUND_RELEASE=true`, which the pattern test
 * lane sets for this file (`PATTERN_TEST_ENVIRONMENT` in
 * `tasks/integration.ts`).
 *
 * Pattern under test: ./card-table.tsx
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import CardTable, {
  type CardTableOutput,
  HAND_SIZE,
  type Move,
} from "./card-table.tsx";

interface Setup {
  table: CardTableOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  table: CardTable({} as Parameters<typeof CardTable>[0]),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  return {
    [TESTS]: [
      { assertion: assert(() => table.view.phase === "new") },
      // The setup is the owner's, and Alice is the owner.
      { action: table.move, event: { kind: "setup", seats: 4 } },
      { assertion: assert(() => table.view.phase === "seating") },
      { assertion: assert(() => table.view.taken.length === 4) },
      { assertion: assert(() => table.view.seat === -1) },
      { label: "seating" },
      { await: "carol-tried" },
      // Bob seated himself, and nobody was seated by Carol's request.
      { assertion: assert(() => table.view.taken[2] === true) },
      { assertion: assert(() => table.view.taken[3] === false) },
      { action: table.move, event: { kind: "sit", seat: 0 } },
      { assertion: assert(() => table.view.seat === 0) },
      // A principal holds one seat.
      { action: table.move, event: { kind: "sit", seat: 1 } },
      { assertion: assert(() => table.view.taken[1] === false) },
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view.phase === "playing") },
      { assertion: assert(() => table.view.hand.length === HAND_SIZE) },
      { assertion: assert(() => table.view.counts[2] === HAND_SIZE) },
      { assertion: assert(() => table.view.counts[1] === 0) },
      { label: "dealt" },
      { await: "bob-left" },
      // Bob's seat is empty again, and Alice still holds her hand.
      { assertion: assert(() => table.view.taken[2] === false) },
      { assertion: assert(() => table.view.counts[2] === 0) },
      { assertion: assert(() => table.view.hand.length === HAND_SIZE) },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  return {
    [TESTS]: [
      { await: "seating" },
      // The setup and the deal are the owner's, and Bob is not the owner.
      { action: table.move, event: { kind: "setup", seats: 2 } },
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view.phase === "seating") },
      { assertion: assert(() => table.view.taken.length === 4) },
      { action: table.move, event: { kind: "sit", seat: 2 } },
      { assertion: assert(() => table.view.seat === 2) },
      { label: "bob-sat" },
      { await: "dealt" },
      // The deal reaches Bob's own view, and a draw adds a card to it.
      { assertion: assert(() => table.view.hand.length === HAND_SIZE) },
      { action: table.move, event: { kind: "draw" } },
      { assertion: assert(() => table.view.hand.length === HAND_SIZE + 1) },
      // Bob leaves, and his view holds no hand from then on.
      { action: table.move, event: { kind: "leave" } },
      { assertion: assert(() => table.view.seat === -1) },
      { assertion: assert(() => table.view.hand.length === 0) },
      { label: "bob-left" },
    ],
  };
});

export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const table = setup.table;
  // A seat taken with a request that names somebody else. A move carries no
  // proposer, so the extra field changes nothing: the seat goes to whoever
  // sent the request.
  const sitAsSomebodyElse = action(() => {
    const request = {
      kind: "sit",
      seat: 3,
      occupant: "did:key:somebody-else",
      proposer: "did:key:somebody-else",
    };
    table.move.send(request as Move);
  });
  return {
    [TESTS]: [
      { await: "bob-sat" },
      // A seat somebody holds is not taken twice.
      { action: table.move, event: { kind: "sit", seat: 2 } },
      { assertion: assert(() => table.view.seat === -1) },
      // The request seats Carol, its sender, and nobody else. She leaves
      // again, so that she only watches the deal.
      { action: sitAsSomebodyElse },
      { assertion: assert(() => table.view.seat === 3) },
      { action: table.move, event: { kind: "leave" } },
      { assertion: assert(() => table.view.seat === -1) },
      { label: "carol-tried" },
      { await: "dealt" },
      // A watcher's view holds the public facts and no hand.
      { assertion: assert(() => table.view.phase === "playing") },
      { assertion: assert(() => table.view.hand.length === 0) },
      { action: table.move, event: { kind: "draw" } },
      { assertion: assert(() => table.view.hand.length === 0) },
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
