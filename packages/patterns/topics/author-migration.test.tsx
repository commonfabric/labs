/**
 * Exercises legacy author migration when Topics run and mutate.
 * Shared input cells expose durable fields and comment identity to assertions.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Topic, { type TopicAuthor, type TopicComment } from "./topic.tsx";

/** Comment storage visible to the fixture's data-preservation assertions. */
interface StoredComment extends TopicComment {
  /** Name written by a legacy client. */
  authorName?: string;

  /** Extra stored content that the migration must preserve. */
  extra?: string;
}

export default pattern(() => {
  const comments = new Writable<StoredComment[]>([
    {
      authorName: "Fable",
      body: "First comment — written headlessly by Fable over the cf CLI.",
      sentAt: 1783615357000,
      extra: "keep this",
    },
    {
      authorName: "Gideon",
      body: "And my first reply from the UI!",
      sentAt: 1783615484455,
    },
    {
      authorName: "Old name",
      author: { kind: "agent", name: "Current name", avatar: "avatar.png" },
      body: "Already structured",
      sentAt: 3,
    },
    {
      authorName: "Preserved person",
      author: { kind: "person", name: "  ", avatar: "person.png" },
      body: "Missing structured name",
      sentAt: 4,
      editedAt: 5,
      removedAt: 6,
      removedBy: { kind: "agent", name: "Moderator" },
    },
    { authorName: "  ", body: "No usable name", sentAt: 7 },
    { body: "No attribution", sentAt: 8 },
  ]);
  const creator = new Writable<TopicAuthor | undefined>();
  const legacyCreator = new Writable("Fable");
  const migrated = new Writable(0);
  const firstComment = comments.key(0);
  const subject = Topic({
    title: "Topics v0 smoke — hello from the fabric",
    body: "I'm adding a body",
    comments,
    createdBy: creator,
    createdByName: legacyCreator,
    topicStateVersion: migrated,
    createdAt: 1783615093992,
  });
  const defaulted = Topic({ createdByName: "Default version" });
  const structured = Topic({
    createdByName: "Legacy creator",
    createdBy: { kind: "agent", name: "Current creator", avatar: "keep.png" },
  });
  const unusableMigrated = new Writable(0);
  const unusable = Topic({
    createdByName: 42,
    comments: [{ authorName: false, body: "No usable name", sentAt: 1 }],
    topicStateVersion: unusableMigrated,
  });
  const completed = Topic({
    createdByName: "Must stay legacy",
    comments: [{
      authorName: "Must stay legacy",
      body: "Untouched",
      sentAt: 1,
    }],
    topicStateVersion: 1,
  });

  const assert_creator_migrated_on_run = assert(() =>
    subject.createdBy?.name === "Fable" &&
    subject.createdBy?.kind === "legacy"
  );
  const assert_comments_migrated_on_run = assert(() =>
    subject.comments[0].author?.name === "Fable" &&
    subject.comments[0].author?.kind === "legacy" &&
    subject.comments[1].author?.name === "Gideon" &&
    subject.comments[1].author?.kind === "legacy"
  );
  const assert_completed_durably = assert(() => migrated.get() === 1);
  const assert_existing_author_wins = assert(() =>
    subject.comments[2].author?.name === "Current name" &&
    subject.comments[2].author?.kind === "agent" &&
    subject.comments[2].author?.avatar === "avatar.png" &&
    structured.createdBy?.name === "Current creator" &&
    structured.createdBy?.kind === "agent" &&
    structured.createdBy?.avatar === "keep.png"
  );
  const assert_partial_author_keeps_metadata = assert(() =>
    subject.comments[3].author?.name === "Preserved person" &&
    subject.comments[3].author?.kind === "person" &&
    subject.comments[3].author?.avatar === "person.png" &&
    subject.comments[3].editedAt === 5 &&
    subject.comments[3].removedAt === 6 &&
    subject.comments[3].removedBy?.name === "Moderator"
  );
  const assert_blank_names_stay_absent = assert(() =>
    subject.comments[4].author === undefined &&
    subject.comments[5].author === undefined
  );
  const assert_original_data_preserved = assert(() =>
    subject.body === "I'm adding a body" &&
    subject.createdAt === 1783615093992 &&
    subject.comments[0].sentAt === 1783615357000 &&
    subject.comments[1].body === "And my first reply from the UI!" &&
    comments.get()[0].authorName === "Fable" &&
    comments.get()[0].extra === "keep this" &&
    legacyCreator.get() === "Fable" &&
    comments.get().length === 6
  );
  const assert_missing_version_defaults_zero = assert(() =>
    defaulted.createdBy?.name === "Default version" &&
    defaulted.createdBy?.kind === "legacy"
  );
  const assert_current_version_skips = assert(() =>
    completed.createdBy?.name === "" &&
    completed.comments[0].author === undefined
  );
  const assert_nonstring_names_complete_without_authors = assert(() =>
    unusable.createdBy?.name === "" &&
    unusable.comments[0].author === undefined &&
    unusableMigrated.get() === 1
  );
  const action_change_legacy_names = action(() => {
    legacyCreator.set("Changed legacy creator");
    creator.key("name").set("");
    comments.key(0).key("authorName").set("Changed legacy commenter");
  });
  const assert_completed_migration_stays_inert = assert(() =>
    creator.get()?.name === "" &&
    subject.comments[0].author?.name === "Fable" &&
    migrated.get() === 1
  );
  const action_replay_migration = action(() => migrated.set(0));
  const assert_replay_fills_only_missing_author = assert(() =>
    creator.get()?.name === "Changed legacy creator" &&
    subject.comments[0].author?.name === "Fable" && migrated.get() === 1
  );
  const action_edit_migrated_comment = action(() => {
    subject.editComment.send({
      comment: firstComment,
      body: "Edited through the original reference",
      agentName: "Test editor",
    });
  });
  const assert_original_reference_remains_editable = assert(() =>
    subject.comments[0].body === "Edited through the original reference" &&
    subject.comments[0].author?.name === "Fable"
  );

  return {
    [TESTS]: [
      { assertion: assert_creator_migrated_on_run },
      { assertion: assert_comments_migrated_on_run },
      { assertion: assert_completed_durably },
      { assertion: assert_existing_author_wins },
      { assertion: assert_partial_author_keeps_metadata },
      { assertion: assert_blank_names_stay_absent },
      { assertion: assert_original_data_preserved },
      { assertion: assert_missing_version_defaults_zero },
      { assertion: assert_current_version_skips },
      { assertion: assert_nonstring_names_complete_without_authors },
      { action: action_change_legacy_names },
      { assertion: assert_completed_migration_stays_inert },
      { action: action_replay_migration },
      { assertion: assert_replay_fills_only_missing_author },
      { action: action_edit_migrated_comment },
      { assertion: assert_original_reference_remains_editable },
    ],
    subject,
  };
});
