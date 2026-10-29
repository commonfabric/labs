/**
 * A test-only board whose members are the real Topic pattern, wired through the
 * naming library the way the exemplar board is. It holds the library to a
 * member pattern it does not own — allocation on create, the backfill over a
 * list filed before the board numbered anything, the names table giving a topic
 * its name by identity, and a topic's own lookup over that table — through a
 * board that is not the Topics board, so the library keeps its own coverage
 * over topics however the Topics board changes.
 *
 * The lookup here is driven from OUTSIDE the member, over the list position's
 * cell. What a topic does with its own `shortName` belongs to the Topics board
 * and is covered in `../../apps/topics/naming.test.tsx`.
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
  Writable,
} from "commonfabric";
import type { TopicDemand, TopicIndexRow } from "../../apps/topics/main.tsx";
import Topic, {
  rejectMutation,
  topicAuthorFromAgent,
} from "../../apps/topics/topic.tsx";
import {
  assignName,
  backfillNames,
  nameOf,
  type NamesMap,
  namesTable,
  type NamesTableRow,
  type NamingDeclaration,
  ownName,
  SEQUENCE_NAMING,
} from "./naming.ts";

interface ShapeInput {
  topics?: Writable<TopicDemand[] | Default<[]>>;
  // deno-lint-ignore ban-types
  names?: Writable<Default<NamesMap, {}>>;
}

interface AddShapeEvent {
  title: string;
  body?: string;
  agentName: string;
}

/**
 * What the rehearsal's `addTopic` returns: the Topics board's own result row,
 * and the name the create allocated beside it.
 */
interface AddShapeResult {
  topic: TopicIndexRow;
  name: string;
}

interface ShapeOutput {
  [NAME]: string;
  topics: TopicDemand[];

  /**
   * The survey surface, declared exactly as the Topics board declares it. The
   * width between this and `topics` is the property under test: a demand of
   * `TopicDemand` carries a topic's body and mentions, the row schema carries
   * neither, and republishing the one array under the narrower schema is what
   * makes a survey cheap.
   */
  index: TopicIndexRow[] | Default<[]>;
  // deno-lint-ignore ban-types
  names: Default<NamesMap, {}>;
  namesTable: NamesTableRow[] | Default<[]>;
  naming: NamingDeclaration;
  addTopic: Stream<AddShapeEvent, AddShapeResult>;
  backfillNames: Stream<{ agentName: string }, { assigned: string[] }>;
}

/**
 * A board over real topics that names its members: `addTopic` as the Topics
 * board writes it, plus the one line that allocates the name in the same
 * transaction as the append, and the name returned beside the topic.
 */
const ShapeBoard = pattern<ShapeInput, ShapeOutput>(({ topics, names }) => {
  const topicCount = topics.get().length;
  const table = namesTable({ names });

  const addTopic = action<AddShapeEvent, AddShapeResult>(
    ({ title, body, agentName }) => {
      const trimmed = (title ?? "").trim();
      const author = topicAuthorFromAgent(agentName) ??
        rejectMutation("addTopic", "agentName must be non-blank");
      if (!trimmed) rejectMutation("addTopic", "title must be non-empty");
      const createdAt = Date.now();
      const piece = Topic({
        title: trimmed,
        body: body ?? "",
        createdAt,
        createdBy: author,
      });
      const name = assignName(names, piece);
      topics.push(piece);
      return { topic: piece, name };
    },
  );

  const backfill = action<{ agentName: string }, { assigned: string[] }>(
    ({ agentName }) => {
      if (!topicAuthorFromAgent(agentName)) {
        rejectMutation("backfillNames", "agentName must be non-blank");
      }
      return { assigned: backfillNames(topics, names) };
    },
  );

  return {
    [NAME]: `Topics (${topicCount})`,
    topics,
    // The topics themselves, declared through the index's narrow row schema:
    // a row's address is the topic's address, so a survey and a follow-up read
    // name the same document.
    index: topics,
    names,
    namesTable: table,
    naming: SEQUENCE_NAMING,
    addTopic,
    backfillNames: backfill,
  };
});

export default pattern(() => {
  const topics = new Writable<TopicDemand[] | Default<[]>>([]);
  const names = new Writable<NamesMap>({});
  const board = ShapeBoard({ topics, names });
  // The same lift a topic runs over its own `boardNames`, driven here against
  // real topic identities from the outside: over the board's table, with the
  // list position's cell standing where a topic's `[SELF]` does.
  const nameOfFirst = ownName({ table: board.namesTable, self: topics.key(0) });
  const nameOfSecond = ownName({
    table: board.namesTable,
    self: topics.key(1),
  });

  const assert_initial = assert(() =>
    (board.topics ?? []).length === 0 &&
    (board.namesTable ?? []).length === 0 &&
    nameOfFirst === undefined &&
    board[NAME] === "Topics (0)"
  );

  // Allocation on create, through the real Topic's create path.
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
    (board.topics ?? []).length === 2 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.createdBy?.name === "Sol" &&
    board.topics?.[1]?.title === "Second topic" &&
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

  // The names table gives a topic its name by identity — one row per named
  // topic, each row's `member` the topic itself — and the reverse lookup
  // returns it for the identity a caller holds, here the list position's
  // cell. The `ownName` lifts are the same lookup as a derivation, which is
  // what a topic wired to this table runs.
  const assert_table_names_each_topic = assert(() =>
    (board.namesTable ?? []).length === 2 &&
    board.namesTable?.[0]?.name === "1" &&
    equals(
      board.namesTable?.[0]?.member as object,
      board.topics?.[0] as object,
    ) &&
    board.namesTable?.[1]?.name === "2" &&
    equals(
      board.namesTable?.[1]?.member as object,
      board.topics?.[1] as object,
    ) &&
    nameOf(topics.key(0), board.namesTable ?? []) === "1" &&
    nameOf(topics.key(1), board.namesTable ?? []) === "2" &&
    nameOfFirst === "1" &&
    nameOfSecond === "2"
  );

  // The bound: topics carry bodies and threads, and neither the namespace
  // nor the table carries any of it.
  const assert_reads_expand_no_topic = assert(() => {
    const namespace = JSON.stringify(board.names);
    const table = JSON.stringify(board.namesTable);
    return !namespace.includes('"title"') &&
      !namespace.includes('"body"') &&
      table.includes('"name"') &&
      !table.includes('"title"') &&
      !table.includes('"body"') &&
      !table.includes('"comments"') &&
      !table.includes("vnode");
  });
  // The narrowing itself, which only a real Topic can show: the same array is
  // published twice, and the schema each is declared through is what a reader
  // gets. The demand carries the living document and the mention list; the row
  // schema carries neither, so a survey of a board of real topics reads no
  // topic's prose, thread, or rendered view.
  const assert_index_narrows_the_demand = assert(() => {
    const survey = JSON.stringify(board.index);
    const demanded = JSON.stringify(board.topics);
    return (board.index ?? []).length === 2 &&
      board.index?.[0]?.title === "First topic" &&
      survey.includes('"createdAt"') &&
      !survey.includes('"body"') &&
      !survey.includes('"comments"') &&
      !survey.includes("vnode") &&
      demanded.includes("The living document.") &&
      !survey.includes("The living document.");
  });

  // The backfill, on a board whose topics were filed before it numbered
  // anything: pushed straight into the list, the way an existing board
  // holds them.
  const olderTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const olderNames = new Writable<NamesMap>({});
  const older = ShapeBoard({ topics: olderTopics, names: olderNames });

  const action_file_unnamed_topics = action(() => {
    olderTopics.push(Topic({ title: "Older one", createdAt: 1 }));
    olderTopics.push(Topic({ title: "Older two", createdAt: 2 }));
  });
  const assert_unnamed_topics_have_no_names = assert(() =>
    (older.topics ?? []).length === 2 &&
    (older.namesTable ?? []).length === 0 &&
    nameOf(olderTopics.key(0), older.namesTable ?? []) === undefined &&
    nameOf(olderTopics.key(1), older.namesTable ?? []) === undefined
  );
  const action_backfill = action(() => {
    older.backfillNames.send({ agentName: "Sol" });
  });
  const assert_backfilled_in_filing_order = assert(() =>
    (older.namesTable ?? []).length === 2 &&
    nameOf(olderTopics.key(0), older.namesTable ?? []) === "1" &&
    nameOf(olderTopics.key(1), older.namesTable ?? []) === "2" &&
    equals(
      ((older.names ?? {}) as NamesMap)["1"] as object,
      older.topics?.[0] as object,
    ) &&
    equals(
      ((older.names ?? {}) as NamesMap)["2"] as object,
      older.topics?.[1] as object,
    )
  );
  // A create after the backfill continues the sequence.
  const action_add_after_backfill = action(() => {
    older.addTopic.send({ title: "Newer one", agentName: "Sol" });
  });
  const assert_create_continues_the_sequence = assert(() =>
    (older.topics ?? []).length === 3 &&
    (older.namesTable ?? []).length === 3 &&
    nameOf(olderTopics.key(2), older.namesTable ?? []) === "3" &&
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2,3"
  );
  // A second backfill, over the list the create has grown, writes nothing:
  // the map holds what the first run and the create left.
  const action_backfill_again = action(() => {
    older.backfillNames.send({ agentName: "Sol" });
  });
  const assert_second_backfill_leaves_the_map = assert(() =>
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2,3" &&
    (older.namesTable ?? []).length === 3 &&
    equals(
      ((older.names ?? {}) as NamesMap)["1"] as object,
      older.topics?.[0] as object,
    ) &&
    equals(
      ((older.names ?? {}) as NamesMap)["2"] as object,
      older.topics?.[1] as object,
    ) &&
    equals(
      ((older.names ?? {}) as NamesMap)["3"] as object,
      older.topics?.[2] as object,
    )
  );

  const assert_declaration = assert(() =>
    board.naming?.policy?.allocator === "sequence" &&
    board.naming?.policy?.unique === "history" &&
    board.naming?.compact === true
  );

  return {
    [TESTS]: [
      { assertion: assert_initial },
      { action: action_add_first },
      { action: action_add_second },
      { assertion: assert_allocated_on_create },
      { assertion: assert_table_names_each_topic },
      { assertion: assert_reads_expand_no_topic },
      { assertion: assert_index_narrows_the_demand },
      { action: action_file_unnamed_topics },
      { assertion: assert_unnamed_topics_have_no_names },
      { action: action_backfill },
      { assertion: assert_backfilled_in_filing_order },
      { action: action_add_after_backfill },
      { assertion: assert_create_continues_the_sequence },
      // Some runs log two `sync-load-failure` lines at teardown, and they are
      // acceptable. Each Topic's `#profile` wish finds no profile in the test
      // space and opens its profile-create surface, a sidecar pattern the test
      // runtime has no server to load (`runtime/runner/src/builtins/wish.ts`),
      // and a topic created late in the run can still be syncing for that when
      // the harness disposes the runtime after the final assertion; the storage
      // layer then logs the cut-short sync once per distinct error
      // (`runtime/runner/test/sync-load-failure-surfacing.test.ts`). It turns
      // on timing, not on wiring: a topic composed with `mentionable` and
      // `boardCrossrefs` logs the same lines as a bare one. The run ends on
      // the write-free second backfill so that less is in flight at teardown,
      // and no assertion here depends on the wish.
      { action: action_backfill_again },
      { assertion: assert_second_backfill_leaves_the_map },
      { assertion: assert_declaration },
    ],
  };
});
