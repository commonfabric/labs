/**
 * The reports board's verbs: `addReport` stores a report labeled
 * `authored-by` the principal that sent it, keeps fields of `structured` it
 * does not know, and refuses a duplicate or malformed report; `linkTopic`
 * records a report's Topic once. Every refusal throws, so the runtime errors
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
      name: "quiet-heron-41",
      kind: "broke",
      words: "Mail stopped syncing.",
      structured,
    });
  });
  const action_add_without_words = action(() => {
    board.addReport.send({
      agentName: "cfs-feedback",
      name: "calm-otter-7",
      kind: "wish",
      structured: { source: "report" },
    });
  });

  const assert_stored = assert(() => {
    const [first, second] = board.reports;
    return board.reports.length === 2 &&
      first.name === "quiet-heron-41" && first.kind === "broke" &&
      first.words === "Mail stopped syncing." &&
      first.structured.source === "failure-card" &&
      JSON.stringify(first.structured.futureField) ===
        JSON.stringify({ nested: [1, 2] }) &&
      first.createdAt > 0 &&
      second.name === "calm-otter-7" && second.words === undefined &&
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

  // Refused: duplicate name, missing name, missing kind, unknown kind,
  // missing source, words too long, unsigned.
  const refused = [
    { name: "quiet-heron-41", kind: "broke", structured: { source: "report" } },
    { name: "  ", kind: "broke", structured: { source: "report" } },
    { name: "a", kind: "", structured: { source: "report" } },
    { name: "b", kind: "bug", structured: { source: "report" } },
    { name: "c", kind: "broke", structured: { source: "" } },
    {
      name: "d",
      kind: "broke",
      words: "x".repeat(MAX_WORDS + 1),
      structured: { source: "report" },
    },
  ];
  const refusals = refused.map((event) =>
    action(() => board.addReport.send({ agentName: "cfs-feedback", ...event }))
  );
  const action_add_unsigned = action(() => {
    board.addReport.send({
      agentName: " ",
      name: "e",
      kind: "broke",
      structured: { source: "report" },
    });
  });
  const assert_nothing_more = assert(() =>
    board.reports.length === 2 &&
    board.reports.filter((report) => report.name === "quiet-heron-41")
        .length === 1
  );

  const action_link = action(() => {
    board.linkTopic.send({
      agentName: "triage",
      name: "quiet-heron-41",
      topic: "of:fid1:topic-a",
    });
  });
  // The same link again changes nothing and is not refused.
  const action_link_again = action(() => {
    board.linkTopic.send({
      agentName: "triage",
      name: "quiet-heron-41",
      topic: "of:fid1:topic-a",
    });
  });
  const assert_linked = assert(() =>
    board.topicOf["quiet-heron-41"] === "of:fid1:topic-a" &&
    board.index[0].topic === "of:fid1:topic-a" &&
    board.index[1].topic === undefined &&
    board.newCount === 1
  );

  // Refused: another Topic for a linked report, an unknown report, a blank
  // Topic, unsigned.
  const linkRefusals = [
    { agentName: "triage", name: "quiet-heron-41", topic: "of:fid1:topic-b" },
    { agentName: "triage", name: "no-such-report", topic: "of:fid1:topic-a" },
    { agentName: "triage", name: "calm-otter-7", topic: " " },
    { agentName: "", name: "calm-otter-7", topic: "of:fid1:topic-a" },
  ].map((event) => action(() => board.linkTopic.send(event)));
  const assert_links_unchanged = assert(() =>
    Object.keys(board.topicOf).length === 1 &&
    board.topicOf["quiet-heron-41"] === "of:fid1:topic-a"
  );

  return {
    expectRuntimeErrors: refusals.length + 1 + linkRefusals.length,
    [TESTS]: [
      { action: action_record_me },
      { action: action_add },
      { action: action_add_without_words },
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
