/**
 * A topic's outbound `mentions` drawn from the body editor's reference map:
 * each entry's destination is reported beside what `mention` recorded, an
 * entry with no destination contributes nothing, and the list follows the map
 * when the map changes.
 */
import {
  action,
  assert,
  Default,
  equals,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import Topic, { type TopicMentionRefMap } from "./topic.tsx";

/** Whether `mentions` holds exactly the given pieces, in any order. */
const sameMembers = (mentions: unknown[] | undefined, expected: object[]) => {
  const actual = mentions ?? [];
  return actual.length === expected.length &&
    expected.every((target) =>
      actual.some((m) =>
        typeof m === "object" && m !== null && equals(m, target)
      )
    );
};

export default pattern(() => {
  const proseTarget = new Writable({ title: "Named in the prose" });
  const otherProseTarget = new Writable({ title: "Named in a later edit" });
  const verbTarget = new Writable({ title: "Recorded by mention" });

  // Both start empty, because a cell cannot be embedded in a cell's initial
  // value; the first action fills them.
  // deno-lint-ignore ban-types
  const references = new Writable<TopicMentionRefMap | Default<{}>>({});
  const mentioned = new Writable<unknown[] | Default<[]>>([]);
  const topic = Topic({ title: "Mentions source", references, mentioned });

  const assert_no_mentions_yet = assert(() => sameMembers(topic.mentions, []));

  const action_prose_and_verb_mention = action(() => {
    references.set({
      named: { destination: proseTarget, modifiedTitle: false },
      dangling: { destination: undefined, modifiedTitle: true },
    });
    mentioned.push(verbTarget);
  });
  // The dangling entry contributes nothing.
  const assert_prose_and_verb_mentions_reported = assert(() =>
    sameMembers(topic.mentions, [proseTarget, verbTarget]) &&
    !sameMembers(topic.mentions, [verbTarget])
  );

  const action_edit_points_elsewhere = action(() => {
    references.set({
      renamed: { destination: otherProseTarget, modifiedTitle: false },
    });
  });
  const assert_mentions_follow_the_map = assert(() =>
    sameMembers(topic.mentions, [otherProseTarget, verbTarget]) &&
    !sameMembers(topic.mentions, [proseTarget, verbTarget])
  );

  const action_prose_mentions_removed = action(() => {
    references.set({});
  });
  const assert_only_verb_mention_left = assert(() =>
    sameMembers(topic.mentions, [verbTarget])
  );

  return {
    [TESTS]: [
      { assertion: assert_no_mentions_yet },
      { action: action_prose_and_verb_mention },
      { assertion: assert_prose_and_verb_mentions_reported },
      { action: action_edit_points_elsewhere },
      { assertion: assert_mentions_follow_the_map },
      { action: action_prose_mentions_removed },
      { assertion: assert_only_verb_mention_left },
    ],
  };
});
