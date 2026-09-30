/**
 * Exercises future-version refusal across every durable Topic entry point and
 * a browser mutation that upgrades old state without a running Topic lift.
 */

import {
  action,
  assert,
  Default,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import Topic, {
  dropMention,
  retractProfileComment,
  retractProfileLink,
  saveProfileBody,
  saveProfileTitle,
  submitProfileComment,
  submitProfileLink,
  TOPIC_STATE_VERSION,
  type TopicAuthor,
  type TopicComment,
  type TopicLink,
  type TopicMentionRefMap,
} from "./topic.tsx";

/** Stored comment with the immutable version-zero author key. */
interface LegacyComment extends TopicComment {
  /** Legacy name read by the first upgrade step. */
  authorName?: string;
}

export default pattern(() => {
  const version = new Writable<number>(TOPIC_STATE_VERSION + 1);
  const creator = new Writable<TopicAuthor | undefined>();
  const comments = new Writable<LegacyComment[]>([
    { authorName: "Legacy commenter", body: "Original comment", sentAt: 1 },
  ]);
  const links = new Writable<TopicLink[]>([
    {
      kind: "web",
      url: "https://example.com",
      label: "Original link",
      addedAt: 2,
    },
  ]);
  const title = new Writable("Original title");
  const body = new Writable("Original body");
  const mentioned = new Writable<unknown[]>([]);
  const references = new Writable<TopicMentionRefMap>({});
  const updatedBy = new Writable<TopicAuthor>({ kind: "person", name: "" });
  const updatedAt = new Writable(0);
  const upgrade = {
    topicStateVersion: version,
    createdByName: "Legacy creator",
    createdBy: creator,
    comments,
  };
  const subject = Topic({
    ...upgrade,
    title,
    body,
    links,
    mentioned,
    references,
    titleUpdatedBy: updatedBy,
    titleUpdatedAt: updatedAt,
    bodyUpdatedBy: updatedBy,
    bodyUpdatedAt: updatedAt,
  });
  const targetA = new Writable({ title: "A" });
  const targetB = new Writable({ title: "B" });
  const action_seed_mention = action(() => mentioned.push(targetA));

  const browserState = {
    upgrade,
    title,
    body,
    comments,
    comment: comments.key(0),
    links,
    link: links.key(0),
    mentioned,
    topic: targetA,
    references,
    titleUpdatedBy: updatedBy,
    titleUpdatedAt: updatedAt,
    bodyUpdatedBy: updatedBy,
    bodyUpdatedAt: updatedAt,
    titleDraft: new Writable("Changed title"),
    bodyDraft: new Writable("Changed body"),
    commentDraft: new Writable("New comment"),
    linkUrlDraft: new Writable("https://example.org"),
    linkLabelDraft: new Writable("New link"),
    linkKindDraft: new Writable("web"),
    referencesDraft: new Writable<TopicMentionRefMap>({}),
    editingTitle: new Writable(true),
    editingBody: new Writable(true),
    profileName: "Test person",
    profileAvatar: "",
  };
  const browserAddComment = submitProfileComment(browserState);
  const browserRemoveComment = retractProfileComment(browserState);
  const browserAddLink = submitProfileLink(browserState);
  const browserRemoveLink = retractProfileLink(browserState);
  const browserSetTitle = saveProfileTitle(browserState);
  const browserSetBody = saveProfileBody(browserState);
  const browserUnmention = dropMention(browserState);

  const action_add_comment = action(() =>
    subject.addComment.send({ body: "New", agentName: "Test agent" })
  );
  const action_edit_comment = action(() =>
    subject.editComment.send({
      comment: comments.key(0),
      body: "Changed",
      agentName: "Test agent",
    })
  );
  const action_remove_comment = action(() =>
    subject.removeComment.send({
      comment: comments.key(0),
      agentName: "Test agent",
    })
  );
  const action_add_link = action(() =>
    subject.addLink.send({
      url: "https://example.org",
      agentName: "Test agent",
    })
  );
  const action_remove_link = action(() =>
    subject.removeLink.send({ link: links.key(0), agentName: "Test agent" })
  );
  const action_set_title = action(() =>
    subject.setTitle.send({ title: "Changed", agentName: "Test agent" })
  );
  const action_set_body = action(() =>
    subject.setBody.send({ body: "Changed", agentName: "Test agent" })
  );
  const action_mention = action(() => subject.mention.send({ topic: targetB }));
  const action_unmention = action(() =>
    subject.unmention.send({ topic: targetA })
  );
  const action_browser_add_comment = action(() => browserAddComment.send());
  const action_browser_remove_comment = action(() =>
    browserRemoveComment.send()
  );
  const action_browser_add_link = action(() => browserAddLink.send());
  const action_browser_remove_link = action(() => browserRemoveLink.send());
  const action_browser_set_title = action(() => browserSetTitle.send());
  const action_browser_set_body = action(() => browserSetBody.send());
  const action_browser_unmention = action(() => browserUnmention.send());

  const assert_no_durable_writes = assert(() =>
    title.get() === "Original title" && body.get() === "Original body" &&
    creator.get() === undefined &&
    comments.get().length === 1 && comments.get()[0].author === undefined &&
    comments.get()[0].body === "Original comment" &&
    comments.get()[0].removedAt === undefined &&
    comments.get()[0].editedAt === undefined &&
    links.get().length === 1 && links.get()[0].removedAt === undefined &&
    mentioned.get().length === 1 &&
    updatedBy.get().name === "" && updatedAt.get() === 0
  );
  const assert_future_version_retained = assert(() =>
    version.get() === TOPIC_STATE_VERSION + 1
  );
  const action_negative_version = action(() => version.set(-1));
  const action_fractional_version = action(() => version.set(0.5));
  const action_unsafe_version = action(() =>
    version.set(Number.MAX_SAFE_INTEGER + 1)
  );
  const assert_negative_version_retained = assert(() => version.get() === -1);
  const assert_fractional_version_retained = assert(() =>
    version.get() === 0.5
  );
  const assert_unsafe_version_retained = assert(() =>
    version.get() === Number.MAX_SAFE_INTEGER + 1
  );

  const oldVersion = new Writable(0);
  const oldCreator = new Writable<TopicAuthor | undefined>({
    name: "",
    kind: "legacy",
  });
  const oldComments = new Writable<LegacyComment[] | Default<[]>>([
    {
      authorName: "Old commenter",
      author: { name: "", kind: "legacy" },
      body: "Old comment",
      sentAt: 1,
    },
  ]);
  const oldDraft = new Writable("New comment");
  const upgradeAndSubmit = submitProfileComment({
    upgrade: {
      topicStateVersion: oldVersion,
      createdByName: "Old creator",
      createdBy: oldCreator,
      comments: oldComments,
    },
    comments: oldComments,
    commentDraft: oldDraft,
    profileName: "Current person",
    profileAvatar: "",
  });
  const assert_upgrade_waits_for_handler = assert(() =>
    oldVersion.get() === 0 && oldCreator.get()?.name === "" &&
    oldComments.get()[0].author?.name === ""
  );
  const action_upgrade_and_submit = action(() => upgradeAndSubmit.send());
  const assert_handler_upgraded_before_appending = assert(() =>
    oldVersion.get() === TOPIC_STATE_VERSION &&
    oldCreator.get()?.name === "Old creator" &&
    oldComments.get().length === 2 &&
    oldComments.get()[0].author?.name === "Old commenter" &&
    oldComments.get()[1].author?.name === "Current person" &&
    oldDraft.get() === ""
  );

  const deferredVersion = new Writable(0);
  const deferredName = new Writable<string | undefined>();
  const deferredCreator = new Writable<TopicAuthor>({
    name: "",
    kind: "legacy",
  });
  const deferredTitle = new Writable("Before");
  const saveWithIncompleteUpgrade = saveProfileTitle({
    ...browserState,
    title: deferredTitle,
    titleDraft: new Writable("Saved while incomplete"),
    upgrade: {
      topicStateVersion: deferredVersion,
      createdByName: deferredName,
      createdBy: deferredCreator,
      comments: new Writable<LegacyComment[]>([]),
    },
  });
  const action_save_with_incomplete_upgrade = action(() =>
    saveWithIncompleteUpgrade.send()
  );
  const assert_handler_leaves_upgrade_incomplete = assert(() =>
    deferredVersion.get() === 0 && deferredCreator.get().name === "" &&
    deferredTitle.get() === "Saved while incomplete"
  );
  const action_supply_upgrade_input = action(() =>
    deferredName.set("Arrived creator")
  );
  const assert_handler_completes_available_upgrade = assert(() =>
    deferredVersion.get() === TOPIC_STATE_VERSION &&
    deferredCreator.get().name === "Arrived creator"
  );

  return {
    expectRuntimeErrors: 19,
    [TESTS]: [
      { action: action_seed_mention },
      { assertion: assert_no_durable_writes },
      { action: action_add_comment },
      { assertion: assert_no_durable_writes },
      { action: action_edit_comment },
      { assertion: assert_no_durable_writes },
      { action: action_remove_comment },
      { assertion: assert_no_durable_writes },
      { action: action_add_link },
      { assertion: assert_no_durable_writes },
      { action: action_remove_link },
      { assertion: assert_no_durable_writes },
      { action: action_set_title },
      { assertion: assert_no_durable_writes },
      { action: action_set_body },
      { assertion: assert_no_durable_writes },
      { action: action_mention },
      { assertion: assert_no_durable_writes },
      { action: action_unmention },
      { assertion: assert_no_durable_writes },
      { action: action_browser_add_comment },
      { assertion: assert_no_durable_writes },
      { action: action_browser_remove_comment },
      { assertion: assert_no_durable_writes },
      { action: action_browser_add_link },
      { assertion: assert_no_durable_writes },
      { action: action_browser_remove_link },
      { assertion: assert_no_durable_writes },
      { action: action_browser_set_title },
      { assertion: assert_no_durable_writes },
      { action: action_browser_set_body },
      { assertion: assert_no_durable_writes },
      { action: action_browser_unmention },
      { assertion: assert_no_durable_writes },
      { assertion: assert_future_version_retained },
      { action: action_negative_version },
      { action: action_set_title },
      { assertion: assert_no_durable_writes },
      { assertion: assert_negative_version_retained },
      { action: action_fractional_version },
      { action: action_set_title },
      { assertion: assert_no_durable_writes },
      { assertion: assert_fractional_version_retained },
      { action: action_unsafe_version },
      { action: action_set_title },
      { assertion: assert_no_durable_writes },
      { assertion: assert_unsafe_version_retained },
      { assertion: assert_upgrade_waits_for_handler },
      { action: action_upgrade_and_submit },
      { assertion: assert_handler_upgraded_before_appending },
      { action: action_save_with_incomplete_upgrade },
      { assertion: assert_handler_leaves_upgrade_incomplete },
      { action: action_supply_upgrade_input },
      { action: action_save_with_incomplete_upgrade },
      { assertion: assert_handler_completes_available_upgrade },
    ],
  };
});
