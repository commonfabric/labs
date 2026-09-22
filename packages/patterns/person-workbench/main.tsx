/**
 * One person's work: the workstreams a synthesized snapshot names them in,
 * each with its topics and pull requests, and, for the viewer alone, the
 * agent sessions attached to that work and a composer that starts the next
 * one with the workstream's context already in the prompt.
 *
 * The snapshot is shared and comes from the work-snapshot piece, read
 * through a view of the fields the cards show. Sessions are the viewer's own,
 * read from the agents connector's index; attachments and starts are this
 * piece's records; a start goes out through a queue the connector's host
 * binds to this pattern's own handler, and one the index has not confirmed
 * can be withdrawn through the same handler. What this shares with the topic
 * workbench lives in `../workbench/`. One start at a time per workstream:
 * while a start for the picked workstream is unconfirmed, Start is disabled
 * with the reason, and the words a start sent clear from the composer.
 */

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
  attachmentsOf,
  type AttachResult,
  captionOf,
  type CheckoutOption,
  type CommandValue,
  confirmedStartsOf,
  type DetachEvent,
  dropAttachment,
  dropStart,
  indexNoteOf,
  isEmptyText,
  recentRowsOf,
  recordAttachment,
  recordStart,
  rowFromAttachment,
  sessionDotColor,
  type SessionIndexView,
  sessionKey,
  type SessionRow,
  sessionRowsOf,
  type SessionStart,
  type ShownHarness,
  startingOf,
} from "../workbench/sessions.ts";
import {
  checkoutOptionsOf,
  configuredSourcesOf,
  mintSessionId,
  pendingStartOf,
  sourceOptionsOf,
  startBlockerOf,
  startBlockerReason,
  startCommandValue,
  startSourceOf,
  withdrawStart,
} from "../workbench/start.ts";

//
// Views of what this reads
//
// The snapshot is another piece's output. Declaring only the fields the cards
// show keeps a required field the producer adds later from voiding a card,
// and an array element that fails validation from voiding the whole array.

/** A person as the snapshot lists them: what the subject matches on. */
export interface PersonView {
  name: string;
  login?: string;
}

/** A topic as a card shows it. */
export interface TopicView {
  title: string;
  url: string;
  summary?: string;
  lastActivityAt?: number;
}

/** A pull request as a card shows it. The state is the snapshot's own
 * literal union: the link-time schema check proves the linked snapshot's
 * contract against this view field by field, and a plain `string` here
 * cannot be proved against a producer field that is an enum with no declared
 * type, so `cf piece link` refuses the snapshot. The typed boundary does not
 * enforce the literals at runtime, and a state this piece does not know still
 * renders as neither open nor merged rather than voiding the row. */
export interface PullRequestView {
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  url: string;
  updatedAt: string;
}

/** A workstream as this piece reads it. */
export interface WorkstreamView {
  id: string;
  name: string;
  summary: string;
  /** Logins or names, as the snapshot's people list spells them. */
  people: string[];
  topics: TopicView[];
  prs: PullRequestView[];
}

/** The work-snapshot piece's outputs, to the depth this piece reads. */
export interface SnapshotView {
  repository: string | Default<"">;
  generatedAt: string | Default<"">;
  people: PersonView[] | Default<[]>;
  workstreams: WorkstreamView[] | Default<[]>;
}

/** A workstream as this piece shows it: the snapshot's row, the viewer's
 * sessions on it, and a few counts. */
export interface WorkstreamCard {
  id: string;
  name: string;
  summary: string;
  people: string[];
  topics: TopicView[];
  prs: PullRequestView[];
  openCount: number;
  mergedCount: number;
  sessions: SessionRow[];
}

//
// Verbs
//

export interface AttachEvent {
  sourceId: string;
  nativeSessionId: string;
  /** One of the person's workstreams, as the workbench shows them. */
  workstreamId: string;
  title?: string;
}

//
// Inputs and outputs
//

export interface PersonWorkbenchInput {
  /** The work-snapshot piece, linked whole. */
  snapshot?: SnapshotView;
  /** Whose work to show: a login or a name from the snapshot's people. */
  person?: string | Default<"">;
  /** The agents connector's complete session index for the viewer. */
  sessions?: SessionIndexView;
  /** Sessions attached to workstreams by hand, this piece's own record. */
  attached?: Writable<Attachment[] | Default<[]>>;
  /** The command queue the connector's host binds for this piece. */
  commands?: Writable<CommandValue[] | Default<[]>>;
  /**
   * Every start this piece has sent, its own record. A start the index has
   * confirmed stays here, since the record is what files its session under
   * the workstream; one the index has not confirmed can be withdrawn.
   */
  starts?: Writable<SessionStart[] | Default<[]>>;
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
  /** The sessions attached by hand; `attachedSessions` adds the confirmed
   * starts to them. */
  attached: Attachment[] | Default<[]>;
  /** Every attached session, the confirmed starts among them. */
  attachedSessions: SessionRow[];
  /** Attached sessions whose workstream the workbench no longer shows. */
  orphanedSessions: SessionRow[];
  /** Starts the index has not confirmed yet. */
  startingSessions: SessionStart[];
  recentSessions: SessionRow[];
  kickoff: string;
  /** Why Start would send nothing, or "" when it would. */
  startBlocker: string;
  spawnPrompt: PerSession<Writable<string>>;
  spawnRoot: PerSession<Writable<string>>;
  spawnSource: PerSession<Writable<string>>;
  spawnWorkstream: PerSession<Writable<string>>;
  /** Attach a session under one of the person's workstreams. Idempotent. */
  attach: Stream<AttachEvent, AttachResult>;
  /** Detach a session by provider identity, a started one included. */
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

//
// Derivations
//

const normalize = (value: string): string => value.trim().toLowerCase();

/** The person the snapshot names, matched on login or name. */
const personOf = lift((
  { people, person }: { people?: PersonView[] | Default<[]>; person: string },
): PersonView | undefined => {
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
    workstreams?: WorkstreamView[] | Default<[]>;
    person: PersonView | undefined;
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
    const row = rowsByKey.get(sessionKey(a.sourceId, a.nativeSessionId)) ??
      rowFromAttachment(a);
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
  state: string,
): "primary" | "accent" | "neutral" | "danger" =>
  state === "merged"
    ? "primary"
    : state === "open"
    ? "accent"
    : state === "draft"
    ? "neutral"
    : "danger";

//
// Handlers (browser)
//

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
 * workstreams, which must be one the workbench shows. Returns whether the
 * record was new, as the topic workbench's does. */
const attachVerb = handler<AttachEvent, {
  attached: Writable<Attachment[] | Default<[]>>;
  workstreamIds: string[];
}, AttachResult>(
  ({ sourceId, nativeSessionId, workstreamId, title }, state) => {
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
    const attachedAt = Date.now();
    const added = recordAttachment(state.attached, {
      sourceId: source,
      nativeSessionId: native,
      title: (title ?? "").trim(),
      attachedAt,
      workstreamId: workstream,
    });
    return { attachedAt, added };
  },
);

const detachRow = handler<void, {
  attached: Writable<Attachment[] | Default<[]>>;
  starts: Writable<SessionStart[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
}>((_, { attached, starts, sourceId, nativeSessionId }) => {
  // A confirmed start is attached through its own record; detaching drops
  // whichever record the session has.
  dropAttachment(attached, sourceId, nativeSessionId);
  dropStart(starts, sourceId, nativeSessionId);
});

/**
 * Sends the connector a `start` command for the picked workstream and records
 * the start for that workstream, or, bound with `withdraw`, takes a start
 * back. It counts as attached once the index carries the session. Exported
 * because the connector's host binds this piece's queue to this handler by
 * name: only a write from here is accepted on that queue, so both the start
 * and its withdrawal go through it.
 */
export const startWorkstreamSession = handler<void, {
  commands: Writable<CommandValue[] | Default<[]>>;
  starts: Writable<SessionStart[] | Default<[]>>;
  spawnRoot: Writable<string>;
  spawnSource: Writable<string>;
  /** The person's words, cleared once a start has sent them. */
  spawnPrompt: Writable<string>;
  sourceOptions: CheckoutOption[];
  configuredSources: string[];
  kickoff: string;
  ownerDid: string;
  card: WorkstreamCard | undefined;
  startMode: string;
  /** The title of a start for the picked workstream the index has not
   * confirmed, or "": one start at a time per workstream, so a second click
   * while the first is on its way sends nothing. */
  pending: string;
  /** Bound on a Withdraw control: the id of the command to take back. The
   * start's own fields are then not read. */
  withdraw?: string;
}>((_, state) => {
  if (state.withdraw) {
    withdrawStart(state.commands, state.starts, state.withdraw);
    return;
  }
  // The same predicate that disables the control: a click that slips past a
  // stale rendering starts nothing.
  const picked = state.spawnSource.get();
  const blocked = startBlockerReason({
    ownerDid: state.ownerDid,
    picked,
    options: state.sourceOptions,
    startable: state.configuredSources,
    kickoff: state.kickoff,
    hasSubject: state.card !== undefined,
    pending: state.pending,
  });
  if (blocked || state.card === undefined) return;
  const sourceId = startSourceOf(
    picked,
    state.sourceOptions,
    state.configuredSources,
  );
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
  // Recorded, not attached: nothing here knows whether a queue took the
  // command or the connector accepted it. The start shows as starting until
  // the index carries the session, and can be withdrawn until then.
  recordStart(state.starts, {
    commandId: command.id,
    sourceId,
    nativeSessionId,
    title,
    startedAt: Date.now(),
    workstreamId: state.card.id,
  });
  // The words went with the start; the composer is ready for the next one,
  // and Start stays disabled until this one is confirmed or withdrawn.
  state.spawnPrompt.set("");
});

//
// The pattern
//

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
      starts,
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
    const confirmedStarts = confirmedStartsOf({ starts, index: sessions });
    const attachments = attachmentsOf({ attached, confirmed: confirmedStarts });
    const startingSessions = startingOf({ starts, index: sessions });
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
    const pickedWorkstreamId = computed(() => card?.id ?? "");
    const pendingStart = pendingStartOf({
      starting: startingSessions,
      workstreamId: pickedWorkstreamId,
    });
    const sourceOptions = sourceOptionsOf({
      index: sessions,
      shown: harnessesShown,
    });
    const configuredSources = configuredSourcesOf({ index: sessions });
    const indexNote = indexNoteOf({ index: sessions });
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
    const indexNoteEmpty = isEmptyText({ text: indexNote });
    const hasIndexNote = computed(() => !indexNoteEmpty);
    const startModeNote = computed(() =>
      mode.trim()
        ? ` The first turn runs under the "${mode.trim()}" permission mode; the kickoff below is exactly what it receives.`
        : ""
    );
    const hasSubject = computed(() => card !== undefined);
    const startBlocker = startBlockerOf({
      ownerDid,
      picked: spawnSource,
      options: sourceOptions,
      startable: configuredSources,
      kickoff,
      hasSubject,
      pending: pendingStart,
    });
    const canStart = isEmptyText({ text: startBlocker });

    // The one handler the queue accepts writes from, bound here for Start
    // and once per starting row for Withdraw.
    const startSession = startWorkstreamSession({
      commands,
      starts,
      spawnRoot,
      spawnSource,
      sourceOptions,
      configuredSources,
      spawnPrompt,
      kickoff,
      ownerDid,
      card,
      startMode: mode,
      pending: pendingStart,
    });

    const attach = attachVerb({ attached, workstreamIds });

    const detach = action<DetachEvent>(({ sourceId, nativeSessionId }) => {
      const source = (sourceId ?? "").trim();
      const native = (nativeSessionId ?? "").trim();
      dropAttachment(attached, source, native);
      dropStart(starts, source, native);
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
                {/* Left: the person's workstreams. */}
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
                                sessionDotColor(row.active)
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
                                starts,
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
                                  starts,
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

                {/* Right: the next session. */}
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
                            data-harness=""
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
                          disabled={computed(() => !canStart)}
                          onClick={startSession}
                        >
                          Start
                        </cf-button>
                        <cf-text
                          variant="caption"
                          tone="muted"
                          data-start-note=""
                        >
                          {canStart
                            ? "Runs the first turn on this Mac through the connector; the start shows below as starting until the connector publishes the session, then joins the workstream."
                            : startBlocker}
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
                                  data-withdraw=""
                                  onClick={startWorkstreamSession({
                                    commands,
                                    starts,
                                    spawnRoot,
                                    spawnSource,
                                    sourceOptions,
                                    configuredSources,
                                    spawnPrompt,
                                    kickoff,
                                    ownerDid,
                                    card,
                                    startMode: mode,
                                    pending: pendingStart,
                                    withdraw: start.commandId,
                                  })}
                                >
                                  Withdraw
                                </cf-button>
                              </cf-hstack>
                            ))}
                            <cf-text variant="caption" tone="muted" block>
                              Withdraw takes the command out of the queue unless
                              the connector has already taken it; a start it has
                              taken still runs, and its session then shows
                              below, unattached.
                            </cf-text>
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
                      {hasIndexNote
                        ? (
                          <cf-text
                            variant="caption"
                            tone="muted"
                            block
                            data-index-note=""
                          >
                            {indexNote}
                          </cf-text>
                        )
                        : null}
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
                                    sessionDotColor(row.active)
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
      startingSessions,
      recentSessions,
      kickoff,
      startBlocker,
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
