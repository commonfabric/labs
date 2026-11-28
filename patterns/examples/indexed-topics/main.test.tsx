/**
 * Tests the indexed-topics board: topics added through the board appear in
 * its listing, the listing's reference to a topic selects it, a mention shows
 * up as the mentioned topic's "mentioned by", which the board's view of the
 * selected topic shows, and renaming a topic changes both, with nothing
 * written by the pattern to bring the database up to date.
 *
 * Run: deno task cf test patterns/examples/indexed-topics/main.test.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeById,
  hasExactText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import Board from "./main.tsx";

const titles = (rows: { title: string }[] | undefined): string =>
  (rows ?? []).map((row) => row.title).join(",");

// The selected topic's text, and its "mentioned by" node, as the board's view
// shows them.
const shownSelection = (view: unknown): string =>
  textContent(findNodeById(view, "selected-topic"));
const shownMentionedBy = (view: unknown): unknown =>
  findNodeById(findNodeById(view, "selected-topic"), "mentioned-by");

export default pattern(() => {
  const board = Board({});

  return {
    [TESTS]: [
      { assertion: assert(() => board.topicCount === 0) },
      // Nothing is selected, so the view shows no topic.
      { assertion: assert(() => shownSelection(board[UI]) === "") },

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
      {
        assertion: assert(() => shownSelection(board[UI]).startsWith("alpha")),
      },

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
      // The view shows beta, and alpha as what mentions it.
      { assertion: assert(() => shownSelection(board[UI]).startsWith("beta")) },
      {
        assertion: assert(() =>
          hasExactText(shownMentionedBy(board[UI]), "Mentioned by: alpha")
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
      {
        assertion: assert(() =>
          hasExactText(shownMentionedBy(board[UI]), "Mentioned by: gamma")
        ),
      },

      // Renaming the selected topic through its own stream renames it, in
      // the listing and in the view, and leaves the topic that mentions it as
      // it was.
      {
        action: action(() => board.selected?.rename?.send({ title: "delta" })),
      },
      { settle: true },
      { assertion: assert(() => board.selected?.title === "delta") },
      {
        assertion: assert(() => titles(board.titles.result) === "delta,gamma"),
      },
      {
        assertion: assert(() => shownSelection(board[UI]).startsWith("delta")),
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
