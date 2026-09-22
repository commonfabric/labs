/**
 * Pattern test for the topic workbench: the topic header reads through the
 * narrow view, sessions come off the connector index newest first with
 * deleted rows dropped, a session naming the topic is offered as related
 * (one naming a longer number is not), attach is idempotent and joins the
 * live row, detach removes it and clears its record so a later attach starts
 * fresh, the spawn command composes from the picked checkout and prompt, a
 * start sends the connector a `start` command and records it until the index
 * carries the session it named (a confirmed start stays attached once the
 * index marks its session deleted, attaching it by hand as well records no
 * second row, and Detach drops it; a second start can be withdrawn, which
 * takes its command back out of the queue; a start with no queue stays
 * starting and can be withdrawn; a second click while a start is
 * unconfirmed sends nothing, and the words a start sent clear from the
 * composer), Start is disabled with its reason when the picked harness
 * cannot start, when no index or no startable harness is linked, when the
 * kickoff is empty, and while a start is unconfirmed, an index that is not the complete
 * bucket is called out, a start carries the configured mode and a shown
 * harness no source runs is listed but starts nothing, the rail's own
 * buttons attach and detach a row and add the topic's words to the prompt,
 * provider identities differing only in where a slash falls stay apart while
 * casing and padding the connector normalizes join the same row, a verb
 * call without both ids is refused, and a desktop start sends the surface
 * and no mode, is confirmed by the session the app makes under an id of its
 * own that names the start's as `startedAs`, joins under that id, drops its
 * record on Detach by row or by verb, and is blocked with the reason over a
 * source that cannot open the app.
 */
import {
  action,
  assert,
  Default,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  findNode,
  findNodeByProp,
  hasText,
  isButton,
  propValue,
} from "../test/vnode-helpers.ts";
import type {
  Attachment,
  CommandValue,
  IndexBucketView,
  PairedSessionIndexView,
  SessionIndexView,
  SessionStart,
  StartableSourcesView,
} from "../workbench/sessions.ts";
import Workbench, { type TopicView } from "./main.tsx";

type IndexFixture =
  & SessionIndexView
  & StartableSourcesView
  & IndexBucketView
  & PairedSessionIndexView;

/** The first queued command, decoded; `null` when the queue is empty. */
// deno-lint-ignore no-explicit-any
const firstCommand = (queued: readonly CommandValue[]): any =>
  JSON.parse(queued[0] ?? "null");

/** The last queued command, decoded; `null` when the queue is empty. */
// deno-lint-ignore no-explicit-any
const lastCommand = (queued: readonly CommandValue[]): any =>
  JSON.parse(queued[queued.length - 1] ?? "null");

/** Whether the Start control is disabled, as the rendered tree has it. */
const startDisabled = (root: unknown): boolean =>
  propValue(findNode(root, isButton("Start")), "disabled") === true;

/** An index row for a session the app made for a desktop start: its own id,
 * and the start's as `startedAs`. */
const appMade = (id: string, startedAs: string) => ({
  sourceId: "claude",
  nativeSessionId: id,
  title: "topic #7: Workbench topic",
  cwd: "/w/labs",
  gitRepo: null,
  gitBranch: "main",
  gitWorktreeRoot: null,
  updatedAt: "2026-09-16T21:00:00.000Z",
  active: true,
  archived: false,
  syncStatus: "complete",
  startedAs,
});

// Plain rows stand in for the connector's linked child cells: the pattern
// reads the same shallow fields either way. Codex is configured but its driver
// cannot start a session; an ACP source and Claude can, and Claude is listed
// first however the connector orders them.
const INDEX: IndexFixture = {
  schema: "commonfabric.agent-connector.session-index",
  ownerDid: "did:key:owner",
  bucket: "all",
  sources: [
    { id: "codex", driver: "codex-app-server", capabilities: {} },
    { id: "acp-lab", driver: "acp", capabilities: { startSession: true } },
    {
      id: "claude",
      driver: "claude-agent-sdk",
      capabilities: { startSession: true },
    },
  ],
  sessions: [
    {
      sourceId: "claude",
      nativeSessionId: "aaa",
      title: "topic #7: Workbench topic",
      cwd: "/w/labs",
      gitRepo: null,
      gitBranch: "main",
      gitWorktreeRoot: null,
      updatedAt: "2026-09-08T10:00:00.000Z",
      active: true,
      archived: false,
      syncStatus: "complete",
    },
    {
      sourceId: "claude",
      nativeSessionId: "bbb",
      title: "something unrelated",
      cwd: "/w/other",
      gitRepo: null,
      gitBranch: "feature",
      gitWorktreeRoot: null,
      updatedAt: "2026-09-08T11:00:00.000Z",
      active: false,
      archived: false,
      syncStatus: "complete",
    },
    {
      sourceId: "claude",
      nativeSessionId: "ccc",
      title: "deleted upstream",
      cwd: null,
      gitRepo: null,
      gitBranch: null,
      gitWorktreeRoot: null,
      updatedAt: "2026-09-08T12:00:00.000Z",
      active: null,
      archived: null,
      syncStatus: "deleted",
    },
    {
      // Names a longer number: `#7` must not claim `#70`.
      sourceId: "claude",
      nativeSessionId: "ddd",
      title: "topic #70: not this one",
      cwd: "/w/labs",
      gitRepo: null,
      gitBranch: "main",
      gitWorktreeRoot: null,
      updatedAt: "2026-09-08T09:00:00.000Z",
      active: false,
      archived: false,
      syncStatus: "complete",
    },
  ],
  checkouts: [{ root: "/w/labs", branch: "main" }],
};

export default pattern(() => {
  const topic = new Writable<TopicView>({
    title: "Workbench topic",
    shortName: "7",
    body: "The living document, which a session starts from.",
    commentCount: 2,
    lastActivityAt: 1_700_000_000_000,
    links: [
      { kind: "web", url: "https://example.com/page", label: "a page" },
      { kind: "pr", url: "https://github.com/o/r/pull/1", label: "#1" },
      {
        kind: "web",
        url: "https://example.com/gone",
        label: "retracted",
        removedAt: 5,
      },
      // Stored before the topic's write guard: rendered as text, kept out of
      // the kickoff.
      { kind: "pr", url: "javascript:alert(1)", label: "legacy" },
    ],
  });
  const index = new Writable<IndexFixture>(INDEX);
  const attached = new Writable<Attachment[] | Default<[]>>([]);
  const commands = new Writable<CommandValue[] | Default<[]>>([]);
  const starts = new Writable<SessionStart[] | Default<[]>>([]);
  const wb = Workbench({
    topic,
    sessions: index,
    attached,
    commands,
    starts,
  });
  // A workbench whose host has bound no queue yet: a start reaches nothing.
  const noQueueStarts = new Writable<SessionStart[] | Default<[]>>([]);
  const noQueue = Workbench({
    topic,
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    starts: noQueueStarts,
  });
  // No index linked at all.
  const bare = Workbench({ topic });
  // An index whose only source cannot start.
  const codexOnly = Workbench({
    topic,
    sessions: new Writable<IndexFixture>({
      ...INDEX,
      sources: [{ id: "codex", driver: "codex-app-server", capabilities: {} }],
    }),
  });
  // No topic, so nothing to start from until the person writes a prompt.
  const blankCommands = new Writable<CommandValue[] | Default<[]>>([]);
  const blank = Workbench({
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    commands: blankCommands,
    starts: new Writable<SessionStart[] | Default<[]>>([]),
  });
  // The connector's recent bucket rather than its complete index.
  const recentBucket = Workbench({
    topic,
    sessions: new Writable<IndexFixture>({ ...INDEX, bucket: "recent" }),
  });
  // Provider identities that a naive join would confuse: a source id with a
  // slash, and casing and padding the connector normalizes.
  const keysAttached = new Writable<Attachment[] | Default<[]>>([]);
  const keys = Workbench({
    topic,
    sessions: new Writable<IndexFixture>({
      ...INDEX,
      sessions: [
        { ...INDEX.sessions[0]!, sourceId: "a/b", nativeSessionId: "c" },
        { ...INDEX.sessions[1]!, sourceId: "a", nativeSessionId: "b/c" },
        INDEX.sessions[0]!,
      ],
    }),
    attached: keysAttached,
  });
  // A desktop start: the connector opens Claude Code on this Mac with the
  // kickoff ready to send; the session the app makes carries the start's id
  // as `startedAs` and its own id everywhere else.
  const desktopIndex = new Writable<IndexFixture>({
    ...INDEX,
    sources: [{
      id: "claude",
      driver: "claude-agent-sdk",
      capabilities: { startSession: true, surfaces: ["headless", "desktop"] },
    }],
  });
  const deskCommands = new Writable<CommandValue[] | Default<[]>>([]);
  const deskStarts = new Writable<SessionStart[] | Default<[]>>([]);
  const desk = Workbench({
    topic,
    sessions: desktopIndex,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    commands: deskCommands,
    starts: deskStarts,
    startMode: "acceptEdits",
    startSurface: "desktop",
  });
  const deskBlocked = Workbench({
    topic,
    sessions: index,
    startSurface: "desktop",
  });
  // A start mode for the first turn, and a harness shown that no source runs.
  const shownCommands = new Writable<CommandValue[] | Default<[]>>([]);
  const shown = Workbench({
    topic,
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    commands: shownCommands,
    starts: new Writable<SessionStart[] | Default<[]>>([]),
    startMode: "acceptEdits",
    harnessesShown: [{ id: "gemini", driver: "gemini-cli" }],
  });

  const assert_header = assert(() =>
    wb[NAME] === "Workbench: Workbench topic" &&
    wb.attachedSessions.length === 0 &&
    // Newest first, and the deleted row is dropped.
    wb.recentSessions.length === 3 &&
    wb.recentSessions[0]?.nativeSessionId === "bbb" &&
    wb.recentSessions[1]?.nativeSessionId === "aaa" &&
    wb.recentSessions[1]?.active === true &&
    wb.recentSessions[2]?.nativeSessionId === "ddd" &&
    // The session whose title names the topic is offered as related; the
    // one naming #70 is not.
    wb.relatedSessions.length === 1 &&
    wb.relatedSessions[0]?.nativeSessionId === "aaa" &&
    // Claude can start from the complete index: nothing blocks Start, and
    // the index earns no caution.
    wb.startBlocker === "" &&
    !startDisabled(wb[UI]) &&
    hasText(wb[UI], "can be withdrawn until then") &&
    findNodeByProp(wb[UI], "data-index-note", "") === undefined
  );

  // Only a source whose driver can start is offered as a harness, Claude
  // first, and a stored link that is not http(s) renders as text with no
  // anchor.
  const assert_harnesses_and_links = assert(() =>
    JSON.stringify(
        propValue(findNodeByProp(wb[UI], "data-harness", ""), "items"),
      ) === JSON.stringify([
        { label: "claude  (claude-agent-sdk)", value: "claude" },
        { label: "acp-lab  (acp)", value: "acp-lab" },
      ]) &&
    findNode(
        wb[UI],
        (node) => propValue(node, "href") === "javascript:alert(1)",
      ) === undefined &&
    hasText(wb[UI], "legacy")
  );

  // Start is disabled, and the caption says why, wherever the handler would
  // send nothing: no index, no startable harness, an empty kickoff, and a
  // linked index that is not the complete bucket earns a caution.
  const action_start_blocked = action(() => {
    bare.startSession.send();
    codexOnly.startSession.send();
    blank.startSession.send();
  });
  const assert_start_blocked = assert(() =>
    bare.startBlocker.startsWith("No session index is linked") &&
    startDisabled(bare[UI]) &&
    hasText(bare[UI], "No session index is linked") &&
    codexOnly.startBlocker ===
      "No harness the connector runs here can start a session." &&
    startDisabled(codexOnly[UI]) &&
    blank.startBlocker === "Write a prompt to start from." &&
    startDisabled(blank[UI]) &&
    blankCommands.get().length === 0 &&
    hasText(
      findNodeByProp(recentBucket[UI], "data-index-note", ""),
      "the connector's recent bucket",
    ) &&
    recentBucket.startBlocker === ""
  );

  const action_attach = action(() => {
    wb.attach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_attached = assert(() =>
    wb.attachedSessions.length === 1 &&
    // Joined with the live row: the title comes from the index, not the
    // attach call, which named none.
    wb.attachedSessions[0]?.title === "topic #7: Workbench topic" &&
    wb.attachedSessions[0]?.gitBranch === "main" &&
    wb.attachedSessions[0]?.attached === true &&
    wb.relatedSessions.length === 0 &&
    wb.recentSessions.length === 2 &&
    wb.recentSessions[0]?.nativeSessionId === "bbb"
  );

  const action_attach_again = action(() => {
    wb.attach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_attach_idempotent = assert(() =>
    wb.attachedSessions.length === 1
  );

  // An attachment the index no longer carries still shows from its own record.
  const action_attach_unknown = action(() => {
    wb.attach.send({
      sourceId: "codex",
      nativeSessionId: "zzz",
      title: "a session the index forgot",
    });
  });
  const assert_unknown_kept = assert(() =>
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions[1]?.title === "a session the index forgot" &&
    wb.attachedSessions[1]?.gitBranch === ""
  );

  const action_detach = action(() => {
    wb.detach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_detached = assert(() =>
    wb.attachedSessions.length === 1 &&
    wb.attachedSessions[0]?.nativeSessionId === "zzz" &&
    wb.recentSessions.length === 3
  );

  // Detach clears the record as well as the membership, so attaching the
  // same session again writes a fresh record rather than reviving the old.
  const action_reattach = action(() => {
    wb.attach.send({
      sourceId: "claude",
      nativeSessionId: "aaa",
      title: "attached again",
    });
  });
  const assert_reattached_fresh = assert(() =>
    wb.attachedSessions.length === 2 &&
    attached.get().find((a) => a.nativeSessionId === "aaa")?.title ===
      "attached again"
  );
  const action_detach_again = action(() => {
    wb.detach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_detached_again = assert(() =>
    wb.attachedSessions.length === 1 && wb.recentSessions.length === 3
  );

  const action_compose_spawn = action(() => {
    wb.spawnRoot.set("/w/labs");
    wb.spawnPrompt.set("Work on topic #7, it's time.");
  });
  const assert_spawn_command = assert(() =>
    wb.kickoff.startsWith(
      'Work on topic #7, it\'s time.\n\nContext:\n- Topic #7, "Workbench topic". Its living document begins: The living document, which a session starts from.',
    ) &&
    wb.kickoff.includes("Links:\n- #1: https://github.com/o/r/pull/1") &&
    !wb.kickoff.includes("javascript:") &&
    wb.spawnCommand.startsWith(
      "cd '/w/labs' && claude 'Work on topic #7, it'\\''s time.",
    )
  );

  // A start sends one `start` command for the Claude source, named after the
  // topic and carrying the kickoff, and records the session it minted:
  // nothing attaches until the index carries the session.
  const action_start = action(() => {
    wb.startSession.send();
  });
  const assert_start_command = assert(() =>
    commands.get().length === 1 &&
    firstCommand(commands.get())?.schema ===
      "commonfabric.agent-connector.command" &&
    firstCommand(commands.get())?.ownerDid === "did:key:owner" &&
    firstCommand(commands.get())?.type === "start" &&
    firstCommand(commands.get())?.sourceId === "claude" &&
    /^[0-9a-f-]{36}$/.test(
      firstCommand(commands.get())?.nativeSessionId ?? "",
    ) &&
    firstCommand(commands.get())?.payload?.cwd === "/w/labs" &&
    firstCommand(commands.get())?.payload?.title ===
      "topic #7: Workbench topic" &&
    (firstCommand(commands.get())?.payload?.text ?? "").startsWith(
      "Work on topic #7, it's time.",
    )
  );
  const assert_start_pending = assert(() =>
    wb.attachedSessions.length === 1 &&
    wb.startingSessions.length === 1 &&
    wb.startingSessions[0]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    wb.startingSessions[0]?.commandId === firstCommand(commands.get())?.id &&
    wb.startingSessions[0]?.title === "topic #7: Workbench topic" &&
    starts.get().length === 1 &&
    hasText(wb[UI], "Starting · 1") &&
    hasText(wb[UI], "Withdraw takes the command out of the queue") &&
    // The composer answers at once: the sent words clear, and Start is
    // disabled with the start it waits on.
    wb.spawnPrompt.get() === "" &&
    wb.startBlocker.startsWith('Starting "topic #7: Workbench topic"') &&
    startDisabled(wb[UI]) &&
    hasText(wb[UI], 'Starting "topic #7: Workbench topic"')
  );
  // A second click while the start is unconfirmed sends nothing: one start
  // at a time for the topic.
  const action_start_twice = action(() => {
    wb.startSession.send();
  });
  const assert_start_once = assert(() =>
    commands.get().length === 1 && starts.get().length === 1 &&
    wb.startingSessions.length === 1
  );

  // The connector publishes the session: the start is confirmed and counts
  // as attached, joined with its live row.
  const action_confirm_start = action(() => {
    const started = firstCommand(commands.get())?.nativeSessionId ?? "";
    const current = index.get();
    index.set({
      ...current,
      sessions: [
        ...current.sessions,
        {
          sourceId: "claude",
          nativeSessionId: started,
          title: "topic #7: Workbench topic",
          cwd: "/w/labs",
          gitRepo: null,
          gitBranch: "main",
          gitWorktreeRoot: null,
          updatedAt: "2026-09-08T13:00:00.000Z",
          active: true,
          archived: false,
          syncStatus: "complete",
        },
      ],
    });
  });
  const assert_start_attached = assert(() =>
    wb.startingSessions.length === 0 &&
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions[1]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    wb.attachedSessions[1]?.title === "topic #7: Workbench topic" &&
    wb.attachedSessions[1]?.sourceId === "claude" &&
    wb.attachedSessions[1]?.gitBranch === "main" &&
    wb.recentSessions.every((row) =>
      row.nativeSessionId !== firstCommand(commands.get())?.nativeSessionId
    )
  );

  // Once the start is confirmed, Start is free again.
  const assert_start_enabled_again = assert(() =>
    wb.startBlocker === "" && !startDisabled(wb[UI])
  );

  // A confirmed start stays attached when the connector later marks the
  // session deleted: the row shows from its own record, as a manually
  // attached session does, and does not fall back to starting.
  const action_delete_started = action(() => {
    const started = firstCommand(commands.get())?.nativeSessionId ?? "";
    const current = index.get();
    index.set({
      ...current,
      sessions: current.sessions.map((s) =>
        s && s.nativeSessionId === started
          ? { ...s, syncStatus: "deleted" as const }
          : s
      ),
    });
  });
  const assert_deleted_still_attached = assert(() =>
    wb.startingSessions.length === 0 &&
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions.some((row) =>
      row.nativeSessionId === firstCommand(commands.get())?.nativeSessionId &&
      row.gitBranch === ""
    )
  );

  // A started session attached by hand as well (a skill inside it attaching
  // itself, naming no title) shows once and keeps the start's title; Detach
  // on it drops both records.
  const action_attach_started = action(() => {
    wb.attach.send({
      sourceId: "claude",
      nativeSessionId: firstCommand(commands.get())?.nativeSessionId ?? "",
    });
  });
  const assert_started_attached_once = assert(() =>
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions.some((row) =>
      row.nativeSessionId === firstCommand(commands.get())?.nativeSessionId &&
      row.title === "topic #7: Workbench topic"
    ) &&
    attached.get().some((a) =>
      a.nativeSessionId === firstCommand(commands.get())?.nativeSessionId &&
      a.title === ""
    )
  );
  const action_detach_started = action(() => {
    clickInRow(wb[UI], "topic #7: Workbench topic", "Detach");
  });
  const assert_started_detached = assert(() =>
    wb.attachedSessions.length === 1 &&
    wb.attachedSessions[0]?.nativeSessionId === "zzz" &&
    starts.get().length === 0 &&
    attached.get().every((a) =>
      a.nativeSessionId !== firstCommand(commands.get())?.nativeSessionId
    )
  );

  // A second start, withdrawn before the connector takes it: the command
  // leaves the queue, and only that command (a value in the queue that is
  // not a command is passed over); the record goes with it.
  const action_start_again = action(() => {
    commands.set([...commands.get(), "not a command"]);
    wb.startSession.send();
  });
  const assert_second_start_pending = assert(() =>
    commands.get().length === 3 &&
    wb.startingSessions.length === 1 &&
    wb.startingSessions[0]?.commandId === lastCommand(commands.get())?.id &&
    starts.get().length === 1 &&
    startDisabled(wb[UI])
  );
  const action_withdraw = action(() => {
    clickInRow(wb[UI], "topic #7: Workbench topic", "Withdraw");
  });
  const assert_withdrawn = assert(() =>
    commands.get().length === 2 &&
    commands.get()[1] === "not a command" &&
    wb.startingSessions.length === 0 &&
    starts.get().length === 0 &&
    wb.attachedSessions.length === 1 &&
    wb.startBlocker === ""
  );

  // With no queue bound, a start records nothing as attached: it stays
  // starting, and Withdraw clears it with nothing to take back.
  const action_start_without_queue = action(() => {
    noQueue.spawnPrompt.set("Start without a queue.");
    noQueue.startSession.send();
  });
  const assert_start_without_queue_pending = assert(() =>
    noQueue.attachedSessions.length === 0 &&
    noQueue.startingSessions.length === 1 &&
    noQueueStarts.get().length === 1 &&
    noQueue.spawnPrompt.get() === "" &&
    noQueue.startBlocker.startsWith('Starting "topic #7: Workbench topic"')
  );
  const action_withdraw_without_queue = action(() => {
    clickInRow(noQueue[UI], "topic #7: Workbench topic", "Withdraw");
  });
  const assert_withdrawn_without_queue = assert(() =>
    noQueue.startingSessions.length === 0 &&
    noQueueStarts.get().length === 0 &&
    noQueue.startBlocker === ""
  );

  // A start through the Codex source sends nothing: its driver cannot start
  // a session, so the picker never offered it, Start is disabled with the
  // reason, and the handler refuses it.
  const action_start_codex = action(() => {
    wb.spawnSource.set("codex");
    wb.startSession.send();
  });
  const assert_codex_start_refused = assert(() =>
    commands.get().length === 2 &&
    wb.attachedSessions.length === 1 &&
    wb.startBlocker ===
      "codex is not a harness this Mac runs; pick one that is." &&
    startDisabled(wb[UI]) &&
    hasText(wb[UI], "codex is not a harness this Mac runs")
  );

  // A start carries the configured mode, and the caption names it; a harness
  // shown without a source behind it is listed, and picking it blocks Start
  // with the reason, so a start through it sends nothing.
  const action_start_with_mode = action(() => {
    shown.startSession.send();
  });
  const assert_started_with_mode = assert(() =>
    shownCommands.get().length === 1 &&
    firstCommand(shownCommands.get())?.payload?.mode === "acceptEdits" &&
    hasText(shown[UI], 'runs under the "acceptEdits" permission mode')
  );
  const action_start_shown = action(() => {
    shown.spawnSource.set("gemini");
    shown.startSession.send();
  });
  const assert_shown_is_inert = assert(() =>
    JSON.stringify(
      propValue(findNodeByProp(shown[UI], "data-harness", ""), "items"),
    ).includes('"gemini  (gemini-cli, not on this Mac)"') &&
    shownCommands.get().length === 1 &&
    shown.startBlocker ===
      "gemini is not a harness this Mac runs; pick one that is." &&
    startDisabled(shown[UI])
  );

  // The rail's buttons write the same record the verbs do: Attach on a recent
  // row attaches it and takes it out of the rail, Detach puts it back.
  const action_click_attach = action(() => {
    clickInRow(wb[UI], "something unrelated", "Attach");
  });
  const assert_clicked_attached = assert(() =>
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions.some((row) =>
      row.nativeSessionId === "bbb" && row.title === "something unrelated"
    ) &&
    wb.recentSessions.every((row) => row.nativeSessionId !== "bbb")
  );
  const action_click_detach = action(() => {
    clickInRow(wb[UI], "something unrelated", "Detach");
  });
  const assert_clicked_detached = assert(() =>
    wb.attachedSessions.length === 1 &&
    wb.recentSessions.some((row) => row.nativeSessionId === "bbb")
  );

  // "Add the topic's words" appends the default sentence to what the person
  // typed rather than replacing it (the earlier words went with the start,
  // so they are typed again here).
  const action_click_topic_words = action(() => {
    wb.spawnPrompt.set("Work on topic #7, it's time.");
    clickButton(wb[UI], "Add the topic's words");
  });
  const assert_topic_words_appended = assert(() =>
    wb.kickoff.startsWith(
      'Work on topic #7, it\'s time.\n\nWork on topic #7, "Workbench topic".\n\nContext:',
    )
  );

  // A desktop start: the caption says where the session opens and names no
  // permission mode; the command carries the surface and no mode; the start
  // waits as starting until the app's session, made under its own id and
  // naming the start's, confirms it, and then the session is attached under
  // its own id. Detach on the row drops the start's record; so does the
  // detach verb given the session's own id.
  const assert_desktop_note = assert(() =>
    desk.startBlocker === "" &&
    hasText(desk[UI], "Opens Claude Code on this Mac with the kickoff ready") &&
    !hasText(desk[UI], "permission mode")
  );
  const action_desktop_start = action(() => {
    desk.spawnRoot.set("/w/labs");
    desk.spawnPrompt.set("Open it in the app.");
    desk.startSession.send();
  });
  const assert_desktop_started = assert(() =>
    deskCommands.get().length === 1 &&
    firstCommand(deskCommands.get())?.payload?.surface === "desktop" &&
    firstCommand(deskCommands.get())?.payload?.mode === undefined &&
    firstCommand(deskCommands.get())?.payload?.cwd === "/w/labs" &&
    (firstCommand(deskCommands.get())?.payload?.text ?? "").startsWith(
      "Open it in the app.",
    ) &&
    desk.startingSessions.length === 1 &&
    desk.attachedSessions.length === 0 &&
    hasText(desk[UI], "sent to Claude Code on this Mac")
  );
  const action_desktop_confirm = action(() => {
    const started = firstCommand(deskCommands.get())?.nativeSessionId ?? "";
    const current = desktopIndex.get();
    desktopIndex.set({
      ...current,
      sessions: [...current.sessions, appMade("app-made-1", started)],
    });
  });
  const assert_desktop_confirmed = assert(() =>
    desk.startingSessions.length === 0 &&
    desk.attachedSessions.length === 1 &&
    desk.attachedSessions[0]?.nativeSessionId === "app-made-1" &&
    desk.attachedSessions[0]?.startedAs ===
      firstCommand(deskCommands.get())?.nativeSessionId &&
    desk.attachedSessions[0]?.gitBranch === "main" &&
    desk.recentSessions.every((row) => row.nativeSessionId !== "app-made-1") &&
    desk.startBlocker === ""
  );
  const action_desktop_detach = action(() => {
    clickInRow(desk[UI], "topic #7: Workbench topic", "Detach");
  });
  const assert_desktop_detached = assert(() =>
    desk.attachedSessions.length === 0 &&
    deskStarts.get().length === 0 &&
    desk.recentSessions.some((row) => row.nativeSessionId === "app-made-1")
  );
  const action_desktop_start_again = action(() => {
    desk.spawnPrompt.set("Once more.");
    desk.startSession.send();
  });
  const assert_desktop_started_again = assert(() =>
    deskCommands.get().length === 2 && desk.startingSessions.length === 1
  );
  const action_desktop_confirm_again = action(() => {
    const started = lastCommand(deskCommands.get())?.nativeSessionId ?? "";
    const current = desktopIndex.get();
    desktopIndex.set({
      ...current,
      sessions: [...current.sessions, appMade("app-made-2", started)],
    });
  });
  const assert_desktop_confirmed_again = assert(() =>
    desk.startingSessions.length === 0 &&
    desk.attachedSessions.length === 1 &&
    desk.attachedSessions[0]?.nativeSessionId === "app-made-2"
  );
  // The index marks the app's session deleted: the row shows from the
  // start's record, naming no start of its own, and Detach on it still finds
  // the start through the index's pairings and drops the record, so the
  // session does not come straight back as a confirmed start.
  const action_desktop_delete_row = action(() => {
    // The deleted row is built from plain data: spreading the stored row
    // would carry only the fields its view had materialized.
    const started = lastCommand(deskCommands.get())?.nativeSessionId ?? "";
    const current = desktopIndex.get();
    desktopIndex.set({
      ...current,
      sessions: current.sessions.map((s) =>
        s && s.nativeSessionId === "app-made-2"
          ? {
            ...appMade("app-made-2", started),
            syncStatus: "deleted" as const,
          }
          : s
      ),
    });
  });
  const assert_desktop_deleted_still_attached = assert(() =>
    desk.attachedSessions.length === 1 &&
    desk.attachedSessions[0]?.nativeSessionId === "app-made-2" &&
    desk.attachedSessions[0]?.startedAs === ""
  );
  const action_desktop_detach_deleted = action(() => {
    clickInRow(desk[UI], "topic #7: Workbench topic", "Detach");
  });
  const assert_desktop_deleted_detached = assert(() =>
    desk.attachedSessions.length === 0 && deskStarts.get().length === 0
  );
  // A third start, confirmed, is dropped by the detach verb given the
  // session's own id.
  const action_desktop_start_third = action(() => {
    desk.spawnPrompt.set("A third time.");
    desk.startSession.send();
  });
  const action_desktop_confirm_third = action(() => {
    const started = lastCommand(deskCommands.get())?.nativeSessionId ?? "";
    const current = desktopIndex.get();
    desktopIndex.set({
      ...current,
      sessions: [...current.sessions, appMade("app-made-3", started)],
    });
  });
  const assert_desktop_confirmed_third = assert(() =>
    desk.startingSessions.length === 0 &&
    desk.attachedSessions.length === 1 &&
    desk.attachedSessions[0]?.nativeSessionId === "app-made-3"
  );
  const action_desktop_detach_verb = action(() => {
    desk.detach.send({ sourceId: "claude", nativeSessionId: "app-made-3" });
  });
  const assert_desktop_verb_detached = assert(() =>
    desk.attachedSessions.length === 0 && deskStarts.get().length === 0
  );
  // Over a source that cannot open the app, a desktop start is blocked.
  const assert_desktop_blocked = assert(() =>
    deskBlocked.startBlocker ===
      "claude cannot open a session in Claude Code on this Mac; pick a harness that can, or start headlessly." &&
    startDisabled(deskBlocked[UI])
  );

  // The join key keeps `("a/b", "c")` apart from `("a", "b/c")`, and an
  // attach spelled with the source's casing and padding the connector
  // normalizes away joins the row all the same, under one record.
  const action_attach_keys = action(() => {
    keys.attach.send({ sourceId: "a/b", nativeSessionId: "c" });
    keys.attach.send({ sourceId: " CLAUDE ", nativeSessionId: "aaa" });
  });
  const assert_keys_distinct = assert(() =>
    keys.attachedSessions.length === 2 &&
    keys.attachedSessions.some((row) =>
      row.sourceId === "a/b" && row.nativeSessionId === "c" &&
      row.title === "topic #7: Workbench topic"
    ) &&
    keys.attachedSessions.some((row) =>
      row.sourceId === "claude" && row.nativeSessionId === "aaa" &&
      row.title === "topic #7: Workbench topic"
    ) &&
    keys.recentSessions.length === 1 &&
    keys.recentSessions[0]?.sourceId === "a" &&
    keys.recentSessions[0]?.nativeSessionId === "b/c" &&
    keysAttached.get().length === 2
  );
  const action_detach_keys = action(() => {
    keys.detach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_keys_detached = assert(() =>
    keys.attachedSessions.length === 1 &&
    keys.attachedSessions[0]?.sourceId === "a/b" &&
    keys.recentSessions.length === 2
  );

  // A verb call without both ids is refused and changes nothing.
  const action_attach_without_ids = action(() => {
    wb.attach.send({ sourceId: "", nativeSessionId: "" });
  });
  const assert_attach_refused = assert(() => wb.attachedSessions.length === 1);

  return {
    [NAME]: "Topic workbench test",
    [UI]: wb[UI],
    // The refused attach above throws inside the verb, which the runner
    // reports as a runtime error; exactly one is expected.
    expectRuntimeErrors: 1,
    [TESTS]: [
      { assertion: assert_header },
      { assertion: assert_harnesses_and_links },
      { render: wb[UI] },
      { action: action_start_blocked },
      { render: bare[UI] },
      { render: codexOnly[UI] },
      { render: blank[UI] },
      { render: recentBucket[UI] },
      { assertion: assert_start_blocked },
      { action: action_attach },
      { assertion: assert_attached },
      { action: action_attach_again },
      { assertion: assert_attach_idempotent },
      { action: action_attach_unknown },
      { assertion: assert_unknown_kept },
      { render: wb[UI] },
      { action: action_detach },
      { assertion: assert_detached },
      { action: action_reattach },
      { assertion: assert_reattached_fresh },
      { action: action_detach_again },
      { assertion: assert_detached_again },
      { action: action_compose_spawn },
      { assertion: assert_spawn_command },
      { action: action_start },
      { assertion: assert_start_command },
      { render: wb[UI] },
      { assertion: assert_start_pending },
      { action: action_start_twice },
      { assertion: assert_start_once },
      { action: action_confirm_start },
      { assertion: assert_start_attached },
      { render: wb[UI] },
      { assertion: assert_start_enabled_again },
      { action: action_delete_started },
      { assertion: assert_deleted_still_attached },
      { action: action_attach_started },
      { assertion: assert_started_attached_once },
      { render: wb[UI] },
      { action: action_detach_started },
      { assertion: assert_started_detached },
      { action: action_start_again },
      { render: wb[UI] },
      { assertion: assert_second_start_pending },
      { action: action_withdraw },
      { assertion: assert_withdrawn },
      { action: action_start_without_queue },
      { assertion: assert_start_without_queue_pending },
      { render: noQueue[UI] },
      { action: action_withdraw_without_queue },
      { assertion: assert_withdrawn_without_queue },
      { action: action_start_codex },
      { render: wb[UI] },
      { assertion: assert_codex_start_refused },
      { action: action_start_with_mode },
      { render: shown[UI] },
      { assertion: assert_started_with_mode },
      { action: action_start_shown },
      { render: shown[UI] },
      { assertion: assert_shown_is_inert },
      { action: action_click_attach },
      { assertion: assert_clicked_attached },
      { action: action_click_detach },
      { assertion: assert_clicked_detached },
      { action: action_click_topic_words },
      { assertion: assert_topic_words_appended },
      { render: desk[UI] },
      { assertion: assert_desktop_note },
      { action: action_desktop_start },
      { render: desk[UI] },
      { assertion: assert_desktop_started },
      { action: action_desktop_confirm },
      { assertion: assert_desktop_confirmed },
      { render: desk[UI] },
      { action: action_desktop_detach },
      { assertion: assert_desktop_detached },
      { action: action_desktop_start_again },
      { assertion: assert_desktop_started_again },
      { action: action_desktop_confirm_again },
      { assertion: assert_desktop_confirmed_again },
      { action: action_desktop_delete_row },
      { assertion: assert_desktop_deleted_still_attached },
      { render: desk[UI] },
      { action: action_desktop_detach_deleted },
      { assertion: assert_desktop_deleted_detached },
      { action: action_desktop_start_third },
      { action: action_desktop_confirm_third },
      { assertion: assert_desktop_confirmed_third },
      { action: action_desktop_detach_verb },
      { assertion: assert_desktop_verb_detached },
      { render: deskBlocked[UI] },
      { assertion: assert_desktop_blocked },
      { action: action_attach_keys },
      { assertion: assert_keys_distinct },
      { action: action_detach_keys },
      { assertion: assert_keys_detached },
      { action: action_attach_without_ids },
      { assertion: assert_attach_refused },
    ],
  };
});
