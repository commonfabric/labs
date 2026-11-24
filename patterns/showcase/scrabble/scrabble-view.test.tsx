/**
 * What the view shows a player through a join, a turn, and the joins it
 * refuses, read off the rendered tree against what each step set up. Tiles come
 * from a fixed bag, so each step names the tile it places by id.
 */
import { assert, NAME, pattern, TESTS, UI, Writable } from "commonfabric";
import Scrabble, { type Letter } from "./scrabble.tsx";
import {
  findElement,
  findElementByText,
  findNode,
  findNodeByProp,
  hasExactText,
  hasText,
  propValue,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";

const tile = (char: string, points: number): Letter => ({
  char,
  points,
  id: `tile-${char.toLowerCase()}`,
  isBlank: false,
});

const A = tile("A", 1);
const T = tile("T", 1);
const S = tile("S", 1);
const O = tile("O", 1);
const G = tile("G", 2);
const R = tile("R", 1);
const N = tile("N", 1);

// Alice draws the first seven; E and D stay in the bag until she scores.
const TEST_BAG: Letter[] = [A, T, S, O, G, R, N, tile("E", 1), tile("D", 2)];

// The scoreboard card of the viewing player, which alone has the gold border.
const ownCard = (view: unknown) =>
  findNode(view, (node) => styleOf(node, "border") === "3px solid #fbbf24");
// The square a submitted or placed tile sits on, by its pixel offset.
const tileAt = (view: unknown, row: number, col: number) =>
  findNode(
    view,
    (node) =>
      styleOf(node, "left") === `${col * 34}px` &&
      styleOf(node, "top") === `${row * 34}px`,
  );

export default pattern(() => {
  // Bob joined with a profile before this test starts; Alice joins by name.
  const bobProfile = Writable.of<{ name?: string; avatar?: string }>({
    name: "Bob",
  });
  const scrabble = Scrabble({
    gameName: "View Match",
    bag: TEST_BAG,
    bagIndex: 0,
    players: {
      list: [{
        name: "Bob",
        profile: bobProfile,
        color: "#0f766e",
        score: 3,
        joinedAt: 0,
      }],
    },
  });

  // A game nobody has seeded fills its bag on the first join.
  const fresh = Scrabble({ gameName: "Fresh Match" });

  return {
    [TESTS]: [
      { action: fresh.joinWithName, event: "Carol" },
      {
        assertion: assert(() =>
          fresh.bag.length === 100 &&
          fresh.rack.length === 7 &&
          fresh.bagIndex === 7 &&
          fresh.board.length === 0 &&
          fresh.message === "Joined as Carol."
        ),
      },

      // Before joining: the game's name, an empty rack, the whole bag, the
      // board's bonus squares, a Join button that waits for a profile, and
      // Bob on the scoreboard under his profile's badge.
      {
        assertion: assert(() => {
          const ui = scrabble[UI];
          const join = findElementByText(ui, "cf-button", "Join");
          return scrabble[NAME] === "Scrabble: View Match" &&
            hasText(findElement(ui, "h2"), "View Match") &&
            propValue(join, "disabled") === true &&
            !hasText(ui, "Playing as") &&
            hasText(ui, "Your Rack (0)") &&
            hasText(ui, "Bag: 9 tiles") &&
            scrabble.bag.length === 9 &&
            hasText(ui, "TWDLTWDLTW") &&
            hasText(ui, "*") &&
            hasText(findElement(ui, "aside"), "Bob3") &&
            findElement(findElement(ui, "aside"), "cf-profile-badge") !==
              undefined &&
            findElement(findElement(ui, "aside"), "cf-avatar") === undefined;
        }),
      },

      // The profile join has no profile to read here, so it asks for one.
      { action: scrabble.joinGame },
      {
        assertion: assert(() =>
          scrabble.message === "Set up a profile to join." &&
          scrabble.players.length === 1 &&
          scrabble.myName === ""
        ),
      },

      { action: scrabble.joinWithName, event: "Alice" },
      {
        assertion: assert(() => {
          const ui = scrabble[UI];
          const card = ownCard(ui);
          return hasText(ui, "Playing as") &&
            hasText(ui, "Your Rack (7)") &&
            hasText(ui, "Bag: 2 tiles") &&
            hasText(card, "Alice") &&
            findNode(card, (node) => hasExactText(node, "0")) !== undefined &&
            propValue(findElement(card, "cf-avatar"), "name") === "Alice" &&
            propValue(
                findElementByText(ui, "cf-button", "Submit Word"),
                "disabled",
              ) ===
              false &&
            hasText(findNodeByProp(ui, "type", "letter"), "A1") &&
            hasText(findElement(ui, "aside"), "Alice joined");
        }),
      },

      // Rejoining under the same name welcomes the player back and draws
      // nothing, even with the whole rack out on the board.
      { action: scrabble.placeTile, event: { letterId: A.id, row: 0, col: 0 } },
      { action: scrabble.placeTile, event: { letterId: T.id, row: 0, col: 1 } },
      { action: scrabble.placeTile, event: { letterId: S.id, row: 0, col: 2 } },
      { action: scrabble.placeTile, event: { letterId: O.id, row: 0, col: 3 } },
      { action: scrabble.placeTile, event: { letterId: G.id, row: 0, col: 4 } },
      { action: scrabble.placeTile, event: { letterId: R.id, row: 0, col: 5 } },
      { action: scrabble.placeTile, event: { letterId: N.id, row: 0, col: 6 } },
      { action: scrabble.joinWithName, event: "Alice" },
      {
        assertion: assert(() =>
          scrabble.message === "Welcome back, Alice." &&
          scrabble.rack.length === 0 &&
          scrabble.placed.length === 7 &&
          scrabble.bagIndex === 7 &&
          scrabble.players.length === 2
        ),
      },
      { action: scrabble.clearBoard },
      { assertion: assert(() => scrabble.rack.length === 7) },

      // A placed tile shows on its square; once submitted it shows its points
      // too, and the score and the log follow.
      { action: scrabble.placeTile, event: { letterId: A.id, row: 7, col: 7 } },
      {
        assertion: assert(() => {
          const ui = scrabble[UI];
          return hasText(tileAt(ui, 7, 7), "A") &&
            hasText(findNodeByProp(ui, "type", "board-tile"), "A");
        }),
      },
      { action: scrabble.placeTile, event: { letterId: T.id, row: 7, col: 8 } },
      { action: scrabble.submitTurn },
      {
        assertion: assert(() => {
          const ui = scrabble[UI];
          return scrabble.message === "Scored 4: AT: 4" &&
            hasText(tileAt(ui, 7, 7), "A1") &&
            hasText(tileAt(ui, 7, 8), "T1") &&
            findNodeByProp(ui, "type", "board-tile") === undefined &&
            findNode(ownCard(ui), (node) => hasExactText(node, "4")) !==
              undefined &&
            hasText(findElement(ui, "aside"), "Alice: AT (+4)") &&
            hasText(ui, "Bag: 0 tiles");
        }),
      },
    ],
    scrabble,
    fresh,
    bobProfile,
  };
});
