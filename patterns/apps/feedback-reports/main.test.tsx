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
import FeedbackReports, { MAX_WORDS, type StoredReport } from "./main.tsx";

export default pattern(() => {
  // Held here so the test can read a stored report's label.
  const reports = new Writable<StoredReport[] | Default<[]>>([]);
  const board = FeedbackReports({ reports });
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
  // missing name, missing kind, unknown kind, missing source, words too long.
  const valid = { kind: "broke", structured: { source: "report" } };
  const refused = [
    { ...valid, id: ID_A, name: "other-name-1" },
    { ...valid, name: "no-id-2" },
    { ...valid, id: ID_A.toUpperCase(), name: "caps-3" },
    { ...valid, id: ID_C.slice(1), name: "short-4" },
    { ...valid, id: ID_C, name: "  " },
    { ...valid, id: ID_C, name: "a", kind: "" },
    { ...valid, id: ID_C, name: "b", kind: "bug" },
    { ...valid, id: ID_C, name: "c", structured: { source: "" } },
    { ...valid, id: ID_C, name: "d", words: "x".repeat(MAX_WORDS + 1) },
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
  // Linking one report leaves the other report of the same name new.
  const assert_linked = assert(() =>
    board.topicOf[ID_A] === "of:fid1:topic-a" &&
    board.index[0].topic === "of:fid1:topic-a" &&
    board.index[1].topic === undefined &&
    board.newCount === 1
  );

  // Refused: another Topic for a linked report, an unknown report, a
  // malformed id, a blank Topic, unsigned.
  const linkRefusals = [
    { agentName: "triage", id: ID_A, topic: "of:fid1:topic-b" },
    { agentName: "triage", id: ID_C, topic: "of:fid1:topic-a" },
    { agentName: "triage", id: "quiet-heron-41", topic: "of:fid1:topic-a" },
    { agentName: "triage", id: ID_B, topic: " " },
    { agentName: "", id: ID_B, topic: "of:fid1:topic-a" },
  ].map((event) => action(() => board.linkTopic.send(event)));
  const assert_links_unchanged = assert(() =>
    Object.keys(board.topicOf).length === 1 &&
    board.topicOf[ID_A] === "of:fid1:topic-a"
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
      ...linkRefusals.flatMap((refusal) => [
        { action: refusal },
        { assertion: assert_links_unchanged },
      ]),
    ],
  };
});
