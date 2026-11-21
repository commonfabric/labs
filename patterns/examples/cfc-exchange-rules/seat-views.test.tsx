/**
 * One principal at the card table: the table set up, seated and dealt by its
 * owner alone, the requests the rules refuse, and what other code may do to
 * it.
 *
 * The table's rule releases a seat's view to the members of that seat's
 * occupant list, on evidence the runtime mints at a display boundary, which a
 * pattern test does not have. So nothing here shows the release firing;
 * `runtime/html/test/worker-display-fit-seat-views.test.ts` does. What this
 * file shows of the policy is that the setup's seat keys pass the capture
 * check, that no public store takes anything of a view, and that only
 * `seating` writes a seat's list.
 *
 * Pattern under test: ./seat-views.tsx
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
import SeatViews, {
  HAND_SIZE,
  type Occupants,
  type SeatView,
} from "./seat-views.tsx";

/** A store anyone may read: it admits only public values. */
type PublicText = MaxConfidentiality<string, readonly []>;

const UNTOUCHED = "untouched";

/** The view's first card into `to`. */
const publishCard = handler<
  void,
  { from: SeatView | undefined; to: Writable<PublicText> }
>((_, { from, to }) => {
  to.set(from?.hand[0] ?? "");
});

/** A literal into `to`: the control that the store takes a write at all. */
const publishLiteral = handler<void, { to: Writable<PublicText> }>(
  (_, { to }) => {
    to.set("literal");
  },
);

/** Not the list's writer: lists `principal` as the seat's occupant. */
const forge = handler<
  void,
  { list: Writable<Occupants>; principal: string }
>((_, { list, principal }) => {
  list.set([{ principal }]);
});

interface Rooms {
  roomLiteral: Writable<Default<PublicText, typeof UNTOUCHED>>;
  roomCard: Writable<Default<PublicText, typeof UNTOUCHED>>;
}

export default pattern<Rooms>(({ roomLiteral, roomCard }) => {
  const table = SeatViews({} as Parameters<typeof SeatViews>[0]);
  const sitAsSomebodyElse = action(() => {
    table.seating.send({ kind: "sit", seat: 1, occupant: "did:key:nobody" });
  });
  const forgeAnEntry = forge({
    list: table.occupants1,
    principal: table.roster[0],
  });
  return {
    [TESTS]: [
      //
      // Setup
      //

      // No view before the setup, and no deal either.
      { assertion: assert(() => table.view0 === undefined) },
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view0 === undefined) },
      // The setup writes every seat's key, each naming its seat's list, so a
      // view of every seat follows it.
      { action: table.move, event: { kind: "setup" } },
      { assertion: assert(() => table.view0?.version === 1) },
      { assertion: assert(() => table.view0?.seat === 0) },
      { assertion: assert(() => table.view1?.seat === 1) },
      { assertion: assert(() => table.view2?.seat === 2) },
      { assertion: assert(() => table.view0?.hand.length === 0) },
      // A second setup is refused.
      { action: table.move, event: { kind: "setup" } },
      { assertion: assert(() => table.view0?.version === 1) },

      //
      // Seating
      //

      // Nobody sits before seating opens.
      { action: table.seating, event: { kind: "sit", seat: 0 } },
      { assertion: assert(() => table.roster.length === 0) },
      { action: table.seating, event: { kind: "open" } },
      { assertion: assert(() => table.phase === "open") },
      // A seat off the table, a fraction of one, and none at all.
      { action: table.seating, event: { kind: "sit", seat: 3 } },
      { action: table.seating, event: { kind: "sit", seat: -1 } },
      { action: table.seating, event: { kind: "sit", seat: 0.5 } },
      { action: table.seating, event: { kind: "sit" } },
      { assertion: assert(() => table.roster.length === 0) },
      // The owner cannot seat anybody else.
      { action: sitAsSomebodyElse },
      { assertion: assert(() => table.roster.length === 0) },
      { assertion: assert(() => table.occupants1.length === 0) },
      // A seat is taken once, and a principal takes one seat.
      { action: table.seating, event: { kind: "sit", seat: 0 } },
      { assertion: assert(() => table.roster[0] !== "") },
      { assertion: assert(() => table.roster[1] === "") },
      {
        assertion: assert(() =>
          table.occupants0[0]?.principal === table.roster[0]
        ),
      },
      { action: table.seating, event: { kind: "sit", seat: 1 } },
      { assertion: assert(() => table.roster[1] === "") },
      { assertion: assert(() => table.occupants1.length === 0) },

      //
      // The deal
      //

      // No deal while seating is open.
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view0?.version === 1) },
      { action: table.seating, event: { kind: "close" } },
      { assertion: assert(() => table.phase === "closed") },
      // Nobody sits once seating has closed.
      { action: table.seating, event: { kind: "sit", seat: 2 } },
      { assertion: assert(() => table.roster[2] === "") },
      // The occupied seat is dealt a hand, and the empty ones none.
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view0?.version === 2) },
      { assertion: assert(() => table.view0?.hand.length === HAND_SIZE) },
      { assertion: assert(() => table.view1?.hand.length === 0) },
      { assertion: assert(() => table.view1?.counts[0] === HAND_SIZE) },
      // A second deal is refused.
      { action: table.move, event: { kind: "deal" } },
      { assertion: assert(() => table.view0?.version === 2) },

      // The view renders.
      { render: table[UI] },

      //
      // What other code may do
      //

      { action: publishLiteral({ to: roomLiteral }) },
      { assertion: assert(() => roomLiteral.get() === "literal") },
      // A view is released to its seat's occupants, not to everyone, so a
      // public store refuses a card of it.
      { action: publishCard({ from: table.view0, to: roomCard }) },
      { assertion: assert(() => roomCard.get() === UNTOUCHED) },
      // Code that is not `seating` cannot write a seat's list.
      { action: forgeAnEntry },
      { assertion: assert(() => table.occupants1.length === 0) },
    ],
    // The refused publish and the refused forgery each log a CFC refusal.
    allowConsoleWarnings: true,
    table,
  };
});
