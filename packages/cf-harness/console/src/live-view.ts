/**
 * One session's work as it happens, in a pane narrow enough to sit beside the
 * thing that asked for it. A host that can only open a plain web address —
 * Loom's task panel among them — opens `/live/<sessionId>` and watches the
 * harness build the piece it asked for, until the piece itself replaces the
 * pane.
 *
 * The event stream is the source. Its durable log is replayed from sequence
 * zero when the page loads, so a pane opened halfway through a turn shows what
 * already happened rather than only what comes next, and a reconnect resumes
 * from the last sequence rendered. Nothing here polls.
 *
 * What the stream carries is the order and the outcome; what a call was given,
 * what CFC decided about it, and what was withheld from the model live in the
 * run's artifacts. So a run is re-read when one of its tool calls completes —
 * the turn's own, whose id is the turn id, and a `delegate_task` child's, whose
 * calls its parent's run does not record — and the two readings are joined by
 * tool call id. The join is what puts a CFC line under a step in a pane that is
 * otherwise a feed.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  type ConsoleChatEventEnvelope,
  type ConsoleRunDetail,
  readRun,
} from "./api.ts";
import { consolePath, pageMount } from "./mount.ts";
import { stepPolicyView, withheldView } from "./steps-view.ts";
import type { ConsoleStep } from "../steps.ts";
import type { ConsoleTurnResultPiece } from "../turn-result.ts";

/** The `delegate_task` child a line belongs to, for the lines under one. */
interface LiveSubagent {
  parentToolCallId: string;
  profile: string;
}

/** One line of the feed. */
export type ConsoleLiveEntry =
  | { kind: "turn"; key: string; turnId: string; startedAt: string }
  | {
    kind: "assistant";
    key: string;
    turnId?: string;
    text: string;
    subagent?: LiveSubagent;
  }
  | {
    kind: "tool";
    key: string;
    turnId?: string;
    toolCallId: string;
    toolName: string;
    title?: string;
    startedAt?: string;
    endedAt?: string;
    status: "running" | "completed" | "failed" | "denied" | "canceled";
    progress?: string;
    resultSummary?: string;
    subagent?: LiveSubagent;
  }
  | {
    kind: "subagent";
    key: string;
    turnId?: string;
    profile: string;
    goal?: string;
    status: "running" | "completed" | "failed";
  }
  | {
    kind: "ended";
    key: string;
    turnId: string;
    status: "completed" | "failed" | "canceled";

    /** Task disposition inside a successfully ended turn. */
    outcome?: "completed" | "question" | "gave-up";

    text?: string;
    pieces: readonly ConsoleTurnResultPiece[];

    /** The space the pieces are in, which composing an address needs. */
    spaceName?: string;
  };

/**
 * The arguments that say what a call was about, in the order a line prefers
 * them. A tool the run's own reading does not cover — every tool but the four
 * it names — is described by the first of these its call carried.
 */
const SUBJECT_ARGUMENTS = [
  "task",
  "question",
  "query",
  "path",
  "slug",
  "name",
];

/** How much of a result or a goal one line carries before it is elided. */
const LINE_LIMIT = 140;

const elide = (text: string, limit = LINE_LIMIT): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** The whitespace a model's own wording carries, flattened to one line. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const asRecord = (value: unknown): Record<string, unknown> =>
  isObjectNotArray(value) ? value as Record<string, unknown> : {};

const parsedRecord = (text: string | undefined): Record<string, unknown> => {
  try {
    return asRecord(JSON.parse(text ?? ""));
  } catch {
    // A result the tool did not write as JSON has no fields to read; the line
    // falls back to the tool's name, which is still what happened.
    return {};
  }
};

/** What a live address names. */
export interface ConsoleLiveAddress {
  /** The session the pane shows, absent for an address naming none. */
  sessionId?: string;

  /** The one turn the pane is narrowed to, when the address asks for one. */
  turnId?: string;

  /**
   * Where the host renders a piece, without its trailing slash. A piece's own
   * address is the one the run recorded, which is the Fabric API's; a host
   * that renders pieces somewhere else says where, and the pane composes
   * against it instead.
   */
  piecesBase?: string;

  /** A `piecesBase` the address carried and this refused. */
  piecesBaseRefused?: true;
}

/**
 * A `piecesBase` the pane will compose against, or nothing. It has to be an
 * absolute `http` or `https` address: the parameter reaches the page from
 * whatever opened it, and it ends up in an `href`, so a `javascript:` or a
 * relative path is refused rather than resolved. The trailing slash goes,
 * because the composition adds its own.
 */
const piecesBaseFrom = (raw: string | null): string | undefined => {
  if (raw === null || raw === "") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  return raw.replace(/\/+$/, "");
};

/**
 * Where one piece is opened. The host that renders pieces somewhere other than
 * the Fabric API says so with `piecesBase`, and the pane composes the address
 * from the space and the slug the run recorded; with no base named, the URL
 * the run recorded is used as it stands rather than rebuilt.
 */
export const consoleLivePieceHref = (
  piece: ConsoleTurnResultPiece,
  spaceName: string | undefined,
  piecesBase: string | undefined,
): string =>
  piecesBase === undefined || spaceName === undefined
    ? piece.url
    : `${piecesBase}/${encodeURIComponent(spaceName)}/${
      encodeURIComponent(piece.slug)
    }`;

/**
 * What the address a pane was opened at names. The session is the last segment
 * of `/live/<sessionId>`, so the pane is a link a host can compose rather than
 * a query a script has to build, and the turn is `?turn=`.
 */
export const consoleLiveAddress = (
  pathname: string,
  search = "",
): ConsoleLiveAddress => {
  // The segment holds at least one character and decoding never gives back
  // fewer, so a match always names a session.
  // Anchored at the end and not the start: a host may front the console
  // under a prefix (`./mount.ts`), and the session is still the last segment.
  const match = /\/live\/([^/]+)\/?$/.exec(pathname);
  let sessionId: string | undefined;
  if (match !== null) {
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      // An escape the address got wrong names no session, so the pane says so
      // rather than opening a stream for an id it repaired into existence.
      sessionId = undefined;
    }
  }
  const params = new URLSearchParams(search);
  const turn = params.get("turn");
  const rawBase = params.get("piecesBase");
  const piecesBase = piecesBaseFrom(rawBase);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(turn === null || turn === "" ? {} : { turnId: turn }),
    ...(piecesBase === undefined ? {} : { piecesBase }),
    ...(rawBase !== null && rawBase !== "" && piecesBase === undefined
      ? { piecesBaseRefused: true as const }
      : {}),
  };
};

/**
 * The runs one event says to re-read. A run writes its artifacts as it goes,
 * so a call that completed is when there is more of its run to read — the
 * turn's own run, and the `delegate_task` child's run when a child made the
 * call, because the parent's run does not record it.
 */
export const consoleLiveRunReads = (
  envelope: ConsoleChatEventEnvelope,
): readonly string[] => {
  const event = envelope.event;
  const turnRun = envelope.turnId !== undefined &&
      (event.kind === "tool_completed" || event.kind === "turn_completed" ||
        event.kind === "turn_failed")
    ? [envelope.turnId]
    : [];
  const childRun = event.kind === "tool_completed"
    ? event.subagent?.childRunId
    : event.kind === "subagent_completed"
    ? event.subagent.childRunId
    : undefined;
  return childRun === undefined ? turnRun : [...turnRun, childRun];
};

/**
 * The feed the events add up to, in the order they arrived. One tool call is
 * one line however many events it produced: a call that started, reported
 * progress and completed reads as a step that ran and finished, which is what
 * a pane this narrow has room to say.
 *
 * A turn id narrows the feed to that turn. An envelope carrying no turn at all
 * — the session's own lifecycle — belongs to no turn and is left out of a
 * narrowed feed rather than shown under whichever turn is open.
 */
export const consoleLiveEntries = (
  envelopes: readonly ConsoleChatEventEnvelope[],
  turnId?: string,
): readonly ConsoleLiveEntry[] => {
  const entries: ConsoleLiveEntry[] = [];
  const tools = new Map<string, Extract<ConsoleLiveEntry, { kind: "tool" }>>();
  const subagents = new Map<
    string,
    Extract<ConsoleLiveEntry, { kind: "subagent" }>
  >();
  let openAssistant:
    | Extract<ConsoleLiveEntry, { kind: "assistant" }>
    | undefined;
  for (
    const envelope of [...envelopes].sort((left, right) =>
      left.sequence - right.sequence
    )
  ) {
    if (turnId !== undefined && envelope.turnId !== turnId) {
      continue;
    }
    const event = envelope.event;
    const named = {
      key: `${envelope.sequence}`,
      ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
    };
    const under = (
      subagent: { parentToolCallId: string; profile: string } | undefined,
    ) =>
      subagent === undefined ? {} : {
        subagent: {
          parentToolCallId: subagent.parentToolCallId,
          profile: subagent.profile,
        },
      };
    // Assistant prose runs until something else happens, so any other event
    // closes the block the deltas were accumulating into.
    if (
      event.kind !== "assistant_delta" && event.kind !== "assistant_completed"
    ) {
      openAssistant = undefined;
    }
    switch (event.kind) {
      case "turn_started": {
        entries.push({
          kind: "turn",
          key: named.key,
          turnId: event.turn.turnId,
          startedAt: event.turn.startedAt,
        });
        break;
      }
      case "assistant_delta": {
        if (openAssistant === undefined) {
          openAssistant = {
            kind: "assistant",
            ...named,
            text: event.text,
            ...under(event.subagent),
          };
          entries.push(openAssistant);
        } else {
          openAssistant.text += event.text;
        }
        break;
      }
      case "assistant_completed": {
        // The completed event carries the whole message, so it settles the
        // text rather than adding to it — however many deltas preceded it.
        if (openAssistant === undefined) {
          entries.push({
            kind: "assistant",
            ...named,
            text: event.text,
            ...under(event.subagent),
          });
        } else {
          openAssistant.text = event.text;
        }
        openAssistant = undefined;
        break;
      }
      case "tool_started": {
        const entry: Extract<ConsoleLiveEntry, { kind: "tool" }> = {
          kind: "tool",
          ...named,
          toolCallId: event.tool.toolCallId,
          toolName: event.tool.toolId,
          ...(event.tool.title === undefined ? {} : {
            title: event.tool.title,
            startedAt: envelope.emittedAt,
          }),
          status: "running",
          ...under(event.subagent),
        };
        tools.set(entry.toolCallId, entry);
        entries.push(entry);
        break;
      }
      case "tool_progress": {
        const held = tools.get(event.toolCallId);
        if (held !== undefined) {
          held.progress = event.message;
        }
        break;
      }
      case "tool_completed": {
        const held = tools.get(event.tool.toolCallId);
        const entry: Extract<ConsoleLiveEntry, { kind: "tool" }> = held ?? {
          kind: "tool" as const,
          ...named,
          toolCallId: event.tool.toolCallId,
          toolName: event.tool.toolId,
          status: "running" as const,
          ...under(event.subagent),
        };
        entry.status = event.status;
        if (event.tool.title !== undefined) entry.title = event.tool.title;
        if (entry.startedAt !== undefined) entry.endedAt = envelope.emittedAt;
        if (event.resultSummary !== undefined) {
          entry.resultSummary = event.resultSummary;
        }
        if (held === undefined) {
          entries.push(entry);
        }
        break;
      }
      case "subagent_started": {
        const entry: Extract<ConsoleLiveEntry, { kind: "subagent" }> = {
          kind: "subagent",
          ...named,
          profile: event.subagent.profile,
          ...(event.subagent.goal === undefined || event.subagent.goal === ""
            ? {}
            : { goal: event.subagent.goal }),
          status: "running",
        };
        subagents.set(event.subagent.parentToolCallId, entry);
        entries.push(entry);
        break;
      }
      case "subagent_completed": {
        const held = subagents.get(event.subagent.parentToolCallId);
        if (held !== undefined) {
          held.status = event.status;
        }
        break;
      }
      case "turn_completed": {
        // Normal final answers already appear in the assistant feed. A
        // finish_task question or reason lives in a tool result, so the
        // closing block renders that sentence alongside any piece links.
        entries.push({
          kind: "ended",
          key: named.key,
          turnId: event.turnId,
          status: "completed",
          outcome: event.result.outcome ?? "completed",
          ...(event.result.outcome === "question" ||
              event.result.outcome === "gave-up"
            ? { text: event.result.finalText }
            : {}),
          pieces: event.result.pieces,
          spaceName: event.result.spaceName,
        });
        break;
      }
      case "turn_failed": {
        for (const entry of tools.values()) {
          if (
            entry.turnId === event.turnId && entry.startedAt && !entry.endedAt
          ) {
            entry.endedAt = envelope.emittedAt;
            entry.status = "failed";
          }
        }
        entries.push({
          kind: "ended",
          key: named.key,
          turnId: event.turnId,
          status: "failed",
          text: event.error.message,
          pieces: [],
        });
        break;
      }
      case "turn_canceled": {
        for (const entry of tools.values()) {
          if (
            entry.turnId === event.turnId && entry.startedAt && !entry.endedAt
          ) {
            entry.endedAt = envelope.emittedAt;
            entry.status = "canceled";
          }
        }
        entries.push({
          kind: "ended",
          key: named.key,
          turnId: event.turnId,
          status: "canceled",
          ...(event.reason === undefined ? {} : { text: event.reason }),
          pieces: [],
        });
        break;
      }
      default:
        break;
    }
  }
  return entries;
};

/**
 * What one tool call was about, in a line. The run's own reading of its
 * transcript supplies what the call was given — the pattern attempt and its
 * compiler message, the search's query, the name a piece was assigned — and
 * the step supplies the rest, because a tool the reading does not cover still
 * carries its arguments. A call whose run has not been read yet has no line,
 * which is what a step still running looks like.
 */
export const consoleLiveToolLine = (
  entry: Extract<ConsoleLiveEntry, { kind: "tool" }>,
  detail: ConsoleRunDetail | undefined,
  step: ConsoleStep | undefined,
): string | undefined => {
  const lens = detail?.lens;
  if (entry.toolName === "run_pattern") {
    const index = lens?.patternAttempts.findIndex((attempt) =>
      attempt.toolCallId === entry.toolCallId
    ) ?? -1;
    const attempt = index < 0 ? undefined : lens?.patternAttempts[index];
    const outcome = attempt === undefined
      ? undefined
      : attempt.message === undefined
      ? attempt.status
      : `${attempt.status}: ${oneLine(attempt.message)}`;
    const ordinal = index < 0 ? "" : `attempt ${index + 1}`;
    return elide(
      [ordinal, outcome].filter((part) =>
        part !== undefined && part !== ""
      )
        .join(" · "),
    );
  }
  if (entry.toolName === "assign_slug") {
    const piece = lens?.pieces.find((named) =>
      named.toolCallId === entry.toolCallId
    );
    const slug = piece?.slug ?? parsedRecord(entry.resultSummary).slug;
    return typeof slug === "string" ? slug : undefined;
  }
  if (entry.toolName === "search_patterns") {
    return elide(
      lens?.searches.find((search) => search.toolCallId === entry.toolCallId)
        ?.query ?? "",
    ) || undefined;
  }
  const input = asRecord(step?.input);
  for (const key of SUBJECT_ARGUMENTS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      return elide(oneLine(value));
    }
  }
  return undefined;
};

/**
 * What the header says the pane is doing, read off the feed rather than off
 * the event that arrived. The feed is already narrowed to the turn the address
 * names, so a header derived from it cannot report a sibling turn's progress
 * the way one advanced per event does; and what the reader is told is then the
 * same thing they are shown.
 */
export const consoleLiveState = (
  entries: readonly ConsoleLiveEntry[],
): string => {
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "ended") {
      return entry.outcome === "question"
        ? "waiting for your answer"
        : entry.outcome === "gave-up"
        ? "stopped"
        : entry.status === "completed"
        ? "done"
        : entry.status;
    }
    if (entry.kind === "tool" && entry.status === "running") {
      return entry.toolName;
    }
    if (entry.kind === "turn") {
      return "working";
    }
  }
  return entries.length === 0 ? "connecting" : "working";
};

/**
 * Whether a feed scrolled this far is at its tail. The last row is rarely
 * flush with the bottom of the scroller — a fractional row height leaves a
 * pixel or two — so a reader is taken to be at the tail when they are within
 * a row's rounding of it.
 */
export const consoleLiveAtTail = (feed: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 8;

/**
 * Whether a step held anything back from the model, and so has an omission
 * block worth opening. A pane this narrow marks the results that withheld
 * something rather than every result that recorded that it withheld nothing.
 */
export const stepWithheldAnything = (step: ConsoleStep): boolean =>
  step.policy?.decision === "withheld" ||
  (step.withheld.status === "recorded" && step.withheld.locations.length > 0) ||
  step.withheld.status === "record-unreadable" ||
  step.withheld.status === "record-entry-missing";

export class ConsoleLive extends LitElement {
  static override properties = {
    sessionId: { attribute: false },
    turnId: { attribute: false },
    piecesBase: { attribute: false },
    piecesBaseRefused: { attribute: false },
    entries: { attribute: false },
    details: { attribute: false },
    state: { attribute: false },
    error: { attribute: false },
  };

  /** The session this pane is showing, read from the address it was opened at. */
  declare sessionId: string | undefined;

  /** The one turn the pane is narrowed to, when the address names one. */
  declare turnId: string | undefined;

  /** Where the host renders a piece, when the address says somewhere. */
  declare piecesBase: string | undefined;

  /** Whether the address carried a `piecesBase` this pane refused. */
  declare piecesBaseRefused: boolean;

  declare entries: readonly ConsoleLiveEntry[];

  /**
   * The runs read so far, by run id. A turn's own run is filed under the turn
   * id, which is the run id a console turn takes; a `delegate_task` child's
   * run is filed under the id the delegation named, because a child's calls
   * are recorded in the child's own run rather than in its parent's.
   */
  declare details: ReadonlyMap<string, ConsoleRunDetail>;

  declare state: string;
  declare error: string | undefined;

  /** Every envelope rendered, which the feed is recomputed from. */
  #envelopes: ConsoleChatEventEnvelope[] = [];

  /** The last sequence rendered; every reconnect resumes from it. */
  #lastSequence = 0;

  #stream: EventSource | undefined;
  #elapsedTimer: ReturnType<typeof setInterval> | undefined;

  /** Which read of a run is the current one, by run id. */
  #reads = new Map<string, number>();

  /**
   * Whether the feed is following the tail. A pane watching a task run wants
   * the newest step in view, and a reader who scrolls up to read an earlier
   * one wants to stay where they scrolled to.
   */
  #pinned = true;

  constructor() {
    super();
    this.entries = [];
    this.details = new Map();
    this.state = "connecting";
    this.piecesBaseRefused = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override updated(): void {
    if (
      this.#stream !== undefined &&
      this.entries.some((entry) =>
        entry.kind === "tool" && entry.startedAt !== undefined &&
        entry.endedAt === undefined
      )
    ) {
      this.#elapsedTimer ??= setInterval(() => this.requestUpdate(), 1000);
    } else {
      clearInterval(this.#elapsedTimer);
      this.#elapsedTimer = undefined;
    }
    if (!this.#pinned) {
      return;
    }
    const feed = this.querySelector(".live-feed");
    feed?.scrollTo({ top: feed.scrollHeight });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    const address = consoleLiveAddress(location.pathname, location.search);
    this.sessionId = address.sessionId;
    this.turnId = address.turnId;
    this.piecesBase = address.piecesBase;
    this.piecesBaseRefused = address.piecesBaseRefused === true;
    if (this.sessionId === undefined) {
      this.state = "no session";
      this.error = "This address names no session.";
      return;
    }
    this.#subscribe(this.sessionId);
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#stream?.close();
    this.#stream = undefined;
    clearInterval(this.#elapsedTimer);
    this.#elapsedTimer = undefined;
  }

  /**
   * Opens the stream, replaying everything the session has already recorded.
   * A reconnect asks from the last sequence rendered, so the feed a reader is
   * watching is continuous across one.
   */
  #subscribe(sessionId: string): void {
    this.#stream?.close();
    const stream = new EventSource(
      consolePath(
        pageMount(),
        `/api/events?sessionId=${
          encodeURIComponent(sessionId)
        }&afterSequence=${this.#lastSequence}`,
      ),
    );
    this.#stream = stream;
    stream.addEventListener("chat", (message) => {
      this.#onEvent(JSON.parse((message as MessageEvent<string>).data));
    });
    stream.addEventListener("error", () => {
      if (stream.readyState === EventSource.CLOSED) {
        this.#subscribe(sessionId);
      }
    });
  }

  #onEvent(envelope: ConsoleChatEventEnvelope): void {
    if (envelope.sequence <= this.#lastSequence) {
      return;
    }
    this.#lastSequence = envelope.sequence;
    this.#envelopes.push(envelope);
    this.entries = consoleLiveEntries(this.#envelopes, this.turnId);
    this.state = consoleLiveState(this.entries);
    // The re-read is driven by the event that says there is more of a run to
    // read, rather than by a clock.
    for (const runId of consoleLiveRunReads(envelope)) {
      void this.#readRun(runId);
    }
  }

  /**
   * Re-reads one run. A run with no artifacts yet is not an error to report:
   * the feed is what the stream said, and the run is what enriches it once it
   * exists.
   */
  async #readRun(runId: string): Promise<void> {
    const read = (this.#reads.get(runId) ?? 0) + 1;
    this.#reads.set(runId, read);
    try {
      const detail = await readRun(runId);
      if (this.#reads.get(runId) === read) {
        this.details = new Map(this.details).set(runId, detail);
      }
    } catch {
      // The run has written nothing yet, or this console does not hold it.
    }
  }

  /**
   * The run that recorded one call, and its step. A call a `delegate_task`
   * child made is recorded in the child's run rather than in the run of the
   * turn it happened under, so the call is looked for across every run read
   * rather than in the one the event was tagged with.
   */
  #recordOf(
    toolCallId: string,
  ): { detail: ConsoleRunDetail; step: ConsoleStep } | undefined {
    for (const detail of this.details.values()) {
      const step = detail.steps.find((candidate) =>
        candidate.toolCallId === toolCallId
      );
      if (step !== undefined) {
        return { detail, step };
      }
    }
    return undefined;
  }

  /** Follows the reader, until they scroll away from the tail. */
  #onScroll(event: Event): void {
    this.#pinned = consoleLiveAtTail(event.target as HTMLElement);
  }

  #toolEntry(
    entry: Extract<ConsoleLiveEntry, { kind: "tool" }>,
  ): TemplateResult {
    const record = this.#recordOf(entry.toolCallId);
    const step = record?.step;
    const line = consoleLiveToolLine(entry, record?.detail, step);
    const elapsed = entry.startedAt === undefined ? undefined : Math.max(
      0,
      Math.floor(
        ((entry.endedAt === undefined
          ? Date.now()
          : Date.parse(entry.endedAt)) -
          Date.parse(entry.startedAt)) / 1000,
      ),
    );
    return html`
      <div class="live-entry tool ${entry.subagent === undefined
        ? ""
        : "child"}">
        <div class="live-head">
          <span class="live-dot ${entry.status}"></span>
          <span class="tool">${entry.title ?? entry.toolName}</span>
          ${elapsed === undefined ? nothing : html`
            <span class="muted">${elapsed}s elapsed</span>
          `}
          ${entry.status === "running" ? nothing : html`
            <span class="badge ${entry.status === "completed"
              ? "ok"
              : "denied"}">${entry.status}</span>
          `}
        </div>
        ${line === undefined ? nothing : html`
          <div class="live-line">${line}</div>
        `} ${entry.progress === undefined ? nothing : html`
          <div class="live-line muted">${elide(entry.progress)}</div>
        `} ${step === undefined
          ? nothing
          : stepPolicyView(step)} ${step === undefined ||
            !stepWithheldAnything(step)
          ? nothing
          : withheldView(step)}
      </div>
    `;
  }

  #entry(entry: ConsoleLiveEntry): TemplateResult {
    switch (entry.kind) {
      case "turn":
        return html`
          <div class="live-entry turn">
            <span>task started</span>
            <span class="muted">
              ${new Date(entry.startedAt).toLocaleTimeString()}
            </span>
          </div>
        `;
      case "assistant":
        return html`
          <div
            class="live-entry said ${entry.subagent === undefined
              ? ""
              : "child"}"
          >
            ${entry.text}
          </div>
        `;
      case "tool":
        return this.#toolEntry(entry);
      case "subagent":
        return html`
          <div class="live-entry subagent">
            <div class="live-head">
              <span class="live-dot ${entry.status}"></span>
              <span class="tool">${entry.profile}</span>
              ${entry.status === "running" ? nothing : html`
                <span class="badge ${entry.status === "completed"
                  ? "ok"
                  : "denied"}">${entry.status}</span>
              `}
            </div>
            ${entry.goal === undefined ? nothing : html`
              <div class="live-line">${elide(oneLine(entry.goal))}</div>
            `}
          </div>
        `;
      case "ended":
        return html`
          <div class="live-entry ended ${entry.status}">
            <div class="live-head">
              <span class="badge ${entry.status === "completed"
                ? "ok"
                : "denied"}">${entry.outcome === "question"
                ? "question"
                : entry.outcome === "gave-up"
                ? "stopped"
                : entry.status}</span>
            </div>
            ${entry.text === undefined ? nothing : html`
              <div class="live-final">${entry.text}</div>
            `} ${entry.pieces.map((piece) =>
              html`
                <a
                  class="piece-link"
                  href="${consoleLivePieceHref(
                    piece,
                    entry.spaceName,
                    this.piecesBase,
                  )}"
                  rel="noopener"
                >
                  Open ${piece.slug}
                </a>
              `
            )}
          </div>
        `;
    }
  }

  protected override render(): TemplateResult {
    return html`
      <header class="live-header">
        <span class="live-state">${this.state}</span>
        ${this.turnId === undefined ? nothing : html`
          <span class="muted">one turn</span>
        `}
      </header>
      ${this.error === undefined ? nothing : html`
        <p class="empty bad">${this.error}</p>
      `} ${this.piecesBaseRefused
        ? html`
          <p class="empty bad">
            The address named a <code>piecesBase</code> that is not an absolute
            http or https URL. Piece links go to the address the run recorded.
          </p>
        `
        : nothing}
      <div class="live-feed" @scroll="${(event: Event) =>
        this.#onScroll(event)}">
        ${this.entries.length === 0 && this.error === undefined
          ? html`
            <p class="empty">Waiting for the first step.</p>
          `
          : this.entries.map((entry) => this.#entry(entry))}
      </div>
    `;
  }
}

customElements.define("console-live", ConsoleLive);
