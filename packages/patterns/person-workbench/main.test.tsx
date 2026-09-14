/**
 * Pattern test for the person workbench: the person's workstreams come from
 * the snapshot by login, each carrying its topics, pull requests, and counts;
 * attach records a session under the picked workstream; the kickoff carries
 * the workstream's context and links; a start sends the connector one
 * `start` command titled after the workstream and attaches its session there;
 * the rail's own buttons attach a session under the picked workstream and
 * take it back out; a second attach records nothing; the detach verb removes
 * a session; a snapshot with no workstreams gives nothing to start; a verb
 * call without both ids is refused; a name the snapshot does not carry shows
 * no workstreams rather than everyone's; a start is pending until the index
 * carries its session (with no queue it stays pending and can be dismissed);
 * the workstream picker steers the kickoff, the start, and the rail's
 * Attach; and an attachment whose workstream a later snapshot drops keeps a
 * place with Detach.
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
  childNodes,
  findNode,
  hasExactText,
  hasText,
  propsOf,
  propValue,
} from "../test/vnode-helpers.ts";
import type {
  Attachment,
  CommandValue,
  PendingStart,
  SessionIndexView,
  StartableSourcesView,
} from "../topic-workbench/main.tsx";
import PersonWorkbench, { type SnapshotView } from "./main.tsx";

type ClickStream = { send: (event: Record<string, never>) => void };

const isButton = (label: string) => (candidate: unknown): boolean =>
  propsOf(candidate)?.onClick !== undefined &&
  hasExactText(candidate, label);

/** The innermost node the predicate accepts: the row itself rather than
 * every container that also carries the row's text. */
const innermost = (
  node: unknown,
  accept: (node: unknown) => boolean,
): unknown => {
  for (const child of childNodes(node)) {
    const hit = innermost(child, accept);
    if (hit !== undefined) return hit;
  }
  return accept(node) ? node : undefined;
};

/** Click the button labelled `label` in the row whose text carries `rowText`. */
const clickInRow = (root: unknown, rowText: string, label: string): void => {
  const row = innermost(
    root,
    (candidate) =>
      hasText(candidate, rowText) &&
      findNode(candidate, isButton(label)) !== undefined,
  );
  const onClick = propsOf(findNode(row, isButton(label)))?.onClick;
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as ClickStream).send({});
  }
};

/** The first queued command, decoded; `null` when the queue is empty. */
// deno-lint-ignore no-explicit-any
const firstCommand = (queued: readonly CommandValue[]): any =>
  JSON.parse(queued[0] ?? "null");

export default pattern(() => {
  const snapshot = new Writable<SnapshotView>({
    repository: "commontoolsinc/labs",
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
  });
  const index = new Writable<SessionIndexView & StartableSourcesView>({
    schema: "commonfabric.agent-connector.session-index",
    ownerDid: "did:key:owner",
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
  const pendingStarts = new Writable<PendingStart[] | Default<[]>>([]);
  const wb = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: index,
    attached,
    commands,
    pendingStarts,
  });
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
    wb.workstreams[0]?.openCount === 1 &&
    wb.workstreams[0]?.mergedCount === 1 &&
    wb.workstreams[0]?.sessions.length === 0 &&
    wb.recentSessions.length === 2
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
    firstCommand(commands.get())?.payload?.text === wb.kickoff &&
    wb.workstreams[0]?.sessions.length === 1 &&
    wb.pendingStarts.length === 1 &&
    wb.pendingStarts[0]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    wb.pendingStarts[0]?.workstreamId === "board-load" &&
    attached.get().length === 1 &&
    hasText(wb[UI], "Starting · 1")
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
    wb.pendingStarts.length === 0 &&
    wb.workstreams[0]?.sessions.length === 2 &&
    wb.workstreams[0]?.sessions.some((s) =>
      s.nativeSessionId === firstCommand(commands.get())?.nativeSessionId &&
      s.gitBranch === "main"
    ) &&
    wb.recentSessions.every((row) =>
      row.nativeSessionId !== firstCommand(commands.get())?.nativeSessionId
    )
  );

  // With no queue bound, a start records nothing as attached: it stays
  // pending, and Dismiss clears it.
  const noQueuePending = new Writable<PendingStart[] | Default<[]>>([]);
  const noQueue = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    pendingStarts: noQueuePending,
  });
  const action_start_without_queue = action(() => {
    noQueue.spawnPrompt.set("Start without a queue.");
    noQueue.startSession.send();
  });
  const assert_start_without_queue_pending = assert(() =>
    noQueue.workstreams[0]?.sessions.length === 0 &&
    noQueue.pendingStarts.length === 1 &&
    noQueuePending.get().length === 1
  );
  const action_dismiss_start = action(() => {
    clickInRow(noQueue[UI], "Board-load performance", "Dismiss");
  });
  const assert_start_dismissed = assert(() =>
    noQueue.pendingStarts.length === 0 && noQueuePending.get().length === 0
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
    pendingStarts: new Writable<PendingStart[] | Default<[]>>([]),
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
    picker.pendingStarts[0]?.workstreamId === "cfc-dials" &&
    pickerAttached.get().find((a) => a.nativeSessionId === "aaa")
        ?.workstreamId === "cfc-dials" &&
    picker.workstreams[1]?.sessions.length === 1
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
    pendingStarts: new Writable<PendingStart[] | Default<[]>>([]),
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

  // The rail's Attach button files the session under the picked workstream
  // (the first card when none is picked); Detach on the card's row takes it
  // back out.
  const action_click_attach = action(() => {
    clickInRow(wb[UI], "something for later", "Attach");
  });
  const assert_clicked_attached = assert(() =>
    wb.workstreams[0]?.sessions.length === 3 &&
    wb.workstreams[0]?.sessions.some((s) => s.nativeSessionId === "bbb") &&
    wb.recentSessions.length === 0
  );
  const action_click_detach = action(() => {
    clickInRow(wb[UI], "something for later", "Detach");
  });
  const assert_clicked_detached = assert(() =>
    wb.workstreams[0]?.sessions.length === 2 &&
    wb.recentSessions.length === 1 &&
    wb.recentSessions[0]?.nativeSessionId === "bbb"
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
    wb.workstreams[0]?.sessions.length === 2
  );
  const action_detach = action(() => {
    wb.detach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_detached = assert(() =>
    wb.workstreams[0]?.sessions.length === 1 &&
    wb.recentSessions.length === 2
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
    nobody.workstreams.length === 0 && nobodysCommands.get().length === 0
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
    wb.workstreams[0]?.sessions.length === 1
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
      { action: action_confirm_start },
      { assertion: assert_start_confirmed },
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
      { assertion: assert_attach_without_card_refused },
      { action: action_attach_stale_pick },
      { assertion: assert_stale_pick_resolved },
      { action: action_attach_unknown_workstream },
      { assertion: assert_unknown_workstream_refused },
      { action: action_start_without_queue },
      { assertion: assert_start_without_queue_pending },
      { render: noQueue[UI] },
      { action: action_dismiss_start },
      { assertion: assert_start_dismissed },
      { action: action_pick_second },
      { assertion: assert_picked_second },
      { action: action_attach_under_b },
      { assertion: assert_attached_under_b },
      { action: action_drop_workstream_b },
      { render: orphan[UI] },
      { assertion: assert_orphaned_with_detach },
      { action: action_detach_orphan },
      { assertion: assert_orphan_detached },
    ],
  };
});
