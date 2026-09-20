/**
 * Single-runtime pattern tests for Topics (CT-1878).
 *
 * Complements multi-user.test.tsx (cross-runtime isolation and merge
 * behavior) and topics-rejections.test.tsx (thrown rejections on the mutating
 * verbs — those runs expect runtime errors): this file drives the happy paths
 * in one runtime — atomic agent signatures, body-at-create, label defaulting,
 * body updates, activity-based sorting, the board's bounded discovery index,
 * and the exported pure helpers. UI composer wrappers keep silent guards,
 * exercised here.
 */
import {
  action,
  assert,
  Default,
  equals,
  NAME,
  pattern,
  Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  type MentionableRow,
  mentionableRowsOf,
} from "../collection-naming/mentionable.ts";
import { type NamesMap } from "../collection-naming/naming.ts";
import Topics, {
  activityOrderOf,
  distinctByIdentity,
  mentionedBy,
  mentionListsOf,
  submitProfileTopic,
  type TopicCrossrefRow,
  type TopicPiece,
} from "./main.tsx";
import Topic, {
  type AddCommentResult,
  type AddLinkResult,
  dropMention,
  isSafeLinkUrl,
  type MentionEvent,
  saveProfileBody,
  saveProfileTitle,
  type SetBodyResult,
  snippet,
  submitProfileComment,
  submitProfileLink,
  type TopicAuthor,
  topicAuthorLabel,
  type TopicComment,
  type TopicLink,
  type TopicLinkKind,
  type TopicMentionRefMap,
  type TopicSummary,
  type UnmentionEvent,
  whenLabel,
} from "./topic.tsx";

interface TestVNode {
  type: "vnode";
  name: string;
  // deno-lint-ignore no-explicit-any
  props: Record<string, any>;
  children: unknown[];
}

const isVNode = (node: unknown): node is TestVNode =>
  typeof node === "object" && node !== null &&
  (node as { type?: unknown }).type === "vnode";

function findAllByTag(
  node: unknown,
  tag: string,
  found: TestVNode[] = [],
): TestVNode[] {
  // Resolved before either test. A compiled reactive child arrives cell-backed,
  // and asking `Array.isArray` or `isVNode` of the cell rather than its value
  // stops the walk one level above what it was looking for — a guard that reds
  // on a correct render, which is no more use than one that misses a wrong one.
  // `propValue` returns a non-cell unchanged, so the plain path pays nothing.
  const resolved = propValue(node);
  if (Array.isArray(resolved)) {
    resolved.forEach((child) => findAllByTag(child, tag, found));
    return found;
  }
  if (!isVNode(resolved)) return found;
  if (resolved.name === tag) found.push(resolved);
  for (const child of resolved.children ?? []) findAllByTag(child, tag, found);
  return found;
}

// Compiled JSX props can be cell-backed even when the source expression was
// a plain string or boolean.
// deno-lint-ignore no-explicit-any
const propValue = (value: any): unknown =>
  value && typeof value.get === "function" ? value.get() : value;

// A faithful pre-authorship Topic projection: the legacy schema has no
// `createdBy` path at all, and its verbs declare no results. Pushing one into
// a current Topic's retained mentionable list exercises the mixed-version
// boundary that production migration must preserve.
//
// Its verbs carry the current declared arity because `Stream<E, R>`
// deliberately does not satisfy `Stream<E>` and the sibling projection is one
// contract for the whole list — verb arity is not the legacy dimension under
// test here, the absent `createdBy` path is. A genuinely older deployed
// sibling, whose verbs return nothing, stays valid against this same list at
// runtime: a declared result adds nothing to the generated schema (C3
// withdrawn — results flow schema-free through receipts), so the stored
// schema a legacy piece is validated against is unchanged.

/**
 * What a topic pattern deployed before the current paths existed publishes.
 *
 * Declared explicitly rather than inferred, because the shim returns undefined
 * for the paths it predates and an inferred `unknown` there would make the
 * output schema carry `{ type: "unknown" }` — which a consumer reads back as
 * undefined for reasons that have nothing to do with this test. Spelling the
 * shape out says the real thing: these paths are absent from a legacy sibling,
 * and `TopicPiece` — where they now carry a default and no `| undefined` — has
 * to survive being handed one.
 */
interface LegacyUnsignedTopicOutput {
  [NAME]: string | undefined;
  title: string;
  body: string;
  comments: TopicComment[];
  links: TopicLink[];
  createdAt: number;
  createdBy: TopicAuthor | undefined;
  mentions: unknown[] | undefined;
  references: TopicMentionRefMap | undefined;
  mentioned: unknown[] | undefined;
  referencedBy: TopicSummary[] | undefined;
  commentCount: number | undefined;
  lastActivityAt: number | undefined;
  addComment: Stream<{ body: string }, AddCommentResult>;
  addLink: Stream<
    { kind: TopicLinkKind; url: string; label: string },
    AddLinkResult
  >;
  setBody: Stream<{ body: string }, SetBodyResult>;
  mention: Stream<MentionEvent>;
  unmention: Stream<UnmentionEvent>;
}

const LegacyUnsignedTopic = pattern<
  Record<PropertyKey, never>,
  LegacyUnsignedTopicOutput
>(() => {
  const addComment = action<{ body: string }, AddCommentResult>((event) => ({
    comment: {
      author: { kind: "person", name: "" },
      body: event.body,
      sentAt: 0,
    },
  }));
  const addLink = action<
    { kind: TopicLinkKind; url: string; label: string },
    AddLinkResult
  >((event) => ({
    link: { kind: event.kind, url: event.url, label: event.label },
  }));
  const setBody = action<{ body: string }, SetBodyResult>((event) => ({
    body: event.body,
  }));
  const mention = action<MentionEvent>(() => {});
  const unmention = action<UnmentionEvent>(() => {});
  return {
    [NAME]: undefined,
    title: "Legacy unsigned sibling",
    body: "",
    comments: [],
    links: [],
    createdAt: 1,
    // The retained mixed-version link materializes the legacy missing path as
    // a present undefined value, which must survive current list validation.
    createdBy: undefined,
    // Absent for the same reason `createdBy` is: this sibling predates these
    // paths, and the current projection has to accept that.
    //
    // These two now declare a default and no `| undefined` on `TopicPiece`,
    // which is exactly what this sibling is here to exercise: a retained
    // mixed-version link materializes a missing path as a present undefined,
    // and current list validation has to survive it.
    mentions: undefined,
    references: undefined,
    mentioned: undefined,
    referencedBy: undefined,
    commentCount: undefined,
    lastActivityAt: undefined,
    addComment,
    addLink,
    setBody,
    mention,
    unmention,
  };
});

export default pattern(() => {
  const board = Topics({});
  // The board stores only TopicPiece's shared-safe projection. Exercise the
  // session-local UI controls on a direct Topic instance so this test does not
  // require those narrower cells to resolve through the shared topics array.
  const directTopic = Topic({
    title: "Direct topic",
    body: "line one\nline two",
  });
  // A retained mixed-version list link can project the absent optional
  // createdBy path as an explicit undefined. Keep that sibling in a live
  // mentionable universe: the consumer must validate it without weakening
  // non-empty authorship away from TopicAuthor.
  const mixedMentionable = new Writable<
    TopicPiece[] | Default<[]>
  >([]);
  const mixedMentionConsumer = Topic({
    title: "Mixed mention consumer",
    mentionable: mixedMentionable,
  });

  // Deterministic bindings for the exact handlers used by Profile-backed UI
  // controls. Pattern tests do not provide a #profile wish result, so bind the
  // resolved snapshot values directly here rather than inventing a production
  // fallback identity.
  const profileTopics = new Writable<TopicPiece[] | Default<[]>>([]);
  // Standalone: no board built this, so there is no pivot to read and the topic
  // it creates simply shows no inbound references. Required rather than
  // optional so a real composer cannot forget it and silently lose them.
  const profileBoardCrossrefs = new Writable<TopicCrossrefRow[] | Default<[]>>(
    [],
  );
  // The namespace the composer is handed, standalone for the same reason: the
  // composer allocates out of it and passes what it allocated into the topic
  // it files, so a browser create is numbered exactly as a headless one is.
  const profileNames = new Writable<NamesMap>({});
  const profileTitleDraft = new Writable("Profile topic");
  const profileComments = new Writable<TopicComment[] | Default<[]>>([]);
  const profileCommentDraft = new Writable("via the profile composer");
  const profileBody = new Writable<string | Default<"">>("old body");
  const profileBodyDraft = new Writable("profile-edited body");
  const profileEditingBody = new Writable(true);
  const profileBodyUpdatedBy = new Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >({ kind: "person", name: "" });
  const profileBodyUpdatedAt = new Writable<number | Default<0>>(0);
  const profileLinks = new Writable<TopicLink[] | Default<[]>>([]);
  const profileLinkUrlDraft = new Writable("https://example.com/profile-link");
  const profileLinkLabelDraft = new Writable("profile link");
  const profileLinkKindDraft = new Writable<TopicLinkKind>("session");
  // The durable map starts holding an entry the edit never touches, so a save
  // that published a stale or empty map would be visible as its loss.
  // deno-lint-ignore ban-types
  const profileReferences = new Writable<TopicMentionRefMap | Default<{}>>({
    kept: { destination: undefined, modifiedTitle: false },
  });
  const profileReferencesDraft = new Writable<TopicMentionRefMap>({
    kept: { destination: undefined, modifiedTitle: false },
    minted: { destination: undefined, modifiedTitle: true },
  });
  const profileUpgrade = {
    topicStateVersion: new Writable(1),
    createdByName: new Writable<unknown>(),
    createdBy: new Writable<TopicAuthor | undefined>(),
    comments: profileComments,
  };
  // Render the same cells the deterministic Profile handlers mutate. This
  // keeps their behavior and the detail UI in one end-to-end test path without
  // inventing a fallback identity for the pattern-test runtime.
  const profileTopic = Topic({
    ...profileUpgrade,
    title: "Profile-authored topic",
    body: profileBody,
    comments: profileComments,
    links: profileLinks,
    bodyUpdatedBy: profileBodyUpdatedBy,
    bodyUpdatedAt: profileBodyUpdatedAt,
  });

  const profileSubmitTopic = submitProfileTopic({
    topics: profileTopics,
    mentionable: profileTopics,
    boardCrossrefs: profileBoardCrossrefs,
    names: profileNames,
    newTitle: profileTitleDraft,
    profileName: " Ada ",
    profileAvatar: " 🦊 ",
  });

  const profileSubmitComment = submitProfileComment({
    upgrade: profileUpgrade,
    comments: profileComments,
    commentDraft: profileCommentDraft,
    profileName: "Ada",
    profileAvatar: "🦊",
  });
  const profileSaveBody = saveProfileBody({
    upgrade: profileUpgrade,
    body: profileBody,
    bodyDraft: profileBodyDraft,
    references: profileReferences,
    referencesDraft: profileReferencesDraft,
    editingBody: profileEditingBody,
    bodyUpdatedBy: profileBodyUpdatedBy,
    bodyUpdatedAt: profileBodyUpdatedAt,
    profileName: "Ada",
    profileAvatar: "🦊",
  });
  const profileSubmitLink = submitProfileLink({
    upgrade: profileUpgrade,
    links: profileLinks,
    linkUrlDraft: profileLinkUrlDraft,
    linkLabelDraft: profileLinkLabelDraft,
    linkKindDraft: profileLinkKindDraft,
    profileName: "Ada",
    profileAvatar: "🦊",
  });

  // --- actions ---

  // The verbs, and every read of what they write, are exercised on a direct
  // instance, because the board's demand carries neither the verbs nor the
  // thread, links, or update stamps they produce. `addTopic`'s own create
  // behavior is asserted through the board below, on the fields it does demand.
  const boardVerbTopic = Topic({
    title: "Board verb target",
    createdBy: { kind: "agent", name: "Sol" },
  });

  const action_add_first_topic = action(() => {
    board.addTopic.send({ title: "  First topic  ", agentName: "  Sol  " });
  });
  const action_add_second_topic = action(() => {
    board.addTopic.send({ title: "Second topic", agentName: "Fable" });
  });
  // Body at create: the create's atomic unit — no reader observes a
  // title-only halfway state, and created-with is not an update (the
  // bodyUpdatedBy/At stamps stay unset; createdBy covers authorship).
  const action_add_third_topic = action(() => {
    board.addTopic.send({
      title: "Composed topic",
      body: "    indented code\nline two\n",
      agentName: "Sol",
    });
  });
  const action_link_unsigned_mixed_version_sibling = action(() => {
    mixedMentionable.push(
      LegacyUnsignedTopic({}) as TopicPiece,
    );
  });

  // The unsigned caller is gone. `agentName` is required on every verb, so
  // there is no legacy board, no hidden name cell, and no unsigned mutation to
  // exercise — a call without a signature now rejects, which
  // `topics-rejections.test.tsx` is where it is proven. What that retires with
  // it: the `myName` fallback, the `createdByName` and `authorName` mirrors it
  // filled, and the `setBody` path that wrote a body while leaving the
  // PREVIOUS author's stamps on it.
  const action_comment_signed = action(() => {
    boardVerbTopic.addComment.send({
      body: "hello thread",
      agentName: "Sol",
    });
  });
  const action_set_body = action(() => {
    boardVerbTopic.setBody.send({
      body: "line one\nline two",
      agentName: "Sol",
    });
  });
  const action_link_valid_unlabeled = action(() => {
    boardVerbTopic.addLink.send({
      kind: "pr",
      url: "https://github.com/commonfabric/labs/pull/4643",
      label: "  ",
      agentName: "Sol",
    });
  });
  const action_comment_first_again = action(() => {
    boardVerbTopic.addComment.send({
      body: "bumping the first topic",
      agentName: "Sol",
    });
  });

  const action_submit_profile_topic = action(() => {
    profileSubmitTopic.send();
  });
  const action_submit_profile_comment = action(() => {
    profileSubmitComment.send();
  });
  const action_save_profile_body = action(() => {
    profileSaveBody.send();
  });
  const action_submit_profile_link = action(() => {
    profileSubmitLink.send();
  });
  const action_start_profile_body_edit = action(() => {
    profileTopic.startEditBody.send();
  });

  // --- UI-affordance flows (the same paths the rendered controls drive) ---

  const action_submit_blank_comment_draft = action(() => {
    directTopic.commentDraft.set("   ");
    directTopic.submitComment.send();
  });
  // Edit flows are split across test steps: startEditBody's handler runs in
  // the scheduler AFTER this action body, so a same-action draft-set would be
  // overwritten by the handler's own body→draft copy.
  const action_start_edit = action(() => {
    directTopic.startEditBody.send();
  });
  const action_cancel_edit = action(() => {
    directTopic.bodyDraft.set("abandoned draft");
    directTopic.cancelEditBody.send();
  });
  const action_submit_blank_link_draft = action(() => {
    directTopic.linkUrlDraft.set("   ");
    directTopic.submitLink.send();
  });
  // --- assertions ---

  const assert_initial = assert(() =>
    board.topicCount === 0 &&
    (board.topics ?? []).length === 0 &&
    (board.mentionable ?? []).length === 0
  );
  const assert_explicit_undefined_author_projection = assert(() =>
    mixedMentionable.get().length === 1 &&
    // The explicit undefined was accepted, then shaped through the declared
    // compatibility default for downstream readers.
    mixedMentionable.get()[0]?.createdBy?.name === "" &&
    mixedMentionable.get()[0]?.commentCount === 0 &&
    mixedMentionable.get()[0]?.lastActivityAt === 0 &&
    mixedMentionable.get()[0]?.[NAME] === "" &&
    // The consumer holding that list materialized rather than failing argument
    // validation on the mixed-version link.
    mixedMentionConsumer[NAME] === "Mixed mention consumer"
  );

  const assert_first_topic = assert(() =>
    board.topicCount === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.body === "" &&
    board.topics?.[0]?.createdBy?.kind === "agent" &&
    board.topics?.[0]?.createdBy?.name === "Sol" &&
    (board.topics?.[0]?.createdAt ?? 0) > 0 &&
    board.topics?.[0]?.commentCount === 0 &&
    board.topics?.[0]?.lastActivityAt === board.topics?.[0]?.createdAt &&
    board.topics?.[0]?.[NAME] === "First topic"
  );

  const assert_comment_landed = assert(() =>
    boardVerbTopic.commentCount === 1 &&
    boardVerbTopic.comments?.[0]?.author?.kind === "agent" &&
    boardVerbTopic.comments?.[0]?.author?.name === "Sol" &&
    boardVerbTopic.comments?.[0]?.body === "hello thread" &&
    (boardVerbTopic.comments?.[0]?.sentAt ?? 0) > 0 &&
    (boardVerbTopic.lastActivityAt ?? 0) >= (boardVerbTopic.createdAt ?? 0)
  );

  const assert_body_set = assert(() =>
    boardVerbTopic.body === "line one\nline two" &&
    boardVerbTopic.bodyUpdatedBy?.kind === "agent" &&
    boardVerbTopic.bodyUpdatedBy?.name === "Sol" &&
    (boardVerbTopic.bodyUpdatedAt ?? 0) > 0
  );

  // A valid https link with a blank label defaults its label to the URL.
  const assert_link_added = assert(() =>
    (boardVerbTopic.links ?? []).length === 1 &&
    boardVerbTopic.links?.[0]?.kind === "pr" &&
    boardVerbTopic.links?.[0]?.label ===
      "https://github.com/commonfabric/labs/pull/4643" &&
    boardVerbTopic.links?.[0]?.addedBy?.name === "Sol" &&
    (boardVerbTopic.links?.[0]?.addedAt ?? 0) > 0
  );

  const assert_second_topic = assert(() =>
    board.topicCount === 2 &&
    board.topics?.[1]?.title === "Second topic" &&
    board.topics?.[1]?.createdBy?.kind === "agent" &&
    board.topics?.[1]?.createdBy?.name === "Fable" &&
    board[NAME] === "Topics (2)"
  );

  const assert_third_topic = assert(() =>
    board.topicCount === 3 &&
    board.topics?.[2]?.title === "Composed topic" &&
    board.topics?.[2]?.createdBy?.name === "Sol" &&
    // Body-at-create: preserved VERBATIM (whitespace-sensitive Markdown must
    // survive, matching setBody), and NOT a body update — the update stamps
    // stay unset (createdBy covers create authorship).
    // Preserved VERBATIM: whitespace-sensitive Markdown must survive, matching
    // setBody. That it is NOT recorded as a body update reads `bodyUpdatedBy/At`,
    // which the board does not demand, and is guarded in
    // `integration/topic-board-child-contract.test.ts`.
    board.topics?.[2]?.body === "    indented code\nline two\n"
  );

  const assert_blank_draft_rejected = assert(() =>
    directTopic.commentCount === 0
  );

  // startEditBody copied the current body into the draft and opened the editor.
  const assert_editing = assert(() =>
    directTopic.editingBody === true &&
    directTopic.bodyDraft.get() === "line one\nline two"
  );

  const assert_edit_cancelled = assert(() =>
    directTopic.editingBody === false &&
    directTopic.body === "line one\nline two"
  );

  const assert_profile_topic_submitted = assert(() => {
    const list = profileTopics.get() ?? [];
    return list.length === 1 &&
      list[0]?.title === "Profile topic" &&
      list[0]?.createdBy?.kind === "person" &&
      list[0]?.createdBy?.name === "Ada" &&
      list[0]?.createdBy?.avatar === "🦊" &&
      profileTitleDraft.get() === "";
  });

  // The browser composer allocates out of the same namespace the headless
  // create does, in the same transaction as its append: drop the allocation
  // and the map stays empty while the topic still lands.
  //
  // That the composer also passes the number INTO the topic is covered in
  // naming.test.tsx, which binds this same handler and witnesses the
  // pass-through through the composed topic's refusal of a second number. It
  // cannot be covered here, and the reason is worth knowing: the composer
  // builds the topic inside the handler, so no cell of this file's is its
  // number input, and `SHOW_TOPIC_NUMBERS` gates the published `shortName`, so
  // reading that would assert an absence every topic has.
  const assert_profile_topic_named = assert(() =>
    Object.keys(profileNames.get()).join(",") === "1" &&
    equals(
      profileNames.get()["1"] as object,
      profileTopics.key(0),
    )
  );

  const assert_profile_comment_submitted = assert(() => {
    const list = profileComments.get() ?? [];
    return list.length === 1 &&
      list[0]?.body === "via the profile composer" &&
      list[0]?.author?.kind === "person" &&
      list[0]?.author?.name === "Ada" &&
      list[0]?.author?.avatar === "🦊" &&
      (list[0]?.sentAt ?? 0) > 0 &&
      profileCommentDraft.get() === "";
  });

  const assert_profile_body_saved = assert(() =>
    profileBody.get() === "profile-edited body" &&
    profileBodyUpdatedBy.get()?.kind === "person" &&
    profileBodyUpdatedBy.get()?.name === "Ada" &&
    profileBodyUpdatedAt.get() > 0 &&
    profileEditingBody.get() === false
  );

  // The staged map publishes with the prose, entry for entry: the one the
  // draft minted arrives, and the one it inherited survives.
  const assert_profile_references_published = assert(() => {
    const published = (profileReferences.get() ?? {}) as TopicMentionRefMap;
    return Object.keys(published).toSorted().join(",") === "kept,minted" &&
      published.minted?.modifiedTitle === true &&
      published.kept?.modifiedTitle === false;
  });

  const assert_profile_link_submitted = assert(() => {
    const list = profileLinks.get() ?? [];
    return list.length === 1 &&
      list[0]?.kind === "session" &&
      list[0]?.url === "https://example.com/profile-link" &&
      list[0]?.label === "profile link" &&
      list[0]?.addedBy?.kind === "person" &&
      list[0]?.addedBy?.name === "Ada" &&
      list[0]?.addedBy?.avatar === "🦊" &&
      (list[0]?.addedAt ?? 0) > 0 &&
      profileLinkUrlDraft.get() === "" &&
      profileLinkLabelDraft.get() === "" &&
      profileLinkKindDraft.get() === "web";
  });

  // The pivot's join, handed the SAME topic at two indices. That is the only
  // shape that separates the rule the pivot actually holds — exclude by
  // identity — from the one that passes every test where each topic appears
  // once, exclude by array position. With a position check the twin at index 1
  // is not excluded, its self-mention matches, and the topic is reported as
  // referenced from its own second entry.
  const twinA = Topic({ title: "Twin" });
  const twinB = Topic({ title: "Other" });
  const assert_self_mention_inert_through_a_twin = assert(() => {
    // `twinB`'s mention of `twinA` is a real inbound edge, so the exclusion is
    // not simply swallowing everything.
    const inbound = mentionedBy(
      twinA,
      [twinA, twinA, twinB],
      [[twinA], [twinA], [twinA]],
    );
    return inbound.length === 1 && equals(inbound[0], twinB);
  });

  // `mentionedBy()` lists a source once for each entry of the list it is
  // handed whose mentions name the topic and which is not the topic itself,
  // so `twinA` at two entries is listed twice. The board's backlinks count a
  // duplicated source once because the pivot hands `mentionedBy()` the list
  // `distinctByIdentity()` returns.
  const assert_mentioned_by_counts_each_matching_entry = assert(() => {
    const inbound = mentionedBy(
      twinB,
      [twinA, twinA, twinB],
      [[twinB], [twinB], []],
    );
    return inbound.length === 2 && equals(inbound[0], twinA) &&
      equals(inbound[1], twinA);
  });

  const assert_repeated_mentions_contribute_one_edge_per_source_entry = assert(
    () => {
      const inbound = mentionedBy(
        twinB,
        [twinA, twinB, twinA],
        [[undefined, twinB, twinB], [twinB], undefined],
      );
      return inbound.length === 1 && equals(inbound[0], twinA);
    },
  );

  // A topic that has never run publishes no `lastActivityAt`, and the row
  // coalesces that absence to 0. Ordering on the 0 would file the newest topic
  // on the board below every topic that has ever run, so the order falls back
  // to `createdAt`, which a cold row always carries.
  const assert_cold_row_orders_by_created_at = assert(() =>
    activityOrderOf({ lastActivityAt: 0, createdAt: 1700 }) === 1700 &&
    activityOrderOf({ lastActivityAt: undefined, createdAt: 1700 }) === 1700
  );

  // A topic that HAS run orders by its published activity, which is what the
  // fallback must not mask: `lastActivityOf` is a max including `createdAt`,
  // so a real value is always the later of the two and never 0.
  const assert_warm_row_orders_by_last_activity = assert(() =>
    activityOrderOf({ lastActivityAt: 2500, createdAt: 1700 }) === 2500
  );

  // The ordering this exists for, stated as the comparison the sort makes: a
  // cold topic filed AFTER a warm one still sorts above it. Fixed inputs that
  // disagree with the defect — under the old `?? 0` the cold row scored 0 and
  // lost to every warm row, whatever its filing time.
  const assert_cold_new_topic_outranks_an_older_warm_one = assert(() => {
    const coldAndNew = { lastActivityAt: 0, createdAt: 9000 };
    const warmAndOld = { lastActivityAt: 8000, createdAt: 1000 };
    return activityOrderOf(coldAndNew) > activityOrderOf(warmAndOld);
  });

  // The pivot's row list, handed a board naming `identityTarget` twice: once
  // directly and once as the slot of a list holding a link to it. The slot is
  // a different link that resolves to the same document, so only a comparison
  // that resolves both sides, as `mentionedBy`'s does, counts it as the same
  // topic. A mid-sync entry is left out, and `identityOther`, listed again
  // last, keeps the place of its first entry.
  const identityTarget = new Writable({ title: "Identity target" });
  const identityOther = new Writable({ title: "Identity other" });
  const identityHolder = new Writable<{ title: string }[] | Default<[]>>([]);
  const action_alias_identity_target = action(() => {
    identityHolder.push(identityTarget);
  });
  const assert_distinct_by_identity_keeps_each_first_occurrence = assert(() => {
    // Taken here rather than captured: a captured cell whose value is a link
    // arrives already pointing at that link's target, so it would hand over
    // the target's own link.
    const identityAlias = identityHolder.key(0);
    const distinct = distinctByIdentity([
      identityOther,
      undefined,
      identityTarget,
      identityAlias,
      identityOther,
    ]);
    return !Writable.equalLinks(identityAlias, identityTarget) &&
      equals(identityAlias, identityTarget) &&
      distinct.length === 2 &&
      Writable.equalLinks(distinct[0], identityOther) &&
      Writable.equalLinks(distinct[1], identityTarget);
  });

  // A source mid-sync reads back as undefined, and taking `.mentions` of that
  // throws — which killed the pivot and, with it, the append that produced the
  // half-written source. The first two entries are what a settled board looks
  // like; the third is the one that used to throw. Reading its list as
  // undefined is exactly what `mentionedBy` above declares and guards.
  const assert_mention_lists_tolerate_a_mid_sync_source = assert(() => {
    const settled = (m: unknown[]) => ({ get: () => ({ mentions: m }) });
    const midSync = { get: () => undefined };
    const lists = mentionListsOf([settled([twinA]), settled([]), midSync]);
    return lists.length === 3 &&
      (lists[0] as unknown[]).length === 1 &&
      (lists[1] as unknown[]).length === 0 &&
      lists[2] === undefined &&
      // And the consumer stays usable on that output rather than merely not
      // throwing: the mid-sync row contributes no inbound edge.
      mentionedBy(twinB, [twinA, twinB], [[twinB], undefined]).length === 1;
  });

  const assert_pure_helpers = assert(() =>
    snippet("a b  c", 3) === "a b…" &&
    snippet("hi", 10) === "hi" &&
    whenLabel(0) === "" &&
    whenLabel(1783560681000).startsWith("Jul ") &&
    isSafeLinkUrl("https://example.com") === true &&
    isSafeLinkUrl("HTTP://EXAMPLE.COM") === true &&
    isSafeLinkUrl("javascript:alert(1)") === false &&
    isSafeLinkUrl("   ") === false &&
    // An author with no name reads as "someone" rather than as blank; the
    // legacy display name that used to stand in here is retired.
    topicAuthorLabel({ kind: "person", name: "" }) === "someone" &&
    topicAuthorLabel({ kind: "agent", name: "Sol" }) === "Sol (agent)"
  );

  // --- index: the board's bounded discovery surface ---

  // Address-plus-summary rows mirror the board at the two-topic point: every
  // The summary scalars answer the survey questions directly, off the topic
  // each row is.
  //
  // Runs while the harness still evaluates the board's card-list computed, so
  // the card branches render (and count as covered), not just the data layer.
  const assert_index_baseline = assert(() =>
    (board.index ?? []).length === 2 &&
    board.index?.[0]?.title === "First topic" &&
    (board.index?.[0]?.createdAt ?? 0) > 0 &&
    board.index?.[0]?.createdBy?.kind === "agent" &&
    board.index?.[0]?.createdBy?.name === "Sol" &&
    (board.index?.[0]?.lastActivityAt ?? 0) >=
      (board.index?.[0]?.createdAt ?? 0) &&
    board.index?.[1]?.title === "Second topic"
  );

  // The bound itself: serializing the whole index carries no expanded piece
  // content (body/comments/links), no verb streams, and no runtime values —
  // the declared schema, not reader discipline, is the guarantee.
  const assert_index_bounded = assert(() => {
    const rows = board.index ?? [];
    if (rows.length < 2) return false;
    const serialized = JSON.stringify(rows);
    return !serialized.includes('"body"') &&
      !serialized.includes('"comments"') &&
      !serialized.includes('"links"') &&
      !serialized.includes('"addComment"') &&
      !serialized.includes('"setBody"') &&
      !serialized.includes('"addLink"') &&
      !serialized.includes("vnode");
  });

  // The index tracks the board rather than snapshotting it: a topic added
  // later gets its own row, with its own scalars.
  const assert_index_tracks_the_board = assert(() =>
    (board.index ?? []).length === 3 &&
    board.index?.[2]?.title === "Composed topic" &&
    // That a row carries a count updated AFTER the row was built is guarded in
    // `integration/topic-board-child-contract.test.ts` ("carries the updated
    // comment count on the board's index row"); this assertion covers the
    // index tracking the board's membership.
    board.index?.[2]?.createdBy?.name === "Sol"
  );

  // Pin the persisted navigation contract directly. A cold renderer must see
  // ordinary cf-cell-link destinations, never pattern-owned handler streams —
  // a card addresses the topic's own cell, so the markup survives a reload
  // that no ephemeral event stream would.
  const assert_cell_link_markup = assert(() => {
    const openLinks = findAllByTag(board[UI], "cf-cell-link");
    if (openLinks.length === 0) return false;
    const topics = board.topics ?? [];
    return openLinks.every((link) =>
      propValue(link.props.label) === "Open" &&
      propValue(link.props.static) === true &&
      link.props.onClick === undefined &&
      link.props["oncf-click"] === undefined &&
      // What the link points at is half the contract, and the half a rendered
      // card still looks right without. A binding to anything but the topic —
      // a view built for the card, a step into the board's own list — renders
      // the same chip, so the comparison below is what separates them: the
      // bound cell has to resolve to a topic the board holds.
      topics.some((topic) => equals(topic, link.props["$cell"]))
    );
  });

  // --- mentionable: the board's mention index ---

  // The mention index mirrors the board as COPIES plus a reference: the two
  // strings the autocomplete needs are in the rows themselves, and `piece`
  // is the topic each row stands for — the same document, by identity.
  const assert_mention_index_baseline = assert(() =>
    (board.mentionable ?? []).length === 2 &&
    board.mentionable?.[0]?.[NAME] === "First topic" &&
    board.mentionable?.[0]?.title === "First topic" &&
    board.mentionable?.[1]?.[NAME] === "Second topic" &&
    equals(
      board.mentionable?.[0]?.piece as object,
      board.topics?.[0] as object,
    ) &&
    equals(
      board.mentionable?.[1]?.piece as object,
      board.topics?.[1] as object,
    )
  );

  // The bound: one self-contained list of scalars and held references.
  // Serializing every row carries no expanded topic content, no verb
  // streams, and no runtime values — the copies plus a link each, nothing
  // else. The declared row schema, not reader discipline, is the guarantee.
  const assert_mention_index_bounded = assert(() => {
    const rows = board.mentionable ?? [];
    if (rows.length < 2) return false;
    const serialized = JSON.stringify(rows);
    return !serialized.includes('"body"') &&
      !serialized.includes('"comments"') &&
      !serialized.includes('"addComment"') &&
      !serialized.includes("vnode");
  });

  // The index tracks the board rather than snapshotting it: a topic added
  // later gets its own row, standing for the new topic by identity.
  const assert_mention_index_tracks_the_board = assert(() =>
    (board.mentionable ?? []).length === 3 &&
    board.mentionable?.[2]?.[NAME] === "Composed topic" &&
    equals(
      board.mentionable?.[2]?.piece as object,
      board.topics?.[2] as object,
    )
  );

  // The derivation's own rules, on sources built by hand:
  // a mid-sync entry contributes no row, the display name falls back to the
  // persisted title until a topic derives its `[NAME]` (and past a blank
  // one), the collection's name for a member is copied off the member's own
  // and reads blank where it has none, and a row records its SOURCE as
  // `piece` — identity, not a copy.
  const assert_mention_index_rows_pure = assert(() => {
    const named = {
      get: () => ({ [NAME]: "Named", title: "Titled", shortName: "42" }),
    };
    const cold = {
      get: () => ({ [NAME]: undefined, title: "Cold title" }),
    };
    const blankName = { get: () => ({ [NAME]: "", title: "Blank name" }) };
    const midSync = { get: () => undefined };
    const rows = mentionableRowsOf(
      [named, cold, midSync, blankName, undefined],
    );
    return rows.length === 3 &&
      rows[0]?.[NAME] === "Named" &&
      rows[0]?.title === "Titled" &&
      rows[0]?.shortName === "42" &&
      rows[0]?.piece === named &&
      rows[1]?.[NAME] === "Cold title" &&
      rows[1]?.shortName === "" &&
      rows[2]?.[NAME] === "Blank name" &&
      rows[2]?.piece === blankName;
  });

  // A topic accepts the index's rows as its mention universe — the exact
  // list the backfill rewires onto every existing topic. The consumer
  // materializing proves the three-string demand validates a row list; the
  // read-back proves the row landed with its copies intact and its piece
  // still a reference, not a flattened copy of the cell.
  const rowPieceTarget = new Writable({ title: "Row piece target" });
  const rowUniverse = new Writable<MentionableRow[] | Default<[]>>([]);
  const rowUniverseConsumer = Topic({
    title: "Row universe consumer",
    mentionable: rowUniverse,
  });
  const action_seed_row_universe = action(() => {
    rowUniverse.push({
      [NAME]: "Seeded row",
      title: "Seeded row",
      shortName: "7",
      piece: rowPieceTarget,
    });
  });
  const assert_row_universe_accepted = assert(() =>
    rowUniverse.get().length === 1 &&
    rowUniverse.get()[0]?.[NAME] === "Seeded row" &&
    rowUniverse.get()[0]?.shortName === "7" &&
    equals(rowUniverse.get()[0]?.piece as object, rowPieceTarget) &&
    rowUniverseConsumer[NAME] === "Row universe consumer"
  );

  // --- mention retraction through the UI affordance ---

  // The rules of the board's mention pivot — one row per topic, a self-mention
  // earning no inbound edge, two mentions each landing their own, and an
  // unmention dropping only what it retracted — are in
  // `packages/patterns/integration/topic-board-child-contract.test.ts`, and
  // the identity-not-position rule is in
  // `assert_self_mention_inert_through_a_twin` above, which hands
  // `mentionedBy()` a list holding one topic twice.
  //
  // What stays here is the part that never needed the pivot: `dropMention` is
  // a UI affordance over a caller's own list, and it needs two piece
  // identities and nothing else.
  // Plain cells rather than Topic pieces. `dropMention` removes by IDENTITY —
  // `removeByValue` matches a cell by its link — so a cell is a faithful stand
  // -in for the piece a real caller would hold, and the rule under test is the
  // same.
  // `mention` and `unmention` themselves, on a directly held topic. Each one
  // writes the topic's OWN `mentioned` list, and the set semantics that make
  // them mergeable are the part worth pinning here.
  // --- Stamped removals (Stage C item 1) ---
  //
  // A retraction stamps the record and leaves it in place. Driven on a
  // directly held topic that owns its own cells, for the reason the mention
  // cases below are: these verbs write the topic's OWN lists. The comment
  // verbs are handed a REFERENCE to a stored element; the link retraction
  // below names its record by `url`.
  const retractionComments = new Writable<TopicComment[]>([]);
  const retractionLinks = new Writable<TopicLink[]>([]);
  const retractionSubject = Topic({
    title: "Retraction subject",
    comments: retractionComments,
    links: retractionLinks,
  });

  const action_retraction_setup = action(() => {
    retractionSubject.addComment.send({
      body: "first thought",
      agentName: "Sol",
    });
    // A second comment, so the thread's sort comparator actually compares.
    // One comment sorts without ever calling it, which leaves the ordering
    // rule — the thing that decides what a reader sees first — unexercised.
    retractionSubject.addComment.send({
      body: "second thought",
      agentName: "Sol",
    });
    retractionSubject.addLink.send({
      url: "https://example.com/a-page",
      agentName: "Sol",
    });
  });

  const action_edit_comment = action(() => {
    retractionSubject.editComment.send({
      comment: retractionComments.key(0),
      body: "first thought, revised",
      agentName: "Sol",
    });
  });

  // An edit revises the body and stamps `editedAt`, leaving `author` and
  // `sentAt` alone: an edit changes what was said, not who said it.
  const assert_comment_edited = assert(() =>
    retractionSubject.commentCount === 2 &&
    retractionSubject.comments?.[0]?.body === "first thought, revised" &&
    retractionSubject.comments?.[0]?.author?.name === "Sol" &&
    (retractionSubject.comments?.[0]?.editedAt ?? 0) > 0 &&
    retractionSubject.comments?.[0]?.removedAt === undefined
  );

  // What the view projection actually carries, which reading the stored
  // records cannot tell you. `commentsView` filters inside `computed()` and
  // its lambda touches only `removedAt`, so if this family's demand is
  // usage-lowered all the way down, the rendered rows would come back with
  // their bodies absent and every assertion above would still pass. Asserting
  // through the render is the only place that shows.
  const assert_rendered_thread_carries_bodies = assert(() => {
    const serialized = JSON.stringify(retractionSubject[UI]);
    return serialized.includes("first thought, revised") &&
      serialized.includes("Sol");
  });

  const action_remove_comment = action(() => {
    retractionSubject.removeComment.send({
      comment: retractionComments.key(0),
      agentName: "Sol",
    });
  });

  // Stamped, not deleted: the record is still stored and still carries what it
  // said, while the count stops counting it.
  const assert_comment_retracted = assert(() =>
    retractionSubject.commentCount === 1 &&
    (retractionSubject.comments ?? []).length === 2 &&
    retractionSubject.comments?.[0]?.body === "first thought, revised" &&
    (retractionSubject.comments?.[0]?.removedAt ?? 0) > 0 &&
    retractionSubject.comments?.[0]?.removedBy?.name === "Sol"
  );

  // The reason the design is stamped rather than deleted, stated as the
  // invariant rather than as a before-and-after. `lastActivityAt` is a max
  // over what the arrays HOLD, so the retracted comment's own stamps are
  // still in it — and the retraction, being the newest thing that happened,
  // is what the max now equals. Skip retracted records in `lastActivityOf`
  // and this reads the link's older `addedAt` instead, which is exactly the
  // backwards move that would reorder the board under a reader.
  const assert_retraction_moved_activity_forward = assert(() =>
    (retractionSubject.comments?.[0]?.removedAt ?? 0) > 0 &&
    retractionSubject.lastActivityAt ===
      retractionSubject.comments?.[0]?.removedAt
  );

  // And the other direction: a retracted comment leaves the rendered thread,
  // so the filter that `commentCount` applies is the same one the reader sees.
  const assert_retracted_comment_leaves_the_render = assert(() => {
    const serialized = JSON.stringify(retractionSubject[UI]);
    return !serialized.includes("first thought, revised");
  });

  const action_remove_link_by_url = action(() => {
    retractionSubject.removeLink.send({
      url: "https://example.com/a-page",
      agentName: "Sol",
    });
  });

  // The url spelling reaches a stored record — the spelling that exists
  // because a link carries no fid for a CLI caller to name.
  const assert_link_retracted = assert(() =>
    (retractionSubject.links ?? []).length === 1 &&
    (retractionSubject.links?.[0]?.removedAt ?? 0) > 0 &&
    retractionSubject.links?.[0]?.removedBy?.name === "Sol"
  );

  const mentionSubject = Topic({ title: "Mention subject" });
  // Plain cells, because `MentionEvent.topic` declares `Writable<{ title }>`
  // rather than a piece, and the verb matches by cell identity.
  const mentionTargetA = new Writable({ title: "Mention target A" });
  const mentionTargetB = new Writable({ title: "Mention target B" });
  // A link on the same topic, so the outbound-reference derivation runs over
  // all three of its sources rather than two. A web URL names no piece, so it
  // resolves to nothing and is filtered out — the mention counts below are
  // unaffected, which is the point: a link that is just a link adds no edge.
  const action_mention_subject_gets_a_link = action(() => {
    mentionSubject.addLink.send({
      url: "https://example.com/not-a-piece",
      agentName: "Sol",
    });
  });
  const assert_plain_link_is_no_mention = assert(() =>
    (mentionSubject.links ?? []).length === 1 &&
    (mentionSubject.mentions ?? []).length === 0
  );

  const action_mention_one = action(() => {
    mentionSubject.mention?.send({ topic: mentionTargetA });
  });
  const assert_mention_recorded = assert(() =>
    (mentionSubject.mentions ?? []).length === 1
  );
  const action_mention_same_again = action(() => {
    mentionSubject.mention?.send({ topic: mentionTargetA });
  });
  // A set-add, not an append: referencing the same piece twice is one
  // reference, which is what makes concurrent mentions mergeable.
  const assert_repeat_mention_is_one = assert(() =>
    (mentionSubject.mentions ?? []).length === 1
  );
  const action_mention_second = action(() => {
    mentionSubject.mention?.send({ topic: mentionTargetB });
  });
  const assert_two_distinct_mentions = assert(() =>
    (mentionSubject.mentions ?? []).length === 2
  );
  const action_unmention_first = action(() => {
    mentionSubject.unmention?.send({ topic: mentionTargetA });
  });
  // Removal resolves against durable state rather than rewriting the array,
  // so the survivor stays the reference it was.
  const assert_only_the_retracted_one_left = assert(() =>
    (mentionSubject.mentions ?? []).length === 1 &&
    equals((mentionSubject.mentions ?? [])[0] as object, mentionTargetB)
  );

  const mentionOne = new Writable({ tag: "mention one" });
  const mentionTwo = new Writable({ tag: "mention two" });
  const uiMentioned = new Writable<unknown[] | Default<[]>>([]);
  const action_ui_mentions_two = action(() => {
    uiMentioned.push(mentionOne);
    uiMentioned.push(mentionTwo);
  });
  const uiDropMention = dropMention({
    upgrade: profileUpgrade,
    mentioned: uiMentioned,
    topic: mentionOne,
  });
  const action_drop_one_from_ui = action(() => {
    uiDropMention.send();
  });
  const assert_ui_dropped_only_that_one = assert(() =>
    uiMentioned.get().length === 1 &&
    // The survivor is still the piece it was, not a flattened copy of it.
    equals(uiMentioned.get()[0] as object, mentionTwo)
  );

  // A piece with no board wired in shows no inbound references rather than
  // failing: `boardCrossrefs` is optional, as `mentionable` is.
  const assert_boardless_topic_has_no_backlinks = assert(() =>
    (directTopic.referencedBy ?? []).length === 0
  );

  // --- setTitle: the rename verb, direct interface only ---

  const action_rename_direct_topic = action(() => {
    directTopic.setTitle.send({
      title: "  Direct topic, renamed  ",
      agentName: " Sol ",
    });
  });
  // Trimmed title, structured attribution, and the rename moves the activity
  // clock — a renamed topic surfaces in the board's most-recent sort.
  const assert_renamed_with_attribution = assert(() =>
    directTopic.title === "Direct topic, renamed" &&
    directTopic.titleUpdatedBy?.kind === "agent" &&
    directTopic.titleUpdatedBy?.name === "Sol" &&
    (directTopic.titleUpdatedAt ?? 0) > 0 &&
    directTopic.lastActivityAt === directTopic.titleUpdatedAt
  );

  // What the HEADER RENDERS, not just what `editingTitle` holds. The two are
  // different claims: a conditional that tested the cell object rather than
  // its value would leave `editingTitle` correct and still render the edit
  // form permanently, and no assertion on the output value can see that.
  // The title input exists only in the edit branch, and the two link drafts
  // are the only other `cf-input`s on the page, so the count discriminates:
  // two while reading, three while renaming.
  // These assert what RENDERS and nothing else; `editingTitle`'s own value is
  // covered by the lifecycle assertions below.
  const assert_header_reads = assert(() =>
    findAllByTag(directTopic[UI], "cf-input").length === 2
  );
  const assert_header_edits = assert(() =>
    findAllByTag(directTopic[UI], "cf-input").length === 3
  );

  // The rename editor's session lifecycle: Edit seeds the draft from the
  // durable title, Cancel discards without touching it.
  const action_start_rename_editor = action(() => {
    directTopic.startEditTitle.send();
  });
  const assert_rename_editor_seeded = assert(() =>
    directTopic.editingTitle === true &&
    directTopic.titleDraft.get() === "Direct topic, renamed"
  );
  const action_cancel_rename_editor = action(() => {
    directTopic.titleDraft.set("abandoned rename");
    directTopic.cancelEditTitle.send();
  });
  const assert_rename_editor_closed = assert(() =>
    directTopic.editingTitle === false &&
    directTopic.title === "Direct topic, renamed"
  );

  // --- saveProfileTitle: the browser rename, deterministic Profile ---
  //
  // Bound to standalone cells like the other Profile handlers, so the
  // mutation is testable without a wish. The property under test: a browser
  // rename lands through the same core as the verb, so the title can never
  // change while titleUpdatedBy keeps describing an earlier rename.
  const renameTitle = new Writable<string | Default<"">>("Before rename");
  const renameTitleDraft = new Writable("");
  const renameEditingTitle = new Writable(false);
  const renameUpdatedBy = new Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >({ kind: "person", name: "" });
  const renameUpdatedAt = new Writable<number | Default<0>>(0);
  const profileSaveTitle = saveProfileTitle({
    upgrade: profileUpgrade,
    title: renameTitle,
    titleDraft: renameTitleDraft,
    editingTitle: renameEditingTitle,
    titleUpdatedBy: renameUpdatedBy,
    titleUpdatedAt: renameUpdatedAt,
    profileName: "Ada",
    profileAvatar: "🦊",
  });

  const action_browser_rename = action(() => {
    renameTitleDraft.set("  After rename  ");
    renameEditingTitle.set(true);
    profileSaveTitle.send();
  });
  const assert_browser_rename_attributed = assert(() =>
    renameTitle.get() === "After rename" &&
    renameUpdatedBy.get()?.kind === "person" &&
    renameUpdatedBy.get()?.name === "Ada" &&
    (renameUpdatedAt.get() ?? 0) > 0 &&
    renameEditingTitle.get() === false
  );

  // A blank draft is a non-event: nothing lands and the editor stays open.
  const action_browser_rename_blank = action(() => {
    renameTitleDraft.set("   ");
    renameEditingTitle.set(true);
    profileSaveTitle.send();
  });
  const assert_blank_rename_declined = assert(() =>
    renameTitle.get() === "After rename" &&
    renameEditingTitle.get() === true
  );

  return {
    // UI demand (#4715) over the board: its card list renders through the real
    // reconciler while the suite runs. The cards bind navigation to index-row
    // pieces (wrapper-nested), which need real reconcile cycles to settle, so
    // the passive [UI] export is backed by explicit `{ render: board[UI] }`
    // steps below. Those cover the card path in both coverage lanes AND guard
    // the wrapper-bind mechanism: a silent non-render regression (blank board,
    // no error) would leave those lines uncovered and trip the coverage gate. A
    // board list element is the shared-safe TopicPiece projection and exposes no
    // [UI]; the topic detail page is driven through its own render step.
    [UI]: board[UI],
    [TESTS]: [
      { assertion: assert_initial },
      { action: action_link_unsigned_mixed_version_sibling },
      { assertion: assert_explicit_undefined_author_projection },
      { action: action_submit_profile_topic },
      { assertion: assert_profile_topic_submitted },
      { assertion: assert_profile_topic_named },
      { action: action_submit_profile_comment },
      { assertion: assert_profile_comment_submitted },
      { action: action_save_profile_body },
      { assertion: assert_profile_body_saved },
      { assertion: assert_profile_references_published },
      { action: action_submit_profile_link },
      { assertion: assert_profile_link_submitted },
      // Render the Profile-authored rows after their mutations land, then the
      // edit state whose Save control is disabled until #profile resolves.
      { render: profileTopic[UI] },
      { action: action_start_profile_body_edit },
      { render: profileTopic[UI] },
      { action: action_add_first_topic },
      { assertion: assert_first_topic },
      { action: action_comment_signed },
      { assertion: assert_comment_landed },
      { action: action_set_body },
      { assertion: assert_body_set },
      { action: action_link_valid_unlabeled },
      { assertion: assert_link_added },
      { action: action_retraction_setup },
      { action: action_edit_comment },
      { assertion: assert_comment_edited },
      { render: retractionSubject[UI] },
      { assertion: assert_rendered_thread_carries_bodies },
      { action: action_remove_comment },
      { assertion: assert_comment_retracted },
      { assertion: assert_retraction_moved_activity_forward },
      { render: retractionSubject[UI] },
      { assertion: assert_retracted_comment_leaves_the_render },
      { action: action_remove_link_by_url },
      { assertion: assert_link_retracted },
      { action: action_add_second_topic },
      { assertion: assert_second_topic },
      { render: board[UI] },
      { assertion: assert_index_baseline },
      { assertion: assert_index_bounded },
      { assertion: assert_mention_index_baseline },
      { assertion: assert_mention_index_bounded },
      { assertion: assert_cell_link_markup },
      { render: board[UI] },
      { action: action_comment_first_again },
      { action: action_add_third_topic },
      { assertion: assert_third_topic },
      { render: board[UI] },
      { assertion: assert_index_tracks_the_board },
      { assertion: assert_mention_index_tracks_the_board },
      { action: action_submit_blank_comment_draft },
      { assertion: assert_blank_draft_rejected },
      { action: action_start_edit },
      { assertion: assert_editing },
      { action: action_cancel_edit },
      { assertion: assert_edit_cancelled },
      { action: action_submit_blank_link_draft },
      // Materialize the direct and legacy Topics without putting UI into the
      // board's shared TopicPiece projection.
      { render: directTopic[UI] },
      { assertion: assert_pure_helpers },
      { assertion: assert_mention_index_rows_pure },
      { action: action_seed_row_universe },
      { assertion: assert_row_universe_accepted },
      { assertion: assert_cold_row_orders_by_created_at },
      { assertion: assert_warm_row_orders_by_last_activity },
      { assertion: assert_cold_new_topic_outranks_an_older_warm_one },
      { assertion: assert_self_mention_inert_through_a_twin },
      { assertion: assert_mentioned_by_counts_each_matching_entry },
      {
        assertion:
          assert_repeated_mentions_contribute_one_edge_per_source_entry,
      },
      { action: action_alias_identity_target },
      { assertion: assert_distinct_by_identity_keeps_each_first_occurrence },
      { assertion: assert_mention_lists_tolerate_a_mid_sync_source },
      { action: action_mention_subject_gets_a_link },
      { assertion: assert_plain_link_is_no_mention },
      { action: action_mention_one },
      { assertion: assert_mention_recorded },
      { action: action_mention_same_again },
      { assertion: assert_repeat_mention_is_one },
      { action: action_mention_second },
      { assertion: assert_two_distinct_mentions },
      { action: action_unmention_first },
      { assertion: assert_only_the_retracted_one_left },
      { action: action_ui_mentions_two },
      { action: action_drop_one_from_ui },
      { assertion: assert_ui_dropped_only_that_one },
      { assertion: assert_boardless_topic_has_no_backlinks },
      { action: action_rename_direct_topic },
      { assertion: assert_renamed_with_attribution },
      { render: directTopic[UI] },
      { assertion: assert_header_reads },
      { action: action_start_rename_editor },
      { assertion: assert_rename_editor_seeded },
      { render: directTopic[UI] },
      { assertion: assert_header_edits },
      { action: action_cancel_rename_editor },
      { assertion: assert_rename_editor_closed },
      { render: directTopic[UI] },
      { assertion: assert_header_reads },
      { action: action_browser_rename },
      { assertion: assert_browser_rename_attributed },
      { action: action_browser_rename_blank },
      { assertion: assert_blank_rename_declined },
    ],
  };
});
