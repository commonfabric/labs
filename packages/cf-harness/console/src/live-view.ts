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

import { html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  type ConsoleChatEventEnvelope,
  type ConsoleRunDetail,
  readRun,
} from "./api.ts";
import { consolePath, pageMount } from "./mount.ts";
import {
  cutFound,
  markdownTemplate,
  revealedText,
  splitAtTokens,
  visibleFound,
} from "./markdown.ts";
import { stepCfcRecorded, withheldView } from "./steps-view.ts";
import type { ConsoleStep } from "../steps.ts";
import type { ConsoleTurnResultPiece } from "../turn-result.ts";
import type { BrowserToolAction } from "../../src/tools/browser.ts";
import type { HarnessPolicyDecisionReasonCode } from "../../src/contracts/policy-trace.ts";
import {
  ANY_HANDLE_TOKEN_PATTERN,
  REFERENT_HANDLE_TOKEN_PREFIX,
} from "../../src/contracts/handle-table.ts";

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
    /** What the model was thinking before it acted, as the provider sums it up. */
    kind: "thought";
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

    /** The call that started the subagent. */
    parentToolCallId: string;
    turnId?: string;
    profile: string;
    goal?: string;
    status: "running" | "completed" | "failed" | "canceled";
  }
  | {
    kind: "ended";
    key: string;
    turnId: string;
    status: "completed" | "failed" | "canceled";

    /** Task disposition inside a successfully ended turn. */
    outcome?: "completed" | "question" | "gave-up";

    text?: string;

    /**
     * A completed turn's answer, in Markdown, when the turn named no piece:
     * the final text as written.
     */
    answer?: string;

    /**
     * The strings the return referents in `text` or `answer` stand for, by
     * token, which the owner reads in place of the handles the parent held.
     */
    revealed?: Readonly<Record<string, string>>;
    pieces: readonly ConsoleTurnResultPiece[];

    /** The space the pieces are in, which composing an address needs. */
    spaceName?: string;
  };

/**
 * The arguments that say what a call was about, in the order a line prefers
 * them. A tool the run's own reading does not cover — every tool but the four
 * it names — is described by the first of these its call carried, except
 * `browser`, whose line is composed from the whole call.
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

/**
 * One piece of a line. Words are what the agent wrote, and the tool's name
 * names a call that does not say what it did in a sentence of its own. The
 * rest are references, each shown as what it stands for as far as the view
 * knows, with what the agent held in its place on hover:
 *
 * - `element`: an element of the page, by the name the page's last snapshot
 *   before the call gave it, which is the page's text, from `source`;
 * - `ref`: an element no snapshot this view can read describes;
 * - `unseen`: a value another agent found, which the agent held only as a
 *   handle, and which the harness `entered` in the handle's place when the
 *   call bound it as a value. Its `state` says whether the run says it fits
 *   what the console may show, and then it carries the whole `value` and the
 *   `sites` it came from; whether the run says it does not; or whether the
 *   view does not know yet;
 * - `address`: an item stored in the space, held as an address handle, by its
 *   name when the view `known`s it.
 */
export type ConsoleLiveLinePart =
  | { kind: "words" | "tool"; text: string }
  | { kind: "element"; text: string; held: string; source: string }
  | { kind: "ref"; text: string; held: string }
  | {
    kind: "unseen";
    text: string;
    held: string;
    entered: boolean;
    state: "shown" | "hidden" | "unknown";
    value?: string;
    sites?: readonly string[];
  }
  | { kind: "address"; text: string; held: string; known: boolean };

/** A line of the feed, as the pieces it is rendered from. */
export type ConsoleLiveLine = readonly ConsoleLiveLinePart[];

/**
 * `line` cut to {@link LINE_LIMIT} characters. A reference is kept whole or
 * not at all, since part of one names nothing.
 */
const elideLine = (line: ConsoleLiveLine): ConsoleLiveLine => {
  if (line.reduce((sum, part) => sum + part.text.length, 0) <= LINE_LIMIT) {
    return line;
  }
  const kept: ConsoleLiveLinePart[] = [];
  let room = LINE_LIMIT - 1;
  for (const part of line) {
    if (part.text.length <= room) {
      kept.push(part);
      room -= part.text.length;
      continue;
    }
    if (part.kind === "words" || part.kind === "tool") {
      kept.push({ kind: part.kind, text: part.text.slice(0, room) });
    }
    break;
  }
  const last = kept.at(-1);
  if (last?.kind === "words") {
    kept[kept.length - 1] = { kind: "words", text: last.text.trimEnd() };
  }
  kept.push({ kind: "words", text: "…" });
  return kept;
};

/** The longest element name a line shows before it is cut. */
const NAME_LIMIT = 48;

/**
 * What a handle token stands for, as a reference: a return referent as the
 * value another agent found, which the harness `entered` in the token's place
 * when a call bound it as a value, and an address handle as the name of the
 * item it names, as far as the run that holds it, `detail`, says.
 */
const handlePart = (
  token: string,
  detail: ConsoleRunDetail | undefined,
  entered: boolean,
): ConsoleLiveLinePart => {
  if (token.startsWith(REFERENT_HANDLE_TOKEN_PREFIX)) {
    if (detail !== undefined && Object.hasOwn(detail.revealed, token)) {
      const value = visibleFound(oneLine(detail.revealed[token]));
      return {
        kind: "unseen",
        text: cutFound(value, NAME_LIMIT),
        held: token,
        entered,
        state: "shown",
        value,
        sites: Object.hasOwn(detail.sites, token) ? detail.sites[token] : [],
      };
    }
    return detail !== undefined && detail.hidden.includes(token)
      ? {
        kind: "unseen",
        text: "a value hidden from this view",
        held: token,
        entered,
        state: "hidden",
      }
      : {
        kind: "unseen",
        text: "a value another agent found",
        held: token,
        entered,
        state: "unknown",
      };
  }
  const slug = detail?.handles.find((handle) => handle.token === token)?.slug;
  return slug === undefined
    ? { kind: "address", text: "a stored item", held: token, known: false }
    : {
      kind: "address",
      text: cutFound(visibleFound(slug), NAME_LIMIT),
      held: token,
      known: true,
    };
};

/**
 * `text`, with each handle token in it shown as the reference it is: whoever
 * holds a token holds a name, not what the name stands for.
 */
const handlesIn = (
  text: string,
  detail: ConsoleRunDetail | undefined,
): ConsoleLiveLine =>
  splitAtTokens<ConsoleLiveLinePart>(
    text,
    ANY_HANDLE_TOKEN_PATTERN,
    (words) => ({ kind: "words", text: words }),
    (token) => handlePart(token, detail, false),
  ).filter((part) => part.text !== "");

/** A line opening with `verb`, then each piece present, separated by spaces. */
const words = (
  verb: string,
  ...pieces: readonly (ConsoleLiveLine | undefined)[]
): ConsoleLiveLine => [
  { kind: "words", text: verb },
  ...pieces.flatMap((piece) =>
    piece === undefined ? [] : [{ kind: "words" as const, text: " " }, ...piece]
  ),
];

/** A word introducing a piece, or nothing when the piece is absent. */
const before = (
  word: string,
  piece: ConsoleLiveLine | undefined,
): ConsoleLiveLine | undefined =>
  piece === undefined
    ? undefined
    : [{ kind: "words", text: `${word} ` }, ...piece];

/** `text` as words, or nothing when it is absent. */
const literal = (text: string | undefined): ConsoleLiveLine | undefined =>
  text === undefined ? undefined : [{ kind: "words", text }];

/** What a `browser` line is composed from: the call's arguments. */
interface BrowserCall {
  /** An argument as one line of text, absent when the call left it unset. */
  field(key: string): string | undefined;

  /** The element the call acted on. */
  ref?: ConsoleLiveLine;

  /** An element of the page, given its ref, or nothing for no ref. */
  element(ref: string | undefined): ConsoleLiveLine | undefined;

  /**
   * The value the call entered, quoted, or the value of the handle bound in
   * its place.
   */
  value?: ConsoleLiveLine;

  /** The address the call opened, or the handle bound in its place. */
  url?: ConsoleLiveLine;
}

/**
 * What each `browser` action did, in the words a reader would use for it: the
 * action and what it acted on.
 */
const BROWSER_LINES: ReadonlyMap<
  string,
  (call: BrowserCall) => ConsoleLiveLine
> = new Map(Object.entries(
  {
    open: ({ url }) => words("Open", url),
    back: () => words("Go back"),
    forward: () => words("Go forward"),
    reload: () => words("Reload the page"),
    scroll: ({ field, ref }) =>
      words("Scroll", literal(field("direction")), before("within", ref)),
    snapshot: ({ field }) =>
      words(
        field("interactive") === "true"
          ? "Look over the page and the controls on it"
          : "Look over the page",
      ),
    get: ({ field, element }) => {
      // A target is a CSS selector, which never starts with `@`, or a ref.
      const target = field("target");
      return field("kind") === "title"
        ? words("Read the page's title")
        : field("kind") === "url"
        ? words("Read the page's address")
        : target === "body"
        ? words("Read the page's text")
        : words(
          "Read the text of",
          target?.startsWith("@")
            ? element(target)
            : before("the part of the page matching", literal(target)),
        );
    },
    console: () => words("Read the messages the page logged"),
    errors: () => words("Read the errors the page reported"),
    screenshot: () => words("Take a screenshot"),
    wait: ({ field, ref }) => {
      const ms = field("ms");
      const loadState = field("loadState");
      return words(
        "Wait",
        literal(ms === undefined ? undefined : `${ms} ms`),
        literal(
          loadState === undefined
            ? undefined
            : LOAD_WAITS.get(loadState) ?? `for ${loadState}`,
        ),
        before("for the address to match", literal(field("urlPattern"))),
        before("for", ref),
      );
    },
    click: ({ field, ref }) => {
      const x = field("x");
      const y = field("y");
      return x !== undefined && y !== undefined
        ? words(`Click at ${x}, ${y} on the screenshot`)
        : words("Click", ref);
    },
    check: ({ ref }) => words("Check", ref),
    fill: ({ ref, value }) => words("Fill", ref, before("with", value)),
    type: ({ ref, value }) => words("Type", value, before("into", ref)),
    select: ({ ref, value }) => words("Choose", value, before("in", ref)),
    press: ({ field }) => words("Press", literal(field("key"))),
    handoff: ({ field }) => {
      const reason = field("reason");
      return words(
        "Hand the page to you",
        literal(
          reason === undefined
            ? undefined
            : HANDOFF_PURPOSES.get(reason) ?? `for ${reason}`,
        ),
      );
    },
  } satisfies Record<BrowserToolAction, (call: BrowserCall) => ConsoleLiveLine>,
));

/** What a `wait` for each load state waits for, in words. */
const LOAD_WAITS: ReadonlyMap<string, string> = new Map([
  ["domcontentloaded", "for the page's content to arrive"],
  ["load", "for the page to load"],
  ["networkidle", "for the page to stop loading anything"],
]);

/** What the owner is handed the page to do, for each reason a hand-off gives. */
const HANDOFF_PURPOSES: ReadonlyMap<string, string> = new Map([
  ["sign-in", "to sign in"],
  ["one-time-code", "to enter a one-time code"],
  ["challenge", "to show that a person is there"],
  ["choice", "to make a choice"],
]);

/**
 * A line of a page snapshot that describes an element and gives it a ref: its
 * role, its name as a JSON string, and right after them the ref, which the
 * browser host writes as `[@e12 at …]` and a Browser Access lease as
 * `[ref=e12]`.
 */
const SNAPSHOT_ELEMENT =
  /^\s*- (\S+) ("(?:[^"\\]|\\.)*") \[(?:@|ref=)([A-Za-z0-9]+)[\s\]]/;

/** What a snapshot says each ref names: a role and a name, by ref. */
type SnapshotElements = ReadonlyMap<string, { role: string; name: string }>;

/** Each snapshot step's elements, read once however often a row is drawn. */
const snapshotsRead = new WeakMap<ConsoleStep, SnapshotElements>();

/**
 * The elements a snapshot step describes, by ref without its `@`. An element
 * whose name the snapshot did not quote as JSON, or named by nothing, or by
 * something holding a handle token, is left out: its name says nothing a
 * reader can rely on.
 */
const snapshotElements = (step: ConsoleStep): SnapshotElements => {
  const read = snapshotsRead.get(step);
  if (read !== undefined) {
    return read;
  }
  const elements = new Map<string, { role: string; name: string }>();
  const text = asRecord(step.output).output;
  for (const line of typeof text === "string" ? text.split("\n") : []) {
    const match = SNAPSHOT_ELEMENT.exec(line);
    if (match === null) continue;
    // The pattern matches a JSON string literal, so a name that parses is a
    // string.
    let name: string;
    try {
      name = JSON.parse(match[2]);
    } catch {
      continue;
    }
    const flat = oneLine(name);
    if (flat === "" || new RegExp(ANY_HANDLE_TOKEN_PATTERN).test(flat)) {
      continue;
    }
    elements.set(match[3], { role: match[1], name: flat });
  }
  snapshotsRead.set(step, elements);
  return elements;
};

/**
 * The word a page's role for an element goes by in a sentence, where the role
 * has a plainer one: a `textbox` is a text field.
 */
const ROLE_WORDS: ReadonlyMap<string, string> = new Map([
  ["textbox", "text field"],
  ["searchbox", "search field"],
  ["combobox", "field"],
  ["spinbutton", "number field"],
  ["menuitem", "menu item"],
  ["menuitemcheckbox", "menu item"],
  ["menuitemradio", "menu item"],
  ["radio", "option"],
  ["treeitem", "item"],
  ["gridcell", "cell"],
]);

/** The site a snapshot was taken on, as its host, when its result says. */
const snapshotSite = (snapshot: ConsoleStep): string | undefined => {
  const url = asRecord(asRecord(snapshot.output).page).url;
  try {
    return typeof url === "string" ? new URL(url).host : undefined;
  } catch {
    // A page address the result did not record whole names no site.
    return undefined;
  }
};

/**
 * The element `ref` names, as the run's last snapshot before step `index`
 * described it: refs are given out afresh by each snapshot, so only the last
 * one says what a ref meant to the call that used it. The element's name is
 * the page's own text, set apart and attributed to the site it came from, and
 * followed by its role in words. An element no such snapshot describes is
 * shown as a page element, held as its ref.
 */
const snapshotElement = (
  steps: readonly ConsoleStep[],
  index: number,
  ref: string,
): ConsoleLiveLine => {
  const snapshot = steps.findLast((step) =>
    step.index < index && step.toolName === "browser" &&
    asRecord(step.input).action === "snapshot"
  );
  const element = snapshot === undefined
    ? undefined
    : snapshotElements(snapshot).get(ref.replace(/^@/, ""));
  if (snapshot === undefined || element === undefined) {
    return [{ kind: "ref", text: "an element of the page", held: ref }];
  }
  const site = snapshotSite(snapshot);
  return [{
    kind: "element",
    text: cutFound(visibleFound(element.name), NAME_LIMIT),
    held: ref,
    source: site === undefined ? "the page" : site,
  }, {
    kind: "words",
    text: ` ${ROLE_WORDS.get(element.role) ?? element.role}`,
  }];
};

/**
 * What one `browser` call did, in a sentence. What the call wrote is shown as
 * words; the element it acted on, and a value it bound through a handle, are
 * shown as references, since the call named them rather than writing them
 * out, and shown as what they stand for as far as the run that made the call,
 * `detail`, says. An action the tool does not define is shown as the call
 * named it.
 */
const browserLine = (
  input: Record<string, unknown>,
  detail: ConsoleRunDetail | undefined,
  index: number,
): ConsoleLiveLine | undefined => {
  const field = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === "string" && value !== ""
      ? oneLine(value)
      : typeof value === "number" || typeof value === "boolean"
      ? `${value}`
      : undefined;
  };
  const action = field("action");
  if (action === undefined) {
    return undefined;
  }
  const element = (ref: string | undefined): ConsoleLiveLine | undefined =>
    ref === undefined
      ? undefined
      : snapshotElement(detail?.steps ?? [], index, ref);
  const bound = (token: string | undefined): ConsoleLiveLine | undefined =>
    token === undefined ? undefined : [handlePart(token, detail, true)];
  const call: BrowserCall = {
    field,
    element,
    ref: element(field("ref")),
    value: typeof input.value === "string"
      ? literal(JSON.stringify(oneLine(input.value)))
      : bound(field("valueHandle")),
    url: literal(field("url")) ?? bound(field("urlHandle")),
  };
  return BROWSER_LINES.get(action)?.(call) ?? words(action);
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
 * Ends the subagents still running under a turn that ended without them, as
 * the turn ended.
 */
const endSubagents = (
  subagents: Iterable<Extract<ConsoleLiveEntry, { kind: "subagent" }>>,
  turnId: string,
  status: "failed" | "canceled",
): void => {
  for (const entry of subagents) {
    if (entry.turnId === turnId && entry.status === "running") {
      entry.status = status;
    }
  }
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
      case "assistant_reasoning":
        entries.push({
          kind: "thought",
          ...named,
          text: event.text,
          ...under(event.subagent),
        });
        break;
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
          parentToolCallId: event.subagent.parentToolCallId,
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
        // A finish_task answer, question, or reason lives in a tool result, so
        // the closing block renders that sentence alongside any piece links.
        // Any other completed turn is answered in its final text, which the
        // closing block renders in place of the assistant block it streamed
        // as: the block holds the parent's words, the answer holds them as
        // the owner reads them.
        const answered = event.result.outcome !== "question" &&
          event.result.outcome !== "gave-up" &&
          event.result.answer === undefined &&
          event.result.finalText.trim() !== "";
        if (answered) {
          const streamed = entries.findLastIndex((entry) =>
            entry.kind === "assistant" && entry.turnId === event.turnId &&
            entry.subagent === undefined
          );
          if (streamed >= 0) {
            entries.splice(streamed, 1);
          }
        }
        entries.push({
          kind: "ended",
          key: named.key,
          turnId: event.turnId,
          status: "completed",
          outcome: event.result.outcome ?? "completed",
          ...(event.result.outcome === "question" ||
              event.result.outcome === "gave-up" ||
              (event.result.outcome === "completed" &&
                event.result.answer !== undefined)
            ? { text: event.result.finalText }
            : answered
            ? { answer: event.result.finalText }
            : {}),
          ...(event.result.revealed === undefined
            ? {}
            : { revealed: event.result.revealed }),
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
        endSubagents(subagents.values(), event.turnId, "failed");
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
        endSubagents(subagents.values(), event.turnId, "canceled");
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
 * What one tool call was about, in words. The run's own reading of its
 * transcript supplies what the call was given — the pattern attempt and its
 * compiler message, the search's query, the name a piece was assigned — and
 * the step supplies the rest, because a tool the reading does not cover still
 * carries its arguments.
 */
const toolSubject = (
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
    return [ordinal, outcome].filter((part) =>
      part !== undefined && part !== ""
    )
      .join(" · ");
  }
  if (entry.toolName === "assign_slug") {
    const piece = lens?.pieces.find((named) =>
      named.toolCallId === entry.toolCallId
    );
    const slug = piece?.slug ?? parsedRecord(entry.resultSummary).slug;
    return typeof slug === "string" ? slug : undefined;
  }
  if (entry.toolName === "search_patterns") {
    return lens?.searches.find((search) =>
      search.toolCallId === entry.toolCallId
    )?.query || undefined;
  }
  const input = asRecord(step?.input);
  for (const key of SUBJECT_ARGUMENTS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      return oneLine(value);
    }
  }
  return undefined;
};

/**
 * An identifier as a reader would say it: `run_pattern` is "Run pattern", and
 * `pattern-author` is "Pattern author".
 */
const spoken = (name: string): string => {
  const spaced = name.replaceAll(/[_-]/g, " ");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

/**
 * What one tool call did, in a line cut to the width a line has. A `browser`
 * call whose run has been read says what it did in a sentence of its own.
 * Any other call is named, by its title or its tool, and followed by
 * {@link toolSubject}, with the handles in it marked as references; a call
 * whose run has not been read yet is named alone, which is what a step still
 * running looks like.
 */
export const consoleLiveToolLine = (
  entry: Extract<ConsoleLiveEntry, { kind: "tool" }>,
  detail: ConsoleRunDetail | undefined,
  step: ConsoleStep | undefined,
): ConsoleLiveLine => {
  const sentence = entry.toolName === "browser" && step !== undefined
    ? browserLine(asRecord(step.input), detail, step.index)
    : undefined;
  if (sentence !== undefined) {
    return elideLine(sentence);
  }
  const name: ConsoleLiveLinePart = {
    kind: "tool",
    text: entry.title ?? spoken(entry.toolName),
  };
  const subject = toolSubject(entry, detail, step);
  return elideLine(
    subject === undefined || subject === ""
      ? [name]
      : [name, { kind: "words", text: " " }, ...handlesIn(subject, detail)],
  );
};

/**
 * `line` as markup: its words as text, the tool's name set as a name, and
 * each reference set apart from the words in a box, showing what it stands
 * for, with what the agent held in its place on hover.
 */
const lineView = (line: ConsoleLiveLine): unknown[] =>
  line.map((part) => {
    switch (part.kind) {
      case "words":
        return part.text;
      case "tool":
        return html`<span class="live-tool">${part.text}</span>`;
      case "element":
        return referenceView(
          part.text,
          `These words come from ${part.source}. The page gives this name to the element the agent chose. The agent referred to it as ${part.held}.`,
          "quoted",
        );
      case "ref":
        return referenceView(
          part.text,
          `The agent referred to an element of the page as ${part.held}. No copy of the page that this view can read describes that element.`,
          "vague",
        );
      case "unseen":
        return referenceView(
          part.text,
          [
            part.state === "shown"
              ? `Another agent found this value${
                part.sites === undefined || part.sites.length === 0
                  ? ""
                  : ` on ${part.sites.join(" and ")}`
              }: ${part.value}.`
              : "Another agent found this value.",
            "This agent never saw it.",
            part.entered
              ? `It used the placeholder ${part.held}. The system put the value in its place.`
              : `It passed the value on as the placeholder ${part.held}.`,
            ...(part.state === "hidden"
              ? [
                "This view does not show the value, because the rules on where it may go do not include this view.",
              ]
              : []),
          ].join(" "),
          part.state === "shown"
            ? "quoted"
            : part.state === "hidden"
            ? "vague sealed"
            : "vague",
          part.sites === undefined || part.sites.length === 0
            ? undefined
            : `from ${part.sites.join(" and ")}`,
        );
      case "address":
        return referenceView(
          part.text,
          `This is an item stored in your space. The agent referred to it as ${part.held}.`,
          part.known ? "" : "vague",
        );
    }
  });

/**
 * One reference, set apart in a box with no space around it, with `title`
 * saying on hover what it is, and `marks` saying how it is shown: `quoted` for
 * words from a page, or a value another agent found; `vague` for words
 * standing in for something the view does not know; and `sealed` for a value
 * the view may not show. A value from a page names the `source` it came from
 * beside it.
 */
const referenceView = (
  text: string,
  title: string,
  marks: string,
  source?: string,
): TemplateResult => {
  const classes = `live-reference ${marks}`.trim();
  const from = source === undefined
    ? nothing
    : html`<span class="live-reference-source">${source}</span>`;
  const inside = html`<span>${text}</span>${from}`;
  return html`<bdi class=${classes} title=${title}>${inside}</bdi>`;
};

/**
 * What CFC made of one step, in a reader's words: how it ended for the step,
 * as one word unless CFC let the call through with nothing held back and
 * nothing raised, and as a word fit to head an explanation either way.
 */
const policyVerdict = (
  step: ConsoleStep,
): { tone: "ok" | "warn" | "bad"; word?: string; heading: string } => {
  const decision = step.policy?.decision;
  if (
    decision === "denied" ||
    step.policyEvents.some((event) => event.severity === "denied")
  ) {
    return { tone: "bad", word: "blocked", heading: "Blocked" };
  }
  if (stepWithheldAnything(step)) {
    return { tone: "warn", word: "withheld", heading: "Partly withheld" };
  }
  if (decision !== undefined && decision !== "allowed") {
    return { tone: "warn", word: decision, heading: spoken(decision) };
  }
  if (step.policyEvents.length > 0) {
    return { tone: "warn", word: "warning", heading: "Allowed with a warning" };
  }
  return {
    tone: "ok",
    heading: decision === undefined ? "Recorded" : "Allowed",
  };
};

/** What else writing a file depends on, under an enforcing run. */
const WRITE_WHERE =
  "Whether a file may be written also depends on where it goes.";

/** What the check on a run's task protects against. */
const WHY =
  "Agents act only on your own requests, never on instructions they read along the way.";

/** What the check on a run's task reaches, under a strict run. */
const EVEN_LOOKING =
  "In this run, that holds even for a step that only looks at information.";

/** A step whose effect is only to read. */
const LOOKING = "This step only looks at information.";

/** What a run that only observes does. */
const ONLY_NOTING = "This run notes what it would stop, but stops nothing.";

/** What a run with CFC turned off does. */
const CHECKS_OFF = "This run does not check where information goes.";

/**
 * A reason's sentence, given the sentence saying where the run's work came
 * from, which a reason about the run's task opens with.
 */
type Reason = (task: string) => string;

/**
 * Why CFC decided what it did about a call, by the reason code it gave, in a
 * sentence an owner can read. A reason about the run's task opens with where
 * the run's work came from, as {@link taskOrigin} reads the prompt slot the
 * decision was made on. A reason a code
 * shares between a call CFC let through and one it refused states the fact
 * it rests on, which the verdict beside it turns into an outcome.
 */
const REASONS: ReadonlyMap<string, Reason> = new Map(Object.entries(
  {
    tool_not_allowed: () => "This run may not use this tool.",
    cfc_disabled: () => CHECKS_OFF,
    cfc_observe_read: () => `${LOOKING} ${ONLY_NOTING}`,
    cfc_observe_direct_command: (task) => `${task} ${ONLY_NOTING}`,
    cfc_observe_requires_direct_command: (task) =>
      `${task} ${WHY} ${ONLY_NOTING} So this step went ahead.`,
    cfc_enforce_explicit_read: () =>
      `${LOOKING} That is always allowed in this run.`,
    cfc_enforce_explicit_direct_command: (task) => `${task} ${WHY}`,
    cfc_enforce_explicit_requires_direct_command: (task) => `${task} ${WHY}`,
    cfc_enforce_strict_direct_command: (task) => `${task} ${WHY}`,
    cfc_enforce_strict_host_command_read: () =>
      "The host allows this context task to discover commands and invoke only its granted read commands.",
    cfc_enforce_strict_requires_direct_command: (task) =>
      `${task} ${WHY} ${EVEN_LOOKING}`,
    write_file_disabled: () => CHECKS_OFF,
    write_file_observe_direct_command: (task) => `${task} ${ONLY_NOTING}`,
    write_file_observe_requires_direct_command: (task) =>
      `${task} ${WHY} ${ONLY_NOTING} So this step went ahead.`,
    write_file_enforce_explicit_direct_command: (task) =>
      `${task} ${WRITE_WHERE}`,
    write_file_enforce_explicit_requires_direct_command: (task) =>
      `${task} ${WHY}`,
    write_file_enforce_strict_direct_command: (task) =>
      `${task} ${WRITE_WHERE}`,
    write_file_enforce_strict_requires_direct_command: (task) =>
      `${task} ${WHY}`,
    structured_result_return: () =>
      "Handing back the run's result is always allowed.",
    subagent_profile_allowed: () =>
      "This run may start this kind of helper agent.",
    subagent_profile_not_allowed: () =>
      "This run may not start this kind of helper agent.",
    invalid_tool_call: () =>
      "The agent wrote this step in a form that could not be read. The step never ran.",
    cfc_release_allowed: () =>
      "The step's result was allowed back to the agent.",
    cfc_release_observed: () =>
      "The step's result went back to the agent. If this run stopped things, part of the result would have been held back.",
    cfc_release_withheld: () =>
      "Part of the step's result was held back from the agent. It held information the agent may not read.",
    cfc_commit_refused: () =>
      "The step's result was not saved. It held information that may not be stored where it was going.",
  } satisfies Record<HarnessPolicyDecisionReasonCode, Reason>,
));

/** Where each surface a task can be entered on is, in words. */
const SURFACES: ReadonlyMap<string, string> = new Map([
  ["console-web", "in the console"],
  ["cli", "on the command line"],
]);

/**
 * Where the work a step belongs to came from, as the check on the run's task
 * read it: the prompt slot the run bound, which says how its task was given
 * and where it was entered. A subagent's run binds the slot of the run that
 * started it, so its work traces back the same way.
 */
const taskOrigin = (
  promptSlot: { role: string; surface: string } | undefined,
): string => {
  const where = promptSlot === undefined
    ? undefined
    : SURFACES.get(promptSlot.surface);
  switch (promptSlot?.role) {
    case undefined:
      return "Nothing records who asked for this work, so the check could not trace it back to a request from you.";
    case "direct-command":
      return `This work traces back to a request you made yourself${
        where === undefined ? "" : ` ${where}`
      }.`;
    case "context":
      return `This work traces back to text given to the agent as background${
        where === undefined ? "" : ` ${where}`
      }, not as a request from you.`;
    case "quote":
      return `This work traces back to text given to the agent as a quotation${
        where === undefined ? "" : ` ${where}`
      }, not as a request from you.`;
    default:
      return "The record of who asked for this work does not say it was you.";
  }
};

/**
 * What CFC made of a step, explained: the verdict, and why, in sentences an
 * owner can read. The reason codes and any event's detail are on hover, for
 * the engineer who needs them.
 */
const policyExplanation = (
  step: ConsoleStep,
): TemplateResult | typeof nothing => {
  if (!stepCfcRecorded(step)) {
    return nothing;
  }
  const verdict = policyVerdict(step);
  const codes = step.policy?.reasonCodes ?? [];
  const task = taskOrigin(step.policy?.promptSlot);
  const sentences = codes.map((code) => REASONS.get(code)?.(task) ?? code);
  if (sentences.length === 0) {
    sentences.push(
      step.policyEvents.length > 0
        ? "The run raised a warning about this step. It did not stop the step."
        : stepWithheldAnything(step)
        ? "Part of the step's result was held back from the agent."
        : "The run recorded where this step's inputs came from.",
    );
  }
  const title = [
    step.policy?.effectClass,
    ...codes,
    ...step.policyEvents.map((event) => event.detail),
  ].filter((part) => part !== undefined).join(" · ");
  const heading =
    html`<span class="live-why-heading ${verdict.tone}">${SHIELD}${verdict.heading}</span>`;
  return html`<p class="live-why" title=${title || nothing}>${heading} ${
    sentences.join(" ")
  }</p>`;
};

/**
 * What CFC made of one step, as a mark small enough to sit at the end of its
 * row: a shield, tinted by what CFC did, and a word unless CFC let the call
 * through with nothing held back and nothing raised. Opening the row says
 * why.
 */
export const consoleLivePolicyMark = (
  step: ConsoleStep,
): TemplateResult | typeof nothing => {
  if (!stepCfcRecorded(step)) {
    return nothing;
  }
  const verdict = policyVerdict(step);
  const spoken = html`<span class="live-spoken">${verdict.heading}</span>`;
  const shown = verdict.word === undefined
    ? nothing
    : html`<span aria-hidden="true">${verdict.word}</span>`;
  return html`<span class="live-policy ${verdict.tone}">${SHIELD}${spoken}${shown}</span>`;
};

/** A shield, drawn in the color of the text around it. */
const SHIELD_PATH =
  "M8 1 2.5 3.2v4.2c0 3.4 2.3 6.2 5.5 7.6 3.2-1.4 5.5-4.2 5.5-7.6V3.2z";
const SHIELD_SHAPE = svg`<path d=${SHIELD_PATH} />`;
const SHIELD =
  html`<svg viewBox="0 0 16 16" aria-hidden="true">${SHIELD_SHAPE}</svg>`;

/**
 * One row of the feed: a status dot, what happened, and quiet details at the
 * end of the row. A row with more to say about it — what CFC decided, what
 * was held back from the model — opens to show it.
 */
const rowView = (
  status: string,
  text: unknown,
  meta: unknown,
  detail: readonly (TemplateResult | typeof nothing)[],
): TemplateResult => {
  const head = html`<span
      class="live-dot ${status}"
      role="img"
      aria-label=${status}
    ></span><span
      class="live-text"
    >${text}</span><span class="live-meta">${meta}</span>`;
  return detail.every((part) => part === nothing)
    ? html`<div class="live-row">${head}</div>`
    : html`
      <details class="live-row">
        <summary>${head}</summary>
        <div
          class="live-detail"
        >${detail}</div>
      </details>
    `;
};

/**
 * How a step that did not complete ended, or nothing for one that did. A
 * denial is left to the step's policy mark when it has one, which says
 * "blocked".
 */
const outcomeBadge = (
  status: string,
  step: ConsoleStep | undefined,
): TemplateResult | typeof nothing =>
  status === "failed" || status === "canceled" ||
    (status === "denied" && (step === undefined || !stepCfcRecorded(step)))
    ? html`<span class="badge denied">${status}</span>`
    : nothing;

/**
 * What a model said or thought, as written: the text is set with its own line
 * breaks kept, so nothing but the text goes inside the block.
 */
const proseView = (
  kind: "said" | "thought",
  child: boolean,
  text: string,
): TemplateResult => {
  const classes = `live-entry ${kind}${child ? " child" : ""}`;
  return html`<div class=${classes}>${text}</div>`;
};

/** What CFC decided about `step`, and why, and what it held back. */
const stepDetail = (
  step: ConsoleStep | undefined,
): readonly (TemplateResult | typeof nothing)[] =>
  step === undefined ? [] : [
    policyExplanation(step),
    stepWithheldAnything(step)
      ? withheldView(step, "What was held back from the agent")
      : nothing,
  ];

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
      return spoken(entry.toolName).toLowerCase();
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
      <div class="live-entry call ${entry.subagent === undefined
        ? ""
        : "child"}">
        ${rowView(
          entry.status,
          lineView(consoleLiveToolLine(entry, record?.detail, step)),
          html`${
            elapsed === undefined ? nothing : html`<span>${elapsed}s</span>`
          }${outcomeBadge(entry.status, step)}${
            step === undefined ? nothing : consoleLivePolicyMark(step)
          }`,
          stepDetail(step),
        )} ${entry.progress === undefined || entry.status !== "running"
          ? nothing
          : html`
            <div class="live-line muted">${lineView(
              elideLine(handlesIn(entry.progress, record?.detail)),
            )}</div>
          `}
      </div>
    `;
  }

  /**
   * A subagent, in the row of the call that started it: the agent, and the
   * task it was given.
   */
  #subagentEntry(
    entry: Extract<ConsoleLiveEntry, { kind: "subagent" }>,
  ): TemplateResult {
    const record = this.#recordOf(entry.parentToolCallId);
    const step = record?.step;
    const agent: ConsoleLiveLinePart = {
      kind: "tool",
      text: `${spoken(entry.profile)} agent`,
    };
    return html`
      <div class="live-entry subagent">
        ${rowView(
          entry.status,
          lineView(
            entry.goal === undefined ? [agent] : elideLine([
              agent,
              { kind: "words", text: " " },
              ...handlesIn(oneLine(entry.goal), record?.detail),
            ]),
          ),
          html`${outcomeBadge(entry.status, step)}${
            step === undefined ? nothing : consoleLivePolicyMark(step)
          }`,
          stepDetail(step),
        )}
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
        return proseView("said", entry.subagent !== undefined, entry.text);
      case "thought":
        return proseView("thought", entry.subagent !== undefined, entry.text);
      case "tool":
        return this.#toolEntry(entry);
      case "subagent":
        return this.#subagentEntry(entry);
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
              <div class="live-final">${revealedText(
                entry.text,
                entry.revealed,
              )}</div>
            `} ${entry.answer === undefined ? nothing : html`
              <div class="live-final live-answer">
                ${markdownTemplate(entry.answer, { revealed: entry.revealed })}
              </div>
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
    // A call that started a subagent is shown as the subagent's row.
    const delegated = new Set(
      this.entries.flatMap((entry) =>
        entry.kind === "subagent" ? [entry.parentToolCallId] : []
      ),
    );
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
            The address named a <code>piecesBase</code> that is not an absolute http or
            https URL. Piece links go to the address the run recorded.
          </p>
        `
        : nothing}
      <div class="live-feed" @scroll="${(event: Event) =>
        this.#onScroll(event)}">
        ${this.entries.length === 0 && this.error === undefined
          ? html`
            <p class="empty">Waiting for the first step.</p>
          `
          : this.entries.filter((entry) =>
            entry.kind !== "tool" || !delegated.has(entry.toolCallId)
          ).map((entry) => this.#entry(entry))}
      </div>
    `;
  }
}

customElements.define("console-live", ConsoleLive);
