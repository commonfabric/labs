/**
 * Assumption Surfacer — a chat that shows, beside the conversation, the
 * assumptions the assistant is making about you, so you can confirm them or
 * set them straight.
 *
 * Each reply rests on things you never said: which language you use, how much
 * you already know, what you are really trying to do. Before answering, the
 * assistant records the few that matter most through its `recordAssumptions`
 * tool, each with a handful of alternatives. The sidebar lists them; pick the
 * one that is right. Confirming keeps the assistant's guess; picking another
 * alternative or "None of these" also tells the assistant in the chat. Every
 * settled assumption is folded into the system prompt, so later replies build
 * on what you told it instead of guessing again.
 *
 * Ported from jkomoros/community-patterns (`assumption-surfacer.tsx`). The
 * original ran a second model over the latest reply and showed only that
 * analysis, never storing it: earlier assumptions vanished with each reply,
 * and a correction was keyed to message 0, so it attached to any later
 * assumption that happened to share its label. Here the assistant records its
 * own assumptions through a tool, and the list is read from those tool calls,
 * which the chat keeps with their input, so it is durable, per reply and
 * complete. Only the user's verdicts are stored beside the chat.
 * The original's "user context" notes were collected but never read; settled
 * assumptions now reach the model through the system prompt instead.
 *
 * Telling the assistant: the dialog drops a message added while a turn is
 * running, and cards appear mid-turn (the tool runs before the reply), so a
 * verdict cannot simply be sent the moment it is made. What the assistant has
 * been told is derived from the chat itself: each send is logged in `updates`
 * with what it says, and counts once its message is in `messages`. A send the
 * dialog dropped never lands, so its verdicts stay unsent; marking them told
 * at send time would lose them, because a verdict made in the same tick as
 * another send runs before the dialog has set `pending`. Unsent updates go out
 * together in one message when a verdict is made while the dialog is idle,
 * with the user's next message, or from the sidebar's "Tell it now" button.
 * Nothing runs when a turn ends (a pattern has no effect to hang that on), but
 * nothing is lost: the system prompt already carries every verdict, and the
 * sidebar says how many updates are waiting.
 */
import {
  action,
  type BuiltInLLMMessage,
  computed,
  Default,
  FS,
  handler,
  llmDialog,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  promptInputMessage,
  type PromptSendEvent,
} from "../../system/cfc/prompt-injection/prompt.ts";

export type AssumptionStatus = "open" | "confirmed" | "corrected" | "rejected";

export interface Assumption {
  /** Stable within one conversation: `a1`, `a2`, … in recording order. */
  id: string;
  /** Which user message (1-based) the reply rested on this assumption. */
  turn: number;
  /** A short excerpt of that user message, so the card says what it was about. */
  about: string;
  /** Two to four words, such as "Language" or "Skill level". */
  label: string;
  /** At most one short sentence, or "". */
  description: string;
  /** The options the assistant weighed, each a few words. */
  alternatives: string[];
  /** The alternative the assistant assumed. */
  assumedIndex: number;
  status: AssumptionStatus;
  /** The alternative the user chose instead, when `status` is "corrected". */
  chosenIndex: number;
}

/** One message of assumption updates, as sent to the dialog. */
export interface SentUpdate {
  /** The message's update part, exactly as sent. */
  text: string;
  /** How many messages the chat held when it was sent: the message lands at
   * this index or later, or never if the dialog dropped it. */
  from: number;
  /** What it told the assistant: for each assumption, the alternative that
   * stands, -1 for "none of these". */
  beliefs: { id: string; index: number }[];
}

/** One assumption as the assistant's tool call reports it. */
export interface ReportedAssumption {
  label: string;
  description?: string;
  alternatives: string[];
  assumedIndex: number;
}

export type Verdict =
  | { kind: "confirm" }
  | { kind: "reject" }
  | { kind: "choose"; index: number };

const DEFAULT_SYSTEM = "You are a helpful, concise assistant.";
const MODEL = "anthropic:claude-sonnet-4-5";
const DEFAULT_TITLE = "Assumption Surfacer";
const MAX_PER_REPLY = 3;
const MAX_ALTERNATIVES = 4;
const TITLE_LENGTH = 30;
const ABOUT_LENGTH = 60;

/** Marks the part of a user message that carries assumption updates rather
 * than words the user typed. The model reads it too. */
export const UPDATE_TAG = "[Assumption update]";

const TOOL_DESCRIPTION =
  "Record the implicit assumptions your next reply rests on, so the user can confirm or correct them. Call it before replying, at most once per reply.";

// Keep the counts in step with MAX_PER_REPLY and MAX_ALTERNATIVES: a module-
// scope template literal may not interpolate under SES.
const ASSUMPTION_INSTRUCTIONS =
  `Before each reply, call the recordAssumptions tool with the 0-3 most consequential implicit assumptions your reply will rest on: things the user did not say, such as their programming language, skill level, platform or goal. For each give:
- label: 2-4 words (e.g. "Language", "Skill level")
- description: one short sentence, or omit it
- alternatives: 2-4 options of 2-6 words each (e.g. "Python", "JavaScript", "TypeScript"), just the key differentiator, not a sentence
- assumedIndex: the index of the alternative you are assuming
Skip the call when the reply is simple or factual. Never mention the tool in your reply.`;

// ---------------------------------------------------------------------------
// Pure logic. The tool call, the verdicts and the prompt all go through these,
// so the tests can reach them without a model.
// ---------------------------------------------------------------------------

/** The text of a message, whether its content is a string or parts. */
export const messageText = (message: BuiltInLLMMessage | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && part.type === "text" && "text" in part ? String(part.text) : ""
    )
    .filter((text) => text !== "")
    .join(" ");
};

const truncate = (text: string, length: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

const isUpdatePart = (text: string): boolean => text.startsWith(UPDATE_TAG);

/** What the user typed in a message, leaving out any assumption updates sent
 * with it: "" for an update-only message. */
export const userText = (message: BuiltInLLMMessage | undefined): string => {
  if (message?.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return isUpdatePart(content) ? "" : content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && part.type === "text" && "text" in part ? String(part.text) : ""
    )
    .filter((text) => text !== "" && !isUpdatePart(text))
    .join(" ");
};

/** The messages the user wrote, as opposed to updates sent on their behalf. */
export const realUserMessages = (
  messages: readonly BuiltInLLMMessage[],
): BuiltInLLMMessage[] => messages.filter((m) => userText(m).trim() !== "");

/** The chat's title: the start of the user's first message. */
export const chatTitle = (messages: readonly BuiltInLLMMessage[]): string =>
  truncate(userText(realUserMessages(messages)[0]), TITLE_LENGTH) ||
  DEFAULT_TITLE;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const cleanText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

/** One reported assumption made safe to store, or null when it is unusable:
 * no label, or fewer than two distinct alternatives. The assumed index names
 * an alternative as reported, so it is followed to that alternative's place
 * once blanks and repeats are dropped; an index that names nothing kept falls
 * back to the first alternative. */
const normalizeOne = (raw: unknown): ReportedAssumption | null => {
  if (!isRecord(raw)) return null;
  const label = cleanText(raw.label);
  const reported = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .map((alt) => cleanText(isRecord(alt) ? alt.value : alt));
  const alternatives = reported
    .filter((alt, i, all) => alt !== "" && all.indexOf(alt) === i)
    .slice(0, MAX_ALTERNATIVES);
  if (label === "" || alternatives.length < 2) return null;
  const index = Number(raw.assumedIndex ?? raw.selectedIndex);
  const assumed = Number.isInteger(index) ? reported[index] ?? "" : "";
  const kept = assumed === "" ? -1 : alternatives.indexOf(assumed);
  return {
    label,
    description: cleanText(raw.description),
    alternatives,
    assumedIndex: kept >= 0 ? kept : 0,
  };
};

/** The usable assumptions from a tool call's arguments, at most three. */
export const normalizeReported = (raw: unknown): ReportedAssumption[] =>
  (isRecord(raw) && Array.isArray(raw.assumptions) ? raw.assumptions : [])
    .map(normalizeOne)
    .filter((a): a is ReportedAssumption => a !== null)
    .slice(0, MAX_PER_REPLY);

/** The record after the assistant reports `reported` for user message `turn`.
 * A label already recorded for the same turn is replaced, not duplicated, so
 * a repeated tool call does not stack cards, and a reply keeps at most
 * MAX_PER_REPLY cards however many calls it makes: new labels past that are
 * dropped. */
export const withRecorded = (
  existing: readonly Assumption[],
  allReported: readonly ReportedAssumption[],
  turn: number,
  about: string,
): Assumption[] => {
  const labelsThisTurn = new Set(
    existing.filter((a) => a.turn === turn).map((a) => a.label.toLowerCase()),
  );
  const isReplacement = (r: ReportedAssumption) =>
    labelsThisTurn.has(r.label.toLowerCase());
  const replacements = allReported.filter(isReplacement);
  const room = Math.max(0, MAX_PER_REPLY - labelsThisTurn.size);
  const fresh = allReported.filter((r) => !isReplacement(r)).slice(0, room);
  const reported = [...replacements, ...fresh];
  const replaced = new Set(replacements.map((r) => r.label.toLowerCase()));
  const kept = existing.filter((a) =>
    a.turn !== turn || !replaced.has(a.label.toLowerCase())
  );
  const nextId = existing.reduce(
    (max, a) => Math.max(max, Number(a.id.slice(1)) || 0),
    0,
  );
  return [
    ...kept,
    ...reported.map((r, i): Assumption => ({
      id: `a${nextId + i + 1}`,
      turn,
      about,
      label: r.label,
      description: r.description ?? "",
      alternatives: [...r.alternatives],
      assumedIndex: r.assumedIndex,
      status: "open",
      chosenIndex: -1,
    })),
  ];
};

/** The alternative an assumption now stands for, or "" when rejected. */
export const settledValue = (a: Assumption): string =>
  a.status === "rejected" ? "" : a.alternatives[
    a.status === "corrected" ? a.chosenIndex : a.assumedIndex
  ] ??
    "";

/** The alternative an assumption now stands for, -1 for "none of these". */
const belief = (a: Assumption): number =>
  a.status === "rejected"
    ? -1
    : a.status === "corrected"
    ? a.chosenIndex
    : a.assumedIndex;

/** The tool name the model records its assumptions with. */
export const RECORD_TOOL = "recordAssumptions";

/** The assumptions the assistant recorded, read from its tool calls in the
 * chat, all open. Each call is folded in with `withRecorded`, so ids, turns
 * and replacement follow recording order exactly as live recording would. */
export const recordedAssumptions = (
  messages: readonly BuiltInLLMMessage[],
): Assumption[] => {
  let record: Assumption[] = [];
  let turn = 0;
  let about = "";
  for (const message of messages) {
    if (userText(message).trim() !== "") {
      turn += 1;
      about = truncate(userText(message), ABOUT_LENGTH);
      continue;
    }
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (
        !isRecord(part) || part.type !== "tool-call" ||
        part.toolName !== RECORD_TOOL
      ) continue;
      const reported = normalizeReported(part.input);
      if (reported.length > 0) {
        record = withRecorded(record, reported, turn, about);
      }
    }
  }
  return record;
};

/** What the user said about one assumption. */
export interface StoredVerdict {
  status: AssumptionStatus;
  chosenIndex: number;
}

/** The recorded assumptions with the user's verdicts applied. */
export const withVerdicts = (
  recorded: readonly Assumption[],
  verdicts: Readonly<Record<string, StoredVerdict>>,
): Assumption[] =>
  recorded.map((a) => {
    const v = verdicts[a.id];
    return v ? { ...a, status: v.status, chosenIndex: v.chosenIndex } : a;
  });

/** The record after a verdict on assumption `id`. A verdict that changes
 * nothing, or names no such assumption or alternative, is a no-op. */
export const applyVerdict = (
  existing: readonly Assumption[],
  id: string,
  verdict: Verdict,
): Assumption[] => {
  const target = existing.find((a) => a.id === id);
  if (!target) return [...existing];
  const choice = verdict.kind === "choose" ? verdict.index : -1;
  if (
    verdict.kind === "choose" &&
    (choice < 0 || choice >= target.alternatives.length)
  ) return [...existing];
  const next: Assumption = verdict.kind === "reject"
    ? { ...target, status: "rejected", chosenIndex: -1 }
    : verdict.kind === "confirm" || choice === target.assumedIndex
    ? { ...target, status: "confirmed", chosenIndex: -1 }
    : { ...target, status: "corrected", chosenIndex: choice };
  return existing.map((a) => (a.id === id ? next : a));
};

/** The sends whose message reached the chat, oldest first. */
export const landedUpdates = (
  sent: readonly SentUpdate[],
  messages: readonly BuiltInLLMMessage[],
): SentUpdate[] =>
  sent.filter((update) =>
    messages.slice(update.from).some((m) =>
      m.role === "user" && Array.isArray(m.content) &&
      m.content.some((part) =>
        part && part.type === "text" && "text" in part &&
        part.text === update.text
      )
    )
  );

/** The alternative the assistant was last told stands for each assumption
 * that any landed update mentions. */
const toldIndexes = (landed: readonly SentUpdate[]): Map<string, number> =>
  new Map(landed.flatMap((u) => u.beliefs.map((b) => [b.id, b.index])));

/** What the assistant has yet to hear about one assumption, given the
 * alternative it was last told (its own guess, until told otherwise), or ""
 * when it already knows. */
export const updateFor = (a: Assumption, told: number): string => {
  const now = belief(a);
  if (now === told) return "";
  const topic = a.label.toLowerCase();
  const assumed = a.alternatives[a.assumedIndex] ?? "";
  return now === -1
    ? `Regarding ${topic}: none of ${a.alternatives.join(", ")}.`
    : now === a.assumedIndex
    ? `Regarding ${topic}: ${assumed} after all.`
    : `Regarding ${topic}: ${
      a.alternatives[now] ?? ""
    } rather than ${assumed}.`;
};

/** The assumptions the assistant has yet to hear about, oldest first, each
 * with its update and the belief that update carries. */
const pendingBeliefs = (
  assumptions: readonly Assumption[],
  sent: readonly SentUpdate[],
  messages: readonly BuiltInLLMMessage[],
): { id: string; index: number; text: string }[] => {
  const told = toldIndexes(landedUpdates(sent, messages));
  return assumptions
    .map((a) => ({
      id: a.id,
      index: belief(a),
      text: updateFor(a, told.get(a.id) ?? a.assumedIndex),
    }))
    .filter((p) => p.text !== "");
};

/** Every update the assistant has yet to hear, oldest assumption first. */
export const unsentUpdates = (
  assumptions: readonly Assumption[],
  sent: readonly SentUpdate[],
  messages: readonly BuiltInLLMMessage[],
): string[] => pendingBeliefs(assumptions, sent, messages).map((p) => p.text);

/** The log entry for sending every unsent update now, or null when there is
 * nothing to send. */
export const nextUpdate = (
  assumptions: readonly Assumption[],
  sent: readonly SentUpdate[],
  messages: readonly BuiltInLLMMessage[],
): SentUpdate | null => {
  const pending = pendingBeliefs(assumptions, sent, messages);
  return pending.length === 0 ? null : {
    text: `${UPDATE_TAG} ${pending.map((p) => p.text).join(" ")}`,
    from: messages.length,
    beliefs: pending.map(({ id, index }) => ({ id, index })),
  };
};

/** One user message carrying the update part `update` and the user's own
 * `text`, either of which may be empty; null when both are. The update goes
 * in a part of its own, tagged, so `userText` can tell it from what the user
 * typed and `landedUpdates` can find it. */
export const composeMessage = (
  update: string,
  text: string,
): BuiltInLLMMessage | null => {
  const parts = [
    ...(update !== "" ? [update] : []),
    ...(text.trim() !== "" ? [text] : []),
  ];
  return parts.length === 0 ? null : {
    role: "user",
    content: parts.map((part) => ({ type: "text" as const, text: part })),
  };
};

/** One line per settled assumption, for the prompt and the summary. */
const settledLine = (a: Assumption): string => {
  const assumed = a.alternatives[a.assumedIndex] ?? "";
  return a.status === "confirmed"
    ? `${a.label}: ${assumed} (confirmed)`
    : a.status === "corrected"
    ? `${a.label}: ${settledValue(a)} (not ${assumed})`
    : `${a.label}: none of ${a.alternatives.join(", ")}`;
};

/** What the user has settled, newest last, one entry per label: a later
 * verdict on the same label overrides an earlier one. */
export const settledFacts = (assumptions: readonly Assumption[]): string[] => {
  const latest = new Map<string, Assumption>();
  assumptions
    .filter((a) => a.status !== "open")
    .forEach((a) => {
      latest.delete(a.label.toLowerCase());
      latest.set(a.label.toLowerCase(), a);
    });
  return [...latest.values()].map(settledLine);
};

/** The dialog's system prompt: the caller's, the tool instructions, and what
 * the user has settled so far. */
export const buildSystemPrompt = (
  base: string,
  assumptions: readonly Assumption[],
): string => {
  const facts = settledFacts(assumptions);
  const settled = facts.length === 0 ? "" : `

The user has settled these; build on them and do not surface them again:
${facts.map((f) => `- ${f}`).join("\n")}`;
  return `${base || DEFAULT_SYSTEM}

${ASSUMPTION_INSTRUCTIONS}${settled}`;
};

const STATUS_TEXT: Record<AssumptionStatus, string> = {
  open: "open",
  confirmed: "confirmed",
  corrected: "corrected",
  rejected: "none of these",
};

/** The markdown the filesystem view reads. */
export const assumptionsMarkdown = (
  title: string,
  assumptions: readonly Assumption[],
): string => {
  const lines = assumptions.map((a) =>
    `- ${a.label} (${STATUS_TEXT[a.status]}): ${
      a.alternatives.map((alt, i) => i === a.assumedIndex ? `**${alt}**` : alt)
        .join(" / ")
    }${a.status === "corrected" ? ` → ${settledValue(a)}` : ""}`
  );
  return [
    `# ${title}`,
    "",
    "## Assumptions",
    "",
    ...(lines.length > 0 ? lines : ["None surfaced yet."]),
    "",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const MUTED = "var(--cf-theme-color-text-secondary, #6b7280)";
const BORDER = "1px solid var(--cf-theme-color-border, #e5e7eb)";

// The body fills the screen's main area and each column is exactly its
// height, so the chat and the card list scroll inside their columns and the
// sidebar's footer (unsent updates, "Tell it now") stays in view. Without
// `minHeight: 0` and the columns' `height: 100%`, both columns grew to the
// whole transcript and the footer sat thousands of pixels down, unreachable.
// On a narrow screen the sidebar wraps below the chat and the body scrolls.
const styles = {
  body: {
    display: "flex",
    flex: "1",
    flexWrap: "wrap",
    minHeight: "0",
    overflowY: "auto",
  },
  chat: {
    flex: "2 1 320px",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minHeight: "0",
  },
  sidebar: {
    flex: "1 1 260px",
    height: "100%",
    maxWidth: "380px",
    borderLeft: BORDER,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minHeight: "0",
  },
  sidebarHeader: {
    padding: "0.75rem 1rem",
    borderBottom: BORDER,
    fontWeight: "600",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerNote: { fontSize: "0.75rem", color: MUTED, fontWeight: "400" },
  empty: {
    color: MUTED,
    fontStyle: "italic",
    textAlign: "center",
    padding: "1rem",
    fontSize: "0.85rem",
  },
  card: {
    marginBottom: "0.75rem",
    borderRadius: "8px",
    border: BORDER,
    overflow: "hidden",
  },
  cardHeader: {
    padding: "0.4rem 0.6rem",
    background: "var(--cf-theme-color-surface, #f5f5f5)",
    borderBottom: BORDER,
    display: "flex",
    justifyContent: "space-between",
    gap: "0.5rem",
    fontSize: "0.8rem",
  },
  cardLabel: { fontWeight: "600" },
  cardStatus: { color: MUTED, whiteSpace: "nowrap" },
  cardBody: {
    padding: "0.5rem 0.6rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
    fontSize: "0.8rem",
  },
  about: { color: MUTED, fontStyle: "italic" },
  options: { display: "flex", flexWrap: "wrap", gap: "0.3rem" },
  footerNote: {
    borderTop: BORDER,
    padding: "0.6rem 1rem",
    fontSize: "0.8rem",
    color: MUTED,
  },
} as const;

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

interface OptionView {
  index: number;
  text: string;
  variant: "primary" | "outline";
}

interface CardView {
  id: string;
  label: string;
  description: string;
  about: string;
  status: string;
  rejectVariant: "primary" | "outline";
  options: OptionView[];
}

const CARD_STATUS: Record<AssumptionStatus, string> = {
  open: "assumed",
  confirmed: "✓ confirmed",
  corrected: "✎ corrected",
  rejected: "✗ none of these",
};

const cardView = (a: Assumption): CardView => {
  const selected = a.status === "rejected"
    ? -1
    : a.status === "corrected"
    ? a.chosenIndex
    : a.assumedIndex;
  return {
    id: a.id,
    label: a.label,
    description: a.description,
    about: a.about ? `About “${a.about}”` : "",
    status: CARD_STATUS[a.status],
    rejectVariant: a.status === "rejected" ? "primary" : "outline",
    options: a.alternatives.map((text, index) => ({
      index,
      // The assistant's own guess is marked, so a correction shows both.
      text: index === a.assumedIndex && a.status === "open" ? `${text}?` : text,
      variant: index === selected && a.status !== "open"
        ? "primary"
        : "outline",
    })),
  };
};

interface AssumptionSurfacerInput {
  messages?: PerSpace<Writable<BuiltInLLMMessage[] | Default<[]>>>;
  /** The user's verdict on each recorded assumption, by its id. The
   * assumptions themselves are read from the model's tool calls in
   * `messages`. */
  verdicts?: PerSpace<
    Writable<Record<string, StoredVerdict> | Default<Record<string, never>>>
  >;
  /** Every message of assumption updates sent, landed or not. */
  updates?: PerSpace<Writable<SentUpdate[] | Default<[]>>>;
  /** The assistant's persona. The assumption instructions are added to it. */
  systemPrompt?: PerSpace<Writable<string | Default<"">>>;
}

export interface AssumptionSurfacerOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  messages: BuiltInLLMMessage[];
  assumptions: Assumption[];
  /** Assumptions still waiting on the user. */
  openCount: number;
  /** What the user has settled, as fed to the model. */
  settled: string[];
  /** Verdicts the assistant has not been told yet, as they will be sent. */
  unsent: string[];
  /** The full system prompt the dialog runs with. */
  system: string;
  pending: boolean | undefined;
  /** The dialog's tool: record the assumptions behind the next reply. */
  recordAssumptions: Stream<{ assumptions: ReportedAssumption[] }>;
  /** Keep the assistant's guess. */
  confirmAssumption: Stream<{ id: string }>;
  /** None of the alternatives fit; tells the assistant. */
  rejectAssumption: Stream<{ id: string }>;
  /** Pick an alternative; a different one than assumed tells the assistant. */
  chooseAlternative: Stream<{ id: string; index: number }>;
  /** Tell the assistant the unsent verdicts now, if no turn is running. */
  sendUpdates: Stream<void>;
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
  clearChat: Stream<void>;
}

/** The dialog's tool. It stores nothing: the call itself, kept in the chat
 * with its input, is the record (`recordedAssumptions`). It only answers the
 * model, through the `result` cell the dialog passes in.
 *
 * Why not write the caller's state here: under server execution a tool
 * handler's write to the pattern's arguments (the document that also holds
 * `messages`) can be withdrawn from the wave while the dialog's own commit of
 * that document still carries it. A list of objects written that way is left
 * as links to element documents that were never committed, and every read of
 * the list then fails, so the sidebar rendered nothing at all. Reading the
 * record from `messages` leaves the dialog the only writer during a turn. */
const recordAssumptionsHandler = handler<
  { assumptions: ReportedAssumption[]; result?: Writable<string> },
  Record<string, never>
>((event) => {
  const n = normalizeReported(event).length;
  event.result?.set(
    n === 0
      ? "No usable assumptions recorded."
      : `Recorded ${n} assumption(s); the user will see them.`,
  );
});

/** The state a send reads and writes. */
interface Outbox {
  verdicts: Writable<Record<string, StoredVerdict>>;
  updates: Writable<SentUpdate[]>;
  messages: Writable<BuiltInLLMMessage[]>;
  addMessage: Stream<BuiltInLLMMessage>;
}

/** The assumptions as they stand now, verdicts applied. */
const currentAssumptions = (
  messages: readonly BuiltInLLMMessage[] | undefined,
  verdicts: Readonly<Record<string, StoredVerdict>> | undefined,
): Assumption[] =>
  withVerdicts(recordedAssumptions(messages ?? []), verdicts ?? {});

/** Sends the unsent updates with the user's `text` (which may be empty) as
 * one message, and logs the send. Nothing is marked told here: the updates
 * count as told once the message is in the chat, so a send the dialog drops
 * leaves them unsent. While a turn runs the dialog would drop the message, so
 * then nothing is sent. */
const tellAssistant = (
  { verdicts, updates, messages, addMessage }: Outbox,
  pending: boolean | undefined,
  text: string,
): void => {
  if (pending) return;
  const sent = updates.get() ?? [];
  const history = messages.get() ?? [];
  const update = nextUpdate(
    currentAssumptions(history, verdicts.get()),
    sent,
    history,
  );
  const message = composeMessage(update?.text ?? "", text);
  if (message === null) return;
  addMessage.send(message);
  if (update) updates.set([...sent, update]);
};

/** Applies a verdict, and tells the assistant at once if it is idle. */
const settle = (
  outbox: Outbox,
  pending: boolean | undefined,
  id: string,
  verdict: Verdict,
): void => {
  const stored = outbox.verdicts.get() ?? {};
  const next = applyVerdict(
    currentAssumptions(outbox.messages.get(), stored),
    id,
    verdict,
  ).find((a) => a.id === id);
  if (!next) return;
  outbox.verdicts.set({
    ...stored,
    [id]: { status: next.status, chosenIndex: next.chosenIndex },
  });
  tellAssistant(outbox, pending, "");
};

const sendMessage = handler<
  PromptSendEvent,
  Outbox & { pending: Writable<boolean | undefined> }
>((event, { pending, ...outbox }) => {
  const text = userText(promptInputMessage(event));
  if (!text.trim()) return;
  tellAssistant(outbox, pending.get(), text);
});

const AssumptionSurfacer = pattern<
  AssumptionSurfacerInput,
  AssumptionSurfacerOutput
>(({ messages, verdicts, updates, systemPrompt }) => {
  const assumptions = computed(() =>
    currentAssumptions(messages.get(), verdicts.get())
  );
  const system = computed(() =>
    buildSystemPrompt(systemPrompt.get(), assumptions)
  );

  const recordAssumptions = recordAssumptionsHandler({});

  const { addMessage, cancelGeneration, pending } = llmDialog({
    system,
    messages,
    model: MODEL,
    builtinTools: false,
    tools: {
      [RECORD_TOOL]: {
        handler: recordAssumptions,
        description: TOOL_DESCRIPTION,
      },
    },
  });

  const outbox = { verdicts, updates, messages, addMessage };
  const confirmAssumption = action(({ id }: { id: string }) =>
    settle(outbox, pending, id, { kind: "confirm" })
  );
  const rejectAssumption = action(({ id }: { id: string }) =>
    settle(outbox, pending, id, { kind: "reject" })
  );
  const chooseAlternative = action(
    ({ id, index }: { id: string; index: number }) =>
      settle(outbox, pending, id, { kind: "choose", index }),
  );
  const sendUpdates = action(() => tellAssistant(outbox, pending, ""));
  const clearChat = action(() => {
    cancelGeneration.send();
    messages.set([]);
    verdicts.set({});
    updates.set([]);
  });

  const title = computed(() => chatTitle(messages.get() ?? []));
  const openCount = computed(() =>
    assumptions.filter((a) => a.status === "open").length
  );
  const settled = computed(() => settledFacts(assumptions));
  const settledNote = computed(() => {
    const n = settled.length;
    return n === 0
      ? ""
      : `${n} settled fact${n === 1 ? "" : "s"} guide replies`;
  });
  const openNote = computed(() => (openCount > 0 ? `${openCount} open` : ""));
  const unsent = computed(() =>
    unsentUpdates(assumptions, updates.get() ?? [], messages.get() ?? [])
  );
  const unsentNote = computed(() => {
    const n = unsent.length;
    return n === 0
      ? ""
      : `${n} update${n === 1 ? "" : "s"} for the assistant ${
        pending ? "after this reply" : "not sent yet"
      }`;
  });
  // Newest first, so the reply just given is at the top.
  const cards = computed(() => [...assumptions].reverse().map(cardView));
  const hasCards = computed(() => assumptions.length > 0);

  const fsContent = computed(() => assumptionsMarkdown(title, assumptions));

  return {
    [NAME]: title,
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header">
          <cf-heading level={4}>{title}</cf-heading>
          <cf-hstack align="center" gap="1">
            <cf-button
              variant="pill"
              type="button"
              title="Clear chat"
              onClick={clearChat}
            >
              Clear
            </cf-button>
          </cf-hstack>
        </cf-vstack>

        <div style={styles.body}>
          <div style={styles.chat}>
            <cf-vscroll
              style="padding: 1rem; flex: 1; min-height: 0;"
              flex
              showScrollbar
              fadeEdges
              snapToBottom
            >
              <cf-chat $messages={messages} pending={pending} />
            </cf-vscroll>
          </div>

          <div style={styles.sidebar}>
            <div style={styles.sidebarHeader}>
              <span>Assumptions</span>
              <span style={styles.headerNote}>
                {pending ? "Thinking…" : openNote}
              </span>
            </div>

            <cf-vscroll
              style="padding: 1rem; flex: 1; min-height: 0;"
              flex
              showScrollbar
            >
              {hasCards
                ? (
                  <div>
                    {cards.map((card) => (
                      <div style={styles.card}>
                        <div style={styles.cardHeader}>
                          <span style={styles.cardLabel}>{card.label}</span>
                          <span style={styles.cardStatus}>{card.status}</span>
                        </div>
                        <div style={styles.cardBody}>
                          {card.about
                            ? <div style={styles.about}>{card.about}</div>
                            : null}
                          {card.description
                            ? <div>{card.description}</div>
                            : null}
                          <div style={styles.options}>
                            {card.options.map((option) => (
                              <cf-button
                                size="sm"
                                variant={option.variant}
                                onClick={() =>
                                  chooseAlternative.send({
                                    id: card.id,
                                    index: option.index,
                                  })}
                              >
                                {option.text}
                              </cf-button>
                            ))}
                            <cf-button
                              size="sm"
                              variant={card.rejectVariant}
                              onClick={() =>
                                rejectAssumption.send({ id: card.id })}
                            >
                              None of these
                            </cf-button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
                : (
                  <div style={styles.empty}>
                    Start a conversation to see the assumptions behind each
                    reply.
                  </div>
                )}
            </cf-vscroll>

            {unsentNote
              ? (
                <div style={styles.footerNote}>
                  <cf-hstack align="center" gap="2">
                    <span>{unsentNote}</span>
                    {pending ? null : (
                      <cf-button
                        size="sm"
                        variant="outline"
                        onClick={sendUpdates}
                      >
                        Tell it now
                      </cf-button>
                    )}
                  </cf-hstack>
                </div>
              )
              : null}
            {settledNote
              ? <div style={styles.footerNote}>{settledNote}</div>
              : null}
          </div>
        </div>

        <cf-prompt-input
          slot="footer"
          placeholder="Ask a question..."
          pending={pending}
          oncf-send={sendMessage({
            verdicts,
            updates,
            messages,
            addMessage,
            pending,
          })}
          oncf-stop={cancelGeneration}
        />
      </cf-screen>
    ),
    [FS]: {
      type: "text/markdown" as const,
      frontmatter: { title },
      content: fsContent,
    },
    messages,
    assumptions,
    openCount,
    settled,
    unsent,
    system,
    pending,
    recordAssumptions,
    confirmAssumption,
    rejectAssumption,
    chooseAlternative,
    sendUpdates,
    addMessage,
    cancelGeneration,
    clearChat,
  };
});

export default AssumptionSurfacer;
