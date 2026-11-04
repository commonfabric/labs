/// <cts-enable />

/**
 * Multi-user pattern test for Topics (CT-1878).
 *
 * One shared Topics board across two worker-isolated runtimes. Covers the
 * board's core multi-user promises:
 * - every headless mutation carries its agent signature atomically,
 * - topics created by either user propagate to the other, with structured
 *   authorship snapshots taken at write time.
 *
 * Concurrent comment appends — both landing, mergeable `push`, no clobbering —
 * are exercised on a topic the setup holds DIRECTLY, not on one reached
 * through the board. That is not a convenience: the board's demand carries
 * neither the thread nor the verbs that write it, so a comment cannot be
 * appended through the board's projection at all. What this file asserts of
 * the board is therefore topic propagation and authorship, never a thread.
 *
 * That leaves one thing no assertion here can make: that a real append raises
 * the `commentCount` the board's index publishes. Proving it needs a topic
 * resolved to its own piece from a board that created it, which is
 * `patterns/integration/topic-board-child-contract.test.ts` — it
 * reads `index[0].commentCount`, appends, and reads it again.
 *
 * Cross-runtime reads use INLINE literal accesses (topics[0].comments[0]) —
 * `.map()`, loop-variable indexing, and helper calls over another runtime's
 * arrays do not resolve before a local write (see lunch-poll and scrabble
 * multi-user tests).
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import Topics, { type TopicsOutput } from "./main.tsx";
import Topic, { type TopicOutput } from "./topic.tsx";

interface Setup {
  board: TopicsOutput;
  thread: TopicOutput;
}

export const setup = pattern(() => ({
  board: Topics({}),
  // The shared thread both participants append to, held directly rather than
  // reached through `board.topics[0]`. The board demands a projection that
  // carries no verbs, so a participant who found this topic through the board
  // could not comment on it — in production the equivalent move is surveying
  // `index` for the topic's own address and calling the topic there.
  thread: Topic({ title: "First topic" }),
}));

export const gideon = pattern<{ setup: Setup }>(({ setup }) => {
  const board = setup.board;

  const action_start_topic = action(() => {
    board.addTopic.send({ title: "First topic", agentName: "Sol" });
  });
  const action_comment = action(() => {
    setup.thread.addComment.send({
      body: "opening the thread",
      agentName: "Sol",
    });
  });

  const assert_topic_created = assert(() =>
    (board.topics ?? []).length === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.createdBy?.kind === "agent" &&
    board.topics?.[0]?.createdBy?.name === "Sol"
  );

  const assert_own_comment = assert(() =>
    setup.thread.comments?.[0]?.author?.kind === "agent" &&
    setup.thread.comments?.[0]?.author?.name === "Sol" &&
    setup.thread.comments?.[0]?.body === "opening the thread" &&
    setup.thread.commentCount === 1
  );

  // Fable commented on my topic and started a second topic. Use literal paths
  // here, as required for cross-runtime reads above; aggregate length and
  // commentCount reads can remain stale until this runtime performs a write.
  const assert_sees_fable_comment = assert(() =>
    setup.thread.comments?.[1]?.author?.name === "Fable"
  );
  const assert_fable_topic_authorship = assert(() =>
    board.topics?.[1]?.createdBy?.name === "Fable"
  );

  return {
    [TESTS]: [
      { action: action_start_topic },
      { assertion: assert_topic_created },
      { action: action_comment },
      { assertion: assert_own_comment },
      { label: "gideon-commented" },
      { await: "fable-done" },
      { assertion: assert_sees_fable_comment },
      { assertion: assert_fable_topic_authorship },
    ],
  };
});

export const fable = pattern<{ setup: Setup }>(({ setup }) => {
  const board = setup.board;

  const action_comment = action(() => {
    setup.thread.addComment.send({
      body: "seconding this",
      agentName: "Fable",
    });
  });
  const action_start_second = action(() => {
    board.addTopic.send({ title: "Second topic", agentName: "Fable" });
  });

  // Sol's topic + comment propagated from the other runtime.
  const assert_sees_sol_setup = assert(() =>
    (board.topics ?? []).length === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    setup.thread.comments?.[0]?.author?.name === "Sol" &&
    setup.thread.commentCount === 1
  );

  // Both comments landed (mergeable append, no clobber), in thread order.
  const assert_both_comments = assert(() =>
    setup.thread.commentCount === 2 &&
    setup.thread.comments?.[0]?.author?.name === "Sol" &&
    setup.thread.comments?.[1]?.author?.name === "Fable" &&
    setup.thread.comments?.[1]?.body === "seconding this"
  );

  const assert_second_topic = assert(() =>
    (board.topics ?? []).length === 2 &&
    board.topics?.[1]?.title === "Second topic" &&
    board.topics?.[1]?.createdBy?.name === "Fable"
  );

  return {
    [TESTS]: [
      { await: "gideon-commented" },
      { assertion: assert_sees_sol_setup },
      { action: action_comment },
      { assertion: assert_both_comments },
      { action: action_start_second },
      { assertion: assert_second_topic },
      { label: "fable-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { gideon, fable } });
