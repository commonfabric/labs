/**
 * Holds what one topic costs the board's collection to a bound that does not
 * grow with the board.
 *
 * The collection re-reads a topic whenever a document its row was read from
 * is written, so the documents behind one topic's row are what a write
 * anywhere on the board can cost. A topic's row is read from the topic's own
 * documents and from the pieces it refers to, and from nothing else: not from
 * the board, and not from the topics that refer to it. This file counts the
 * documents recorded for the topic with the most of them, on a board where
 * every other topic mentions one hub, and holds that count as the board
 * doubles.
 *
 * What does grow with the board is how many topics a write to the hub
 * re-reads, one for each topic that mentions it. That is the collection's
 * documented cost and is not bounded here.
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import Topics from "./main.tsx";
import Topic from "./topic.tsx";

/**
 * The most documents one topic's row is read from: its own, and one for each
 * piece it refers to. A spoke here refers to one piece.
 */
const WIDEST_ROW = 8;

export default pattern(() => {
  const board = Topics({});
  const hub = Topic({ title: "Hub", board: board.board });
  const spokeOne = Topic({ title: "Spoke one", board: board.board });
  const spokeTwo = Topic({ title: "Spoke two", board: board.board });
  const spokeThree = Topic({ title: "Spoke three", board: board.board });
  const spokeFour = Topic({ title: "Spoke four", board: board.board });
  const spokeFive = Topic({ title: "Spoke five", board: board.board });
  const spokeSix = Topic({ title: "Spoke six", board: board.board });

  // The documents recorded for the topic recorded with the most.
  const widest = board.board.query<{ docs: number }>(`
    SELECT count(*) AS docs FROM member_deps
    GROUP BY member_cf_link ORDER BY docs DESC LIMIT 1`);
  const held = board.board.query<{ topics: number; edges: number }>(`
    SELECT (SELECT count(*) FROM topics) AS topics,
      (SELECT count(*) FROM topics_mentioned) AS edges`);

  const action_three_spokes_mention_the_hub = action(() => {
    board.board.add("topics", hub);
    board.board.add("topics", spokeOne);
    board.board.add("topics", spokeTwo);
    board.board.add("topics", spokeThree);
    spokeOne.mention?.send({ topic: hub });
    spokeTwo.mention?.send({ topic: hub });
    spokeThree.mention?.send({ topic: hub });
  });
  const assert_small_board_is_within_the_bound = assert(() =>
    held.result?.[0]?.topics === 4 &&
    held.result?.[0]?.edges === 3 &&
    (widest.result?.[0]?.docs ?? 0) > 0 &&
    (widest.result?.[0]?.docs ?? Infinity) <= WIDEST_ROW
  );

  const action_three_more_spokes_mention_the_hub = action(() => {
    board.board.add("topics", spokeFour);
    board.board.add("topics", spokeFive);
    board.board.add("topics", spokeSix);
    spokeFour.mention?.send({ topic: hub });
    spokeFive.mention?.send({ topic: hub });
    spokeSix.mention?.send({ topic: hub });
  });
  // Twice the mentions of the hub, and no topic's row is read from more.
  const assert_doubled_board_is_within_the_same_bound = assert(() =>
    held.result?.[0]?.topics === 7 &&
    held.result?.[0]?.edges === 6 &&
    (widest.result?.[0]?.docs ?? Infinity) <= WIDEST_ROW
  );

  return {
    [TESTS]: [
      { action: action_three_spokes_mention_the_hub },
      { assertion: assert_small_board_is_within_the_bound },
      { action: action_three_more_spokes_mention_the_hub },
      { assertion: assert_doubled_board_is_within_the_same_bound },
    ],
  };
});
