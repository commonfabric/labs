/**
 * Pattern test for the person workbench: the person's workstreams come from
 * the snapshot by login, each carrying its topics, pull requests, and counts;
 * attach records a session under the picked workstream; the kickoff carries
 * the workstream's context and links; a start sends the connector one
 * `start` command titled after the workstream and attaches its session there;
 * the rail's own buttons attach a session under the picked workstream and
 * take it back out; a second attach records nothing; the detach verb removes
 * a session; a snapshot with no workstreams gives nothing to start; a verb
 * call without both ids is refused; and a name the snapshot does not carry
 * shows no workstreams rather than everyone's.
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
} from "../test/vnode-helpers.ts";
import type {
  Attachment,
  CommandValue,
  SessionIndexView,
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
  const index = new Writable<SessionIndexView>({
    schema: "commonfabric.agent-connector.session-index",
    ownerDid: "did:key:owner",
    sources: [{ id: "claude", driver: "claude-agent-sdk" }],
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
  const wb = PersonWorkbench({
    snapshot,
    person: "seefeldb",
    sessions: index,
    attached,
    commands,
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
    wb.workstreams[0]?.sessions.length === 2 &&
    wb.workstreams[0]?.sessions[1]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    attached.get()[1]?.workstreamId === "board-load"
  );

  // The rail's Attach button files the session under the picked workstream
  // (the first card when none is picked); Detach on the card's row takes it
  // back out.
  const action_click_attach = action(() => {
    clickInRow(wb[UI], "something for later", "Attach");
  });
  const assert_clicked_attached = assert(() =>
    wb.workstreams[0]?.sessions.length === 3 &&
    wb.workstreams[0]?.sessions[2]?.nativeSessionId === "bbb" &&
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
  const nobody = PersonWorkbench({
    snapshot: new Writable<SnapshotView>({
      repository: "",
      generatedAt: "",
      people: [],
      workstreams: [],
    }),
    person: "nobody",
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    commands: nobodysCommands,
  });
  const action_start_without_card = action(() => {
    nobody.startSession.send();
  });
  const assert_nothing_started = assert(() =>
    nobody.workstreams.length === 0 && nobodysCommands.get().length === 0
  );

  // A verb call without both ids is refused and changes nothing.
  const action_attach_without_ids = action(() => {
    wb.attach.send({ sourceId: "", nativeSessionId: "" });
  });
  const assert_attach_refused = assert(() =>
    wb.workstreams[0]?.sessions.length === 1
  );

  return {
    [NAME]: "Person workbench test",
    [UI]: wb[UI],
    // The refused attach above throws inside the verb, which the runner
    // reports as a runtime error; exactly one is expected.
    expectRuntimeErrors: 1,
    [TESTS]: [
      { assertion: assert_stranger },
      { assertion: assert_person },
      { render: wb[UI] },
      { action: action_attach },
      { assertion: assert_attached },
      { action: action_compose },
      { assertion: assert_kickoff },
      { action: action_start },
      { assertion: assert_started },
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
    ],
  };
});
