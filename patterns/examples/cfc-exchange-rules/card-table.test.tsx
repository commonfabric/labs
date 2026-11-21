/**
 * One principal at the card table: the table set up, seated and dealt by its
 * owner alone, the moves the rules refuse, and what other code may do to it.
 *
 * The table's rule releases the view to the principal it was computed for,
 * at a boundary that asks who is reading. A pattern test has no such
 * boundary, so nothing here shows the release firing;
 * `runtime/html/test/worker-display-fit-card-table.test.ts` does. What this
 * file shows of the policy is that no public store takes anything of a view,
 * and that only `move` writes the state.
 *
 * Run with `EXPERIMENTAL_VIEWER_BOUND_RELEASE=true`, which the pattern test
 * lane sets for this file (`PATTERN_TEST_ENVIRONMENT` in
 * `tasks/integration.ts`).
 *
 * Pattern under test: ./card-table.tsx
 */
import {
  assert,
  type Default,
  handler,
  type MaxConfidentiality,
  pattern,
  TESTS,
  UI,
  type Writable,
} from "commonfabric";
import CardTable, {
  HAND_SIZE,
  MAX_SEATS,
  type TableView,
} from "./card-table.tsx";

/** A store anyone may read: it admits only public values. */
type PublicText = MaxConfidentiality<string, readonly []>;

const UNTOUCHED = "untouched";

/** The view's first card into `to`. */
const publishCard = handler<
  void,
  { from: TableView; to: Writable<PublicText> }
>((_, { from, to }) => {
  to.set(from?.hand[0] ?? "");
});

/** A literal into `to`: the control that the store takes a write at all. */
const publishLiteral = handler<void, { to: Writable<PublicText> }>(
  (_, { to }) => {
    to.set("literal");
  },
);

interface Rooms {
  roomLiteral: Writable<Default<PublicText, typeof UNTOUCHED>>;
  roomCard: Writable<Default<PublicText, typeof UNTOUCHED>>;
}

export default pattern<Rooms>(({ roomLiteral, roomCard }) => {
  const table = CardTable({} as Parameters<typeof CardTable>[0]);
  return {
    [TESTS]: [
      //
      // Setup
      //

      // The table before its setup has no seats, and takes no other move.
      { assertion: assert(() => table.view.phase === "new") },
      { assertion: assert(() => table.view.taken.length === 0) },
      { action: table.move, event: { kind: "sit", seat: 0 } },
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view.version === 0) },
      // A setup with no seats, with too many, and with a fraction of one.
      { action: table.move, event: { kind: "setup", seats: 0 } },
      { action: table.move, event: { kind: "setup", seats: MAX_SEATS + 1 } },
      { action: table.move, event: { kind: "setup", seats: 2.5 } },
      { action: table.move, event: { kind: "setup" } },
      { assertion: assert(() => table.view.phase === "new") },
      // The number of seats is the setup's to choose.
      { action: table.move, event: { kind: "setup", seats: 5 } },
      { assertion: assert(() => table.view.phase === "seating") },
      { assertion: assert(() => table.view.taken.length === 5) },
      { assertion: assert(() => table.view.version === 1) },
      // A second setup is refused.
      { action: table.move, event: { kind: "setup", seats: 2 } },
      { assertion: assert(() => table.view.taken.length === 5) },

      //
      // Seating
      //

      // A seat off the table, a fraction of one, and none at all.
      { action: table.move, event: { kind: "sit", seat: 5 } },
      { action: table.move, event: { kind: "sit", seat: -1 } },
      { action: table.move, event: { kind: "sit", seat: 0.5 } },
      { action: table.move, event: { kind: "sit" } },
      { assertion: assert(() => table.view.seat === -1) },
      // No deal with nobody seated, and no draw before the deal.
      { action: table.move, event: { kind: "deal" } },
      { action: table.move, event: { kind: "draw" } },
      { assertion: assert(() => table.view.phase === "seating") },
      // A principal takes one seat, leaves it, and takes another.
      { action: table.move, event: { kind: "sit", seat: 3 } },
      { assertion: assert(() => table.view.seat === 3) },
      { action: table.move, event: { kind: "sit", seat: 4 } },
      { assertion: assert(() => table.view.seat === 3) },
      { assertion: assert(() => table.view.taken[4] === false) },
      { action: table.move, event: { kind: "leave" } },
      { assertion: assert(() => table.view.seat === -1) },
      { action: table.move, event: { kind: "leave" } },
      { action: table.move, event: { kind: "sit", seat: 1 } },
      { assertion: assert(() => table.view.seat === 1) },
      { assertion: assert(() => table.view.version === 4) },

      //
      // The deal
      //

      // The occupied seat is dealt a hand, and the empty ones none.
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view.phase === "playing") },
      { assertion: assert(() => table.view.hand.length === HAND_SIZE) },
      { assertion: assert(() => table.view.counts[1] === HAND_SIZE) },
      { assertion: assert(() => table.view.counts[0] === 0) },
      { assertion: assert(() => table.view.deck === 52 - HAND_SIZE) },
      // A second deal is refused, and nobody sits once cards are out.
      { action: table.move, event: { kind: "deal" } },
      { action: table.move, event: { kind: "sit", seat: 2 } },
      { assertion: assert(() => table.view.version === 5) },
      // A draw moves the deck's top card into the hand.
      { action: table.move, event: { kind: "draw" } },
      { assertion: assert(() => table.view.hand.length === HAND_SIZE + 1) },
      { assertion: assert(() => table.view.deck === 52 - HAND_SIZE - 1) },

      // The view renders.
      { render: table[UI] },

      //
      // What other code may do
      //

      { action: publishLiteral({ to: roomLiteral }) },
      { assertion: assert(() => roomLiteral.get() === "literal") },
      // A view is released to the principal it was computed for, not to
      // everyone, so a public store refuses a card of it.
      { action: publishCard({ from: table.view, to: roomCard }) },
      { assertion: assert(() => roomCard.get() === UNTOUCHED) },
    ],
    // The refused publish logs a CFC refusal.
    allowConsoleWarnings: true,
    table,
  };
});
