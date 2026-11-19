/**
 * Tests the indexed-topics board: topics added through the board appear in
 * its listing, a mention shows up as the mentioned topic's "mentioned by",
 * and renaming a topic changes both, with nothing written by the pattern to
 * bring the database up to date.
 *
 * Run: deno task cf test patterns/examples/indexed-topics/main.test.tsx
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Board, { type TopicOutput } from "./main.tsx";

const titles = (rows: { title: string }[] | undefined): string =>
  (rows ?? []).map((row) => row.title).join(",");

export default pattern(() => {
  const board = Board({});
  const alpha = new Writable<TopicOutput | undefined>(undefined);

  return {
    [TESTS]: [
      { assertion: assert(() => board.topicCount === 0) },

      { action: action(() => board.addTopic.send({ title: "alpha" })) },
      { settle: true },
      { action: action(() => alpha.set(board.latest)) },
      { action: action(() => board.addTopic.send({ title: "beta" })) },
      { settle: true },

      { assertion: assert(() => board.topicCount === 2) },
      {
        assertion: assert(() => titles(board.titles.result) === "alpha,beta"),
      },
      // Nothing mentions alpha yet.
      {
        assertion: assert(() => alpha.get()?.mentionedBy.result?.length === 0),
      },

      {
        action: action(() => {
          const target = alpha.get();
          if (target) board.latest?.mention.send({ topic: target });
        }),
      },
      { settle: true },
      {
        assertion: assert(() =>
          titles(alpha.get()?.mentionedBy.result) === "beta"
        ),
      },

      // The rename is a write to the topic alone; the collection follows it.
      { action: action(() => board.latest?.rename.send({ title: "gamma" })) },
      { settle: true },
      {
        assertion: assert(() => titles(board.titles.result) === "alpha,gamma"),
      },
      {
        assertion: assert(() =>
          titles(alpha.get()?.mentionedBy.result) === "gamma"
        ),
      },
    ],
    board,
  };
});
