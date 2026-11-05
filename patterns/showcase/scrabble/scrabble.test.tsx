import { action, assert, pattern, TESTS } from "commonfabric";
import Scrabble, { type Letter } from "./scrabble.tsx";

const tile = (char: string, id: string): Letter => ({
  char,
  points: char === "D" || char === "G" ? 2 : 1,
  id,
  isBlank: false,
});

const TEST_BAG: Letter[] = [
  tile("A", "tile-a"),
  tile("T", "tile-t"),
  tile("E", "tile-e"),
  tile("S", "tile-s"),
  tile("R", "tile-r"),
  tile("N", "tile-n"),
  tile("O", "tile-o"),
  tile("D", "tile-d"),
  tile("G", "tile-g"),
];

const rackLetter = (rack: readonly Letter[], char: string) =>
  rack.find((letter) => letter.char === char)!;

export default pattern(() => {
  const scrabble = Scrabble({
    gameName: "Test Scrabble",
    bag: TEST_BAG,
    bagIndex: 0,
  });

  const action_join_alice = action(() => {
    scrabble.joinWithName.send("Alice");
  });

  const action_try_rename_after_join = action(() => {
    scrabble.joinWithName.send("Bob");
  });

  const action_submit_off_center_word = action(() => {
    const a = rackLetter(scrabble.rack, "A");
    const t = rackLetter(scrabble.rack, "T");
    scrabble.placeTile.send({ letterId: a.id, row: 0, col: 0 });
    scrabble.placeTile.send({ letterId: t.id, row: 0, col: 1 });
    scrabble.submitTurn.send();
  });

  const action_submit_center_word = action(() => {
    const a = rackLetter(scrabble.rack, "A");
    const t = rackLetter(scrabble.rack, "T");
    scrabble.placeTile.send({ letterId: a.id, row: 7, col: 7 });
    scrabble.placeTile.send({ letterId: t.id, row: 7, col: 8 });
    scrabble.submitTurn.send();
  });

  const action_clear_unsubmitted_tiles = action(() => {
    const first = scrabble.rack[0];
    const second = scrabble.rack[1];
    scrabble.placeTile.send({ letterId: first.id, row: 8, col: 7 });
    scrabble.placeTile.send({ letterId: second.id, row: 8, col: 8 });
    scrabble.clearBoard.send();
  });

  const action_reset_game = action(() => {
    scrabble.resetGame.send();
  });

  const assert_off_center_word_rejected = assert(() =>
    scrabble.players.length === 1 &&
    scrabble.players[0]?.name === "Alice" &&
    scrabble.board.length === 0 &&
    scrabble.placed.length === 0 &&
    scrabble.rack.length === 7 &&
    scrabble.bagIndex === 7 &&
    scrabble.message === "The first word must cover the center star."
  );

  const assert_joined_name_is_immutable = assert(() =>
    scrabble.players.length === 1 &&
    scrabble.players[0]?.name === "Alice" &&
    scrabble.myName === "Alice" &&
    scrabble.rack.length === 7 &&
    scrabble.message === "You already joined as Alice."
  );

  const assert_center_word_submitted = assert(() => {
    const board = scrabble.board;
    const player = scrabble.players[0];
    const lastEvent = scrabble.gameEvents.at(-1);
    return board.length === 2 &&
      board[0].letter.char === "A" &&
      board[0].row === 7 &&
      board[0].col === 7 &&
      board[1].letter.char === "T" &&
      board[1].row === 7 &&
      board[1].col === 8 &&
      scrabble.placed.length === 0 &&
      scrabble.rack.length === 7 &&
      scrabble.bagIndex === 9 &&
      player?.score === 4 &&
      lastEvent?.type === "word" &&
      lastEvent.details.includes("AT (+4)") &&
      scrabble.message.startsWith("Scored 4:");
  });

  const assert_clear_returns_tiles = assert(() =>
    scrabble.placed.length === 0 &&
    scrabble.rack.length === 7 &&
    scrabble.message === "Cleared your unsubmitted tiles."
  );

  const action_submit_dictionary_word = action(() => {
    const n = rackLetter(scrabble.rack, "N");
    const o = rackLetter(scrabble.rack, "O");
    const d = rackLetter(scrabble.rack, "D");
    const e = rackLetter(scrabble.rack, "E");
    const s = rackLetter(scrabble.rack, "S");
    scrabble.placeTile.send({ letterId: n.id, row: 8, col: 7 });
    scrabble.placeTile.send({ letterId: o.id, row: 9, col: 7 });
    scrabble.placeTile.send({ letterId: d.id, row: 10, col: 7 });
    scrabble.placeTile.send({ letterId: e.id, row: 11, col: 7 });
    scrabble.placeTile.send({ letterId: s.id, row: 12, col: 7 });
    scrabble.submitTurn.send();
  });

  // ANODES is in the attached dictionary and outside the handful of words the
  // board already demonstrates, so scoring it reads the word list end to end.
  const assert_dictionary_word_scored = assert(() => {
    const lastEvent = scrabble.gameEvents.at(-1);
    return scrabble.board.length === 7 &&
      lastEvent?.type === "word" &&
      lastEvent.details.includes("ANODES") &&
      scrabble.message.startsWith("Scored ");
  });

  const assert_reset_clears_game = assert(() =>
    scrabble.board.length === 0 &&
    scrabble.players.length === 0 &&
    scrabble.gameEvents.length === 0 &&
    scrabble.rack.length === 0 &&
    scrabble.placed.length === 0 &&
    scrabble.bagIndex === 0 &&
    scrabble.message === "Game reset. Join again to draw a fresh rack."
  );

  return {
    [TESTS]: [
      { action: action_join_alice },
      { action: action_try_rename_after_join },
      { assertion: assert_joined_name_is_immutable },
      { action: action_submit_off_center_word },
      { assertion: assert_off_center_word_rejected },
      { action: action_submit_center_word },
      { assertion: assert_center_word_submitted },
      { action: action_clear_unsubmitted_tiles },
      { assertion: assert_clear_returns_tiles },
      { action: action_submit_dictionary_word },
      { assertion: assert_dictionary_word_scored },
      { action: action_reset_game },
      { assertion: assert_reset_clears_game },
    ],
    scrabble,
  };
});
