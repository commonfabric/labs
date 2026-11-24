/**
 * Tests the indexed-topics board: topics added through the board appear in
 * its listing, the listing's reference to a topic selects it, a mention shows
 * up as the mentioned topic's "mentioned by", and renaming a topic changes
 * both, with nothing written by the pattern to bring the database up to date.
 *
 * Run: deno task cf test patterns/examples/indexed-topics/main.test.tsx
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import Board from "./main.tsx";

const titles = (rows: { title: string }[] | undefined): string =>
  (rows ?? []).map((row) => row.title).join(",");

export default pattern(() => {
  const board = Board({});

  return {
    [TESTS]: [
      { settle: true },
      { assertion: assert(() => board.topicCount === 0) },
      {
        assertion: assert(() =>
          board.titles.pending === false && board.titles.result?.length === 0
        ),
      },

      { action: action(() => board.addTopic.send({ title: "alpha" })) },
      { action: action(() => board.addTopic.send({ title: "beta" })) },
      { settle: true },
      { assertion: assert(() => board.topicCount === 2) },
      {
        assertion: assert(() => titles(board.titles.result) === "alpha,beta"),
      },

      // A listing row's reference selects the topic it names.
      {
        action: action(() => {
          const row = board.titles.result?.find((row) => row.title === "alpha");
          if (row) board.select.send({ topic: row.topic });
        }),
      },
      { settle: true },
      { assertion: assert(() => board.selected?.title === "alpha") },

      // Alpha mentions beta, named by beta's listing reference.
      {
        action: action(() => {
          const row = board.titles.result?.find((row) => row.title === "beta");
          if (row) board.selected?.mention?.send({ topic: row.topic });
        }),
      },
      {
        action: action(() => {
          const row = board.titles.result?.find((row) => row.title === "beta");
          if (row) board.select.send({ topic: row.topic });
        }),
      },
      { settle: true },
      { assertion: assert(() => board.selected?.title === "beta") },
      // Reading the result starts beta's query, which the settle then waits
      // for.
      {
        assertion: assert(() => board.selected?.mentionedBy?.pending !== true),
      },
      { settle: true },
      {
        assertion: assert(() =>
          titles(board.selected?.mentionedBy?.result) === "alpha"
        ),
      },
      // The row holds the mentioning topic as a cell, read here for a field
      // the collection does not mirror.
      {
        assertion: assert(() =>
          board.selected?.mentionedBy?.result?.[0]?.topic.get().mentions
            .length === 1
        ),
      },

      // Renaming alpha is a write to alpha alone, made through the cell the
      // row holds. The collection follows it.
      {
        action: action(() =>
          board.selected?.mentionedBy?.result?.[0]?.topic.key("title").set(
            "gamma",
          )
        ),
      },
      { settle: true },
      {
        assertion: assert(() => titles(board.titles.result) === "beta,gamma"),
      },
      {
        assertion: assert(() =>
          titles(board.selected?.mentionedBy?.result) === "gamma"
        ),
      },
    ],
    board,
  };
});
