/**
 * The lo-fi inductor's decisions, apart from the pattern that stores and shows
 * them: running a rule set over items, finding where it disagrees with the
 * hi-fi model, splitting the graded examples, scoring a rule set, building the
 * prompts, and judging a proposed rule set against the current one.
 *
 * Every function here is pure: the pattern calls them from computeds and from
 * the one action that writes what a judgement decided.
 */

import {
  calculateF1,
  calculatePrecisionRecall,
  isRegexSafe,
} from "../self-improving-classifier/classifier-logic.ts";
import {
  type CanonicalRule,
  checkRule,
  describeRule,
  stableHash,
} from "./rule-grammar.ts";

// =============================================================================
// TYPES
// =============================================================================

/** One thing to label: a connector's record, a message, anything with text. */
export interface Item {
  id: string;
  fields: Record<string, string>;
}

/** What the hi-fi model answers about one item. */
export interface HifiAnswer {
  label: boolean;
  reasoning: string;
}

/** One item's hi-fi call, as far as grading reads it. */
export interface HifiState {
  id: string;
  answer: {
    pending: boolean;
    error?: unknown;
    result?: Partial<Record<keyof HifiAnswer, unknown>> | undefined;
  };
}

/** Which side of the graded set an item is on. Stable: a hash of its id. */
export type Split = "train" | "heldout";

/** One item as the inductor sees it. */
export interface ItemRow {
  id: string;
  fields: Record<string, string>;
  /** The hi-fi label, or null until the model has answered usably. */
  hifi: boolean | null;
  /** The current rule set's label. */
  lofi: boolean;
  /** The lo-fi label disagrees with a hi-fi label that has arrived. */
  surprise: boolean;
  split: Split;
}

/** How well a rule set labels a set of examples. */
export interface Score {
  f1: number;
  precision: number;
  recall: number;
  examples: number;
}

/** A proposed rule set, as the model is asked to give it. */
export interface Proposal {
  rules: Array<{ field: string; pattern: string; predicts: boolean }>;
  reasoning: string;
}

/** What judging a proposal decided. */
export interface Judgement {
  accepted: boolean;
  reason: string;
  /** The proposed rules that passed the grammar and the safety check. */
  rules: CanonicalRule[];
  /** Why each refused rule was refused. */
  refusals: string[];
  currentF1: number;
  proposedF1: number;
  heldOut: number;
}

/** Where the current rewrite stands. */
export type RewriteStatus =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ready"; judgement: Judgement };

/** One judged proposal, as the history keeps it. */
export interface HistoryEntry {
  round: number;
  accepted: boolean;
  reason: string;
  proposed: CanonicalRule[];
  refusals: string[];
  currentF1: number;
  proposedF1: number;
  heldOut: number;
  /** The surprises this round answered, so the next round counts new ones. */
  answered: string[];
  decidedAt: number;
}

/** The rules a person is ready to share for a goal. */
export interface Published {
  goal: string;
  rules: CanonicalRule[];
  publishedAt: number;
  /** Whether the rules were sent to a pool for this goal. */
  pooled?: boolean;
}

/** The most rules a set may hold. */
export const MAX_RULES = 20;

/** How many examples of each kind the rewrite prompt carries at most. */
const PROMPT_SURPRISES = 30;
const PROMPT_AGREEMENTS = 20;

// =============================================================================
// SPLIT
// =============================================================================

/**
 * The side of the graded set `id` is on: held out when its hash falls in the
 * first `heldOutPercent` of a hundred buckets. The same id always lands on the
 * same side, so an example never leaks from held-out into training.
 */
export function splitOf(id: string, heldOutPercent: number): Split {
  const bucket = parseInt(stableHash(id).slice(0, 8), 16) % 100;
  return bucket < heldOutPercent ? "heldout" : "train";
}

// =============================================================================
// RUNNING RULES
// =============================================================================

/** A rule with its compiled expression. */
interface CompiledRule {
  rule: CanonicalRule;
  regex: RegExp;
}

/**
 * `rules` compiled, leaving out any that is outside the grammar or unsafe.
 * Stored rules are canonical already; a rule seeded by hand may not be.
 */
function compileRules(rules: readonly CanonicalRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    const check = checkRule(rule);
    if (!check.ok || !isRegexSafe(check.rule.pattern)) continue;
    compiled.push({ rule, regex: new RegExp(check.rule.pattern, "i") });
  }
  return compiled;
}

/**
 * The label a compiled rule set gives `fields`: YES when a YES rule matches
 * and no NO rule does. A NO rule is an exception to the YES rules; with no
 * rule matching, the answer is NO.
 */
function label(
  compiled: readonly CompiledRule[],
  fields: Record<string, string>,
): boolean {
  let yes = false;
  for (const { rule, regex } of compiled) {
    const value = fields[rule.field];
    if (typeof value !== "string" || !regex.test(value)) continue;
    if (!rule.predicts) return false;
    yes = true;
  }
  return yes;
}

/** The label `rules` give `fields`. */
export function labelWith(
  rules: readonly CanonicalRule[],
  fields: Record<string, string>,
): boolean {
  return label(compileRules(rules), fields);
}

/** The hi-fi label in `state`, or null while there is no usable one. */
function hifiLabel(state: HifiState | undefined): boolean | null {
  const answer = state?.answer;
  if (!answer || answer.pending || answer.error) return null;
  const label = answer.result?.label;
  return typeof label === "boolean" ? label : null;
}

/**
 * Every item with its hi-fi label (once usable), the current rules' label, and
 * whether the two disagree.
 */
export function gradeItems(
  items: readonly Item[],
  hifi: readonly HifiState[],
  rules: readonly CanonicalRule[],
  heldOutPercent: number,
): ItemRow[] {
  const compiled = compileRules(rules);
  const byId = new Map<string, HifiState>();
  for (const state of hifi) byId.set(state.id, state);
  return items.map((item) => {
    const hifiValue = hifiLabel(byId.get(item.id));
    const lofi = label(compiled, item.fields);
    return {
      id: item.id,
      fields: { ...item.fields },
      hifi: hifiValue,
      lofi,
      surprise: hifiValue !== null && hifiValue !== lofi,
      split: splitOf(item.id, heldOutPercent),
    };
  });
}

/** The counts the view and the text projection show. */
export interface Summary {
  items: number;
  labelled: number;
  agreements: number;
  surprises: number;
  /** Agreements over labelled items, or null with nothing labelled. */
  agreementRate: number | null;
  heldOut: number;
}

export function summarize(rows: readonly ItemRow[]): Summary {
  const labelled = rows.filter((row) => row.hifi !== null);
  const surprises = labelled.filter((row) => row.surprise).length;
  return {
    items: rows.length,
    labelled: labelled.length,
    agreements: labelled.length - surprises,
    surprises,
    agreementRate: labelled.length === 0
      ? null
      : (labelled.length - surprises) / labelled.length,
    heldOut: labelled.filter((row) => row.split === "heldout").length,
  };
}

// =============================================================================
// SCORING
// =============================================================================

/** The held-out examples: labelled items on the held-out side. */
export function heldOutExamples(
  rows: readonly ItemRow[],
): Array<{ fields: Record<string, string>; label: boolean }> {
  return rows
    .filter((row) => row.split === "heldout" && row.hifi !== null)
    .map((row) => ({ fields: row.fields, label: row.hifi === true }));
}

/**
 * How well `rules` label `examples`, as precision, recall, and F1 over YES.
 * With nothing to divide by, precision or recall counts as one half, as the
 * self-improving classifier scores a rule, so a set that stays silent on
 * examples with no YES among them is not scored zero.
 */
export function scoreRules(
  rules: readonly CanonicalRule[],
  examples: ReadonlyArray<{ fields: Record<string, string>; label: boolean }>,
): Score {
  const compiled = compileRules(rules);
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const example of examples) {
    const predicted = label(compiled, example.fields);
    if (predicted && example.label) truePositives++;
    else if (predicted) falsePositives++;
    else if (example.label) falseNegatives++;
  }
  const { precision, recall } = calculatePrecisionRecall({
    truePositives,
    falsePositives,
    falseNegatives,
  });
  return {
    f1: calculateF1({ precision, recall }),
    precision,
    recall,
    examples: examples.length,
  };
}

// =============================================================================
// SURPRISES
// =============================================================================

/** The surprises no judged round has answered yet, by id. */
export function newSurprises(
  rows: readonly ItemRow[],
  history: readonly HistoryEntry[],
): string[] {
  const answered = new Set<string>();
  for (const entry of history) {
    for (const id of entry.answered ?? []) answered.add(id);
  }
  return rows
    .filter((row) => row.surprise && !answered.has(row.id))
    .map((row) => row.id);
}

// =============================================================================
// PROMPTS
// =============================================================================

export const HIFI_SYSTEM =
  `You are a careful labeller. You are given a yes-or-no question and one item.
Answer the question about the item.
Respond with:
- label: true for YES, false for NO
- reasoning: one short sentence saying why`;

/** The prompt asking the hi-fi model about `item`, or "" with no goal. */
export function buildHifiPrompt(goal: string, item: Item): string {
  const question = goal.trim();
  if (question === "") return "";
  return `Question: ${question}\n\nItem:\n${
    JSON.stringify(item.fields, null, 2)
  }`;
}

export const REWRITE_SYSTEM =
  `You write lo-fi rules: case-insensitive regular expressions that answer a yes-or-no question about items as well as a careful labeller does.
Propose a WHOLE replacement rule set, not a change to one rule.
Each rule has:
- field: the item field the pattern is tested against
- pattern: a regular expression without slashes or flags
- predicts: true if a match means YES, false if a match means NO even when a YES rule matches
An item is YES when some YES rule matches and no NO rule matches.
Use only plain regular expressions: no backreferences, no lookahead or lookbehind, no named groups, no nested repetition such as (a+)+.
Never put personal details (names, addresses, account numbers) in a pattern; rules must generalise.
Also give a one-sentence reasoning.`;

function exampleLine(row: ItemRow): string {
  return `- ${JSON.stringify(row.fields)} → ${row.hifi ? "YES" : "NO"}${
    row.surprise ? ` (current rules said ${row.lofi ? "YES" : "NO"})` : ""
  }`;
}

/**
 * The prompt asking for a new rule set, or "" while fewer than `rewriteAfter`
 * surprises are new since the last judged round. It shows the model only
 * training examples, so the held-out score stays an honest test.
 */
export function buildRewritePrompt(
  goal: string,
  rules: readonly CanonicalRule[],
  rows: readonly ItemRow[],
  history: readonly HistoryEntry[],
  rewriteAfter: number,
): string {
  const question = goal.trim();
  if (question === "") return "";
  if (newSurprises(rows, history).length < Math.max(1, rewriteAfter)) {
    return "";
  }
  const training = rows.filter((row) =>
    row.split === "train" && row.hifi !== null
  );
  const surprises = training.filter((row) => row.surprise).slice(
    -PROMPT_SURPRISES,
  );
  const agreements = training.filter((row) => !row.surprise).slice(
    -PROMPT_AGREEMENTS,
  );
  const fields = new Set(rows.flatMap((row) => Object.keys(row.fields)));
  return [
    `Question: ${question}`,
    `Fields items have: ${[...fields].sort().join(", ")}`,
    `Current rules:\n${
      rules.length === 0 ? "(none)" : rules.map(describeRule).join("\n")
    }`,
    `Items the current rules got wrong:\n${
      surprises.length === 0 ? "(none)" : surprises.map(exampleLine).join("\n")
    }`,
    `Items the current rules got right:\n${
      agreements.length === 0
        ? "(none)"
        : agreements.map(exampleLine).join("\n")
    }`,
  ].join("\n\n");
}

// =============================================================================
// JUDGING A PROPOSAL
// =============================================================================

/**
 * Whether the proposed rule set replaces `current`. The proposal is model
 * output, so nothing in it is trusted to have its declared type. It is
 * accepted only when every rule is inside the grammar and safe to run, and the
 * set scores strictly better F1 than the current one on the held-out examples;
 * a tie keeps the current set.
 */
export function judgeProposal(
  current: readonly CanonicalRule[],
  proposal: unknown,
  heldOut: ReadonlyArray<{ fields: Record<string, string>; label: boolean }>,
): Judgement {
  const currentF1 = scoreRules(current, heldOut).f1;
  const refuse = (
    reason: string,
    rules: CanonicalRule[] = [],
    refusals: string[] = [],
  ): Judgement => ({
    accepted: false,
    reason,
    rules,
    refusals,
    currentF1,
    proposedF1: 0,
    heldOut: heldOut.length,
  });

  const drafts = typeof proposal === "object" && proposal !== null
    ? (proposal as { rules?: unknown }).rules
    : undefined;
  if (!Array.isArray(drafts)) return refuse("the proposal held no rule list");
  if (drafts.length > MAX_RULES) {
    return refuse(`the proposal held more than ${MAX_RULES} rules`);
  }

  const rules: CanonicalRule[] = [];
  const refusals: string[] = [];
  drafts.forEach((draft: unknown, index) => {
    const check = checkRule(draft);
    if (!check.ok) {
      refusals.push(`rule ${index + 1}: ${check.reason}`);
    } else if (!isRegexSafe(check.rule.pattern)) {
      refusals.push(
        `rule ${
          index + 1
        }: /${check.rule.pattern}/ could backtrack catastrophically`,
      );
    } else if (!rules.some((rule) => rule.key === check.rule.key)) {
      rules.push(check.rule);
    }
  });
  if (refusals.length > 0) {
    return refuse("a proposed rule was refused", rules, refusals);
  }

  const proposedF1 = scoreRules(rules, heldOut).f1;
  const better = proposedF1 > currentF1;
  return {
    accepted: better,
    reason: heldOut.length === 0
      ? "there are no held-out examples to score on yet"
      : better
      ? `held-out F1 rose from ${percent(currentF1)} to ${percent(proposedF1)}`
      : `held-out F1 ${percent(proposedF1)} is not better than ${
        percent(currentF1)
      }`,
    rules,
    refusals,
    currentF1,
    proposedF1,
    heldOut: heldOut.length,
  };
}

/** The parts of the rewrite call's state that `rewriteStatus` reads. */
export interface RewriteGeneration {
  pending: boolean;
  error?: unknown;
  result?: unknown;
}

/**
 * Where the rewrite stands: idle while the prompt is empty, pending while the
 * model works, and ready with a judgement once it answers. A failed call is
 * judged too, as a refusal, so the round is recorded and its surprises are
 * answered rather than asked about again.
 */
export function rewriteStatus(
  prompt: string,
  generation: RewriteGeneration,
  current: readonly CanonicalRule[],
  rows: readonly ItemRow[],
): RewriteStatus {
  if (prompt === "") return { status: "idle" };
  if (generation.pending) return { status: "pending" };
  const heldOut = heldOutExamples(rows);
  if (generation.error) {
    const currentF1 = scoreRules(current, heldOut).f1;
    return {
      status: "ready",
      judgement: {
        accepted: false,
        reason: `the model call failed: ${String(generation.error)}`,
        rules: [],
        refusals: [],
        currentF1,
        proposedF1: 0,
        heldOut: heldOut.length,
      },
    };
  }
  if (generation.result === undefined || generation.result === null) {
    return { status: "pending" };
  }
  return {
    status: "ready",
    judgement: judgeProposal(current, generation.result, heldOut),
  };
}

/** A plain copy of `rule`, detached from any cell it was read from. */
function copyRule(rule: CanonicalRule): CanonicalRule {
  return {
    field: rule.field,
    pattern: rule.pattern,
    predicts: rule.predicts,
    key: rule.key,
  };
}

/**
 * What recording `judgement` as round `round` writes: the history entry,
 * naming the surprises it answered, and the rule set that follows it, which is
 * the proposed set only when it was accepted. Everything is a plain copy: the
 * judgement is read from a computed that goes idle once the round is recorded,
 * so a stored reference into it would come to read as nothing.
 */
export function settle(
  rules: readonly CanonicalRule[],
  round: number,
  judgement: Judgement,
  answered: readonly string[],
  decidedAt: number,
): { rules: CanonicalRule[]; entry: HistoryEntry } {
  const proposed = judgement.rules.map(copyRule);
  return {
    rules: judgement.accepted ? proposed.map(copyRule) : rules.map(copyRule),
    entry: {
      round,
      accepted: judgement.accepted,
      reason: judgement.reason,
      proposed,
      refusals: [...judgement.refusals],
      currentF1: judgement.currentF1,
      proposedF1: judgement.proposedF1,
      heldOut: judgement.heldOut,
      answered: [...answered],
      decidedAt,
    },
  };
}

// =============================================================================
// PRESENTATION
// =============================================================================

/** A fraction as a whole percentage, such as "83%". */
export function percent(fraction: number | null): string {
  return fraction === null ? "–" : `${Math.round(fraction * 100)}%`;
}

/** What the pattern holds, as Markdown. */
export function markdownOf(
  goal: string,
  summary: Summary,
  rules: readonly CanonicalRule[],
  heldOutF1: number,
  history: readonly HistoryEntry[],
): string {
  const lines = [
    `# ${goal.trim() || "Lo-fi inductor"}`,
    "",
    `${summary.items} items, ${summary.labelled} labelled by the hi-fi model, ` +
    `${
      percent(summary.agreementRate)
    } agreement, ${summary.surprises} surprises.`,
    "",
    `## Rules (held-out F1 ${percent(heldOutF1)}, ${summary.heldOut} held out)`,
    "",
    ...(rules.length === 0
      ? ["No rules yet."]
      : rules.map((rule) => `- \`${describeRule(rule)}\``)),
    "",
    "## Proposals",
    "",
    ...(history.length === 0
      ? ["None yet."]
      : history.map((entry) =>
        `- Round ${entry.round}: ${
          entry.accepted ? "accepted" : "rejected"
        } — ${entry.reason}`
      )),
  ];
  return lines.join("\n");
}

/** One item's labels, as the view shows them. */
export function verdictText(row: ItemRow): string {
  const lofi = row.lofi ? "YES" : "NO";
  if (row.hifi === null) return `lo-fi ${lofi}, hi-fi …`;
  return `lo-fi ${lofi}, hi-fi ${row.hifi ? "YES" : "NO"}`;
}
