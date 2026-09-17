/**
 * Pattern tests for the member namespace the Topics board owns: allocation in
 * the same transaction as the create, the names table that gives a topic its
 * name by identity, the backfill over topics filed before the board numbered
 * anything, and the bound on what any of those reads expands.
 *
 * Topics shows none of those numbers while `SHOW_TOPIC_NUMBERS` in
 * `topic.tsx` is off, and this file holds that as well. A topic publishes no
 * `shortName` then, so its header, the board's cards, the survey rows and the
 * mention universe's rows all carry none, while the namespace and the names
 * table carry every one. A case reading an absence for a topic the board has
 * named states that number in the table beside it, so the absence stands
 * against a number that exists; the two over a topic nothing has named have no
 * number to stand against and read the table as empty.
 *
 * Separate from topics.test.tsx for the reason render-shape.test.tsx is
 * separate from it: this file drives one surface end to end and keeps
 * compiling while a change to the board's other demands is in flight.
 *
 * A named topic's header and its published name are read off a topic this file
 * composes and lists in a board's input, which the board's `backfillNames`
 * then names. A verb that captured the
 * body-held topic could not name it: a verb receives a captured topic through
 * its own state schema, which does not materialize one (`TopicOutput`'s
 * `editingBody` says why). `backfillNames` reaches the topic through the
 * board's list instead.
 *
 * That same seam is how this file reads what a topic STORES, which is a
 * separate question from what it shows and the one the storage cases below
 * ask. A topic composed here takes its number through a cell this file holds,
 * so the cell is readable afterwards whatever the topic publishes. Nothing
 * published would serve: `SHOW_TOPIC_NUMBERS` gates the publication, so an
 * assertion over `shortName` reads absent for a topic holding a number and for
 * one holding none alike, and would pass with the storage removed.
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
 * load (`packages/runner/src/builtins/wish.ts`); a topic created late in the
 * run can still be syncing for that when the harness disposes the runtime. The
 * run therefore ends on a write-free assertion, and nothing here depends on the
 * wish.
 */

import {
  action,
  assert,
  Default,
  equals,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  backfillNames,
  nameOf,
  type NamesMap,
  namesTable,
  recordNames,
  type RecordNamesResult,
} from "../collection-naming/naming.ts";
import { findNodeByProp, hasText } from "../test/vnode-helpers.ts";
import Topics, { type TopicDemand } from "./main.tsx";
import Topic, { TOPIC_STATE_VERSION } from "./topic.tsx";

/**
 * The number badge under `node`, if one is rendered. A topic's number rides in
 * the one badge carrying `data-member-name`, so this says nothing about the
 * other badges a topic renders — a link's kind, for one.
 */
const numberBadge = (node: unknown): unknown =>
  findNodeByProp(node, "data-member-name", "");

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
  // `packages/cli/integration/topics-restore-drill.sh`.
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
  // titles, and no number, although the table names both.
  const assert_index_rows_carry_no_name = assert(() =>
    (board.index ?? []).length === 2 &&
    board.index?.[0]?.title === "First topic" &&
    board.index?.[0]?.shortName === undefined &&
    board.index?.[1]?.shortName === undefined &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2"
  );
  // The board's cards show the titles and no number, although the table names
  // both topics: the badge is the only `cf-badge` a card renders.
  const assert_cards_show_no_number = assert(() =>
    numberBadge(board[UI]) === undefined &&
    hasText(board[UI], "First topic") &&
    hasText(board[UI], "Second topic") &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2"
  );
  // The mention universe: one row per topic, each copying its topic's absent
  // name as the empty one, although the table names both. A `#42` completion
  // matches a row's name and a mention's pill shows it, so a row without one
  // is offered for no number and gives a pill none.
  const assert_universe_rows_carry_no_name = assert(() =>
    (board.mentionable ?? []).length === 2 &&
    board.mentionable?.[0]?.[NAME] === "First topic" &&
    board.mentionable?.[0]?.title === "First topic" &&
    board.mentionable?.[0]?.shortName === "" &&
    board.mentionable?.[1]?.shortName === "" &&
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

  // A numbered topic stores its number and shows none, which is the whole of
  // what hiding costs and the case both halves of this change meet in. The
  // topic is listed in the board's input and numbered by the board's step,
  // which asks it to store what the namespace holds for it; the cell it was
  // composed with is how this file reads that it did. The namespace and the
  // table naming the topic are what make the absences below absences of a
  // number the topic has.
  const heldNames = new Writable<NamesMap>({});
  const heldNumber = new Writable<string | undefined>(undefined);
  const held = Topic({ title: "Held topic", shortName: heldNumber });
  const heldBoard = Topics({ topics: [held], names: heldNames });
  const action_name_the_held_topic = action(() => {
    heldBoard.backfillNames.send({ agentName: "Sol" });
  });
  const assert_named_topic_stores_it_and_shows_none = assert(() =>
    Object.keys((heldBoard.names ?? {}) as NamesMap).join(",") === "1" &&
    heldBoard.namesTable?.[0]?.name === "1" &&
    equals(
      heldBoard.namesTable?.[0]?.member as object,
      heldBoard.topics?.[0] as object,
    ) &&
    heldNumber.get() === "1" &&
    held.shortName === undefined &&
    numberBadge(held[UI]) === undefined &&
    hasText(held[UI], "Held topic")
  );

  // The numbering step, on a board that held topics before it numbered
  // anything. The topics are listed in the board's input, which is how a board
  // from before the namespace holds its members and, here, how each one's
  // number cell stays readable: nothing wires a board table onto them, because
  // a topic has no input for one.
  const olderOne = new Writable<string | undefined>(undefined);
  const olderTwo = new Writable<string | undefined>(undefined);
  const olderThree = new Writable<string | undefined>(undefined);
  const olderTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const olderNames = new Writable<NamesMap>({});
  const older = Topics({ topics: olderTopics, names: olderNames });

  const action_file_two_unnamed = action(() => {
    olderTopics.push(
      Topic({ title: "Older one", createdAt: 1, shortName: olderOne }),
    );
    olderTopics.push(
      Topic({ title: "Older two", createdAt: 2, shortName: olderTwo }),
    );
  });
  // An unnamed member's row reads the default, so the board reads whole before
  // anything names it, and its universe row is one no `#42` query matches.
  // Here the table names nothing either, which is the state a backfill ends.
  const assert_unnamed_rows_carry_no_name = assert(() =>
    older.topicCount === 2 &&
    (older.index ?? []).length === 2 &&
    older.index?.[0]?.shortName === undefined &&
    older.index?.[1]?.shortName === undefined &&
    (older.namesTable ?? []).length === 0 &&
    older.mentionable?.[0]?.shortName === "" &&
    numberBadge(older[UI]) === undefined
  );
  // The library call the verb makes, so its report is observable here: the
  // VERB's own result is not, because `send()` hands a pattern test nothing.
  const runs = new Writable<RecordNamesResult[]>([]);
  const action_backfill = action(() => {
    runs.push(recordNames(olderTopics, olderNames));
  });
  // The backfill names both topics in the table, and neither the survey rows
  // nor the universe rows carry a number.
  const assert_backfilled_in_filing_order = assert(() =>
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2" &&
    nameOf(olderTopics.key(0), older.namesTable ?? []) === "1" &&
    nameOf(olderTopics.key(1), older.namesTable ?? []) === "2" &&
    older.index?.[0]?.shortName === undefined &&
    older.index?.[1]?.shortName === undefined &&
    older.mentionable?.[0]?.shortName === "" &&
    older.mentionable?.[1]?.shortName === "" &&
    equals(
      ((older.names ?? {}) as NamesMap)["1"] as object,
      older.topics?.[0] as object,
    )
  );
  // And each asked topic stored what it was asked for. This is the half no
  // published path carries while numbers are hidden, and the half the step
  // exists for.
  const assert_asked_topics_stored_their_numbers = assert(() =>
    olderOne.get() === "1" &&
    olderTwo.get() === "2"
  );
  // What the first run reports, and what it cannot. `assigned` settles the
  // namespace exactly. `named` is empty and `pending` holds both, and that is
  // the degradation `SHOW_TOPIC_NUMBERS` costs rather than a fact about these
  // topics: the step reads a topic's published `shortName` to tell a stored
  // number from none, and the switch gates it, so every topic reads as storing
  // nothing however much it holds. Turning the switch on is what restores it.
  const assert_first_run_reports_what_it_allocated = assert(() =>
    runs.get().length === 1 &&
    runs.get()[0]?.assigned?.join(",") === "1,2" &&
    runs.get()[0]?.named?.length === 0 &&
    runs.get()[0]?.pending?.join(",") === "1,2"
  );

  // A create after the backfill continues the sequence rather than restarting
  // it. The name a create allocates is as real as a backfilled one, and
  // `namesTable` is where both are read while no topic publishes one.
  const action_add_after_backfill = action(() => {
    older.addTopic.send({ title: "Newer one", agentName: "Sol" });
  });
  const action_file_a_late_unnamed = action(() => {
    olderTopics.push(
      Topic({ title: "Older three", createdAt: 3, shortName: olderThree }),
    );
  });
  const action_backfill_again = action(() => {
    older.backfillNames.send({ agentName: "Sol" });
  });
  const assert_backfill_skips_the_named = assert(() =>
    older.topicCount === 4 &&
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2,3,4" &&
    older.index?.[2]?.title === "Newer one" &&
    older.index?.[2]?.shortName === undefined &&
    older.index?.[3]?.title === "Older three" &&
    older.index?.[3]?.shortName === undefined &&
    nameOf(olderTopics.key(2), older.namesTable ?? []) === "3" &&
    nameOf(olderTopics.key(3), older.namesTable ?? []) === "4"
  );
  // A later run allocates nothing and stores nothing new. It asks again, which
  // is what the step can do and no more while numbers are hidden; what it must
  // not do is write, and the two clauses below are that: no key joins the map,
  // and no topic's stored number moves.
  const action_backfill_a_third_time = action(() => {
    runs.push(recordNames(olderTopics, olderNames));
  });
  const assert_later_run_allocates_nothing = assert(() =>
    runs.get().length === 2 &&
    runs.get()[1]?.assigned?.length === 0 &&
    runs.get()[1]?.pending?.join(",") === "1,2,3,4"
  );
  const assert_later_run_stores_nothing_new = assert(() =>
    olderOne.get() === "1" &&
    olderTwo.get() === "2" &&
    olderThree.get() === "4"
  );
  const assert_third_backfill_leaves_the_map = assert(() =>
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2,3,4" &&
    (older.namesTable ?? []).length === 4 &&
    equals(
      ((older.names ?? {}) as NamesMap)["3"] as object,
      older.topics?.[2] as object,
    )
  );

  //
  // What a topic stores
  //
  // Everything above reads what Topics shows. These read what a topic holds,
  // through the cell it was composed with, because while `SHOW_TOPIC_NUMBERS`
  // is off nothing published carries it.
  //

  // A topic composed with a number and NO board at all: no names table, no
  // pivot, no mention universe, and no sibling topic in existence. It holds
  // the number anyway, which is the whole of what storing it buys — there is
  // nothing else it could be reading — and it renders without failing.
  const loneNumber = new Writable<string | undefined>("7");
  const lone = Topic({ title: "Lone topic", shortName: loneNumber });
  const assert_lone_topic_holds_its_number = assert(() =>
    loneNumber.get() === "7" &&
    lone[NAME] === "Lone topic" &&
    hasText(lone[UI], "Lone topic")
  );
  // And `recordName` is what writes that cell, on a topic wired to nothing.
  const blankNumber = new Writable<string | undefined>(undefined);
  const blank = Topic({ title: "Blank topic", shortName: blankNumber });
  const action_record_on_a_lone_topic = action(() => {
    blank.recordName.send({ name: "5" });
  });
  const assert_record_wrote_the_store = assert(() => blankNumber.get() === "5");

  // The create passes its allocated number into the topic it creates, which
  // no published path shows and no cell of this file's is inside. What does
  // show it is the topic's own refusal: `recordName` rejects a number that
  // disagrees with one already stored, so a board-created topic refusing `9`
  // is a topic that stores something else. Drop the pass-through at the create
  // and nothing is stored, the call is accepted, and this assertion reads `9`
  // back out of the namespace's own topic.
  const madeNames = new Writable<NamesMap>({});
  const madeTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const made = Topics({ topics: madeTopics, names: madeNames });
  const action_make_one = action(() => {
    made.addTopic.send({ title: "Made topic", agentName: "Sol" });
  });
  const action_record_a_second_number = action(() => {
    madeTopics.key(0).resolveAsCell().key("recordName").send({ name: "9" });
  });
  const assert_create_stored_what_it_allocated = assert(() =>
    Object.keys((madeNames.get() ?? {}) as NamesMap).join(",") === "1" &&
    nameOf(madeTopics.key(0), made.namesTable ?? []) === "1"
  );

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
  const blocked = Topics({ topics: blockedTopics, names: blockedNames });
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
    blocked.namesTable?.[0]?.name === "1" &&
    blockedNumber.get() === undefined
  );
  const action_unblock = action(() => {
    blockedVersion.set(TOPIC_STATE_VERSION);
  });
  const assert_rerun_completes_the_write = assert(() =>
    blockedRuns.get().length === 2 &&
    blockedRuns.get()[1]?.assigned?.length === 0 &&
    blockedNumber.get() === "1"
  );

  // A topic the namespace holds only under a key the grammar does not admit —
  // what a client writing the map over the memory protocol can leave. The
  // table gives it no row, so it has no name by the lookup every reader has,
  // and the step numbers it like any other unnumbered topic rather than
  // skipping it. The foreign entry is left where it is.
  const foreignNumber = new Writable<string | undefined>(undefined);
  const foreignNames = new Writable<NamesMap>({});
  const foreignTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const foreignBoard = Topics({
    topics: foreignTopics,
    names: foreignNames,
  });
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
    (foreignBoard.namesTable ?? []).length === 0
  );
  const action_record_foreign = action(() => {
    recordNames(foreignTopics, foreignNames);
  });
  const assert_foreign_keyed_topic_is_numbered = assert(() =>
    Object.keys((foreignNames.get() ?? {}) as NamesMap).toSorted().join(",") ===
      "007,1" &&
    (foreignBoard.namesTable ?? []).length === 1 &&
    foreignBoard.namesTable?.[0]?.name === "1" &&
    foreignNumber.get() === "1"
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
  const mislabeled = Topics({
    topics: mislabeledTopics,
    names: mislabeledNames,
  });
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
    mislabeled.namesTable?.[0]?.name === "1" &&
    mislabeledNumber.get() === "9"
  );

  return {
    // Three refusals a topic's own verb makes, and each is a case above
    // working: the board-created topic declining a second number, the blocked
    // topic before its state version is repaired, and the mislabeled topic
    // keeping the number it holds. An exact count, so a guard that quietly
    // stopped refusing fails here rather than passing on a silent overwrite.
    expectRuntimeErrors: 3,
    [TESTS]: [
      { assertion: assert_initial },
      { assertion: assert_declaration },
      { action: action_add_first },
      { action: action_add_second },
      { assertion: assert_allocated_on_create },
      { assertion: assert_table_names_each_topic },
      { assertion: assert_index_rows_carry_no_name },
      { assertion: assert_cards_show_no_number },
      { assertion: assert_universe_rows_carry_no_name },
      { assertion: assert_reads_expand_no_topic },
      { assertion: assert_solo_topic_has_no_name },
      { assertion: assert_solo_topic_renders_no_badge },
      { action: action_name_the_held_topic },
      { assertion: assert_named_topic_stores_it_and_shows_none },
      { action: action_file_two_unnamed },
      { assertion: assert_unnamed_rows_carry_no_name },
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
      { assertion: assert_later_run_allocates_nothing },
      { assertion: assert_later_run_stores_nothing_new },
      { assertion: assert_lone_topic_holds_its_number },
      { action: action_record_on_a_lone_topic },
      { assertion: assert_record_wrote_the_store },
      { action: action_make_one },
      { action: action_record_a_second_number },
      { assertion: assert_create_stored_what_it_allocated },
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
      { action: action_file_a_mislabeled_topic },
      { action: action_record_mislabeled },
      { assertion: assert_mislabeled_keeps_its_own },
    ],
  };
});
