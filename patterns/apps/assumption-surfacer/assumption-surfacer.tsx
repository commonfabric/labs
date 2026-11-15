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
 * own assumptions through a tool (a bound handler, which is how a dialog tool
 * writes the caller's state), so the list is durable, per reply and complete.
 * The original's "user context" notes were collected but never read; settled
 * assumptions now reach the model through the system prompt instead.
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

/** The chat's title: the start of its first message. */
export const chatTitle = (messages: readonly BuiltInLLMMessage[]): string =>
  truncate(messageText(messages[0]), TITLE_LENGTH) || DEFAULT_TITLE;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const cleanText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

/** One reported assumption made safe to store, or null when it is unusable:
 * no label, or fewer than two distinct alternatives. An assumed index out of
 * range falls back to the first alternative. */
const normalizeOne = (raw: unknown): ReportedAssumption | null => {
  if (!isRecord(raw)) return null;
  const label = cleanText(raw.label);
  const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .map((alt) => cleanText(isRecord(alt) ? alt.value : alt))
    .filter((alt, i, all) => alt !== "" && all.indexOf(alt) === i)
    .slice(0, MAX_ALTERNATIVES);
  if (label === "" || alternatives.length < 2) return null;
  const index = Number(raw.assumedIndex ?? raw.selectedIndex);
  return {
    label,
    description: cleanText(raw.description),
    alternatives,
    assumedIndex: Number.isInteger(index) && index >= 0 &&
        index < alternatives.length
      ? index
      : 0,
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
 * a repeated tool call does not stack cards. */
export const withRecorded = (
  existing: readonly Assumption[],
  reported: readonly ReportedAssumption[],
  turn: number,
  about: string,
): Assumption[] => {
  const replaced = new Set(reported.map((r) => r.label.toLowerCase()));
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

/** The record after a verdict on assumption `id`, and the message to tell the
 * assistant, "" when there is nothing new to say. A verdict that changes
 * nothing is a no-op. */
export const applyVerdict = (
  existing: readonly Assumption[],
  id: string,
  verdict: Verdict,
): { assumptions: Assumption[]; message: string } => {
  const target = existing.find((a) => a.id === id);
  const unchanged = { assumptions: [...existing], message: "" };
  if (!target) return unchanged;

  const choice = verdict.kind === "choose" ? verdict.index : -1;
  if (
    verdict.kind === "choose" &&
    (choice < 0 || choice >= target.alternatives.length)
  ) return unchanged;
  const next: Assumption = verdict.kind === "reject"
    ? { ...target, status: "rejected", chosenIndex: -1 }
    : verdict.kind === "confirm" || choice === target.assumedIndex
    ? { ...target, status: "confirmed", chosenIndex: -1 }
    : { ...target, status: "corrected", chosenIndex: choice };
  if (
    next.status === target.status && next.chosenIndex === target.chosenIndex
  ) return unchanged;

  const topic = target.label.toLowerCase();
  const assumed = target.alternatives[target.assumedIndex] ?? "";
  const message = next.status === "corrected"
    ? `Regarding ${topic}: ${settledValue(next)} rather than ${assumed}.`
    : next.status === "rejected"
    ? `Regarding ${topic}: not ${assumed}, and none of ${
      target.alternatives.join(", ")
    }.`
    // A plain confirmation tells the assistant nothing new, unless it takes
    // back an earlier correction.
    : target.status === "open"
    ? ""
    : `Regarding ${topic}: ${assumed} after all.`;

  return {
    assumptions: existing.map((a) => (a.id === id ? next : a)),
    message,
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

const styles = {
  body: {
    display: "flex",
    flex: "1",
    flexWrap: "wrap",
    overflow: "hidden",
    height: "100%",
  },
  chat: {
    flex: "2 1 320px",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minHeight: "0",
  },
  sidebar: {
    flex: "1 1 260px",
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
    background: "var(--cf-theme-color-surface-secondary, #f5f5f5)",
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
  assumptions?: PerSpace<Writable<Assumption[] | Default<[]>>>;
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
  /** The full system prompt the dialog runs with. */
  system: string;
  pending: boolean | undefined;
  /** The dialog's tool: record the assumptions behind the next reply. */
  recordAssumptions: Stream<{ assumptions: ReportedAssumption[] }, string>;
  /** Keep the assistant's guess. */
  confirmAssumption: Stream<{ id: string }>;
  /** None of the alternatives fit; tells the assistant. */
  rejectAssumption: Stream<{ id: string }>;
  /** Pick an alternative; a different one than assumed tells the assistant. */
  chooseAlternative: Stream<{ id: string; index: number }>;
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
  clearChat: Stream<void>;
}

const recordAssumptionsHandler = handler<
  { assumptions: ReportedAssumption[] },
  {
    assumptions: Writable<Assumption[]>;
    messages: Writable<BuiltInLLMMessage[]>;
  },
  string
>((event, { assumptions, messages }) => {
  const reported = normalizeReported(event);
  if (reported.length === 0) return "No assumptions recorded.";
  const userMessages = messages.get().filter((m) => m.role === "user");
  assumptions.set(
    withRecorded(
      assumptions.get(),
      reported,
      userMessages.length,
      truncate(
        messageText(userMessages[userMessages.length - 1]),
        ABOUT_LENGTH,
      ),
    ),
  );
  return `Recorded ${reported.length} assumption(s); the user will see them.`;
});

/** Applies a verdict and, when it changes what the assistant should know,
 * tells it in the chat. */
const settle = (
  assumptions: Writable<Assumption[]>,
  addMessage: Stream<BuiltInLLMMessage>,
  id: string,
  verdict: Verdict,
): void => {
  const result = applyVerdict(assumptions.get(), id, verdict);
  assumptions.set(result.assumptions);
  if (result.message !== "") {
    addMessage.send({
      role: "user",
      content: [{ type: "text" as const, text: result.message }],
    });
  }
};

const sendMessage = handler<
  PromptSendEvent,
  { addMessage: Stream<BuiltInLLMMessage> }
>((event, { addMessage }) => {
  if (!event.detail.text.trim()) return;
  addMessage.send(promptInputMessage(event));
});

const AssumptionSurfacer = pattern<
  AssumptionSurfacerInput,
  AssumptionSurfacerOutput
>(({ messages, assumptions, systemPrompt }) => {
  const system = computed(() =>
    buildSystemPrompt(systemPrompt.get(), assumptions.get())
  );

  const recordAssumptions = recordAssumptionsHandler({ assumptions, messages });

  const { addMessage, cancelGeneration, pending } = llmDialog({
    system,
    messages,
    model: MODEL,
    builtinTools: false,
    tools: {
      recordAssumptions: {
        handler: recordAssumptions,
        description: TOOL_DESCRIPTION,
      },
    },
  });

  const confirmAssumption = action(({ id }: { id: string }) =>
    settle(assumptions, addMessage, id, { kind: "confirm" })
  );
  const rejectAssumption = action(({ id }: { id: string }) =>
    settle(assumptions, addMessage, id, { kind: "reject" })
  );
  const chooseAlternative = action(
    ({ id, index }: { id: string; index: number }) =>
      settle(assumptions, addMessage, id, { kind: "choose", index }),
  );
  const clearChat = action(() => {
    cancelGeneration.send();
    messages.set([]);
    assumptions.set([]);
  });

  const title = computed(() => chatTitle(messages.get()));
  const openCount = computed(() =>
    assumptions.get().filter((a) => a.status === "open").length
  );
  const settled = computed(() => settledFacts(assumptions.get()));
  const settledNote = computed(() => {
    const n = settled.length;
    return n === 0
      ? ""
      : `${n} settled fact${n === 1 ? "" : "s"} guide replies`;
  });
  const openNote = computed(() => (openCount > 0 ? `${openCount} open` : ""));
  // Newest first, so the reply just given is at the top.
  const cards = computed(() => [...assumptions.get()].reverse().map(cardView));
  const hasCards = computed(() => assumptions.get().length > 0);

  const fsContent = computed(() =>
    assumptionsMarkdown(title, assumptions.get())
  );

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
              style="padding: 1rem; flex: 1;"
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

            <cf-vscroll style="padding: 1rem; flex: 1;" flex showScrollbar>
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

            {settledNote
              ? <div style={styles.footerNote}>{settledNote}</div>
              : null}
          </div>
        </div>

        <cf-prompt-input
          slot="footer"
          placeholder="Ask a question..."
          pending={pending}
          oncf-send={sendMessage({ addMessage })}
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
    system,
    pending,
    recordAssumptions,
    confirmAssumption,
    rejectAssumption,
    chooseAlternative,
    addMessage,
    cancelGeneration,
    clearChat,
  };
});

export default AssumptionSurfacer;
