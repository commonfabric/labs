import {
  action,
  computed,
  Default,
  handler,
  lift,
  NAME,
  pattern,
  type PerSession,
  Stream,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

import {
  isSafeLinkUrl,
  snippet,
  TOPICS_THEME,
  whenLabel,
} from "../topics/topic.tsx";
import {
  attachedRowsOf,
  type Attachment,
  attachmentKey,
  attachmentsOf,
  captionOf,
  type CheckoutOption,
  checkoutOptionsOf,
  type CommandValue,
  configuredSourcesOf,
  confirmedStartsOf,
  dropAttachment,
  dropPendingStart,
  mintSessionId,
  type PendingStart,
  recentRowsOf,
  recordAttachment,
  recordPendingStart,
  type SessionIndexView,
  sessionKey,
  type SessionRow,
  sessionRowsOf,
  type ShownHarness,
  sourceOptionsOf,
  type StartableSourcesView,
  startCommandValue,
  startSourceOf,
  unconfirmedStartsOf,
} from "../topic-workbench/main.tsx";
import type {
  PersonRef,
  PullRequestRef,
  TopicRef,
  Workstream,
} from "../work-snapshot/main.tsx";

// ===== What this is =====
//
// One person's work: the workstreams a synthesized snapshot names them in,
// each with its topics and pull requests, and, for the viewer alone, the
// agent sessions attached to that work and a composer that starts the next
// one with the workstream's context already in the prompt.
//
// The snapshot is shared and comes from the work-snapshot piece. Sessions are
// the viewer's own, read from the agents connector's index; attachments are
// this piece's record; the start goes out through a queue the connector's
// host binds to this pattern's own handler.

// ===== Views of what this reads =====

/** The work-snapshot piece's outputs, read shallowly. */
export interface SnapshotView {
  repository: string | Default<"">;
  generatedAt: string | Default<"">;
  people: PersonRef[] | Default<[]>;
  workstreams: Workstream[] | Default<[]>;
}

/** A workstream as this piece shows it: the snapshot's row, the viewer's
 * sessions on it, and a few counts. */
export interface WorkstreamCard {
  id: string;
  name: string;
  summary: string;
  people: string[];
  topics: TopicRef[];
  prs: PullRequestRef[];
  openCount: number;
  mergedCount: number;
  sessions: SessionRow[];
}

// ===== Verbs =====

export interface AttachEvent {
  sourceId: string;
  nativeSessionId: string;
  workstreamId?: string;
  title?: string;
}

export interface DetachEvent {
  sourceId: string;
  nativeSessionId: string;
}

// ===== Inputs and outputs =====

export interface PersonWorkbenchInput {
  /** The work-snapshot piece, linked whole. */
  snapshot?: SnapshotView;
  /** Whose work to show: a login or a name from the snapshot's people. */
  person?: string | Default<"">;
  /** The agents connector's complete session index for the viewer. */
  sessions?: SessionIndexView;
  /** Sessions attached to workstreams, this piece's own record. */
  attached?: Writable<Attachment[] | Default<[]>>;
  /** The command queue the connector's host binds for this piece. */
  commands?: Writable<CommandValue[] | Default<[]>>;
  /** Starts sent and not yet confirmed by the index, this piece's own
   * record. */
  pendingStarts?: Writable<PendingStart[] | Default<[]>>;
  /** The permission mode a started session's first turn runs under. */
  startMode?: string | Default<"">;
  /** Harnesses listed in the picker that no configured source backs. */
  harnessesShown?: ShownHarness[] | Default<[]>;
}

export interface PersonWorkbenchOutput {
  [NAME]: string;
  [UI]: VNode;
  personName: string;
  workstreams: WorkstreamCard[];
  attached: Attachment[] | Default<[]>;
  /** Every attached session, the confirmed starts among them. */
  attachedSessions: SessionRow[];
  /** Attached sessions whose workstream the workbench no longer shows. */
  orphanedSessions: SessionRow[];
  /** Starts the index has not confirmed yet. */
  pendingStarts: PendingStart[];
  recentSessions: SessionRow[];
  kickoff: string;
  spawnPrompt: PerSession<Writable<string>>;
  spawnRoot: PerSession<Writable<string>>;
  spawnSource: PerSession<Writable<string>>;
  spawnWorkstream: PerSession<Writable<string>>;
  attach: Stream<AttachEvent>;
  detach: Stream<DetachEvent>;
  /** Start a session for the picked workstream. */
  startSession: Stream<void>;
  // The connector's host reads this field's schema to learn which handler may
  // write the queue it binds for this piece. The field has no stored value.
  commandAuthorization?: WriteAuthorizedBy<
    boolean,
    typeof startWorkstreamSession
  >;
}

// ===== Derivations =====

const normalize = (value: string): string => value.trim().toLowerCase();

/** The person the snapshot names, matched on login or name. */
const personOf = lift((
  { people, person }: { people?: PersonRef[] | Default<[]>; person: string },
): PersonRef | undefined => {
  const needle = normalize(person);
  if (!needle) return undefined;
  return (people ?? []).find((p) =>
    normalize(p.login ?? "") === needle || normalize(p.name) === needle
  );
});

/** The person's workstreams, with the viewer's attached sessions joined in.
 * With no person named, every workstream shows; a name the snapshot's people
 * do not carry shows none, so a stale or mistyped name is not everyone's. */
const cardsOf = lift((
  { workstreams, person, named, rows, attached }: {
    workstreams?: Workstream[] | Default<[]>;
    person: PersonRef | undefined;
    named: string;
    rows: SessionRow[];
    attached: Attachment[] | Default<[]>;
  },
): WorkstreamCard[] => {
  if (person === undefined && normalize(named)) return [];
  const names = new Set(
    [person?.login, person?.name].flatMap((n) => n ? [normalize(n)] : []),
  );
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const attachedByWorkstream = new Map<string, SessionRow[]>();
  for (const a of attached) {
    if (!a.workstreamId) continue;
    const key = sessionKey(a.sourceId, a.nativeSessionId);
    const row = rowsByKey.get(key) ?? {
      key,
      sourceId: a.sourceId,
      nativeSessionId: a.nativeSessionId,
      title: a.title,
      cwd: "",
      gitBranch: "",
      gitRepo: "",
      updatedAt: "",
      active: false,
      attached: true,
    };
    const own = attachedByWorkstream.get(a.workstreamId) ?? [];
    own.push(row);
    attachedByWorkstream.set(a.workstreamId, own);
  }
  return (workstreams ?? [])
    .filter((w) =>
      names.size === 0 || w.people.some((p) => names.has(normalize(p)))
    )
    .map((w) => ({
      id: w.id,
      name: w.name,
      summary: w.summary,
      people: w.people,
      topics: w.topics,
      prs: w.prs,
      openCount: w.prs.filter((p) => p.state === "open" || p.state === "draft")
        .length,
      mergedCount: w.prs.filter((p) => p.state === "merged").length,
      sessions: attachedByWorkstream.get(w.id) ?? [],
    }));
});

const workstreamOptionsOf = lift((
  { cards }: { cards: WorkstreamCard[] },
): CheckoutOption[] => cards.map((c) => ({ label: c.name, value: c.id })));

/** Attached sessions no card shows: their workstream was dropped or renamed
 * by a later snapshot, or the person no longer belongs to it. They keep a
 * place of their own with Detach, so an attachment never becomes
 * unreachable. */
const orphanedRowsOf = lift((
  { attachedRows, attached, cards }: {
    attachedRows: SessionRow[];
    attached: Attachment[];
    cards: WorkstreamCard[];
  },
): SessionRow[] => {
  const shown = new Set(cards.map((c) => c.id));
  const orphanKeys = new Set(
    attached.filter((a) => !a.workstreamId || !shown.has(a.workstreamId))
      .map((a) => sessionKey(a.sourceId, a.nativeSessionId)),
  );
  return attachedRows.filter((row) => orphanKeys.has(row.key));
});

/** The workstream the composer targets: the picked one, else the first. */
const pickedOf = lift((
  { cards, picked }: { cards: WorkstreamCard[]; picked: string },
): WorkstreamCard | undefined =>
  cards.find((c) => c.id === picked.trim()) ?? cards[0]
);

/** The kickoff prompt: the person's words first, then the workstream's
 * context, then the links. */
const kickoffOf = lift((
  { prompt, card }: { prompt: string; card: WorkstreamCard | undefined },
): string => {
  const head = prompt.trim() ||
    (card ? `Work on "${card.name}".` : "");
  if (!card) return head;
  const topicLines = card.topics.slice(0, 6).map((t) =>
    `- Topic "${t.title}"${t.summary ? `: ${snippet(t.summary, 240)}` : ""}`
  );
  const prLines = card.prs
    .filter((p) => p.state === "open" || p.state === "draft")
    .slice(0, 8)
    .map((p) => `- PR #${p.number}, "${p.title}", ${p.state}`);
  // Only links that are http(s) go into a prompt; a stored link that is not
  // renders as text and is not repeated here.
  const links = [
    ...card.topics.slice(0, 6).filter((t) => isSafeLinkUrl(t.url))
      .map((t) => `- ${t.url}`),
    ...card.prs.filter((p) =>
      (p.state === "open" || p.state === "draft") && isSafeLinkUrl(p.url)
    ).slice(0, 8).map((p) => `- ${p.url}`),
  ];
  return [
    head,
    `Context:\n- Workstream "${card.name}": ${card.summary}`,
    ...(topicLines.length ? [topicLines.join("\n")] : []),
    ...(prLines.length ? [`Open pull requests:\n${prLines.join("\n")}`] : []),
    ...(links.length ? [`Links:\n${links.join("\n")}`] : []),
  ].join("\n\n");
});

const stateColor = (
  state: PullRequestRef["state"],
): "primary" | "accent" | "neutral" | "danger" =>
  state === "merged"
    ? "primary"
    : state === "open"
    ? "accent"
    : state === "draft"
    ? "neutral"
    : "danger";

// ===== Handlers (browser) =====

/** Attaches a rail row under the composer's resolved workstream card: the
 * picked one, else the first. With no card (the person has no workstreams)
 * there is nothing to file it under, so nothing is recorded; a record with
 * no reachable card would show nowhere and could not be detached. */
const attachToPicked = handler<void, {
  attached: Writable<Attachment[] | Default<[]>>;
  card: WorkstreamCard | undefined;
  sourceId: string;
  nativeSessionId: string;
  title: string;
}>((_, state) => {
  if (!state.card) return;
  recordAttachment(state.attached, {
    sourceId: state.sourceId,
    nativeSessionId: state.nativeSessionId,
    title: state.title,
    attachedAt: Date.now(),
    workstreamId: state.card.id,
  });
});

/** The headless attach: a session files itself under one of the person's
 * workstreams, which must be one the workbench shows. */
const attachVerb = handler<AttachEvent, {
  attached: Writable<Attachment[] | Default<[]>>;
  workstreamIds: string[];
}>(({ sourceId, nativeSessionId, workstreamId, title }, state) => {
  const source = (sourceId ?? "").trim();
  const native = (nativeSessionId ?? "").trim();
  if (!source || !native) {
    throw new Error("attach: sourceId and nativeSessionId are required");
  }
  const workstream = (workstreamId ?? "").trim();
  if (!workstream || !state.workstreamIds.includes(workstream)) {
    throw new Error(
      "attach: workstreamId must name one of this person's workstreams",
    );
  }
  recordAttachment(state.attached, {
    sourceId: source,
    nativeSessionId: native,
    title: (title ?? "").trim(),
    attachedAt: Date.now(),
    workstreamId: workstream,
  });
});

const detachRow = handler<void, {
  attached: Writable<Attachment[] | Default<[]>>;
  pendingStarts: Writable<PendingStart[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
}>((_, { attached, pendingStarts, sourceId, nativeSessionId }) => {
  // A confirmed start is attached through its pending record; detaching
  // drops whichever record the session has.
  dropAttachment(attached, sourceId, nativeSessionId);
  dropPendingStart(pendingStarts, sourceId, nativeSessionId);
});

const dismissStart = handler<void, {
  pendingStarts: Writable<PendingStart[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
}>((_, { pendingStarts, sourceId, nativeSessionId }) => {
  dropPendingStart(pendingStarts, sourceId, nativeSessionId);
});

/**
 * Sends the connector a `start` command for the picked workstream and records
 * the start as pending for that workstream; it counts as attached once the
 * index carries the session. Exported because the connector's host binds this
 * piece's queue to this handler by name.
 */
export const startWorkstreamSession = handler<void, {
  commands: Writable<CommandValue[] | Default<[]>>;
  pendingStarts: Writable<PendingStart[] | Default<[]>>;
  spawnRoot: Writable<string>;
  spawnSource: Writable<string>;
  sourceOptions: CheckoutOption[];
  configuredSources: string[];
  kickoff: string;
  ownerDid: string;
  card: WorkstreamCard | undefined;
  startMode: string;
}>((_, state) => {
  // A harness shown for display has no source to run it, and a configured
  // source whose driver cannot start is no harness for this either; a picker
  // value naming one (or a stale choice) starts nothing.
  const sourceId = startSourceOf(
    state.spawnSource.get(),
    state.sourceOptions,
    state.configuredSources,
  );
  if (!state.ownerDid || !sourceId || !state.card || !state.kickoff.trim()) {
    return;
  }
  const nativeSessionId = mintSessionId();
  const title = state.card.name;
  const command = startCommandValue({
    ownerDid: state.ownerDid,
    idPrefix: "person-workbench",
    sourceId,
    nativeSessionId,
    text: state.kickoff,
    cwd: state.spawnRoot.get().trim(),
    title,
    mode: state.startMode.trim(),
  });
  state.commands.push(command.value);
  // Pending, not attached: nothing here knows whether a queue took the
  // command or the connector accepted it. The start shows as starting until
  // the index carries the session, and can be dismissed if it never does.
  recordPendingStart(state.pendingStarts, {
    commandId: command.id,
    sourceId,
    nativeSessionId,
    title,
    startedAt: Date.now(),
    workstreamId: state.card.id,
  });
});

// ===== The pattern =====

/** The ids of the workstreams the workbench shows, for the attach verb. */
const workstreamIdsOf = lift((
  { cards }: { cards: WorkstreamCard[] },
): string[] => cards.map((card) => card.id));

export default pattern<PersonWorkbenchInput, PersonWorkbenchOutput>(
  (
    {
      snapshot,
      person,
      sessions,
      attached,
      commands,
      pendingStarts,
      startMode,
      harnessesShown,
    },
  ) => {
    const spawnPrompt = new Writable.perSession("");
    const spawnRoot = new Writable.perSession("");
    const spawnSource = new Writable.perSession("");
    const spawnWorkstream = new Writable.perSession("");

    const named = person ?? "";
    const personRef = personOf({ people: snapshot?.people, person });
    const confirmedStarts = confirmedStartsOf({
      pending: pendingStarts,
      index: sessions,
    });
    const attachments = attachmentsOf({ attached, confirmed: confirmedStarts });
    const startingSessions = unconfirmedStartsOf({
      pending: pendingStarts,
      index: sessions,
    });
    const rows = sessionRowsOf({ index: sessions, attached: attachments });
    const cards = cardsOf({
      workstreams: snapshot?.workstreams,
      person: personRef,
      named,
      rows,
      attached: attachments,
    });
    const recentSessions = recentRowsOf({ rows, limit: 8 });
    const attachedSessions = attachedRowsOf({ attached: attachments, rows });
    const orphanedSessions = orphanedRowsOf({
      attachedRows: attachedSessions,
      attached: attachments,
      cards,
    });
    const workstreamOptions = workstreamOptionsOf({ cards });
    const card = pickedOf({ cards, picked: spawnWorkstream });
    const kickoff = kickoffOf({ prompt: spawnPrompt, card });
    const sourceOptions = sourceOptionsOf({
      index: sessions,
      shown: harnessesShown,
    });
    const configuredSources = configuredSourcesOf({ index: sessions });
    const mode = startMode ?? "";
    const checkoutOptions = checkoutOptionsOf({ index: sessions });
    const ownerDid = sessions?.ownerDid ?? "";
    const personName = computed(() => personRef?.name ?? (person ?? "").trim());
    const emptyNote = computed(() =>
      personRef === undefined && (person ?? "").trim()
        ? `No one named ${(person ?? "").trim()} is in the current snapshot.`
        : "No workstreams name this person in the current snapshot."
    );
    const workstreamIds = workstreamIdsOf({ cards });
    const repository = snapshot?.repository ?? "";
    const generatedAt = snapshot?.generatedAt ?? "";
    const hasCards = cards.length > 0;
    const hasRecent = recentSessions.length > 0;
    const hasOrphans = orphanedSessions.length > 0;
    const hasStarting = startingSessions.length > 0;
    const startModeNote = computed(() =>
      mode.trim()
        ? ` The first turn runs under the "${mode.trim()}" permission mode; the kickoff below is exactly what it receives.`
        : ""
    );

    const startSession = startWorkstreamSession({
      commands,
      pendingStarts,
      spawnRoot,
      spawnSource,
      sourceOptions,
      configuredSources,
      kickoff,
      ownerDid,
      card,
      startMode: mode,
    });

    const attach = attachVerb({ attached, workstreamIds });

    const detach = action<DetachEvent>(({ sourceId, nativeSessionId }) => {
      const source = (sourceId ?? "").trim();
      const native = (nativeSessionId ?? "").trim();
      dropAttachment(attached, source, native);
      dropPendingStart(pendingStarts, source, native);
    });

    return {
      [NAME]: computed(() =>
        personName ? `${personName}'s work` : "A person's work"
      ),
      [UI]: (
        <cf-theme theme={TOPICS_THEME}>
          <cf-screen>
            <cf-vstack slot="header" gap="1" padding="4">
              <cf-hstack gap="2" align="center">
                <cf-text
                  block
                  style="font-size: 1.25rem; font-weight: 600; flex: 1; min-width: 0;"
                >
                  {personName ? `${personName} · work` : "A person's work"}
                </cf-text>
                <cf-text variant="caption" tone="muted">
                  {repository}
                </cf-text>
              </cf-hstack>
              <cf-text variant="caption" tone="muted">
                {hasCards
                  ? `${cards.length} workstreams · ${attachedSessions.length} sessions attached · synthesized ${generatedAt}`
                  : emptyNote}
              </cf-text>
            </cf-vstack>

            <cf-vstack gap="3" padding="4">
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(26rem, 100%), 1fr)); gap: 0.75rem; align-items: start;">
                {/* ── Left: the person's workstreams ── */}
                <cf-vstack gap="3" style="min-width: 0;">
                  {cards.map((c) => (
                    <cf-card data-workstream="">
                      <cf-vstack gap="2">
                        <cf-hstack justify="between" align="center">
                          <cf-heading level={5}>{c.name}</cf-heading>
                          <cf-text variant="caption" tone="muted">
                            {`${c.openCount} open · ${c.mergedCount} merged · ${c.topics.length} topics`}
                          </cf-text>
                        </cf-hstack>
                        <cf-text tone="muted" block>{c.summary}</cf-text>
                        {c.topics.map((topic) => (
                          <cf-hstack gap="2" align="center" data-topic-row="">
                            <cf-badge size="xs" color="neutral">topic</cf-badge>
                            {isSafeLinkUrl(topic.url)
                              ? (
                                <a
                                  href={topic.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                                >
                                  {topic.title}
                                </a>
                              )
                              : (
                                <cf-text
                                  tone="muted"
                                  style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                                >
                                  {topic.title}
                                </cf-text>
                              )}
                            <cf-text variant="caption" tone="muted">
                              {topic.lastActivityAt
                                ? whenLabel(topic.lastActivityAt)
                                : ""}
                            </cf-text>
                          </cf-hstack>
                        ))}
                        {c.prs.map((pr) => (
                          <cf-hstack gap="2" align="center" data-pr-row="">
                            <cf-badge size="xs" color={stateColor(pr.state)}>
                              {pr.state}
                            </cf-badge>
                            {isSafeLinkUrl(pr.url)
                              ? (
                                <a
                                  href={pr.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                                >
                                  #{pr.number} {pr.title}
                                </a>
                              )
                              : (
                                <cf-text
                                  tone="muted"
                                  style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                                >
                                  #{pr.number} {pr.title}
                                </cf-text>
                              )}
                            <cf-text variant="caption" tone="muted">
                              {pr.updatedAt.slice(0, 10)}
                            </cf-text>
                          </cf-hstack>
                        ))}
                        <cf-text variant="caption" tone="muted">
                          {c.sessions.length > 0
                            ? `Your sessions on this work · ${c.sessions.length}`
                            : "No sessions of yours on this work yet."}
                        </cf-text>
                        {c.sessions.map((row) => (
                          <cf-hstack gap="2" align="center" data-session-row="">
                            <span
                              style={`display:inline-block;width:0.5rem;height:0.5rem;border-radius:50%;flex:0 0 auto;background:${
                                row.active ? "#2A7A55" : "#C2CAD0"
                              }`}
                            >
                            </span>
                            <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                              <cf-text block truncate style="font-weight: 600;">
                                {row.title || "(untitled session)"}
                              </cf-text>
                              <cf-text variant="caption" tone="muted" truncate>
                                {captionOf(row)}
                              </cf-text>
                            </cf-vstack>
                            <cf-button
                              variant="ghost"
                              size="sm"
                              data-detach=""
                              onClick={detachRow({
                                attached,
                                pendingStarts,
                                sourceId: row.sourceId,
                                nativeSessionId: row.nativeSessionId,
                              })}
                            >
                              Detach
                            </cf-button>
                          </cf-hstack>
                        ))}
                      </cf-vstack>
                    </cf-card>
                  ))}
                  {hasOrphans
                    ? (
                      <cf-card data-orphaned="">
                        <cf-vstack gap="2">
                          <cf-heading level={5}>
                            Attached to work no longer shown
                          </cf-heading>
                          <cf-text variant="caption" tone="muted">
                            {`${orphanedSessions.length} sessions attached under a workstream this snapshot no longer lists for you.`}
                          </cf-text>
                          {orphanedSessions.map((row) => (
                            <cf-hstack
                              gap="2"
                              align="center"
                              data-orphan-row=""
                            >
                              <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                                <cf-text
                                  block
                                  truncate
                                  style="font-weight: 600;"
                                >
                                  {row.title || "(untitled session)"}
                                </cf-text>
                                <cf-text
                                  variant="caption"
                                  tone="muted"
                                  truncate
                                >
                                  {captionOf(row)}
                                </cf-text>
                              </cf-vstack>
                              <cf-button
                                variant="ghost"
                                size="sm"
                                data-detach=""
                                onClick={detachRow({
                                  attached,
                                  pendingStarts,
                                  sourceId: row.sourceId,
                                  nativeSessionId: row.nativeSessionId,
                                })}
                              >
                                Detach
                              </cf-button>
                            </cf-hstack>
                          ))}
                        </cf-vstack>
                      </cf-card>
                    )
                    : null}
                </cf-vstack>

                {/* ── Right: the next session ── */}
                <cf-vstack gap="3" style="min-width: 0;">
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={5}>Start a session</cf-heading>
                      <cf-text variant="caption" tone="muted">
                        Your words go first; the workstream's topics, open pull
                        requests, and links follow.
                      </cf-text>
                      <cf-field label="Workstream">
                        <cf-select
                          $value={spawnWorkstream}
                          items={workstreamOptions}
                        />
                      </cf-field>
                      <cf-field label="Prompt">
                        <cf-textarea
                          $value={spawnPrompt}
                          rows={3}
                          placeholder="What should this session do?"
                        />
                      </cf-field>
                      <cf-hstack gap="2" align="end" style="flex-wrap: wrap;">
                        <cf-field label="Harness" style="flex: 1 1 12rem;">
                          <cf-select
                            $value={spawnSource}
                            items={sourceOptions}
                          />
                        </cf-field>
                        <cf-field label="Checkout" style="flex: 1 1 14rem;">
                          <cf-select
                            $value={spawnRoot}
                            items={checkoutOptions}
                          />
                        </cf-field>
                      </cf-hstack>
                      <cf-hstack gap="2" align="center">
                        <cf-button
                          variant="primary"
                          data-start=""
                          onClick={startSession}
                        >
                          Start
                        </cf-button>
                        <cf-text variant="caption" tone="muted">
                          Runs the first turn on this Mac through the connector;
                          the start shows below as starting until the connector
                          publishes the session, then joins the workstream.
                          {startModeNote}
                        </cf-text>
                      </cf-hstack>
                      {hasStarting
                        ? (
                          <cf-vstack gap="2" data-starting="">
                            <cf-text variant="caption" tone="muted">
                              Starting · {startingSessions.length}
                            </cf-text>
                            {startingSessions.map((start) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-starting-row=""
                              >
                                <cf-vstack
                                  gap="0"
                                  style="flex: 1; min-width: 0;"
                                >
                                  <cf-text
                                    block
                                    truncate
                                    style="font-weight: 600;"
                                  >
                                    {start.title || "(untitled session)"}
                                  </cf-text>
                                  <cf-text
                                    variant="caption"
                                    tone="muted"
                                    truncate
                                  >
                                    {`${start.sourceId} · sent to the connector; joins the workstream when the session appears in the index`}
                                  </cf-text>
                                </cf-vstack>
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  data-dismiss=""
                                  onClick={dismissStart({
                                    pendingStarts,
                                    sourceId: start.sourceId,
                                    nativeSessionId: start.nativeSessionId,
                                  })}
                                >
                                  Dismiss
                                </cf-button>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : null}
                      <cf-field label="Kickoff prompt, as it will be sent">
                        <cf-text
                          block
                          data-kickoff=""
                          style="font-family: ui-monospace, monospace; font-size: 0.82em; white-space: pre-wrap;"
                        >
                          {kickoff}
                        </cf-text>
                      </cf-field>
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={5}>Recent sessions</cf-heading>
                        <cf-text variant="caption" tone="muted">
                          attach one to the picked workstream
                        </cf-text>
                      </cf-hstack>
                      {hasRecent
                        ? (
                          <cf-vstack gap="2">
                            {recentSessions.map((row) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-session-row=""
                              >
                                <span
                                  style={`display:inline-block;width:0.5rem;height:0.5rem;border-radius:50%;flex:0 0 auto;background:${
                                    row.active ? "#2A7A55" : "#C2CAD0"
                                  }`}
                                >
                                </span>
                                <cf-vstack
                                  gap="0"
                                  style="flex: 1; min-width: 0;"
                                >
                                  <cf-text
                                    block
                                    truncate
                                    style="font-weight: 600;"
                                  >
                                    {row.title || "(untitled session)"}
                                  </cf-text>
                                  <cf-text
                                    variant="caption"
                                    tone="muted"
                                    truncate
                                  >
                                    {captionOf(row)}
                                  </cf-text>
                                </cf-vstack>
                                <cf-button
                                  variant="secondary"
                                  size="sm"
                                  data-attach=""
                                  disabled={computed(() => !hasCards)}
                                  onClick={attachToPicked({
                                    attached,
                                    card,
                                    sourceId: row.sourceId,
                                    nativeSessionId: row.nativeSessionId,
                                    title: row.title,
                                  })}
                                >
                                  Attach
                                </cf-button>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : (
                          <cf-text tone="muted" block>
                            No session index linked, or every session is
                            attached.
                          </cf-text>
                        )}
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>
              </div>
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
      personName,
      workstreams: cards,
      attached,
      attachedSessions,
      orphanedSessions,
      pendingStarts: startingSessions,
      recentSessions,
      kickoff,
      spawnPrompt,
      spawnRoot,
      spawnSource,
      spawnWorkstream,
      attach,
      detach,
      startSession,
    };
  },
);
