/**
 * Exercises one shared migration with two open runtimes and concurrent comment
 * appends. The initial current version lets both readers open the legacy data
 * before an action enables migration.
 */

import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import Topic, { type TopicOutput } from "./topic.tsx";

/** Shared topic and its stored state version. */
interface Setup {
  /** Topic both participants keep open. */
  topic: TopicOutput;

  /** Test control for enabling migration after both readers are ready. */
  migrated: Writable<number>;
}

/** Creates shared legacy records with migration initially disabled. */
export const setup = pattern(() => {
  const migrated = new Writable(1);
  const topic = Topic({
    createdByName: "Legacy creator",
    topicStateVersion: migrated,
    comments: [
      { authorName: "Fable", body: "Legacy comment", sentAt: 1 },
      {
        authorName: "Old display name",
        author: { kind: "agent", name: "Current author" },
        body: "Structured comment",
        sentAt: 2,
      },
    ],
  });
  return { topic, migrated };
});

/** Enables migration with both readers open, then appends a comment. */
export const first = pattern<{ setup: Setup }>(({ setup }) => {
  const action_enable_migration = action(() => setup.migrated.set(0));
  const action_append = action(() =>
    setup.topic.addComment.send({
      agentName: "First writer",
      body: "First concurrent comment",
    })
  );
  const assert_legacy_is_visible = assert(() =>
    setup.topic.comments[0].body === "Legacy comment" &&
    setup.topic.comments[0].author === undefined
  );
  const assert_migrated = assert(() =>
    setup.topic.createdBy?.name === "Legacy creator" &&
    setup.topic.comments[0].author?.name === "Fable" &&
    setup.topic.comments[0].author?.kind === "legacy" &&
    setup.topic.comments[1].author?.name === "Current author" &&
    setup.migrated.get() === 1
  );
  const assert_both_appends = assert(() =>
    setup.topic.comments.length === 4 &&
    setup.topic.comments[2].author?.kind === "agent" &&
    setup.topic.comments[3].author?.kind === "agent" &&
    ((setup.topic.comments[2].author?.name === "First writer" &&
      setup.topic.comments[2].body === "First concurrent comment" &&
      setup.topic.comments[3].author?.name === "Second writer" &&
      setup.topic.comments[3].body === "Second concurrent comment") ||
      (setup.topic.comments[2].author?.name === "Second writer" &&
        setup.topic.comments[2].body === "Second concurrent comment" &&
        setup.topic.comments[3].author?.name === "First writer" &&
        setup.topic.comments[3].body === "First concurrent comment")) &&
    setup.topic.comments[0].author?.name === "Fable"
  );
  return {
    [TESTS]: [
      { assertion: assert_legacy_is_visible },
      { label: "first-open" },
      { await: "second-open" },
      { action: action_enable_migration },
      { assertion: assert_migrated },
      { label: "migration-enabled" },
      { action: action_append },
      { label: "first-appended" },
      { await: "second-appended" },
      { assertion: assert_both_appends },
    ],
  };
});

/** Observes migration from another runtime and appends a comment. */
export const second = pattern<{ setup: Setup }>(({ setup }) => {
  const action_append = action(() =>
    setup.topic.addComment.send({
      agentName: "Second writer",
      body: "Second concurrent comment",
    })
  );
  const assert_legacy_is_visible = assert(() =>
    setup.topic.comments[0].body === "Legacy comment" &&
    setup.topic.comments[0].author === undefined
  );
  const assert_migrated = assert(() =>
    setup.topic.createdBy?.name === "Legacy creator" &&
    setup.topic.comments[0].author?.name === "Fable" &&
    setup.topic.comments[0].author?.kind === "legacy" &&
    setup.topic.comments[1].author?.name === "Current author" &&
    setup.migrated.get() === 1
  );
  const assert_both_appends = assert(() =>
    setup.topic.comments.length === 4 &&
    setup.topic.comments[2].author?.kind === "agent" &&
    setup.topic.comments[3].author?.kind === "agent" &&
    ((setup.topic.comments[2].author?.name === "First writer" &&
      setup.topic.comments[2].body === "First concurrent comment" &&
      setup.topic.comments[3].author?.name === "Second writer" &&
      setup.topic.comments[3].body === "Second concurrent comment") ||
      (setup.topic.comments[2].author?.name === "Second writer" &&
        setup.topic.comments[2].body === "Second concurrent comment" &&
        setup.topic.comments[3].author?.name === "First writer" &&
        setup.topic.comments[3].body === "First concurrent comment")) &&
    setup.topic.comments[0].author?.name === "Fable"
  );
  return {
    [TESTS]: [
      { assertion: assert_legacy_is_visible },
      { label: "second-open" },
      { await: "first-open" },
      { await: "migration-enabled" },
      { assertion: assert_migrated },
      { action: action_append },
      { label: "second-appended" },
      { await: "first-appended" },
      { assertion: assert_both_appends },
    ],
  };
});

export default multiUserTest({ setup, participants: { first, second } });
