/**
 * The rules a placement, a drag, and a submission enforce, one rejection at a
 * time. Every tile comes from a fixed bag, so each step names the tile it moves
 * by id rather than reading the rack, and each step sends one event.
 *
 * The drop handlers are bound only in the view, so the drag steps walk to the
 * drop zone and fire its `oncf-drop` with a link to the dragged tile, as
 * `cf-drop-zone` does.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import Scrabble, { type Letter, type PlacedTile } from "./scrabble.tsx";
import {
  findNodeByProp,
  fireEvent,
} from "../../tools/test-support/vnode-helpers.ts";

const tile = (char: string, points: number): Letter => ({
  char,
  points,
  id: `tile-${char.toLowerCase() || "blank"}`,
  isBlank: char === "",
});

const A = tile("A", 1);
const T = tile("T", 1);
const S = tile("S", 1);
const O = tile("O", 1);
const G = tile("G", 2);
const BLANK = tile("", 0);
const N = tile("N", 1);

// Alice draws the first seven; E and D refill her rack after her first word.
const TEST_BAG: Letter[] = [
  A,
  T,
  S,
  O,
  G,
  BLANK,
  N,
  tile("E", 1),
  tile("D", 2),
];

// One board square is 32px plus a 2px gap; aim at the middle of one.
const BOARD_RECT = { left: 100, top: 50, width: 508, height: 508 };
const at = (row: number, col: number) => ({
  pointerX: BOARD_RECT.left + col * 34 + 16,
  pointerY: BOARD_RECT.top + row * 34 + 16,
  dropZoneRect: BOARD_RECT,
});

// The pointer alone, as a drop on the rack reports it.
const POINTER = { pointerX: 20, pointerY: 20 };

const ids = (letters: readonly Letter[]) =>
  letters.map((letter) => letter.id).join(",");
const squares = (tiles: readonly PlacedTile[]) =>
  tiles.map((tile) => `${tile.letter.char}@${tile.row},${tile.col}`).join(" ");

// Fires the drop handler of the zone accepting `accept`, as a drop there does.
// Module scope: an action's callback may not capture a function from the
// pattern body.
const dropOn = (view: unknown, accept: string, detail: unknown) =>
  fireEvent(
    findNodeByProp(view, "accept", accept),
    "oncf-drop",
    { detail },
    `the drop zone accepting ${accept}`,
  );
const BOARD = "letter,board-tile";
const RACK = "board-tile";

export default pattern(() => {
  const scrabble = Scrabble({
    gameName: "Rules",
    bag: TEST_BAG,
    bagIndex: 0,
  });

  // What a drag hands the drop zone: the dragged rack letter, or the placed
  // tile (letter and square) for a tile already on the board.
  const draggedN = Writable.of<Letter>(N);
  const draggedG = Writable.of<Letter>(G);
  const draggedO = Writable.of<PlacedTile>({ letter: O, row: 8, col: 7 });
  const draggedText = Writable.of<string>("not a tile");
  const draggedShapeless = Writable.of<{ label: string }>({ label: "card" });

  return {
    [TESTS]: [
      { action: scrabble.submitTurn },
      {
        assertion: assert(() =>
          scrabble.message === "Join before submitting a word."
        ),
      },

      { action: scrabble.joinWithName, event: "Alice" },
      { action: scrabble.submitTurn },
      {
        assertion: assert(() =>
          scrabble.message === "Place tiles before submitting."
        ),
      },

      // placeTile refuses a square off the board, a tile not in the rack, and
      // a blank nobody has chosen a letter for, and leaves the rack whole.
      {
        action: scrabble.placeTile,
        event: { letterId: A.id, row: 15, col: 0 },
      },
      {
        assertion: assert(() =>
          scrabble.message === "Drop outside board bounds."
        ),
      },
      {
        action: scrabble.placeTile,
        event: { letterId: "tile-z", row: 7, col: 7 },
      },
      {
        assertion: assert(() =>
          scrabble.message === "Tile not found in your rack."
        ),
      },
      {
        action: scrabble.placeTile,
        event: { letterId: BLANK.id, row: 7, col: 7 },
      },
      {
        assertion: assert(() =>
          scrabble.message ===
            "Choose a blank tile letter before placing it." &&
          scrabble.placed.length === 0 &&
          scrabble.rack.length === 7
        ),
      },

      // A lone tile forms no word, and goes back to the rack.
      { action: scrabble.placeTile, event: { letterId: A.id, row: 7, col: 7 } },
      { action: scrabble.submitTurn },
      {
        assertion: assert(() =>
          scrabble.message === "No valid word formed." &&
          scrabble.board.length === 0 &&
          scrabble.placed.length === 0 &&
          scrabble.rack.some((letter) => letter.id === A.id)
        ),
      },

      { action: scrabble.placeTile, event: { letterId: T.id, row: 7, col: 7 } },
      { action: scrabble.placeTile, event: { letterId: G.id, row: 7, col: 8 } },
      { action: scrabble.submitTurn },
      {
        assertion: assert(() =>
          scrabble.message === "Invalid words: TG." &&
          scrabble.board.length === 0 &&
          scrabble.rack.length === 7
        ),
      },

      // S at the corner touches nothing: AT scores, and S comes back.
      { action: scrabble.placeTile, event: { letterId: A.id, row: 7, col: 7 } },
      { action: scrabble.placeTile, event: { letterId: T.id, row: 7, col: 8 } },
      { action: scrabble.placeTile, event: { letterId: S.id, row: 0, col: 0 } },
      { action: scrabble.submitTurn },
      {
        assertion: assert(() =>
          scrabble.message === "Scored 4: AT: 4" &&
          squares(scrabble.board) === "A@7,7 T@7,8" &&
          scrabble.placed.length === 0 &&
          ids(scrabble.rack) ===
            "tile-o,tile-blank,tile-n,tile-g,tile-s,tile-e,tile-d" &&
          scrabble.bagIndex === 9
        ),
      },

      { action: scrabble.placeTile, event: { letterId: O.id, row: 7, col: 7 } },
      {
        assertion: assert(() =>
          scrabble.message === "That square already has a submitted tile."
        ),
      },

      { action: scrabble.placeTile, event: { letterId: O.id, row: 0, col: 0 } },
      { action: scrabble.placeTile, event: { letterId: N.id, row: 0, col: 1 } },
      { action: scrabble.submitTurn },
      {
        assertion: assert(() =>
          scrabble.message === "Tiles must connect to an existing word." &&
          scrabble.placed.length === 0 &&
          scrabble.rack.length === 7
        ),
      },

      { action: scrabble.placeTile, event: { letterId: O.id, row: 8, col: 7 } },
      { action: scrabble.placeTile, event: { letterId: N.id, row: 8, col: 7 } },
      {
        assertion: assert(() =>
          scrabble.message === "That square already has one of your tiles." &&
          squares(scrabble.placed) === "O@8,7"
        ),
      },

      // Dragging a placed tile moves it; dragging a rack tile places it.
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedO, ...at(9, 7) })
        ),
      },
      { assertion: assert(() => squares(scrabble.placed) === "O@9,7") },
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedN, ...at(9, 7) })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "That square already has one of your tiles." &&
          squares(scrabble.placed) === "O@9,7"
        ),
      },
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedN, ...at(10, 7) })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "" &&
          squares(scrabble.placed) === "O@9,7 N@10,7" &&
          !scrabble.rack.some((letter) => letter.id === N.id)
        ),
      },
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedO, ...at(10, 7) })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "That square already has one of your tiles." &&
          squares(scrabble.placed) === "O@9,7 N@10,7"
        ),
      },

      // The square checks apply to a drag as to placeTile, and a dragged cell
      // holding no tile is refused by name.
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedO, ...at(-1, 3) })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "Drop outside board bounds."
        ),
      },
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, {
            sourceCell: draggedShapeless,
            ...at(11, 7),
          })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "Could not identify dragged tile."
        ),
      },
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedO, ...at(7, 8) })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "That square already has a submitted tile."
        ),
      },
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedText, ...at(11, 7) })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "Could not identify dragged tile."
        ),
      },

      // A drop missing its zone's rectangle or its source changes nothing, on
      // the board or on the rack, and neither does dragging a tile still in
      // the rack onto the rack.
      {
        action: action(() =>
          dropOn(scrabble[UI], BOARD, { sourceCell: draggedO, ...POINTER })
        ),
      },
      {
        action: action(() => dropOn(scrabble[UI], RACK, POINTER)),
      },
      {
        action: action(() =>
          dropOn(scrabble[UI], RACK, { sourceCell: draggedText, ...POINTER })
        ),
      },
      {
        action: action(() =>
          dropOn(scrabble[UI], RACK, { sourceCell: draggedG, ...POINTER })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "Could not identify dragged tile." &&
          squares(scrabble.placed) === "O@9,7 N@10,7" &&
          scrabble.rack.length === 5
        ),
      },

      // Dragging a placed tile onto the rack takes it back.
      {
        action: action(() =>
          dropOn(scrabble[UI], RACK, { sourceCell: draggedO, ...POINTER })
        ),
      },
      {
        assertion: assert(() =>
          scrabble.message === "" &&
          squares(scrabble.placed) === "N@10,7" &&
          scrabble.rack.at(-1)?.id === O.id
        ),
      },
    ],
    scrabble,
    draggedN,
    draggedG,
    draggedO,
    draggedText,
    draggedShapeless,
  };
});
