/**
 * Exercises the topic's kept comment count and activity time: the upgrade step
 * that computes them for a topic stored before they were kept, and the verbs
 * that keep them in the writes that change what they summarize. Every
 * assertion reads the input cells the topic was given, because the board's
 * index reads those stored values without running the topic.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Topic, {
  TOPIC_STATE_VERSION,
  type TopicComment,
  type TopicLink,
} from "./topic.tsx";

const SOL = { kind: "agent", name: "Sol" } as const;

export default pattern(() => {
  // A topic stored at version one: its authors are migrated, and its count and
  // activity time were never kept. One comment is retracted and one edited, and
  // one link is retracted, so the step has every stamp to weigh.
  const storedVersion = new Writable(1);
  const storedCount = new Writable(0);
  const storedActivity = new Writable(0);
  const stored = Topic({
    title: "Stored before the values were kept",
    comments: [
      { author: SOL, body: "kept", sentAt: 10 },
      {
        author: SOL,
        body: "retracted",
        sentAt: 20,
        removedAt: 50,
        removedBy: SOL,
      },
      { author: SOL, body: "edited", sentAt: 30, editedAt: 40 },
    ],
    links: [
      { kind: "web", url: "https://example.com/a", label: "a", addedAt: 35 },
      {
        kind: "web",
        url: "https://example.com/b",
        label: "b",
        addedAt: 5,
        removedAt: 45,
        removedBy: SOL,
      },
    ],
    createdAt: 1,
    bodyUpdatedAt: 15,
    titleUpdatedAt: 25,
    topicStateVersion: storedVersion,
    commentCount: storedCount,
    lastActivityAt: storedActivity,
  });

  // Two comments are there to read, and the retraction at 50 is the newest
  // stamp: a retraction is activity, and it keeps the clock from moving back.
  const assert_run_stores_the_values = assert(() =>
    storedVersion.get() === TOPIC_STATE_VERSION &&
    storedCount.get() === 2 &&
    storedActivity.get() === 50 &&
    stored.commentCount === 2 &&
    stored.lastActivityAt === 50
  );

  // A topic created at the current version, the way the board creates one.
  const comments = new Writable<TopicComment[]>([]);
  const links = new Writable<TopicLink[]>([]);
  const commentCount = new Writable(0);
  const lastActivityAt = new Writable(100);
  const kept = Topic({
    title: "Kept by its verbs",
    comments,
    links,
    createdAt: 100,
    topicStateVersion: TOPIC_STATE_VERSION,
    commentCount,
    lastActivityAt,
  });

  const action_add_comment = action(() =>
    kept.addComment.send({ body: "one", agentName: "Sol" })
  );
  const assert_comment_counted = assert(() =>
    commentCount.get() === 1 &&
    lastActivityAt.get() === comments.get()[0].sentAt &&
    kept.commentCount === 1
  );

  const action_add_second_comment = action(() =>
    kept.addComment.send({ body: "two", agentName: "Sol" })
  );
  const assert_second_comment_counted = assert(() =>
    commentCount.get() === 2 &&
    lastActivityAt.get() === comments.get()[1].sentAt
  );

  const action_edit_comment = action(() =>
    kept.editComment.send({
      comment: comments.key(0),
      body: "one, revised",
      agentName: "Sol",
    })
  );
  const assert_edit_moves_activity_only = assert(() =>
    commentCount.get() === 2 &&
    lastActivityAt.get() === comments.get()[0].editedAt
  );

  const action_retract_comment = action(() =>
    kept.removeComment.send({ comment: comments.key(1), agentName: "Sol" })
  );
  const assert_retraction_uncounted = assert(() =>
    commentCount.get() === 1 &&
    lastActivityAt.get() === comments.get()[1].removedAt &&
    kept.commentCount === 1
  );

  const action_add_link = action(() =>
    kept.addLink.send({ url: "https://example.com/kept", agentName: "Sol" })
  );
  const assert_link_moves_activity = assert(() =>
    commentCount.get() === 1 &&
    lastActivityAt.get() === links.get()[0].addedAt
  );

  const action_retract_link = action(() =>
    kept.removeLink.send({ url: "https://example.com/kept", agentName: "Sol" })
  );
  const assert_link_retraction_moves_activity = assert(() =>
    lastActivityAt.get() === links.get()[0].removedAt
  );

  const action_set_body = action(() =>
    kept.setBody.send({ body: "A new body.", agentName: "Sol" })
  );
  const assert_body_moves_activity = assert(() =>
    lastActivityAt.get() === kept.bodyUpdatedAt
  );

  const action_set_title = action(() =>
    kept.setTitle.send({ title: "Renamed", agentName: "Sol" })
  );
  const assert_title_moves_activity = assert(() =>
    lastActivityAt.get() === kept.titleUpdatedAt
  );

  // The activity time is a max: a verb whose stamp is older than the kept
  // value leaves it where it is, and the count still moves.
  const FUTURE = 9_000_000_000_000;
  const action_move_activity_ahead = action(() => lastActivityAt.set(FUTURE));
  const action_add_late_comment = action(() =>
    kept.addComment.send({ body: "three", agentName: "Sol" })
  );
  const assert_activity_never_moves_back = assert(() =>
    lastActivityAt.get() === FUTURE && commentCount.get() === 2
  );

  return {
    [TESTS]: [
      { assertion: assert_run_stores_the_values },
      { action: action_add_comment },
      { assertion: assert_comment_counted },
      { action: action_add_second_comment },
      { assertion: assert_second_comment_counted },
      { action: action_edit_comment },
      { assertion: assert_edit_moves_activity_only },
      { action: action_retract_comment },
      { assertion: assert_retraction_uncounted },
      { action: action_add_link },
      { assertion: assert_link_moves_activity },
      { action: action_retract_link },
      { assertion: assert_link_retraction_moves_activity },
      { action: action_set_body },
      { assertion: assert_body_moves_activity },
      { action: action_set_title },
      { assertion: assert_title_moves_activity },
      { action: action_move_activity_ahead },
      { action: action_add_late_comment },
      { assertion: assert_activity_never_moves_back },
    ],
  };
});
