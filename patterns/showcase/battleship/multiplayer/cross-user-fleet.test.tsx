/// <cts-enable />
/**
 * Multi-user pattern test: each player reads the nested fleet the other
 * player wrote.
 *
 * Battleship hands each player a cell their opponent writes. The shape that
 * once read back wrong across sessions is the one held here: the owning
 * pattern declares the cells `Writable<Fleet | null | Default<null>>`, the
 * reading pattern takes them as `Writable<Fleet | null>`, and the value is an
 * array of objects that each nest an object and an array. Read from the other
 * user's runtime, the array kept its length while every element came back
 * `undefined`. Both players here read the other's fleet down to the nested
 * fields.
 *
 * Write order is deterministic (markers): Alice first, then Bob.
 */
import {
  action,
  assert,
  computed,
  Default,
  handler,
  multiUserTest,
  pattern,
  Stream,
  TESTS,
  Writable,
} from "commonfabric";

interface Coordinate {
  row: number;
  col: number;
}

interface Ship {
  id: number;
  name: string;
  start: Coordinate;
  hits: boolean[];
}

interface Fleet {
  label: string;
  ships: Ship[];
}

interface ViewInput {
  otherFleet: Writable<Fleet | null>;
}

interface ViewOutput {
  otherFirstShip: Ship | null;
  otherShipCount: number;
}

const FleetView = pattern<ViewInput, ViewOutput>(({ otherFleet }) => ({
  otherFirstShip: computed(() => otherFleet.get()?.ships[0] ?? null),
  otherShipCount: computed(() => otherFleet.get()?.ships.length ?? 0),
}));

function shipsFor(label: string): Ship[] {
  return label === "Alice"
    ? [
      {
        id: 1,
        name: "A-Ship1",
        start: { row: 0, col: 0 },
        hits: [false, false],
      },
      { id: 2, name: "A-Ship2", start: { row: 2, col: 3 }, hits: [true] },
    ]
    : [
      {
        id: 10,
        name: "B-Ship1",
        start: { row: 5, col: 5 },
        hits: [false, true, false, false],
      },
      { id: 11, name: "B-Ship2", start: { row: 7, col: 1 }, hits: [false] },
    ];
}

const placeFleet = handler<
  void,
  { fleet: Writable<Fleet | null>; label: string }
>((_event, { fleet, label }) => {
  fleet.set({ label, ships: shipsFor(label) });
});

interface BoardsInput {
  fleet1: Writable<Fleet | null | Default<null>>;
  fleet2: Writable<Fleet | null | Default<null>>;
}

interface BoardsOutput {
  placeFleet1: Stream<void>;
  placeFleet2: Stream<void>;
  player1View: ViewOutput;
  player2View: ViewOutput;
}

const Boards = pattern<BoardsInput, BoardsOutput>(({ fleet1, fleet2 }) => ({
  placeFleet1: placeFleet({ fleet: fleet1, label: "Alice" }),
  placeFleet2: placeFleet({ fleet: fleet2, label: "Bob" }),
  player1View: FleetView({ otherFleet: fleet2 }),
  player2View: FleetView({ otherFleet: fleet1 }),
}));

interface Setup {
  boards: BoardsOutput;
}

export const setup = pattern(() => ({
  boards: Boards({ fleet1: null, fleet2: null }),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const boards = setup.boards;

  const action_place = action(() => {
    boards.placeFleet1.send();
  });

  const assert_reads_bobs_fleet = assert(() =>
    boards.player1View.otherShipCount === 2 &&
    boards.player1View.otherFirstShip?.id === 10 &&
    boards.player1View.otherFirstShip?.name === "B-Ship1" &&
    boards.player1View.otherFirstShip?.start.row === 5 &&
    boards.player1View.otherFirstShip?.start.col === 5 &&
    boards.player1View.otherFirstShip?.hits.length === 4 &&
    boards.player1View.otherFirstShip?.hits[1] === true
  );

  return {
    [TESTS]: [
      { action: action_place },
      { label: "alice-placed" },
      { await: "bob-placed" },
      { assertion: assert_reads_bobs_fleet },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const boards = setup.boards;

  const action_place = action(() => {
    boards.placeFleet2.send();
  });

  const assert_reads_alices_fleet = assert(() =>
    boards.player2View.otherShipCount === 2 &&
    boards.player2View.otherFirstShip?.id === 1 &&
    boards.player2View.otherFirstShip?.name === "A-Ship1" &&
    boards.player2View.otherFirstShip?.start.row === 0 &&
    boards.player2View.otherFirstShip?.hits.length === 2
  );

  return {
    [TESTS]: [
      { await: "alice-placed" },
      { assertion: assert_reads_alices_fleet },
      { action: action_place },
      { label: "bob-placed" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
