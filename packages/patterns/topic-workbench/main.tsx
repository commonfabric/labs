/**
 * A per-person lens over ONE topic: the topic's summary, the agent sessions
 * attached to it, the sessions that look related, the topic's links, and a
 * composer that starts a new session for the topic.
 *
 * It is a piece in the PERSON's own space rather than a change to the topic,
 * because agent sessions are published owner-confidential by the agents
 * connector while the topic lives on a shared board. The workbench holds a
 * reference to the topic and reads the person's connector index; nothing here
 * writes into the topic.
 *
 * Attachments and starts are the workbench's own records, sessions are read
 * from the connector's complete index, and "start a session" sends the
 * connector a `start` command through a queue the connector's host binds to
 * this pattern's own handler. Every start is recorded; it counts as attached
 * only once the index carries the session it named, since the queue may not
 * be bound yet or the connector may refuse the start, and until then it can
 * be withdrawn through the same handler. A confirmed start's record stays,
 * being what attaches its session. The composed shell command stays
 * as the fallback for a person whose host has no queue for this piece. What
 * this shares with the person workbench lives in `../workbench/`. One start
 * at a time: while a start is unconfirmed, Start is disabled with the reason,
 * and the words a start sent clear from the composer. With `startSurface`
 * set to `desktop`, a start opens Claude Code on this Mac with the kickoff
 * ready to send instead of running its first turn here; the session the app
 * makes carries the start's id as `startedAs`, which confirms the start.
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
  pairingsOf,
  recentRowsOf,
  recordAttachment,
  recordStart,
  sessionDotColor,
  type SessionIndexView,
  type SessionPairing,
  type SessionRow,
  sessionRowsOf,
  type SessionStart,
  type ShownHarness,
  startedAsOf,
  startingOf,
} from "../workbench/sessions.ts";
import {
  checkoutOptionsOf,
  configuredSourcesOf,
  desktopSourcesOf,
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

/** What the workbench reads of the topic it is about: a narrow view, never
 * the whole piece. Every field carries a default so a topic written before a
 * field existed still reads. */
export interface TopicView {
  title: string | Default<"">;
  shortName?: string;
  body: string | Default<"">;
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;
  createdBy?:
    | { kind: string; name: string; avatar?: string }
    | Default<{ kind: "person"; name: "" }>;
  links: TopicLinkView[] | Default<[]>;
}

export interface TopicLinkView {
  kind: string;
  url: string;
  label?: string;
  addedAt?: number;
  removedAt?: number;
}

//
// Verbs
//

export interface AttachEvent {
  sourceId: string;
  nativeSessionId: string;
  /** The title as known at attach time; the live title comes from the index. */
  title?: string;
}

//
// Inputs and outputs
//

export interface WorkbenchInput {
  /** The topic this workbench is about, linked from the board's topic piece. */
  topic?: TopicView;
  /** The agents connector's complete session index for this person. */
  sessions?: SessionIndexView;
  /** Sessions attached to the topic by hand, the workbench's own record. */
  attached?: Writable<Attachment[] | Default<[]>>;
  /**
   * The command queue the connector's host binds for this piece. Absent until
   * the host has linked it; a start sent before then reaches nothing.
   */
  commands?: Writable<CommandValue[] | Default<[]>>;
  /**
   * Every start this workbench has sent, the workbench's own record. A start
   * the index has confirmed stays here, since the record is what attaches its
   * session; one the index has not confirmed can be withdrawn.
   */
  starts?: Writable<SessionStart[] | Default<[]>>;
  /**
   * The permission mode a started session's first turn runs under, one the
   * driver advertises. Empty leaves the driver's default, which cannot pass a
   * tool or network approval headlessly.
   */
  startMode?: string | Default<"">;
  /** Where a started session runs: `headless` (the default) runs the first
   * turn on this Mac through the connector; `desktop` opens Claude Code on
   * this Mac with the kickoff ready to send, takes no mode, and the session
   * the app makes joins once the person sends it and the connector sees it. */
  startSurface?: string | Default<"">;
  /**
   * Harnesses to list in the picker beside the connector's sources, for a
   * machine that shows a harness it does not run. Picking one starts nothing.
   */
  harnessesShown?: ShownHarness[] | Default<[]>;
}

export interface WorkbenchOutput {
  [NAME]: string;
  [UI]: VNode;
  /** The sessions attached by hand; `attachedSessions` adds the confirmed
   * starts to them. */
  attached: Attachment[] | Default<[]>;
  /** Every attached session, the confirmed starts among them. */
  attachedSessions: SessionRow[];
  /** Starts the index has not confirmed yet. */
  startingSessions: SessionStart[];
  relatedSessions: SessionRow[];
  recentSessions: SessionRow[];
  spawnCommand: string;
  /** The prompt as it will be sent: the person's words, then the topic's
   * context and links. */
  kickoff: string;
  /** Why Start would send nothing, or "" when it would. */
  startBlocker: string;
  spawnPrompt: PerSession<Writable<string>>;
  spawnRoot: PerSession<Writable<string>>;
  spawnSource: PerSession<Writable<string>>;
  /** Attach a session by provider identity. Idempotent. */
  attach: Stream<AttachEvent, AttachResult>;
  /** Detach a session by provider identity, a started one included. */
  detach: Stream<DetachEvent>;
  /**
   * Start a session for the topic: sends the connector a `start` command
   * carrying the kickoff prompt, the picked checkout, and the topic's name as
   * the session title, and records the start. Until the index carries the
   * session the start can be withdrawn; once it does, the record is what
   * attaches the session.
   */
  startSession: Stream<void>;
  // The connector's host reads this field's schema to learn which handler may
  // write the queue it binds for this piece. The field has no stored value.
  commandAuthorization?: WriteAuthorizedBy<
    boolean,
    typeof startSessionCommand
  >;
}

//
// Derivations
//
// Module-scope lifts, because the declared parameter is what bounds the read.

/** Sessions that name the topic without being attached: the topic's number
 * or its title appears in the session's title. A suggestion, not a claim. */
const relatedRowsOf = lift((
  { rows, shortName, title }: {
    rows: SessionRow[];
    shortName: string;
    title: string;
  },
): SessionRow[] => {
  // The number matches as a whole token, so `#1` does not claim `#10`.
  const number = shortName.trim();
  const numberPattern = number
    ? new RegExp(
      `(?:#|top/)${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`,
      "i",
    )
    : undefined;
  const titleNeedle = title.trim().toLowerCase();
  if (!numberPattern && titleNeedle.length < 3) return [];
  return rows.filter((r) =>
    !r.attached && (
      (numberPattern?.test(r.title) ?? false) ||
      (titleNeedle.length >= 3 && r.title.toLowerCase().includes(titleNeedle))
    )
  );
});

/** The topic's links still present, PRs first. */
const presentLinksOf = lift((
  { links }: { links?: TopicLinkView[] | Default<[]> },
): TopicLinkView[] =>
  (links ?? []).filter((l) => l.removedAt === undefined).toSorted((a, b) =>
    (a.kind === "pr" ? 0 : 1) - (b.kind === "pr" ? 0 : 1)
  )
);

/** The prompt a session for this topic starts from: the topic's number and
 * title, and the head of its living document. */
const defaultPromptOf = lift((
  { shortName, title }: {
    shortName: string;
    title: string;
  },
): string => {
  // One sentence. The kickoff's context block carries the document excerpt,
  // so the sentence must not repeat it.
  const name = shortName ? `topic #${shortName}` : "the topic";
  return title.trim() ? `Work on ${name}, "${title}".` : "";
});

/** The prompt a session actually starts from: the person's own words first,
 * then the topic's context, then the links. The person's words are never
 * replaced; an empty box falls back to the default sentence. */
const kickoffOf = lift((
  { prompt, defaultPrompt, shortName, title, body, links }: {
    prompt: string;
    defaultPrompt: string;
    shortName: string;
    title: string;
    body: string;
    links: TopicLinkView[];
  },
): string => {
  const head = prompt.trim() || defaultPrompt;
  if (!title.trim()) return head;
  const name = shortName ? `Topic #${shortName}` : "The topic";
  const opening = snippet(body, 400);
  const context = opening
    ? `${name}, "${title}". Its living document begins: ${opening}`
    : `${name}, "${title}".`;
  // Only links that are http(s) go into a prompt; a stored link that is not
  // (written before the topic's guard) renders as text and is not repeated.
  const urls = links.filter((l) => l.kind === "pr" && isSafeLinkUrl(l.url))
    .map((l) => `- ${l.label ? `${l.label}: ` : ""}${l.url}`);
  return [
    head,
    `Context:\n- ${context}`,
    ...(urls.length ? [`Links:\n${urls.join("\n")}`] : []),
  ].join("\n\n");
});

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command to paste until the connector can start a session itself. */
const spawnCommandOf = lift((
  { root, prompt }: { root: string; prompt: string },
): string =>
  root.trim()
    ? `cd ${shellQuote(root.trim())} && claude ${shellQuote(prompt)}`
    : `claude ${shellQuote(prompt)}`
);

//
// Handlers (browser)
//

const attachFromRow = handler<void, {
  attached: Writable<Attachment[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
  title: string;
}>((_, { attached, sourceId, nativeSessionId, title }) => {
  recordAttachment(attached, {
    sourceId,
    nativeSessionId,
    title,
    attachedAt: Date.now(),
  });
});

const detachFromRow = handler<void, {
  attached: Writable<Attachment[] | Default<[]>>;
  starts: Writable<SessionStart[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
  /** The id the start that made the session named, or "". */
  startedAs: string;
  /** The pairings the complete index carries: a row the index has dropped
   * shows from its record, naming no start, and the start's id comes from
   * here instead. */
  pairings: SessionPairing[];
}>(
  (_, { attached, starts, sourceId, nativeSessionId, startedAs, pairings }) => {
    // A confirmed start is attached through its own record; detaching drops
    // whichever record the session has, under the session's own id or the
    // id its desktop start named.
    dropAttachment(attached, sourceId, nativeSessionId);
    dropStart(
      starts,
      sourceId,
      nativeSessionId,
      startedAs || startedAsOf(pairings, sourceId, nativeSessionId),
    );
  },
);

const useDefaultPrompt = handler<void, {
  spawnPrompt: Writable<string>;
  defaultPrompt: string;
}>((_, { spawnPrompt, defaultPrompt }) => {
  // Add to what the person typed; never replace it.
  const current = spawnPrompt.get().trim();
  spawnPrompt.set(current ? `${current}\n\n${defaultPrompt}` : defaultPrompt);
});

/**
 * Sends the connector a `start` command and records the start, or, bound
 * with `withdraw`, takes a start back. Exported because the connector's host
 * binds this piece's queue to this handler by name: only a write from here is
 * accepted on that queue, so both the start and its withdrawal go through it.
 */
export const startSessionCommand = handler<void, {
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
  shortName: string;
  title: string;
  startMode: string;
  /** Where the session runs: "desktop" opens Claude Code on this Mac and
   * sends no mode; anything else runs the first turn here. */
  startSurface: string;
  /** The sources that can open a session in Claude Code on this Mac. */
  desktopSources: string[];
  /** The title of a start the index has not confirmed, or "": one start at
   * a time, so a second click while the first is on its way sends nothing. */
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
    pending: state.pending,
    surface: state.startSurface.trim(),
    desktopCapable: state.desktopSources,
  });
  if (blocked) return;
  const sourceId = startSourceOf(
    picked,
    state.sourceOptions,
    state.configuredSources,
  );
  const nativeSessionId = mintSessionId();
  const sessionTitle = state.shortName
    ? `topic #${state.shortName}: ${state.title}`
    : state.title;
  const desktop = state.startSurface.trim() === "desktop";
  const command = startCommandValue({
    ownerDid: state.ownerDid,
    idPrefix: "workbench",
    sourceId,
    nativeSessionId,
    text: state.kickoff,
    cwd: state.spawnRoot.get().trim(),
    title: sessionTitle,
    mode: desktop ? undefined : state.startMode.trim(),
    surface: desktop ? "desktop" : undefined,
  });
  state.commands.push(command.value);
  // Recorded, not attached: nothing here knows whether a queue took the
  // command or the connector accepted it. The start shows as starting until
  // the index carries the session, and can be withdrawn until then.
  recordStart(state.starts, {
    commandId: command.id,
    sourceId,
    nativeSessionId,
    title: sessionTitle,
    startedAt: Date.now(),
  });
  // The words went with the start; the composer is ready for the next one,
  // and Start stays disabled until this one is confirmed or withdrawn.
  state.spawnPrompt.set("");
});

//
// The pattern
//

export default pattern<WorkbenchInput, WorkbenchOutput>(
  (
    {
      topic,
      sessions,
      attached,
      commands,
      starts,
      startMode,
      startSurface,
      harnessesShown,
    },
  ) => {
    const spawnPrompt = new Writable.perSession("");
    const spawnRoot = new Writable.perSession("");
    const spawnSource = new Writable.perSession("");

    const title = topic?.title ?? "";
    const shortName = topic?.shortName ?? "";
    const body = topic?.body ?? "";
    const commentCount = topic?.commentCount ?? 0;
    const lastActivityAt = topic?.lastActivityAt ?? 0;
    const hasTopic = title.trim().length > 0;
    const hasBody = body.trim().length > 0;

    const confirmedStarts = confirmedStartsOf({ starts, index: sessions });
    const attachments = attachmentsOf({ attached, confirmed: confirmedStarts });
    const startingSessions = startingOf({ starts, index: sessions });
    const pendingStart = pendingStartOf({ starting: startingSessions });
    const rows = sessionRowsOf({ index: sessions, attached: attachments });
    const attachedSessions = attachedRowsOf({ attached: attachments, rows });
    const relatedSessions = relatedRowsOf({ rows, shortName, title });
    const recentSessions = recentRowsOf({ rows, limit: 8 });
    const links = presentLinksOf({ links: topic?.links });
    const checkoutOptions = checkoutOptionsOf({ index: sessions });
    const sourceOptions = sourceOptionsOf({
      index: sessions,
      shown: harnessesShown,
    });
    const configuredSources = configuredSourcesOf({ index: sessions });
    const indexNote = indexNoteOf({ index: sessions });
    const ownerDid = sessions?.ownerDid ?? "";
    const mode = startMode ?? "";
    const surface = startSurface ?? "";
    const desktopSources = desktopSourcesOf({ index: sessions });
    const pairings = pairingsOf({ index: sessions });
    const startModeNote = computed(() =>
      mode.trim() && surface.trim() !== "desktop"
        ? ` The first turn runs under the "${mode.trim()}" permission mode; the kickoff below is exactly what it receives.`
        : ""
    );
    const defaultPrompt = defaultPromptOf({ shortName, title });
    const kickoff = kickoffOf({
      prompt: spawnPrompt,
      defaultPrompt,
      shortName,
      title,
      body,
      links,
    });
    const spawnCommand = spawnCommandOf({ root: spawnRoot, prompt: kickoff });
    const startBlocker = startBlockerOf({
      ownerDid,
      picked: spawnSource,
      options: sourceOptions,
      startable: configuredSources,
      kickoff,
      pending: pendingStart,
      surface,
      desktopCapable: desktopSources,
    });
    const canStart = isEmptyText({ text: startBlocker });
    const startNote = computed(() =>
      surface.trim() === "desktop"
        ? "Opens Claude Code on this Mac with the kickoff ready to send; the start shows above as starting until you send it there and the connector sees the session, and can be withdrawn until then."
        : "Runs the first turn on this Mac through the connector; the start shows above as starting until the connector publishes the session, and can be withdrawn until then."
    );
    const startingCaption = computed(() =>
      surface.trim() === "desktop"
        ? "sent to Claude Code on this Mac; attaches once you send it there and the connector sees the session"
        : "sent to the connector; attaches when the session appears in the index"
    );
    // The one handler the queue accepts writes from, bound here for Start
    // and once per starting row for Withdraw.
    const startSession = startSessionCommand({
      commands,
      starts,
      spawnRoot,
      spawnSource,
      sourceOptions,
      configuredSources,
      spawnPrompt,
      kickoff,
      ownerDid,
      shortName,
      title,
      startMode: mode,
      startSurface: surface,
      desktopSources,
      pending: pendingStart,
    });

    const hasAttached = attachedSessions.length > 0;
    const hasStarting = startingSessions.length > 0;
    const hasRelated = relatedSessions.length > 0;
    const hasRecent = recentSessions.length > 0;
    const hasLinks = links.length > 0;
    const hasIndex = computed(() => rows.length > 0);
    const indexNoteEmpty = isEmptyText({ text: indexNote });
    const hasIndexNote = computed(() => !indexNoteEmpty);
    const hasPrompt = computed(() =>
      spawnPrompt.get().trim().length > 0 || hasTopic
    );

    // Verbs, headless: a skill inside a session can attach itself.

    const attach = action<AttachEvent, AttachResult>(
      ({ sourceId, nativeSessionId, title: given }) => {
        const source = (sourceId ?? "").trim();
        const native = (nativeSessionId ?? "").trim();
        if (!source || !native) {
          throw new Error("attach: sourceId and nativeSessionId are required");
        }
        const attachedAt = Date.now();
        const added = recordAttachment(attached, {
          sourceId: source,
          nativeSessionId: native,
          title: (given ?? "").trim(),
          attachedAt,
        });
        return { attachedAt, added };
      },
    );

    const detach = action<DetachEvent>(({ sourceId, nativeSessionId }) => {
      const source = (sourceId ?? "").trim();
      const native = (nativeSessionId ?? "").trim();
      dropAttachment(attached, source, native);
      dropStart(starts, source, native, startedAsOf(pairings, source, native));
    });

    return {
      [NAME]: hasTopic ? `Workbench: ${title}` : "Workbench (no topic)",
      [UI]: (
        <cf-theme theme={TOPICS_THEME}>
          <cf-screen>
            <cf-vstack slot="header" gap="1" padding="4">
              <cf-hstack gap="2" align="center">
                {shortName
                  ? (
                    <cf-badge size="sm" color="primary" data-member-name="">
                      {shortName}
                    </cf-badge>
                  )
                  : null}
                <cf-text
                  block
                  style="font-size: 1.25rem; font-weight: 600; flex: 1; min-width: 0;"
                >
                  {hasTopic ? title : "No topic linked yet"}
                </cf-text>
              </cf-hstack>
              <cf-text variant="caption" tone="muted">
                {hasTopic
                  ? `Your part of it · ${attachedSessions.length} sessions attached · ${recentSessions.length} recent · ${links.length} links · ${commentCount} comments · last activity ${
                    whenLabel(lastActivityAt)
                  }`
                  : "Link a topic into this workbench's `topic` input."}
              </cf-text>
            </cf-vstack>

            <cf-vstack gap="3" padding="4">
              {/* Two panes side by side; one column when the window is narrow. */}
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(24rem, 100%), 1fr)); gap: 0.75rem; align-items: start;">
                {/* Left: the topic's own material. */}
                <cf-vstack gap="3" style="min-width: 0;">
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={5}>Living document</cf-heading>
                      {hasBody
                        ? <cf-markdown content={body} />
                        : (
                          <cf-text tone="muted" block>
                            The topic has no body yet.
                          </cf-text>
                        )}
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={5}>Links</cf-heading>
                        <cf-text variant="caption" tone="muted">
                          PRs first
                        </cf-text>
                      </cf-hstack>
                      {hasLinks
                        ? (
                          <cf-vstack gap="1">
                            {links.map((link) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-link-row=""
                              >
                                <cf-badge
                                  size="xs"
                                  color={link.kind === "pr"
                                    ? "primary"
                                    : "neutral"}
                                >
                                  {link.kind}
                                </cf-badge>
                                {isSafeLinkUrl(link.url)
                                  ? (
                                    <a
                                      href={link.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                                    >
                                      {link.label || link.url}
                                    </a>
                                  )
                                  : (
                                    <cf-text
                                      tone="muted"
                                      style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                                    >
                                      {link.label || link.url}
                                    </cf-text>
                                  )}
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : (
                          <cf-text tone="muted" block>
                            The topic has no links yet.
                          </cf-text>
                        )}
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>

                {/* Right: your sessions, and the next one. */}
                <cf-vstack gap="3" style="min-width: 0;">
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={5}>
                          Sessions on this topic
                        </cf-heading>
                        <cf-text variant="caption" tone="muted">
                          {attachedSessions.length} attached
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
                      {hasAttached
                        ? (
                          <cf-vstack gap="2">
                            {attachedSessions.map((row) => (
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
                                  variant="ghost"
                                  size="sm"
                                  data-detach=""
                                  onClick={detachFromRow({
                                    attached,
                                    starts,
                                    sourceId: row.sourceId,
                                    nativeSessionId: row.nativeSessionId,
                                    startedAs: row.startedAs,
                                    pairings,
                                  })}
                                >
                                  Detach
                                </cf-button>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : (
                          <cf-text tone="muted" block>
                            No sessions attached. Attach one below, or start
                            one.
                          </cf-text>
                        )}
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
                                    {`${start.sourceId} · ${startingCaption}`}
                                  </cf-text>
                                </cf-vstack>
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  data-withdraw=""
                                  onClick={startSessionCommand({
                                    commands,
                                    starts,
                                    spawnRoot,
                                    spawnSource,
                                    sourceOptions,
                                    configuredSources,
                                    spawnPrompt,
                                    kickoff,
                                    ownerDid,
                                    shortName,
                                    title,
                                    startMode: mode,
                                    startSurface: surface,
                                    desktopSources,
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
                    </cf-vstack>
                  </cf-card>

                  {hasRelated
                    ? (
                      <cf-card>
                        <cf-vstack gap="2">
                          <cf-hstack justify="between" align="center">
                            <cf-heading level={5}>Looks related</cf-heading>
                            <cf-text variant="caption" tone="muted">
                              titles that name this topic
                            </cf-text>
                          </cf-hstack>
                          <cf-vstack gap="2">
                            {relatedSessions.map((row) => (
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
                                  onClick={attachFromRow({
                                    attached,
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
                        </cf-vstack>
                      </cf-card>
                    )
                    : null}

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={5}>Recent sessions</cf-heading>
                        <cf-text variant="caption" tone="muted">
                          newest first
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
                                  onClick={attachFromRow({
                                    attached,
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
                            {hasIndex
                              ? "Every session the connector knows is attached."
                              : "No session index linked, or the connector has not collected yet."}
                          </cf-text>
                        )}
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={5}>Start a session</cf-heading>
                      <cf-text variant="caption" tone="muted">
                        Your words go first; the topic's context and links
                        follow.
                      </cf-text>
                      <cf-field label="Prompt">
                        <cf-textarea
                          $value={spawnPrompt}
                          rows={3}
                          placeholder={defaultPrompt}
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
                        <cf-button
                          variant="ghost"
                          onClick={useDefaultPrompt({
                            spawnPrompt,
                            defaultPrompt,
                          })}
                        >
                          Add the topic's words
                        </cf-button>
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
                          {canStart ? startNote : startBlocker}
                          {startModeNote}
                        </cf-text>
                      </cf-hstack>
                      {hasPrompt
                        ? (
                          <cf-vstack gap="2">
                            <cf-field label="Kickoff prompt, as it will be sent">
                              <cf-text
                                block
                                data-kickoff=""
                                style="font-family: ui-monospace, monospace; font-size: 0.82em; white-space: pre-wrap;"
                              >
                                {kickoff}
                              </cf-text>
                            </cf-field>
                            <cf-field label="Or run it yourself">
                              <cf-text
                                block
                                data-spawn-command=""
                                style="font-family: ui-monospace, monospace; font-size: 0.82em; white-space: pre-wrap; word-break: break-all;"
                              >
                                {spawnCommand}
                              </cf-text>
                            </cf-field>
                          </cf-vstack>
                        )
                        : null}
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>
              </div>
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
      attached,
      attachedSessions,
      startingSessions,
      relatedSessions,
      recentSessions,
      spawnCommand,
      kickoff,
      startBlocker,
      spawnPrompt,
      spawnRoot,
      spawnSource,
      attach,
      detach,
      startSession,
    };
  },
);
