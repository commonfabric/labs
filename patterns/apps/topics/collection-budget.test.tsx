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
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import { type NamesMap } from "../../product/collection-naming/naming.ts";
import Topics from "./main.tsx";

/**
 * The most documents one topic's row is read from: its own, and one for each
 * piece it refers to. A spoke here refers to one piece.
 */
const WIDEST_ROW = 8;

export default pattern(() => {
  // The topics are filed through the board, which adds each to its
  // collection, and the namespace holds each one under its number, which is
  // where the test reaches a topic's `mention` verb. `1` is the hub.
  const names = new Writable<NamesMap>({});
  const board = Topics({ names });

  // The documents recorded for the topic recorded with the most.
  const widest = board.board.query<{ docs: number }>(`
    SELECT count(*) AS docs FROM member_deps
    GROUP BY member_cf_link ORDER BY docs DESC LIMIT 1`);
  const held = board.board.query<{ topics: number; edges: number }>(`
    SELECT (SELECT count(*) FROM topics) AS topics,
      (SELECT count(*) FROM topics_mentioned) AS edges`);

  const action_file_the_hub_and_three_spokes = action(() => {
    for (const title of ["Hub", "Spoke one", "Spoke two", "Spoke three"]) {
      board.addTopic.send({ title, agentName: "Sol" });
    }
  });
  const action_three_spokes_mention_the_hub = action(() => {
    const hub = names.key("1").resolveAsCell();
    for (const name of ["2", "3", "4"]) {
      names.key(name).resolveAsCell().key("mention").send({ topic: hub });
    }
  });
  const assert_small_board_is_within_the_bound = assert(() =>
    held.result?.[0]?.topics === 4 &&
    held.result?.[0]?.edges === 3 &&
    (widest.result?.[0]?.docs ?? 0) > 0 &&
    (widest.result?.[0]?.docs ?? Infinity) <= WIDEST_ROW
  );

  const action_file_three_more_spokes = action(() => {
    for (const title of ["Spoke four", "Spoke five", "Spoke six"]) {
      board.addTopic.send({ title, agentName: "Sol" });
    }
  });
  const action_three_more_spokes_mention_the_hub = action(() => {
    const hub = names.key("1").resolveAsCell();
    for (const name of ["5", "6", "7"]) {
      names.key(name).resolveAsCell().key("mention").send({ topic: hub });
    }
  });
  // Twice the mentions of the hub, and no topic's row is read from more.
  const assert_doubled_board_is_within_the_same_bound = assert(() =>
    held.result?.[0]?.topics === 7 &&
    held.result?.[0]?.edges === 6 &&
    (widest.result?.[0]?.docs ?? Infinity) <= WIDEST_ROW
  );

  return {
    [TESTS]: [
      { action: action_file_the_hub_and_three_spokes },
      { action: action_three_spokes_mention_the_hub },
      { assertion: assert_small_board_is_within_the_bound },
      { action: action_file_three_more_spokes },
      { action: action_three_more_spokes_mention_the_hub },
      { assertion: assert_doubled_board_is_within_the_same_bound },
    ],
  };
});
