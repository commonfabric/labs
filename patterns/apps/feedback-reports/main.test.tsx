/**
 * The reports board's verbs: `addReport` stores a report labeled
 * `authored-by` the principal that sent it, keeps fields of `structured` it
 * does not know, keys reports by id rather than by name, and refuses a
 * duplicate id or a malformed report; `linkTopic` records a report's Topic
 * once, by id. Every refusal throws, so the runtime errors
 * are counted exactly, and each is followed by an assertion that nothing
 * landed.
 */
import {
  action,
  assert,
  currentPrincipal,
  type Default,
  pattern,
  principalOf,
  TESTS,
  Writable,
} from "commonfabric";
import FeedbackReports, {
  MAX_WORDS,
  type StoredReport,
  type TopicOfMap,
} from "./main.tsx";

/** One more failing probe than a report may hold. */
const MANY_PROBES = Array.from(
  { length: 51 },
  () => ({ connector: "gmail", probe: "token" }),
);

export default pattern(() => {
  // Held here so the test can read a stored report's label.
  const reports = new Writable<StoredReport[] | Default<[]>>([]);
  const topicOf = new Writable<TopicOfMap>({});
  const board = FeedbackReports({ reports, topicOf });
  const me = new Writable("");

  const ID_A = "0123456789abcdef".repeat(2);
  const ID_B = "b".repeat(32);
  const ID_C = "c".repeat(32);

  const structured = {
    source: "failure-card",
    cfs: { release: "2026.11.18" },
    want: { id: "w1", cause: "auth-expired", stop: "gmail-sync", since: 1 },
    // A field no reader knows yet, which the board keeps.
    futureField: { nested: [1, 2] },
  };

  const action_record_me = action(() => me.set(currentPrincipal() ?? ""));
  const action_add = action(() => {
    board.addReport.send({
      agentName: "cfs-feedback",
      id: ID_A,
      name: "quiet-heron-41",
      kind: "broke",
      words: "Mail stopped syncing.",
      structured,
    });
  });
  // Another install's report with the same name: names are labels, and two
  // installs pick from the same small set, so the board keeps both.
  const action_add_same_name = action(() => {
    board.addReport.send({
      agentName: "cfs-feedback",
      id: ID_B,
      name: "quiet-heron-41",
      kind: "wish",
      structured: { source: "report" },
    });
  });

  const assert_stored = assert(() => {
    const [first, second] = board.reports;
    return board.reports.length === 2 &&
      first.id === ID_A && first.name === "quiet-heron-41" &&
      first.kind === "broke" && first.words === "Mail stopped syncing." &&
      first.structured.source === "failure-card" &&
      JSON.stringify(first.structured.futureField) ===
        JSON.stringify({ nested: [1, 2] }) &&
      first.createdAt > 0 &&
      second.id === ID_B && second.name === "quiet-heron-41" &&
      second.words === undefined &&
      board.newCount === 2;
  });

  // The sender is the label, not a field: the record names its writer only
  // through `authored-by`, which names the principal the call acted for.
  const assert_authored_by_sender = assert(() =>
    me.get() !== "" &&
    board.reports.length > 0 &&
    !Object.keys(board.reports[0] ?? {}).includes("sender") &&
    principalOf(reports.key(0), "authored-by") === me.get()
  );

  // Refused: duplicate id, missing id, an id in capitals, an id one short,
  // missing name, a name of another shape, missing kind, unknown kind,
  // missing source, words too long, a link in `structured`, a cause that is
  // prose, too many probes. `fields.test.ts` checks the code of each refusal
  // and the rest of the rules; here each must also leave the board as it was.
  const valid = {
    kind: "broke",
    name: "brave-lynx-3",
    structured: { source: "report" },
  };
  const refused = [
    { ...valid, id: ID_A, name: "other-name-1" },
    { ...valid, name: "no-id-2" },
    { ...valid, id: ID_A.toUpperCase() },
    { ...valid, id: ID_C.slice(1) },
    { ...valid, id: ID_C, name: "  " },
    { ...valid, id: ID_C, name: "Quiet Heron" },
    { ...valid, id: ID_C, kind: "" },
    { ...valid, id: ID_C, kind: "bug" },
    { ...valid, id: ID_C, structured: { source: "" } },
    { ...valid, id: ID_C, words: "x".repeat(MAX_WORDS + 1) },
    {
      ...valid,
      id: ID_C,
      structured: { source: "report", note: "see https://example.com" },
    },
    {
      ...valid,
      id: ID_C,
      structured: { source: "report", want: { cause: "it broke, sorry" } },
    },
    {
      ...valid,
      id: ID_C,
      structured: {
        source: "report",
        failingProbes: MANY_PROBES,
      },
    },
  ];
  const refusals = refused.map((event) =>
    action(() =>
      board.addReport.send({ agentName: "cfs-feedback", id: "", ...event })
    )
  );
  const action_add_unsigned = action(() => {
    board.addReport.send({
      agentName: " ",
      id: ID_C,
      name: "e",
      kind: "broke",
      structured: { source: "report" },
    });
  });
  const assert_nothing_more = assert(() =>
    board.reports.length === 2 &&
    board.reports.filter((report) => report.id === ID_A).length === 1
  );

  const action_link = action(() => {
    board.linkTopic.send({
      agentName: "triage",
      id: ID_A,
      topic: "of:fid1:topic-a",
    });
  });
  // The same link again changes nothing and is not refused.
  const action_link_again = action(() => {
    board.linkTopic.send({
      agentName: "triage",
      id: ID_A,
      topic: "of:fid1:topic-a",
    });
  });
  // Another Topic replaces the link: who may be believed is the reader's to
  // decide, from the link's `authored-by` label.
  const action_relink = action(() => {
    board.linkTopic.send({ agentName: "triage", id: ID_B, topic: "top/7" });
  });
  const action_relink_again = action(() => {
    board.linkTopic.send({ agentName: "triage", id: ID_B, topic: "top/8" });
  });
  const assert_relinked = assert(() =>
    board.topicOf[ID_B] === "top/8" &&
    principalOf(topicOf.key(ID_B), "authored-by") === me.get()
  );
  // Linking one report leaves the other report of the same name new.
  const assert_linked = assert(() =>
    board.topicOf[ID_A] === "of:fid1:topic-a" &&
    board.index[0].topic === "of:fid1:topic-a" &&
    board.index[1].topic === undefined &&
    board.newCount === 1
  );

  // Refused: an unknown report, a malformed id, a blank Topic, a Topic
  // that is a link rather than an address, unsigned.
  const linkRefusals = [
    { agentName: "triage", id: ID_C, topic: "of:fid1:topic-a" },
    { agentName: "triage", id: "quiet-heron-41", topic: "of:fid1:topic-a" },
    { agentName: "triage", id: ID_A, topic: " " },
    { agentName: "triage", id: ID_A, topic: "https://example.com/top/1" },
    { agentName: "", id: ID_A, topic: "of:fid1:topic-b" },
  ].map((event) => action(() => board.linkTopic.send(event)));
  const assert_links_unchanged = assert(() =>
    Object.keys(board.topicOf).length === 2 &&
    board.topicOf[ID_A] === "of:fid1:topic-a" &&
    board.topicOf[ID_B] === "top/8"
  );

  return {
    expectRuntimeErrors: refusals.length + 1 + linkRefusals.length,
    [TESTS]: [
      { action: action_record_me },
      { action: action_add },
      { action: action_add_same_name },
      { assertion: assert_stored },
      { assertion: assert_authored_by_sender },
      ...refusals.flatMap((refusal) => [
        { action: refusal },
        { assertion: assert_nothing_more },
      ]),
      { action: action_add_unsigned },
      { assertion: assert_nothing_more },
      { action: action_link },
      { action: action_link_again },
      { assertion: assert_linked },
      { action: action_relink },
      { action: action_relink_again },
      { assertion: assert_relinked },
      ...linkRefusals.flatMap((refusal) => [
        { action: refusal },
        { assertion: assert_links_unchanged },
      ]),
    ],
  };
});
