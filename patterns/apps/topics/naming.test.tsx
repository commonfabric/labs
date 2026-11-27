/**
 * Pattern tests for the member namespace the Topics board owns: allocation in
 * the same transaction as the create, the names table that gives a topic its
 * name by identity, the backfill over topics filed before the board numbered
 * anything, and the bound on what any of those reads expands.
 *
 * A topic publishes the number it stores, and this file holds that as well:
 * its header, the board's cards, the survey rows and the mention universe's
 * rows all carry the number the namespace and the names table hold for it. A
 * topic that stores none publishes none, and a case reading that absence
 * states what the table holds beside it, so the absence stands against a
 * namespace that has named the topic or has not.
 *
 * That publication is also what this file reads to ask what a topic STORES.
 * The two are one property — a topic publishes its `shortName` input — so the
 * published path is the read, including on a topic composed with no board and
 * on one composed with no number cell at all.
 *
 * Separate from topics.test.tsx for the reason render-shape.test.tsx is
 * separate from it: this file drives one surface end to end and keeps
 * compiling while a change to the board's other demands is in flight.
 *
 * A named topic's header and its published name are read off a topic this file
 * composes and lists, which the numbering step then names: `recordNames`, the
 * call the board's `backfillNames` makes over the board's collection. A board
 * cannot be handed such a topic, because its collection takes a topic only
 * from the board's own ways of filing one, each of which creates the topic
 * inside the verb. A verb that captured the body-held topic could not name it
 * either: a verb receives a captured topic through its own state schema,
 * which does not materialize one (`TopicOutput`'s `editingBody` says why).
 *
 * The mixed-vintage case — a topic deployed before `shortName` existed, read
 * beside one that has it — is NOT here, and deliberately. A fixture of that
 * shape was written here and measured inert: spelling `shortName` as a
 * required path on both the demand and the publication, which is the defect it
 * would guard, left every one of its clauses green. The case that does
 * discriminate is `assert_explicit_undefined_author_projection` in
 * topics.test.tsx, which stands a legacy sibling in a live universe and reds
 * under exactly that mutation.
 *
 * Some runs log `sync-load-failure` lines at teardown, and they are acceptable.
 * Each Topic's `#profile` wish finds no profile in the test space and opens its
 * profile-create surface, a sidecar pattern the test runtime has no server to
 * load (`runtime/runner/src/builtins/wish.ts`); a topic created late in the
 * run can still be syncing for that when the harness disposes the runtime. The
 * run therefore ends on a write-free assertion, and nothing here depends on the
 * wish.
 */

import {
  action,
  assert,
  Default,
  equals,
  indexedCollections,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  nameOf,
  type NamesMap,
  namesTable,
  recordNames,
  type RecordNamesResult,
} from "../../product/collection-naming/naming.ts";
import {
  findNodeByProp,
  hasExactText,
  hasText,
  innermostNode,
} from "../../tools/test-support/vnode-helpers.ts";
import Topics, { submitProfileTopic, type TopicDemand } from "./main.tsx";
import Topic, { TOPIC_STATE_VERSION, type TopicMirrored } from "./topic.tsx";

/**
 * The number badge under `node`, if one is rendered. A topic's number rides in
 * the one badge carrying `data-member-name`, so this says nothing about the
 * other badges a topic renders — a link's kind, for one.
 */
const numberBadge = (node: unknown): unknown =>
  findNodeByProp(node, "data-member-name", "");

/**
 * The number badge in the board card whose text carries `title`, so a board
 * rendering several cards is asked about one of them rather than about
 * whichever card the walk reaches first. `undefined` where that card renders
 * no badge, which `hasExactText` reads as no text at all.
 */
const cardBadge = (board: unknown, title: string): unknown =>
  numberBadge(
    innermostNode(
      board,
      (node) => hasText(node, title) && numberBadge(node) !== undefined,
    ),
  );

export default pattern(() => {
  const names = new Writable<NamesMap>({});
  const board = Topics({ names });

  const assert_initial = assert(() =>
    board.topicCount === 0 &&
    (board.namesTable ?? []).length === 0 &&
    Object.keys((board.names ?? {}) as NamesMap).length === 0
  );
  // The policy the board publishes beside the names, so a consumer deciding
  // whether it may hold a name rather than an identity reads the promise
  // instead of assuming one.
  const assert_declaration = assert(() =>
    board.naming?.policy?.allocator === "sequence" &&
    board.naming?.policy?.unique === "history" &&
    board.naming?.policy?.permanent === true &&
    board.naming?.policy?.reuse === false &&
    board.naming?.compact === true
  );

  // Allocation on create: the topic is reachable at `names["1"]` the moment it
  // exists, and the entry names the topic itself rather than a copy of it.
  // `addTopic`'s returned `name` is not observable here: a verb's result
  // reaches its caller through the handling's receipt, and `send()` gives a
  // pattern test nothing. The namespace keys below pin what was allocated;
  // that the verb hands it back is asserted where a result IS observable, in
  // `runtime/cli/integration/topics-restore-drill.sh`.
  const action_add_first = action(() => {
    board.addTopic.send({
      title: "First topic",
      body: "The living document.",
      agentName: "Sol",
    });
  });
  const action_add_second = action(() => {
    board.addTopic.send({ title: "Second topic", agentName: "Fable" });
  });
  const assert_allocated_on_create = assert(() =>
    board.topicCount === 2 &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2" &&
    equals(
      ((board.names ?? {}) as NamesMap)["1"] as object,
      board.topics?.[0] as object,
    ) &&
    equals(
      ((board.names ?? {}) as NamesMap)["2"] as object,
      board.topics?.[1] as object,
    )
  );
  // The table the board derives once and hands every topic it creates: one row
  // per named member, each row addressed by the member it describes, so a
  // topic looking itself up by identity finds one row.
  const assert_table_names_each_topic = assert(() =>
    (board.namesTable ?? []).length === 2 &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2" &&
    equals(
      board.namesTable?.[0]?.member as object,
      board.topics?.[0] as object,
    ) &&
    equals(
      board.namesTable?.[1]?.member as object,
      board.topics?.[1] as object,
    )
  );
  // A survey row IS its topic, so it carries what the topic publishes: the
  // titles, and the number the table names each topic by.
  const assert_index_rows_carry_the_number = assert(() =>
    (board.index ?? []).length === 2 &&
    board.index?.[0]?.title === "First topic" &&
    board.index?.[0]?.shortName === "1" &&
    board.index?.[1]?.shortName === "2" &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2"
  );
  // The board's cards show the titles and each topic's own number, in the one
  // badge a card marks with `data-member-name`.
  const assert_cards_show_the_number = assert(() =>
    hasExactText(cardBadge(board[UI], "First topic"), "1") &&
    hasExactText(cardBadge(board[UI], "Second topic"), "2") &&
    hasText(board[UI], "First topic") &&
    hasText(board[UI], "Second topic") &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2"
  );
  // The mention universe: one row per topic, each copying the number its topic
  // publishes. A `#42` completion matches a row's name and a mention's pill
  // shows it, so the row carrying `1` is what `#1` offers and what a pill for
  // that topic reads.
  const assert_universe_rows_carry_the_number = assert(() =>
    (board.mentionable ?? []).length === 2 &&
    board.mentionable?.[0]?.[NAME] === "First topic" &&
    board.mentionable?.[0]?.title === "First topic" &&
    board.mentionable?.[0]?.shortName === "1" &&
    board.mentionable?.[1]?.shortName === "2" &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2" &&
    equals(
      board.mentionable?.[0]?.piece as object,
      board.topics?.[0] as object,
    )
  );
  // The bound: topics carry bodies and threads, and neither the namespace nor
  // the table carries any of it. The universe carries the copied strings and
  // nothing behind the reference beside them.
  const assert_reads_expand_no_topic = assert(() => {
    const namespace = JSON.stringify(board.names);
    const table = JSON.stringify(board.namesTable);
    const universe = JSON.stringify(board.mentionable);
    return !namespace.includes('"title"') &&
      !namespace.includes('"body"') &&
      table.includes('"name"') &&
      !table.includes('"title"') &&
      !table.includes('"comments"') &&
      universe.includes('"shortName"') &&
      !universe.includes("The living document.") &&
      !universe.includes('"comments"') &&
      !universe.includes("vnode");
  });

  // A topic wired to no board has no name, renders no badge, and does not
  // fail: the number is the collection's, and a topic without one is whole.
  // The lookup produces nothing, and the demand declares the property
  // optional, so a reader sees no `shortName` at all rather than a blank one.
  const solo = Topic({ title: "Solo topic" });
  const assert_solo_topic_has_no_name = assert(() =>
    solo.shortName === undefined &&
    solo[NAME] === "Solo topic"
  );
  const assert_solo_topic_renders_no_badge = assert(() =>
    numberBadge(solo[UI]) === undefined &&
    hasText(solo[UI], "Solo topic")
  );

  // A numbered topic publishes the number it stores, in its own header as well
  // as through a board. The topic is listed here and numbered by the step,
  // which asks it to store what the namespace holds for it; the publication
  // is how this file reads that it did. The namespace and the table naming
  // the topic are what that publication is checked against.
  const heldNames = new Writable<NamesMap>({});
  const heldTable = namesTable({ names: heldNames });
  const heldTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const heldNumber = new Writable<string | undefined>(undefined);
  const held = Topic({ title: "Held topic", shortName: heldNumber });
  const action_list_the_held_topic = action(() => {
    heldTopics.push(held);
  });
  const action_name_the_held_topic = action(() => {
    recordNames(heldTopics, heldNames);
  });
  const assert_named_topic_publishes_its_number = assert(() =>
    Object.keys((heldNames.get() ?? {}) as NamesMap).join(",") === "1" &&
    heldTable?.[0]?.name === "1" &&
    nameOf(heldTopics.key(0), heldTable ?? []) === "1" &&
    held.shortName === "1" &&
    hasExactText(numberBadge(held[UI]), "1") &&
    hasText(held[UI], "Held topic")
  );

  // The numbering step, over topics filed before their board numbered
  // anything. The topics are listed here, which is how a board from before
  // the namespace held its members and, here, how each one's number cell
  // stays readable: nothing wires a board table onto them, because a topic
  // has no input for one. The step is the library call the board's
  // `backfillNames` makes, so its report is observable: the VERB's own result
  // is not, because `send()` hands a pattern test nothing. The board here
  // shares the namespace, so that its creates allocate after the names the
  // step wrote; it holds none of the listed topics.
  const olderOne = new Writable<string | undefined>(undefined);
  const olderTwo = new Writable<string | undefined>(undefined);
  const olderThree = new Writable<string | undefined>(undefined);
  const olderTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const olderNames = new Writable<NamesMap>({});
  const olderTable = namesTable({ names: olderNames });
  const older = Topics({ names: olderNames });

  const action_file_two_unnamed = action(() => {
    olderTopics.push(
      Topic({ title: "Older one", createdAt: 1, shortName: olderOne }),
    );
    olderTopics.push(
      Topic({ title: "Older two", createdAt: 2, shortName: olderTwo }),
    );
  });
  // Before the step runs, neither topic stores a number and the table names
  // neither.
  const assert_unnamed_topics_carry_no_name = assert(() =>
    (olderTopics.get() ?? [])[0]?.shortName === undefined &&
    (olderTopics.get() ?? [])[1]?.shortName === undefined &&
    (olderTable ?? []).length === 0
  );
  const runs = new Writable<RecordNamesResult[]>([]);
  const action_backfill = action(() => {
    runs.push(recordNames(olderTopics, olderNames));
  });
  // The step names both topics in the table, in filing order.
  const assert_backfilled_in_filing_order = assert(() =>
    Object.keys((olderNames.get() ?? {}) as NamesMap).join(",") === "1,2" &&
    nameOf(olderTopics.key(0), olderTable ?? []) === "1" &&
    nameOf(olderTopics.key(1), olderTable ?? []) === "2"
  );
  // And each asked topic stored what it was asked for, read through
  // `TopicDemand`, the board's demand over its topics — which is the
  // projection `recordNames` itself reads a member's name from, and so the
  // read that decides which list the run below reports each topic under.
  const assert_asked_topics_stored_their_numbers = assert(() =>
    (olderTopics.get() ?? [])[0]?.shortName === "1" &&
    (olderTopics.get() ?? [])[1]?.shortName === "2"
  );
  // What the first run reports, and what it cannot. `assigned` settles the
  // namespace exactly. Neither topic stored a number when the run read it, so
  // both were asked and both land under `pending`, which confirms nothing: a
  // send's effect is invisible to the transaction that makes it. `named` is
  // empty for that reason and no other, and the later run below is where these
  // two come back under it.
  const assert_first_run_reports_what_it_allocated = assert(() =>
    runs.get().length === 1 &&
    runs.get()[0]?.assigned?.join(",") === "1,2" &&
    runs.get()[0]?.named?.length === 0 &&
    runs.get()[0]?.pending?.join(",") === "1,2"
  );

  // A create after the backfill continues the sequence rather than restarting
  // it. The name a create allocates is as real as a backfilled one, and a
  // topic publishes it whichever way it got there.
  const action_add_after_backfill = action(() => {
    older.addTopic.send({ title: "Newer one", agentName: "Sol" });
  });
  const action_file_a_late_unnamed = action(() => {
    olderTopics.push(
      Topic({ title: "Older three", createdAt: 3, shortName: olderThree }),
    );
  });
  const action_backfill_again = action(() => {
    recordNames(olderTopics, olderNames);
  });
  const assert_backfill_skips_the_named = assert(() =>
    older.topicCount === 1 &&
    Object.keys((olderNames.get() ?? {}) as NamesMap).join(",") === "1,2,3,4" &&
    older.index?.[0]?.title === "Newer one" &&
    older.index?.[0]?.shortName === "3" &&
    (olderTopics.get() ?? [])[2]?.shortName === "4" &&
    // A create adds to the board and not to the list, so the list's third
    // entry is the topic filed after the create.
    nameOf(olderNames.key("3"), olderTable ?? []) === "3" &&
    nameOf(olderTopics.key(2), olderTable ?? []) === "4"
  );
  // A later run over a list every topic of which publishes its number: it
  // allocates nothing, asks nothing, and reports all three under `named` with
  // `pending` empty. The topic the board created holds `3` and is not on the
  // list, so the run does not report it. An empty `pending` is the report
  // that says the list is finished, and it is the one the step can only make
  // by reading what a topic publishes.
  const action_backfill_a_third_time = action(() => {
    runs.push(recordNames(olderTopics, olderNames));
  });
  const assert_later_run_reports_them_named = assert(() =>
    runs.get().length === 2 &&
    runs.get()[1]?.assigned?.length === 0 &&
    runs.get()[1]?.named?.join(",") === "1,2,4" &&
    runs.get()[1]?.pending?.length === 0
  );
  // And it stored nothing new: every topic publishes the number it held before
  // the run, the listed ones in the filing order the list holds them in.
  const assert_later_run_stores_nothing_new = assert(() =>
    (olderTopics.get() ?? [])[0]?.shortName === "1" &&
    (olderTopics.get() ?? [])[1]?.shortName === "2" &&
    (olderTopics.get() ?? [])[2]?.shortName === "4" &&
    older.topics?.[0]?.shortName === "3"
  );
  const assert_third_backfill_leaves_the_map = assert(() =>
    Object.keys((olderNames.get() ?? {}) as NamesMap).join(",") === "1,2,3,4" &&
    (olderTable ?? []).length === 4 &&
    equals(
      ((olderNames.get() ?? {}) as NamesMap)["3"] as object,
      older.topics?.[0] as object,
    )
  );

  // The board's own step, over its collection. Every way of filing a topic
  // numbers it, so what the step finds to do is a namespace that lacks a topic
  // the collection holds; here the namespace is emptied under two filed
  // topics. The step names them again in filing order, each by the number it
  // already stores, so it asks neither for anything: a topic asked for a
  // number other than its own refuses it, and that refusal would be a runtime
  // error this file does not expect.
  const repairNames = new Writable<NamesMap>({});
  const repair = Topics({ names: repairNames });
  const action_file_two_on_the_repair_board = action(() => {
    repair.addTopic.send({ title: "Repair one", agentName: "Sol" });
    repair.addTopic.send({ title: "Repair two", agentName: "Sol" });
  });
  const action_empty_the_repair_namespace = action(() => {
    repairNames.set({});
  });
  const assert_repair_namespace_is_empty = assert(() =>
    repair.topicCount === 2 &&
    Object.keys(repairNames.get() ?? {}).length === 0 &&
    (repair.namesTable ?? []).length === 0
  );
  const action_repair_the_namespace = action(() => {
    repair.backfillNames.send({ agentName: "Sol" });
  });
  const assert_repair_names_the_collection_in_filing_order = assert(() =>
    Object.keys(repairNames.get() ?? {}).join(",") === "1,2" &&
    equals(
      (repairNames.get() ?? {})["1"] as object,
      repair.topics?.[0] as object,
    ) &&
    equals(
      (repairNames.get() ?? {})["2"] as object,
      repair.topics?.[1] as object,
    ) &&
    repair.namesTable?.[1]?.name === "2" &&
    repair.index?.[0]?.title === "Repair one" &&
    repair.index?.[0]?.shortName === "1" &&
    repair.index?.[1]?.shortName === "2"
  );

  //
  // What a topic stores
  //
  // Everything above reads a topic's number through a board or a names table.
  // These reach a topic that has none: the store is its own, and it publishes
  // what it holds whether or not anything is listing it.
  //

  // A topic composed with a number and NO board at all: no names table, no
  // pivot, no mention universe, and no sibling topic in existence. It
  // publishes the number it holds anyway, which is the whole of what storing
  // it buys — there is nothing else it could be reading — and renders it.
  const loneNumber = new Writable<string | undefined>("7");
  const lone = Topic({ title: "Lone topic", shortName: loneNumber });
  const assert_lone_topic_publishes_its_number = assert(() =>
    lone.shortName === "7" &&
    hasExactText(numberBadge(lone[UI]), "7") &&
    lone[NAME] === "Lone topic" &&
    hasText(lone[UI], "Lone topic")
  );
  // And `recordName` is what writes the store, on a topic wired to nothing.
  // The one case reading the composed cell as well as the publication, which
  // is what pins the two together: a topic publishes the number its durable
  // input holds, and a publication drawn from anywhere else would satisfy
  // every other assertion in this file.
  const blankNumber = new Writable<string | undefined>(undefined);
  const blank = Topic({ title: "Blank topic", shortName: blankNumber });
  const action_record_on_a_lone_topic = action(() => {
    blank.recordName.send({ name: "5" });
  });
  const assert_record_wrote_the_store = assert(() =>
    blankNumber.get() === "5" &&
    blank.shortName === "5"
  );

  // The create passes its allocated number into the topic it creates, and the
  // created topic publishes it — which is the read below, since no cell of
  // this file's is that topic's input. The topic's REFUSAL of a second number
  // stands beside it: `recordName` rejects a number disagreeing with one
  // already stored, so a board-created topic refusing `9` is one that stores
  // something else. That refusal is counted, not asserted — it is one of this
  // file's five expected runtime errors, and dropping the pass-through at the
  // create makes the call succeed and the count fall to four.
  const madeNames = new Writable<NamesMap>({});
  const made = Topics({ names: madeNames });
  const action_make_one = action(() => {
    made.addTopic.send({ title: "Made topic", agentName: "Sol" });
  });
  const action_record_a_second_number = action(() => {
    madeNames.key("1").resolveAsCell().key("recordName").send({ name: "9" });
  });
  const assert_create_allocated_into_the_namespace = assert(() =>
    Object.keys((madeNames.get() ?? {}) as NamesMap).join(",") === "1" &&
    nameOf(madeNames.key("1"), made.namesTable ?? []) === "1" &&
    made.index?.[0]?.shortName === "1"
  );

  // The browser composer passes its allocated number into the topic too, and
  // it is a SECOND create path: `submitProfileTopic` and `addTopic` hand
  // `createNamed` separate callbacks, so a pass-through dropped from one is
  // not dropped from the other. Read off what the composed topic publishes,
  // because the composer builds its topic inside the handler and no cell here
  // is that topic's input; its refusal of a second number stands beside that
  // read the way the headless create's does.
  const composerNames = new Writable<NamesMap>({});
  const composerMentionable = new Writable<TopicDemand[] | Default<[]>>([]);
  const composerBoard = indexedCollections<{ topics: TopicMirrored }>({
    topics: {
      columns: { shortName: "text" },
      relations: ["mentioned", "mentions"],
    },
  });
  const composerFiled = composerBoard.query<{ shortName: string }>(
    "SELECT shortName FROM topics",
  );
  const composerDraft = new Writable("Composed topic");
  const composerSubmit = submitProfileTopic({
    board: composerBoard,
    mentionable: composerMentionable,
    names: composerNames,
    newTitle: composerDraft,
    profileName: "Ada",
  });
  const action_compose_a_topic = action(() => {
    composerSubmit.send();
  });
  const assert_composer_allocated_into_the_namespace = assert(() =>
    Object.keys(composerNames.get() ?? {}).join(",") === "1" &&
    (composerFiled.result ?? []).length === 1 &&
    composerFiled.result?.[0]?.shortName === "1"
  );
  const action_offer_the_composed_topic_another = action(() => {
    composerNames.key("1").resolveAsCell().key("recordName").send({
      name: "9",
    });
  });

  // A write that could not land on one run and lands on the next, which is the
  // recovery a re-run exists for. The obstruction is real and removable: this
  // topic opens at a state version no source supports, so `recordName` refuses
  // before its write like every other verb (`upgradeTopicState`). Repairing the
  // version is the operator's step, and the next run completes what the first
  // could not.
  const blockedNumber = new Writable<string | undefined>(undefined);
  const blockedVersion = new Writable<number | Default<0>>(99);
  const blockedTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const blockedNames = new Writable<NamesMap>({});
  const blockedTable = namesTable({ names: blockedNames });
  const blockedRuns = new Writable<RecordNamesResult[]>([]);
  const action_file_a_blocked_topic = action(() => {
    blockedTopics.push(
      Topic({
        title: "Blocked",
        createdAt: 1,
        shortName: blockedNumber,
        topicStateVersion: blockedVersion,
      }),
    );
  });
  const action_record_blocked = action(() => {
    blockedRuns.push(recordNames(blockedTopics, blockedNames));
  });
  const assert_blocked_write_did_not_land = assert(() =>
    blockedRuns.get().length === 1 &&
    blockedRuns.get()[0]?.assigned?.join(",") === "1" &&
    blockedTable?.[0]?.name === "1" &&
    (blockedTopics.get() ?? [])[0]?.shortName === undefined
  );
  const action_unblock = action(() => {
    blockedVersion.set(TOPIC_STATE_VERSION);
  });
  const assert_rerun_completes_the_write = assert(() =>
    blockedRuns.get().length === 2 &&
    blockedRuns.get()[1]?.assigned?.length === 0 &&
    (blockedTopics.get() ?? [])[0]?.shortName === "1"
  );

  // A topic the namespace holds only under a key the grammar does not admit —
  // what a client writing the map over the memory protocol can leave. The
  // table gives it no row, so it has no name by the lookup every reader has,
  // and the step numbers it like any other unnumbered topic rather than
  // skipping it. The foreign entry is left where it is.
  const foreignNumber = new Writable<string | undefined>(undefined);
  const foreignNames = new Writable<NamesMap>({});
  const foreignTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const foreignTable = namesTable({ names: foreignNames });
  const action_hold_under_a_foreign_key = action(() => {
    const topic = Topic({
      title: "Foreign-keyed",
      createdAt: 1,
      shortName: foreignNumber,
    });
    foreignTopics.push(topic);
    foreignNames.key("007").set(topic);
  });
  const assert_foreign_key_is_no_name = assert(() =>
    Object.keys(foreignNames.get() ?? {}).join(",") === "007" &&
    (foreignTable ?? []).length === 0
  );
  const action_record_foreign = action(() => {
    recordNames(foreignTopics, foreignNames);
  });
  const assert_foreign_keyed_topic_is_numbered = assert(() =>
    Object.keys((foreignNames.get() ?? {}) as NamesMap).toSorted().join(",") ===
      "007,1" &&
    (foreignTable ?? []).length === 1 &&
    foreignTable?.[0]?.name === "1" &&
    (foreignTopics.get() ?? [])[0]?.shortName === "1"
  );

  // A topic filed before this change existed at all: composed with no
  // `shortName` key, so its durable argument has no such path, which is what
  // every topic on the deployed board holds. The step numbers it and asks it
  // to store what it allocated.
  //
  // Nothing here supplies a cell for its number, and that is the case rather
  // than an oversight — a pre-input topic is exactly one nothing was handed a
  // cell for. It publishes what the step asked it to store all the same, which
  // is what the assertion below reads. Its refusal of a SECOND number stands
  // beside that: `recordName` refuses a number disagreeing with one already
  // stored, and a topic that stored nothing would accept `9`. That refusal is
  // one of this file's expected runtime errors, and dropping the step's send
  // makes the call succeed and the count fall.
  const preInputNames = new Writable<NamesMap>({});
  const preInputTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const preInputTable = namesTable({ names: preInputNames });
  const action_file_a_pre_input_topic = action(() => {
    preInputTopics.push(Topic({ title: "Pre-input", createdAt: 1 }));
  });
  const action_number_the_pre_input_topic = action(() => {
    recordNames(preInputTopics, preInputNames);
  });
  const assert_pre_input_topic_is_numbered = assert(() =>
    Object.keys(preInputNames.get() ?? {}).join(",") === "1" &&
    (preInputTable ?? []).length === 1 &&
    nameOf(preInputTopics.key(0), preInputTable ?? []) === "1" &&
    (preInputTopics.get() ?? [])[0]?.shortName === "1"
  );
  const action_offer_the_pre_input_topic_another = action(() => {
    preInputTopics.key(0).resolveAsCell().key("recordName").send({ name: "9" });
  });

  // Two silences, and they belong to different pieces of code. The STEP's is
  // that `recordNames` sends nothing to a member already publishing the name
  // it would ask for. The VERB's is that `recordName` returns before it writes
  // when the number asked for is the number stored. The step's silence is what
  // stops the verb being reached at all, so a case that only re-runs the step
  // cannot see the verb's guard; each is driven here on its own.
  //
  // Both are seen rather than assumed. A re-write of the same string leaves
  // every value it could be compared against unchanged, so comparing values
  // cannot detect one. Parking the topic at a state version no source supports
  // is what makes a write observable: `upgradeTopicState` refuses such a
  // version, and `recordName` reaches it only by going on to write. So no
  // error means no write. Drop the verb's early return and the direct call
  // below rejects, whichever guard it reaches first; drop the step's skip and
  // `assert_later_run_reports_them_named` above reds instead.
  const settledNumber = new Writable<string | undefined>(undefined);
  const settledVersion = new Writable<number | Default<0>>(
    TOPIC_STATE_VERSION,
  );
  //
  // No board here: this case drives `recordNames` over the list and the
  // namespace directly, as the cases above do. The board's own step is the
  // `repair` board above.
  const settledNames = new Writable<NamesMap>({});
  const settledTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const action_file_a_settled_topic = action(() => {
    settledTopics.push(
      Topic({
        title: "Settled",
        createdAt: 1,
        shortName: settledNumber,
        topicStateVersion: settledVersion,
      }),
    );
  });
  const action_number_the_settled_topic = action(() => {
    recordNames(settledTopics, settledNames);
  });
  const assert_settled_topic_stored_its_number = assert(() =>
    Object.keys(settledNames.get() ?? {}).join(",") === "1" &&
    (settledTopics.get() ?? [])[0]?.shortName === "1"
  );
  const action_park_the_settled_version = action(() => {
    settledVersion.set(99);
  });
  // The verb asked directly for the number the topic already stores, which is
  // the call the step no longer makes now that it can see that number. Nothing
  // else reaches `recordName`'s same-number return: every other `recordName`
  // in this file names a number its topic does not store.
  const action_offer_the_settled_topic_its_own_number = action(() => {
    settledTopics.key(0).resolveAsCell().key("recordName").send({ name: "1" });
  });
  const assert_second_run_wrote_nothing = assert(() =>
    Object.keys(settledNames.get() ?? {}).join(",") === "1" &&
    (settledTopics.get() ?? [])[0]?.shortName === "1" &&
    settledVersion.get() === 99
  );

  // The number a topic holds is the topic's, not the board's reading of it.
  // This one stores `9` and the namespace has never heard of it, so the step
  // allocates `1`, asks for `1`, and the topic refuses: a number is permanent,
  // and the one it holds is not the one being asked for. A topic that read a
  // board table for its number would hold `1` here. Each run's refusal is one
  // of the runtime errors this file expects.
  const mislabeledNumber = new Writable<string | undefined>("9");
  const mislabeledTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const mislabeledNames = new Writable<NamesMap>({});
  const mislabeledTable = namesTable({ names: mislabeledNames });
  const action_file_a_mislabeled_topic = action(() => {
    mislabeledTopics.push(
      Topic({ title: "Mislabeled", createdAt: 1, shortName: mislabeledNumber }),
    );
  });
  const action_record_mislabeled = action(() => {
    recordNames(mislabeledTopics, mislabeledNames);
  });
  const assert_mislabeled_keeps_its_own = assert(() =>
    Object.keys(mislabeledNames.get() ?? {}).join(",") === "1" &&
    mislabeledTable?.[0]?.name === "1" &&
    (mislabeledTopics.get() ?? [])[0]?.shortName === "9"
  );

  return {
    // Five refusals a topic's own verb makes, and each is a case above
    // working: the board-created topic, the composed topic and the pre-input
    // topic each declining a second number, the blocked topic before its state
    // version is repaired, and the mislabeled topic keeping the number it
    // holds. An exact count, so
    // a guard that quietly stopped refusing fails here rather than passing on
    // a silent overwrite — and so does a second run that writes, which the
    // settled topic's parked version would refuse.
    expectRuntimeErrors: 5,
    [TESTS]: [
      { assertion: assert_initial },
      { assertion: assert_declaration },
      { action: action_add_first },
      { action: action_add_second },
      { assertion: assert_allocated_on_create },
      { assertion: assert_table_names_each_topic },
      { assertion: assert_index_rows_carry_the_number },
      { assertion: assert_cards_show_the_number },
      { assertion: assert_universe_rows_carry_the_number },
      { assertion: assert_reads_expand_no_topic },
      { assertion: assert_solo_topic_has_no_name },
      { assertion: assert_solo_topic_renders_no_badge },
      { action: action_list_the_held_topic },
      { action: action_name_the_held_topic },
      { assertion: assert_named_topic_publishes_its_number },
      { action: action_file_two_unnamed },
      { assertion: assert_unnamed_topics_carry_no_name },
      { action: action_backfill },
      { assertion: assert_backfilled_in_filing_order },
      { assertion: assert_asked_topics_stored_their_numbers },
      { assertion: assert_first_run_reports_what_it_allocated },
      { action: action_add_after_backfill },
      { action: action_file_a_late_unnamed },
      { action: action_backfill_again },
      { assertion: assert_backfill_skips_the_named },
      { action: action_backfill_a_third_time },
      { assertion: assert_third_backfill_leaves_the_map },
      { assertion: assert_later_run_reports_them_named },
      { assertion: assert_later_run_stores_nothing_new },
      { action: action_file_two_on_the_repair_board },
      { action: action_empty_the_repair_namespace },
      { assertion: assert_repair_namespace_is_empty },
      { action: action_repair_the_namespace },
      { assertion: assert_repair_names_the_collection_in_filing_order },
      { assertion: assert_lone_topic_publishes_its_number },
      { action: action_record_on_a_lone_topic },
      { assertion: assert_record_wrote_the_store },
      { action: action_make_one },
      { action: action_record_a_second_number },
      { assertion: assert_create_allocated_into_the_namespace },
      { action: action_compose_a_topic },
      { assertion: assert_composer_allocated_into_the_namespace },
      { action: action_offer_the_composed_topic_another },
      { action: action_file_a_blocked_topic },
      { action: action_record_blocked },
      { assertion: assert_blocked_write_did_not_land },
      { action: action_unblock },
      { action: action_record_blocked },
      { assertion: assert_rerun_completes_the_write },
      { action: action_hold_under_a_foreign_key },
      { assertion: assert_foreign_key_is_no_name },
      { action: action_record_foreign },
      { assertion: assert_foreign_keyed_topic_is_numbered },
      { action: action_file_a_pre_input_topic },
      { action: action_number_the_pre_input_topic },
      { assertion: assert_pre_input_topic_is_numbered },
      { action: action_offer_the_pre_input_topic_another },
      { action: action_file_a_settled_topic },
      { action: action_number_the_settled_topic },
      { assertion: assert_settled_topic_stored_its_number },
      { action: action_park_the_settled_version },
      { action: action_number_the_settled_topic },
      { action: action_offer_the_settled_topic_its_own_number },
      { assertion: assert_second_run_wrote_nothing },
      { action: action_file_a_mislabeled_topic },
      { action: action_record_mislabeled },
      { assertion: assert_mislabeled_keeps_its_own },
    ],
  };
});
