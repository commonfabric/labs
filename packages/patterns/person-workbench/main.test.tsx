/**
 * Pattern test for the person workbench: the person's workstreams come from
 * the snapshot by login, each carrying its topics, pull requests, and counts
 * (a draft pull request counts as open); attach records a session under the
 * picked workstream and returns whether the record was new; the kickoff
 * carries the workstream's context and links; a start sends the connector one
 * `start` command titled after the workstream and records it until the index
 * carries its session, which then joins the workstream; Detach on a started
 * session drops its record (a second click while the start is unconfirmed
 * sends nothing, the words a start sent clear from the composer, and Start is
 * free again once the index confirms the session or the start is withdrawn;
 * a pending start blocks only its own workstream); a second start is
 * withdrawn, taking its command out of the queue; the rail's own buttons attach a session under the picked
 * workstream and take it back out, and a disabled Attach records nothing;
 * a second attach records nothing; the detach verb removes a session; a
 * snapshot with no workstreams leaves Start disabled with its reason; a verb
 * call without both ids is refused; a name the snapshot does not carry shows
 * no workstreams rather than everyone's; with no queue a start stays starting
 * and can be withdrawn; the workstream picker steers the kickoff, the start,
 * and the rail's Attach; an attachment whose workstream a later snapshot
 * drops, or that names none, keeps a place with Detach; an index that is
 * not the complete bucket is called out; and a desktop start sends the
 * surface and no mode, joins its workstream through the session the app
 * makes under an id of its own that names the start's as `startedAs`, drops
 * its record on Detach by row or by verb, and is blocked with the reason over
 * a source that cannot open the app.
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
import {
  WORK_SNAPSHOT_SCHEMA,
  type WorkSnapshot,
} from "../work-snapshot/main.tsx";
import PersonWorkbench, { type SnapshotView } from "./main.tsx";

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
  title: "Board-load performance",
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

// The snapshot as the work-snapshot piece publishes it, fields this piece
// does not read included; the dashboard reads it through its own view.
const SNAPSHOT: WorkSnapshot = {
  schema: WORK_SNAPSHOT_SCHEMA,
  repository: "commontoolsinc/labs",
  window: { since: "2026-08-28", until: "2026-09-11" },
  generatedAt: "2026-09-11T20:00:00.000Z",
  people: [
    { name: "Berni", login: "seefeldb" },
    { name: "Gideon", login: "mathpirate" },
  ],
  workstreams: [
    {
      id: "board-load",
      name: "Board-load performance",
      summary: "Making the Topics board fast enough to live in.",
      people: ["seefeldb", "mathpirate"],
      topics: [{
        title: "Board-load pre-sync follow-ups",
        url: "https://estuary.example/of:fid1:topic",
        summary: "The board loads in 4.5 s; the residual is naming waves.",
        lastActivityAt: 1_700_000_000_000,
      }, {
        // Stored by a producer without the snapshot's guard: text, no anchor.
        title: "Legacy topic",
        url: "javascript:alert(1)",
      }],
      prs: [
        {
          repo: "commontoolsinc/labs",
          number: 6844,
          title: "Flip the server-execution default back to ON",
          state: "open",
          url: "https://github.com/commontoolsinc/labs/pull/6844",
          updatedAt: "2026-09-08T00:00:00.000Z",
        },
        {
          repo: "commontoolsinc/labs",
          number: 6785,
          title: "keep a corpus's decoded documents resident",
          state: "merged",
          url: "https://github.com/commontoolsinc/labs/pull/6785",
          updatedAt: "2026-09-03T00:00:00.000Z",
          mergedAt: "2026-09-03T00:00:00.000Z",
        },
        {
          repo: "commontoolsinc/labs",
          number: 1,
          title: "Legacy pull",
          state: "closed",
          url: "javascript:alert(2)",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          repo: "commontoolsinc/labs",
          number: 6900,
          title: "A draft, counted as open",
          state: "draft",
          url: "https://github.com/commontoolsinc/labs/pull/6900",
          updatedAt: "2026-09-09T00:00:00.000Z",
        },
      ],
    },
    {
      id: "cfc-dials",
      name: "CFC dials",
      summary: "Turning the dials on by default.",
      people: ["mathpirate"],
      topics: [],
      prs: [],
    },
  ],
};

export default pattern(() => {
  const snapshot = new Writable<SnapshotView>(SNAPSHOT);
  const index = new Writable<IndexFixture>({
    schema: "commonfabric.agent-connector.session-index",
    ownerDid: "did:key:owner",
    bucket: "all",
    sources: [{
      id: "claude",
      driver: "claude-agent-sdk",
      capabilities: { startSession: true },
    }],
    sessions: [{
      sourceId: "claude",
      nativeSessionId: "aaa",
      title: "an earlier session",
      cwd: "/w/labs",
      gitRepo: null,
      gitBranch: "main",
      gitWorktreeRoot: null,
      updatedAt: "2026-09-08T10:00:00.000Z",
      active: false,
      archived: false,
      syncStatus: "complete",
    }, {
      sourceId: "claude",
      nativeSessionId: "bbb",
      title: "something for later",
      cwd: "/w/labs",
      gitRepo: null,
      gitBranch: "feature",
      gitWorktreeRoot: null,
      updatedAt: "2026-09-08T11:00:00.000Z",
      active: false,
      archived: false,
      syncStatus: "complete",
    }],
    checkouts: [{ root: "/w/labs", branch: "main" }],
  });
  const attached = new Writable<Attachment[] | Default<[]>>([]);
  const commands = new Writable<CommandValue[] | Default<[]>>([]);
  const starts = new Writable<SessionStart[] | Default<[]>>([]);
  const wb = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: index,
    attached,
    commands,
    starts,
  });
  // A desktop start: the connector opens Claude Code on this Mac with the
  // kickoff ready to send; the session the app makes carries the start's id
  // as `startedAs` and its own id everywhere else.
  const desktopIndex = new Writable<IndexFixture>({
    schema: "commonfabric.agent-connector.session-index",
    ownerDid: "did:key:owner",
    bucket: "all",
    sources: [{
      id: "claude",
      driver: "claude-agent-sdk",
      capabilities: { startSession: true, surfaces: ["headless", "desktop"] },
    }],
    sessions: [],
    checkouts: [{ root: "/w/labs", branch: "main" }],
  });
  const deskCommands = new Writable<CommandValue[] | Default<[]>>([]);
  const deskStarts = new Writable<SessionStart[] | Default<[]>>([]);
  const desk = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: desktopIndex,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    commands: deskCommands,
    starts: deskStarts,
    startMode: "acceptEdits",
    startSurface: "desktop",
  });
  const deskBlocked = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: index,
    startSurface: "desktop",
  });
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
    firstCommand(deskCommands.get())?.payload?.title ===
      "Board-load performance" &&
    desk.startingSessions.length === 1 &&
    desk.startingSessions[0]?.workstreamId === "board-load" &&
    desk.workstreams[0]?.sessions.length === 0 &&
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
    desk.workstreams[0]?.sessions.length === 1 &&
    desk.workstreams[0]?.sessions[0]?.nativeSessionId === "app-made-1" &&
    desk.workstreams[0]?.sessions[0]?.startedAs ===
      firstCommand(deskCommands.get())?.nativeSessionId &&
    desk.recentSessions.every((row) => row.nativeSessionId !== "app-made-1") &&
    desk.startBlocker === ""
  );
  const action_desktop_detach = action(() => {
    clickInRow(desk[UI], "Board-load performance", "Detach");
  });
  const assert_desktop_detached = assert(() =>
    desk.workstreams[0]?.sessions.length === 0 &&
    deskStarts.get().length === 0 &&
    desk.recentSessions.some((row) => row.nativeSessionId === "app-made-1")
  );
  const action_desktop_start_again = action(() => {
    desk.spawnPrompt.set("Once more.");
    desk.startSession.send();
  });
  const action_desktop_confirm_again = action(() => {
    const started = lastCommand(deskCommands.get())?.nativeSessionId ?? "";
    const current = desktopIndex.get();
    desktopIndex.set({
      ...current,
      sessions: [...current.sessions, appMade("app-made-2", started)],
    });
  });
  const assert_desktop_confirmed_again = assert(() =>
    deskCommands.get().length === 2 &&
    desk.startingSessions.length === 0 &&
    desk.workstreams[0]?.sessions.length === 1 &&
    desk.workstreams[0]?.sessions[0]?.nativeSessionId === "app-made-2"
  );
  const action_desktop_detach_verb = action(() => {
    desk.detach.send({ sourceId: "claude", nativeSessionId: "app-made-2" });
  });
  const assert_desktop_verb_detached = assert(() =>
    desk.workstreams[0]?.sessions.length === 0 &&
    deskStarts.get().length === 0
  );
  const assert_desktop_blocked = assert(() =>
    deskBlocked.startBlocker ===
      "claude cannot open a session in Claude Code on this Mac; pick a harness that can, or start headlessly." &&
    startDisabled(deskBlocked[UI])
  );
  // A name the snapshot's people do not carry: nothing shows, not everything.
  const stranger = PersonWorkbench({
    snapshot,
    person: "nobody",
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    commands: new Writable<CommandValue[] | Default<[]>>([]),
  });
  const assert_stranger = assert(() =>
    stranger.personName === "nobody" && stranger.workstreams.length === 0 &&
    hasText(
      stranger[UI],
      "No one named nobody is in the current snapshot.",
    )
  );

  // A stored link that is not http(s) renders as text with no anchor, and
  // the kickoff does not repeat it.
  const assert_links_safe = assert(() =>
    findNode(
        wb[UI],
        (node) =>
          propValue(node, "href") === "javascript:alert(1)" ||
          propValue(node, "href") === "javascript:alert(2)",
      ) === undefined &&
    hasText(wb[UI], "Legacy topic") && hasText(wb[UI], "Legacy pull") &&
    !wb.kickoff.includes("javascript:")
  );

  const assert_person = assert(() =>
    wb[NAME] === "Berni's work" &&
    wb.personName === "Berni" &&
    wb.workstreams.length === 1 &&
    wb.workstreams[0]?.id === "board-load" &&
    wb.workstreams[0]?.openCount === 2 &&
    wb.workstreams[0]?.mergedCount === 1 &&
    wb.workstreams[0]?.sessions.length === 0 &&
    wb.recentSessions.length === 2 &&
    wb.startBlocker === "" &&
    !startDisabled(wb[UI]) &&
    findNodeByProp(wb[UI], "data-index-note", "") === undefined
  );

  const action_attach = action(() => {
    wb.attach.send({
      sourceId: "claude",
      nativeSessionId: "aaa",
      workstreamId: "board-load",
    });
  });
  const assert_attached = assert(() =>
    wb.workstreams[0]?.sessions.length === 1 &&
    wb.workstreams[0]?.sessions[0]?.title === "an earlier session" &&
    wb.recentSessions.length === 1 &&
    wb.recentSessions[0]?.nativeSessionId === "bbb"
  );

  const action_compose = action(() => {
    wb.spawnPrompt.set("Re-run the pinned ablation.");
    wb.spawnRoot.set("/w/labs");
  });
  const assert_kickoff = assert(() =>
    wb.kickoff.startsWith(
      'Re-run the pinned ablation.\n\nContext:\n- Workstream "Board-load performance": Making the Topics board fast enough to live in.',
    ) &&
    wb.kickoff.includes(
      '- Topic "Board-load pre-sync follow-ups": The board loads',
    ) &&
    wb.kickoff.includes(
      '- PR #6844, "Flip the server-execution default back to ON", open',
    ) &&
    wb.kickoff.includes('- PR #6900, "A draft, counted as open", draft') &&
    !wb.kickoff.includes("#6785") &&
    wb.kickoff.includes(
      "Links:\n- https://estuary.example/of:fid1:topic\n- https://github.com/commontoolsinc/labs/pull/6844",
    )
  );

  // A start sends the command and records a pending start for the picked
  // workstream; nothing is attached until the index carries the session.
  const action_start = action(() => {
    wb.startSession.send();
  });
  const assert_started = assert(() =>
    commands.get().length === 1 &&
    firstCommand(commands.get())?.type === "start" &&
    firstCommand(commands.get())?.ownerDid === "did:key:owner" &&
    firstCommand(commands.get())?.sourceId === "claude" &&
    firstCommand(commands.get())?.payload?.cwd === "/w/labs" &&
    firstCommand(commands.get())?.payload?.title === "Board-load performance" &&
    (firstCommand(commands.get())?.payload?.text ?? "").startsWith(
      "Re-run the pinned ablation.",
    ) &&
    wb.workstreams[0]?.sessions.length === 1 &&
    wb.startingSessions.length === 1 &&
    wb.startingSessions[0]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    wb.startingSessions[0]?.workstreamId === "board-load" &&
    attached.get().length === 1 &&
    hasText(wb[UI], "Starting · 1") &&
    // The composer answers at once: the sent words clear, and Start is
    // disabled with the start it waits on.
    wb.spawnPrompt.get() === "" &&
    wb.startBlocker.startsWith('Starting "Board-load performance"') &&
    startDisabled(wb[UI])
  );
  // A second click while the start is unconfirmed sends nothing: one start
  // at a time per workstream.
  const action_start_twice = action(() => {
    wb.startSession.send();
  });
  const assert_start_once = assert(() =>
    commands.get().length === 1 && starts.get().length === 1 &&
    wb.startingSessions.length === 1
  );
  // The connector publishes the session: the start joins the workstream.
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
          title: "Board-load performance",
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
  const assert_start_confirmed = assert(() =>
    wb.startingSessions.length === 0 &&
    wb.workstreams[0]?.sessions.length === 2 &&
    wb.workstreams[0]?.sessions.some((s) =>
      s.nativeSessionId === firstCommand(commands.get())?.nativeSessionId &&
      s.gitBranch === "main"
    ) &&
    wb.recentSessions.every((row) =>
      row.nativeSessionId !== firstCommand(commands.get())?.nativeSessionId
    ) &&
    wb.startBlocker === ""
  );

  // Detach on a started session, through its card's row, drops the start's
  // record as well.
  const action_detach_started = action(() => {
    clickInRow(wb[UI], "Board-load performance", "Detach");
  });
  const assert_started_detached = assert(() =>
    wb.workstreams[0]?.sessions.length === 1 &&
    wb.workstreams[0]?.sessions[0]?.nativeSessionId === "aaa" &&
    starts.get().length === 0
  );

  // A second start, withdrawn before the connector takes it: only its
  // command leaves the queue, and the record goes with it.
  const action_start_again = action(() => {
    wb.startSession.send();
  });
  const assert_second_start_pending = assert(() =>
    commands.get().length === 2 &&
    wb.startingSessions.length === 1 &&
    wb.startingSessions[0]?.commandId === lastCommand(commands.get())?.id &&
    hasText(wb[UI], "Withdraw takes the command out of the queue")
  );
  const action_withdraw = action(() => {
    clickInRow(wb[UI], "Board-load performance", "Withdraw");
  });
  const assert_withdrawn = assert(() =>
    commands.get().length === 1 &&
    firstCommand(commands.get())?.payload?.title ===
      "Board-load performance" &&
    wb.startingSessions.length === 0 &&
    starts.get().length === 0 &&
    wb.startBlocker === ""
  );

  // With no queue bound, a start records nothing as attached: it stays
  // starting, and Withdraw clears it with nothing to take back.
  const noQueueStarts = new Writable<SessionStart[] | Default<[]>>([]);
  const noQueue = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    starts: noQueueStarts,
  });
  const action_start_without_queue = action(() => {
    noQueue.spawnPrompt.set("Start without a queue.");
    noQueue.startSession.send();
  });
  const assert_start_without_queue_pending = assert(() =>
    noQueue.workstreams[0]?.sessions.length === 0 &&
    noQueue.startingSessions.length === 1 &&
    noQueueStarts.get().length === 1 &&
    noQueue.spawnPrompt.get() === "" &&
    noQueue.startBlocker.startsWith('Starting "Board-load performance"')
  );
  const action_withdraw_without_queue = action(() => {
    clickInRow(noQueue[UI], "Board-load performance", "Withdraw");
  });
  const assert_withdrawn_without_queue = assert(() =>
    noQueue.startingSessions.length === 0 &&
    noQueueStarts.get().length === 0 && noQueue.startBlocker === ""
  );

  // The workstream picker: a person with two workstreams picks the second,
  // and the kickoff, the start's title, and the rail's Attach follow it.
  const pickerAttached = new Writable<Attachment[] | Default<[]>>([]);
  const pickerCommands = new Writable<CommandValue[] | Default<[]>>([]);
  const picker = PersonWorkbench({
    snapshot,
    person: "mathpirate",
    sessions: index,
    attached: pickerAttached,
    commands: pickerCommands,
    starts: new Writable<SessionStart[] | Default<[]>>([]),
  });
  const action_pick_second = action(() => {
    picker.spawnWorkstream.set("cfc-dials");
    picker.startSession.send();
    clickInRow(picker[UI], "an earlier session", "Attach");
  });
  const assert_picked_second = assert(() =>
    picker.workstreams.length === 2 &&
    picker.kickoff.startsWith('Work on "CFC dials".') &&
    firstCommand(pickerCommands.get())?.payload?.title === "CFC dials" &&
    picker.startingSessions[0]?.workstreamId === "cfc-dials" &&
    pickerAttached.get().find((a) => a.nativeSessionId === "aaa")
        ?.workstreamId === "cfc-dials" &&
    picker.workstreams[1]?.sessions.length === 1
  );
  // One start at a time per workstream: with the CFC dials start unconfirmed,
  // the first workstream can still start, and the picked one says why not.
  const action_pick_first_while_pending = action(() => {
    picker.spawnWorkstream.set("board-load");
  });
  const assert_first_can_start = assert(() =>
    picker.startBlocker === "" && !startDisabled(picker[UI])
  );
  const action_pick_second_while_pending = action(() => {
    picker.spawnWorkstream.set("cfc-dials");
  });
  const assert_second_blocked = assert(() =>
    picker.startBlocker.startsWith('Starting "CFC dials"') &&
    startDisabled(picker[UI])
  );

  // An attachment whose workstream a later snapshot drops keeps a place of
  // its own, with Detach, rather than vanishing from every list.
  const orphanSnapshot = new Writable<SnapshotView>({
    repository: "commontoolsinc/labs",
    generatedAt: "2026-09-11T20:00:00.000Z",
    people: [{ name: "Gideon", login: "mathpirate" }],
    workstreams: ["a", "b"].map((id) => ({
      id,
      name: `Stream ${id}`,
      summary: "s",
      people: ["mathpirate"],
      topics: [],
      prs: [],
    })),
  });
  const orphanAttached = new Writable<Attachment[] | Default<[]>>([]);
  const orphan = PersonWorkbench({
    snapshot: orphanSnapshot,
    person: "mathpirate",
    sessions: index,
    attached: orphanAttached,
    commands: new Writable<CommandValue[] | Default<[]>>([]),
    starts: new Writable<SessionStart[] | Default<[]>>([]),
  });
  const action_attach_under_b = action(() => {
    orphan.attach.send({
      sourceId: "claude",
      nativeSessionId: "aaa",
      workstreamId: "b",
    });
  });
  const assert_attached_under_b = assert(() =>
    orphan.workstreams.length === 2 &&
    orphan.workstreams[1]?.sessions.length === 1 &&
    orphan.orphanedSessions.length === 0
  );
  const action_drop_workstream_b = action(() => {
    orphanSnapshot.set({
      ...orphanSnapshot.get(),
      generatedAt: "2026-09-12T06:00:00.000Z",
      workstreams: [{
        id: "a",
        name: "Stream a",
        summary: "s",
        people: ["mathpirate"],
        topics: [],
        prs: [],
      }],
    });
  });
  const assert_orphaned_with_detach = assert(() =>
    orphan.workstreams.length === 1 &&
    orphan.workstreams[0]?.sessions.length === 0 &&
    orphan.orphanedSessions.length === 1 &&
    orphan.orphanedSessions[0]?.nativeSessionId === "aaa" &&
    orphan.attachedSessions.length === 1 &&
    orphan.recentSessions.every((row) => row.nativeSessionId !== "aaa") &&
    hasText(orphan[UI], "Attached to work no longer shown")
  );
  const action_detach_orphan = action(() => {
    clickInRow(orphan[UI], "an earlier session", "Detach");
  });
  const assert_orphan_detached = assert(() =>
    orphan.orphanedSessions.length === 0 &&
    orphanAttached.get().length === 0 &&
    orphan.recentSessions.some((row) => row.nativeSessionId === "aaa")
  );
  // A record that names no workstream at all (written by another workbench
  // over the same record) is orphaned the same way.
  const action_seed_unfiled = action(() => {
    orphanAttached.set([{
      sourceId: "claude",
      nativeSessionId: "bbb",
      title: "filed nowhere",
      attachedAt: 1,
    }]);
  });
  const assert_unfiled_orphaned = assert(() =>
    orphan.orphanedSessions.length === 1 &&
    orphan.orphanedSessions[0]?.nativeSessionId === "bbb"
  );

  // The connector's recent bucket rather than its complete index earns a
  // caution beside the rail.
  const recentBucket = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: new Writable<IndexFixture>({
      schema: "commonfabric.agent-connector.session-index",
      ownerDid: "did:key:owner",
      bucket: "recent",
      sessions: [],
    }),
  });
  const assert_recent_bucket_noted = assert(() =>
    hasText(
      findNodeByProp(recentBucket[UI], "data-index-note", ""),
      "the connector's recent bucket",
    )
  );

  // The rail's Attach button files the session under the picked workstream
  // (the first card when none is picked); Detach on the card's row takes it
  // back out.
  const action_click_attach = action(() => {
    clickInRow(wb[UI], "something for later", "Attach");
  });
  const assert_clicked_attached = assert(() =>
    wb.workstreams[0]?.sessions.length === 2 &&
    wb.workstreams[0]?.sessions.some((s) => s.nativeSessionId === "bbb") &&
    // The detached start's session is the one row left in the rail.
    wb.recentSessions.length === 1 &&
    wb.recentSessions.every((row) => row.nativeSessionId !== "bbb")
  );
  const action_click_detach = action(() => {
    clickInRow(wb[UI], "something for later", "Detach");
  });
  const assert_clicked_detached = assert(() =>
    wb.workstreams[0]?.sessions.length === 1 &&
    wb.recentSessions.length === 2 &&
    wb.recentSessions.some((row) => row.nativeSessionId === "bbb")
  );

  // A second attach of the same session records nothing; the detach verb
  // removes it.
  const action_attach_again = action(() => {
    wb.attach.send({
      sourceId: "claude",
      nativeSessionId: "aaa",
      workstreamId: "board-load",
    });
  });
  const assert_attached_once = assert(() =>
    wb.workstreams[0]?.sessions.length === 1
  );
  const action_detach = action(() => {
    wb.detach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_detached = assert(() =>
    wb.workstreams[0]?.sessions.length === 0 &&
    wb.recentSessions.length === 3
  );

  // A snapshot with no workstreams gives the person no card to start from,
  // so a start sends nothing.
  const nobodysCommands = new Writable<CommandValue[] | Default<[]>>([]);
  const nobodysAttached = new Writable<Attachment[] | Default<[]>>([]);
  const nobody = PersonWorkbench({
    snapshot: new Writable<SnapshotView>({
      repository: "",
      generatedAt: "",
      people: [],
      workstreams: [],
    }),
    person: "nobody",
    sessions: index,
    attached: nobodysAttached,
    commands: nobodysCommands,
  });
  const action_start_without_card = action(() => {
    nobody.startSession.send();
  });
  const assert_nothing_started = assert(() =>
    nobody.workstreams.length === 0 && nobodysCommands.get().length === 0 &&
    nobody.startBlocker === "No workstream to start from." &&
    startDisabled(nobody[UI]) &&
    hasText(nobody[UI], "No workstream to start from.")
  );
  // With no workstream to file under, the rail's Attach is disabled and the
  // verb refuses: a record no card reaches would show nowhere.
  const action_attach_without_card = action(() => {
    nobody.attach.send({
      sourceId: "claude",
      nativeSessionId: "aaa",
      workstreamId: "board-load",
    });
  });
  const action_click_attach_without_card = action(() => {
    clickInRow(nobody[UI], "an earlier session", "Attach");
  });
  const assert_attach_without_card_refused = assert(() =>
    nobodysAttached.get().length === 0 &&
    propValue(findNode(nobody[UI], isButton("Attach")), "disabled") === true
  );

  // A stale pick names no visible workstream: the rail files the row under
  // the resolved card (the first), and the verb refuses the unknown id.
  const action_attach_stale_pick = action(() => {
    wb.spawnWorkstream.set("gone");
    clickInRow(wb[UI], "something for later", "Attach");
  });
  const assert_stale_pick_resolved = assert(() =>
    attached.get().find((a) => a.nativeSessionId === "bbb")?.workstreamId ===
      "board-load" &&
    wb.workstreams[0]?.sessions.some((s) => s.nativeSessionId === "bbb") ===
      true
  );
  const action_detach_stale_pick = action(() => {
    wb.detach.send({ sourceId: "claude", nativeSessionId: "bbb" });
  });
  const action_attach_unknown_workstream = action(() => {
    wb.attach.send({
      sourceId: "claude",
      nativeSessionId: "ccc",
      workstreamId: "gone",
    });
  });
  const assert_unknown_workstream_refused = assert(() =>
    attached.get().every((a) => a.nativeSessionId !== "ccc")
  );

  // A verb call without both ids is refused and changes nothing.
  const action_attach_without_ids = action(() => {
    wb.attach.send({
      sourceId: "",
      nativeSessionId: "",
      workstreamId: "board-load",
    });
  });
  const assert_attach_refused = assert(() =>
    wb.workstreams[0]?.sessions.length === 0
  );

  return {
    [NAME]: "Person workbench test",
    [UI]: wb[UI],
    // The three refused attaches above (no ids, no card, an unknown
    // workstream) each throw inside the verb, which the runner reports as
    // runtime errors; exactly three are expected.
    expectRuntimeErrors: 3,
    [TESTS]: [
      { assertion: assert_stranger },
      { assertion: assert_person },
      { render: wb[UI] },
      { assertion: assert_links_safe },
      { action: action_attach },
      { assertion: assert_attached },
      { action: action_compose },
      { assertion: assert_kickoff },
      { action: action_start },
      { assertion: assert_started },
      { action: action_start_twice },
      { assertion: assert_start_once },
      { action: action_confirm_start },
      { assertion: assert_start_confirmed },
      { render: wb[UI] },
      { action: action_detach_started },
      { assertion: assert_started_detached },
      { action: action_start_again },
      { render: wb[UI] },
      { assertion: assert_second_start_pending },
      { action: action_withdraw },
      { assertion: assert_withdrawn },
      { render: wb[UI] },
      { action: action_click_attach },
      { assertion: assert_clicked_attached },
      { render: wb[UI] },
      { action: action_click_detach },
      { assertion: assert_clicked_detached },
      { action: action_attach_again },
      { assertion: assert_attached_once },
      { action: action_detach },
      { assertion: assert_detached },
      { action: action_start_without_card },
      { assertion: assert_nothing_started },
      { action: action_attach_without_ids },
      { assertion: assert_attach_refused },
      { action: action_attach_without_card },
      { render: nobody[UI] },
      { action: action_click_attach_without_card },
      { assertion: assert_attach_without_card_refused },
      { action: action_attach_stale_pick },
      { assertion: assert_stale_pick_resolved },
      { action: action_detach_stale_pick },
      { action: action_attach_unknown_workstream },
      { assertion: assert_unknown_workstream_refused },
      { action: action_start_without_queue },
      { assertion: assert_start_without_queue_pending },
      { render: noQueue[UI] },
      { action: action_withdraw_without_queue },
      { assertion: assert_withdrawn_without_queue },
      { action: action_pick_second },
      { assertion: assert_picked_second },
      { action: action_pick_first_while_pending },
      { render: picker[UI] },
      { assertion: assert_first_can_start },
      { action: action_pick_second_while_pending },
      { render: picker[UI] },
      { assertion: assert_second_blocked },
      { action: action_attach_under_b },
      { assertion: assert_attached_under_b },
      { action: action_drop_workstream_b },
      { render: orphan[UI] },
      { assertion: assert_orphaned_with_detach },
      { action: action_detach_orphan },
      { assertion: assert_orphan_detached },
      { action: action_seed_unfiled },
      { assertion: assert_unfiled_orphaned },
      { render: recentBucket[UI] },
      { assertion: assert_recent_bucket_noted },
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
      { action: action_desktop_confirm_again },
      { assertion: assert_desktop_confirmed_again },
      { action: action_desktop_detach_verb },
      { assertion: assert_desktop_verb_detached },
      { render: deskBlocked[UI] },
      { assertion: assert_desktop_blocked },
    ],
  };
});
