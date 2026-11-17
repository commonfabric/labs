/**
 * Lo-fi inductor: one yes-or-no goal, a stream of items, and a frontier model
 * (hi-fi) that labels each of them. Alongside it runs a cheap rule set (lo-fi):
 * case-insensitive regular expressions in a restricted grammar. Where the two
 * disagree the rule set was surprised; once enough surprises are new, the
 * model proposes a whole new rule set, which replaces the current one only if
 * every rule is in grammar and safe and the set scores strictly better on a
 * held-out split. See README.md for the design and its CFC debt.
 *
 * State lives in the space (`PerSpace`): the items, the rules learned from
 * them, and the history are the piece's own, and every reader derives the same
 * hi-fi labels, so they are asked for once per item, not once per viewer. Only
 * the draft in the add-an-item box is per session.
 */

import {
  action,
  computed,
  type Default,
  FS,
  generateObject,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type { InductorPoolOutput } from "../inductor-pool/inductor-pool.tsx";
import {
  buildHifiPrompt,
  gradeItems,
  heldOutExamples,
  HIFI_SYSTEM,
  type HifiAnswer,
  type HistoryEntry,
  type Item,
  type ItemRow,
  markdownOf,
  newSurprises,
  percent,
  type Proposal,
  type Published,
  REWRITE_SYSTEM,
  rewriteRequest,
  type RewriteStatus,
  rewriteStatus,
  scoreRules,
  settle,
  summarize,
  type Summary,
  verdictText,
} from "./induction.ts";
import { type CanonicalRule, describeRule } from "./rule-grammar.ts";

export type { CanonicalRule } from "./rule-grammar.ts";
export type {
  HistoryEntry,
  Item,
  ItemRow,
  Published,
  RewriteStatus,
  Summary,
} from "./induction.ts";

/** What the inductor needs of a pool: its goal, and where to contribute. */
export type PoolTarget = Pick<InductorPoolOutput, "goal" | "submit">;

/** A new goal, as `setGoal` takes it. */
export interface GoalEvent {
  goal: string;
}

/** An item as `submitItem` takes it; an id is minted when none is given. */
export interface SubmittedItem {
  id?: string;
  fields: Record<string, string>;
}

interface LofiInductorInput {
  /** The yes-or-no question, such as "Is this email a bill?". */
  goal?: PerSpace<Writable<string | Default<"">>>;
  /** The items to label. Anything can feed them, through `submitItem`. */
  items?: PerSpace<Writable<Item[] | Default<[]>>>;
  /** The current rule set, in canonical form. */
  rules?: PerSpace<Writable<CanonicalRule[] | Default<[]>>>;
  /** Every judged proposal, accepted or not. */
  history?: PerSpace<Writable<HistoryEntry[] | Default<[]>>>;
  /** The rules as last published, or null. */
  published?: PerSpace<Writable<Published | null | Default<null>>>;
  /**
   * This piece's pseudonym in the goal's pool, minted on the first publish.
   * One piece holds one goal, so it is one per goal, and unlinkable to the
   * person's pseudonyms for other goals.
   */
  pseudonym?: PerSpace<Writable<string | Default<"">>>;
  /**
   * The pool to publish to. Omitted, the inductor wishes for a
   * `#inductorPool`; either way it publishes only to a pool for its goal.
   */
  pool?: PoolTarget;
  /**
   * The model that labels items. Omitted, the deployment's default
   * `generateObject` model answers; a stronger one, such as
   * `gateway:claude-opus-5-5` where the gateway lists it
   * (`/api/ai/llm/models`), can be named.
   */
  hifiModel?: PerSpace<string>;
  /** How many new surprises start a rewrite. */
  rewriteAfter?: PerSpace<number | Default<3>>;
  /** The share of items held out to score proposals on, in percent. */
  heldOutPercent?: PerSpace<number | Default<30>>;
  /** Retries of the current rewrite's failed model call. */
  rewriteAttempt?: PerSpace<Writable<number | Default<0>>>;
}

/** Induces cheap regex rules for a yes-or-no question from a model's answers. #classifier #learning */
export interface LofiInductorOutput {
  [NAME]: string;
  [UI]: VNode;
  /** The goal, rules, counts, and proposal history as Markdown. */
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  goal: string;
  items: Item[];
  rules: CanonicalRule[];
  history: HistoryEntry[];
  published: Published | null;
  /** This piece's pseudonym in the goal's pool, or "" before it publishes. */
  pseudonym: string;
  /** Every item with its hi-fi and lo-fi labels. */
  rows: ItemRow[];
  summary: Summary;
  /** The current rules' F1 on the held-out items. */
  heldOutF1: number;
  /** Where the current rewrite stands. */
  rewrite: RewriteStatus;
  /**
   * Ask a new question. The rules, the history, the pseudonym, and what was
   * published were all for the old one, so they are cleared; the items stay,
   * and the hi-fi model labels them for the new question.
   */
  setGoal: Stream<GoalEvent>;
  /** Add one item. An id the list holds already adds nothing. */
  submitItem: Stream<SubmittedItem>;
  /**
   * Record the rewrite's judgement once it is ready: adopt the proposed set if
   * it was accepted, and add the round to the history either way.
   */
  settleRewrite: Stream<void>;
  /** Ask the model again after the rewrite's call failed. */
  retryRewrite: Stream<void>;
  /** Publish the current rules for the goal. */
  publish: Stream<void>;
}

export default pattern<LofiInductorInput, LofiInductorOutput>(
  ({
    goal,
    items,
    rules,
    history,
    published,
    pseudonym,
    pool,
    hifiModel,
    rewriteAfter,
    heldOutPercent,
    rewriteAttempt,
  }) => {
    const draft = new Writable.perSession("");
    const goalDraft = new Writable.perSession("");

    // ========================================================================
    // HI-FI: one cached model call per item
    // ========================================================================

    // Expression-bodied on purpose: in a block body, the transformer wraps a
    // `const answer = generateObject(...)` in a lift that never settles.
    const hifi = items.map((item) => ({
      id: item.id,
      answer: generateObject<HifiAnswer>({
        prompt: computed(() => buildHifiPrompt(goal.get(), item)),
        system: HIFI_SYSTEM,
        model: hifiModel,
      }),
    }));

    // ========================================================================
    // LO-FI and SURPRISES
    // ========================================================================

    const rows = computed(() =>
      gradeItems(items.get(), hifi, rules.get(), heldOutPercent)
    );
    const summary = computed(() => summarize(rows));
    const heldOutF1 = computed(() =>
      scoreRules(rules.get(), heldOutExamples(rows)).f1
    );

    // ========================================================================
    // REWRITE: a whole new rule set once enough surprises are new
    // ========================================================================

    const request = computed(() =>
      rewriteRequest(
        goal.get(),
        rules.get(),
        rows,
        history.get(),
        rewriteAfter,
        rewriteAttempt.get(),
      )
    );
    const rewritePrompt = computed(() => request?.prompt ?? "");
    const proposal = generateObject<Proposal>({
      prompt: rewritePrompt,
      system: REWRITE_SYSTEM,
    });
    const rewrite = computed(() =>
      rewriteStatus(
        request,
        {
          pending: proposal.pending,
          error: proposal.error,
          result: proposal.result,
        },
        rules.get(),
        rows,
      )
    );

    // A computed cannot write, so the judgement is recorded here, by an
    // action, when a person or an agent sends `settleRewrite`. Adding an item
    // does not settle as well: an action that reads `rewrite` while hi-fi
    // calls are in flight can lose their results (see README.md, "Known
    // runtime issues").
    const settleRewrite = action(() => {
      const status = rewrite;
      if (status.status !== "ready") return;
      // Only the surprises the request was frozen on are answered; any that
      // arrived since stay new for the next round.
      const next = settle(
        rules.get(),
        history.get().length + 1,
        status.judgement,
        status.answered,
        Date.now(),
      );
      if (status.judgement.accepted) rules.set(next.rules);
      history.push(next.entry);
      rewriteAttempt.set(0);
    });

    // A failed model call records nothing; this asks the same question again.
    const retryRewrite = action(() => {
      if (rewrite.status !== "failed") return;
      rewriteAttempt.set(rewriteAttempt.get() + 1);
    });

    // The goal changes only here, never per keystroke: every hi-fi call is
    // asked for the goal, so a live input re-asked about every item on each
    // key. A new question also gets a new pseudonym, so the pool cannot link
    // this piece's contributions for two questions.
    const setGoal = action((event: GoalEvent) => {
      const next = typeof event?.goal === "string" ? event.goal.trim() : "";
      if (next === "" || next === goal.get().trim()) return;
      goal.set(next);
      rules.set([]);
      history.set([]);
      published.set(null);
      pseudonym.set("");
    });

    const applyGoalDraft = action(() => {
      const next = goalDraft.get().trim();
      if (next === "") return;
      setGoal.send({ goal: next });
      goalDraft.set("");
    });

    const submitItem = action((event: SubmittedItem) => {
      const fields = Object.fromEntries(
        Object.entries(event?.fields ?? {}).filter(([, value]) =>
          typeof value === "string"
        ),
      );
      if (Object.keys(fields).length === 0) return;
      const id = typeof event.id === "string" && event.id.trim() !== ""
        ? event.id.trim()
        : `item-${Math.random().toString(36).slice(2, 10)}`;
      if (items.get().some((existing) => existing.id === id)) return;
      items.push({ id, fields });
    });

    const addDraft = action(() => {
      const text = draft.get().trim();
      if (text === "") return;
      submitItem.send({ fields: { text } });
      draft.set("");
    });

    // ========================================================================
    // PUBLISH: the rules leave this piece only into a pool for its goal
    // ========================================================================

    // A pool serves one goal, and the wish cannot yet match on it, so
    // `publish` checks the goal before it sends.
    const poolWish = wish<PoolTarget>({
      query: "#inductorPool",
      scope: ["~", "."],
    });
    // Null, not undefined, when there is none: an action whose context
    // holds an undefined value does not run.
    const target = pool ?? poolWish.result ?? null;

    const publish = action(() => {
      // Randomness is allowed in an action, so the first publish mints the
      // pseudonym. The pool binds it to this principal from then on.
      if (!pseudonym.get()) {
        pseudonym.set(`p-${Math.random().toString(36).slice(2, 12)}`);
      }
      const question = goal.get().trim();
      const snapshot = rules.get().map((rule) => ({ ...rule }));
      const reached = target !== null &&
        (target.goal ?? "").trim() === question;
      published.set({
        goal: question,
        rules: snapshot,
        publishedAt: Date.now(),
        pooled: reached,
      });
      if (reached) {
        target.submit.send({ pseudonym: pseudonym.get(), rules: snapshot });
      }
    });

    // ========================================================================
    // VIEW
    // ========================================================================

    const title = computed(() => {
      const question = goal.get().trim();
      return question ? `Lo-fi inductor: ${question}` : "Lo-fi inductor";
    });
    const content = computed(() =>
      markdownOf(goal.get(), summary, rules.get(), heldOutF1, history.get())
    );
    const statsLine = computed(() =>
      `${summary.items} items · ${summary.labelled} labelled · ` +
      `${
        percent(summary.agreementRate)
      } agreement · ${summary.surprises} surprises`
    );
    const rulesHeading = computed(() =>
      `Rules · held-out F1 ${percent(heldOutF1)} on ${summary.heldOut} items`
    );
    const ruleLines = computed(() => rules.get().map(describeRule));
    const rewriteLine = computed(() => {
      const status = rewrite;
      if (status.status === "idle") {
        const missing = Math.max(1, rewriteAfter) -
          newSurprises(rows, history.get()).length;
        return missing > 0
          ? `Waiting for ${missing} more surprises before proposing new rules.`
          : "Waiting for the hi-fi model to label the items so far.";
      }
      if (status.status === "pending") return "Proposing a new rule set…";
      if (status.status === "failed") {
        return `Proposing failed (${status.reason}); nothing was recorded.`;
      }
      return `Proposed: ${status.judgement.reason}.`;
    });
    const rewriteReady = computed(() => rewrite.status === "ready");
    const rewriteFailed = computed(() => rewrite.status === "failed");
    // What the ready proposal holds: its rules, and why any were refused.
    const proposalLines = computed(() => {
      const status = rewrite;
      if (status.status !== "ready") return [];
      return [
        ...status.judgement.rules.map(describeRule),
        ...status.judgement.refusals,
      ];
    });
    const settleLabel = computed(() => {
      const status = rewrite;
      if (status.status !== "ready") return "";
      const { accepted, currentF1, proposedF1 } = status.judgement;
      return accepted
        ? `Apply new rules (F1 ${percent(currentF1)} → ${percent(proposedF1)})`
        : "Dismiss rejected proposal";
    });
    const historyLines = computed(() =>
      [...history.get()].reverse().map((entry) => ({
        round: `Round ${entry.round}: ${
          entry.accepted ? "accepted" : "rejected"
        }`,
        reason: entry.reason,
        detail: [
          ...entry.proposed.map(describeRule),
          ...entry.refusals,
        ].join("\n"),
      }))
    );
    const publishedLine = computed(() => {
      const snapshot = published.get();
      if (!snapshot) return "Not published yet.";
      return snapshot.pooled
        ? `Published ${snapshot.rules.length} rules to the pool for ` +
          `“${snapshot.goal}”.`
        : `No pool for “${snapshot.goal}” found; nothing was sent.`;
    });
    const itemLines = computed(() =>
      [...rows].reverse().map((row) => ({
        text: Object.values(row.fields).join(" · "),
        verdict: verdictText(row),
        color: row.surprise
          ? "var(--cf-theme-color-error)"
          : "var(--cf-theme-color-text-muted)",
      }))
    );

    return {
      [NAME]: title,
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="2">
            <cf-heading level={4}>{title}</cf-heading>
            <cf-hstack gap="2">
              <cf-input
                $value={goalDraft}
                placeholder="A new yes-or-no question, such as “Is this email a bill?”"
                style="flex: 1;"
              />
              <cf-button onClick={applyGoalDraft}>Set goal</cf-button>
            </cf-hstack>
            <span>{statsLine}</span>
          </cf-vstack>
          <cf-vscroll>
            <cf-vstack gap="3" style="padding: 1rem;">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>{rulesHeading}</cf-heading>
                  {ruleLines.map((line) => <code>{line}</code>)}
                  <span>{rewriteLine}</span>
                  {proposalLines.map((line) => <code>{line}</code>)}
                  {rewriteReady
                    ? (
                      <cf-button onClick={() => settleRewrite.send()}>
                        {settleLabel}
                      </cf-button>
                    )
                    : null}
                  {rewriteFailed
                    ? (
                      <cf-button onClick={() => retryRewrite.send()}>
                        Try again
                      </cf-button>
                    )
                    : null}
                  <cf-hstack gap="2" align="center">
                    <cf-button onClick={() => publish.send()}>
                      Publish rules
                    </cf-button>
                    <span>{publishedLine}</span>
                  </cf-hstack>
                </cf-vstack>
              </cf-card>
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>Proposals</cf-heading>
                  {historyLines.map((entry) => (
                    <cf-vstack gap="0">
                      <strong>{entry.round}</strong>
                      <span>{entry.reason}</span>
                      <pre style="margin: 0; white-space: pre-wrap;">{entry.detail}</pre>
                    </cf-vstack>
                  ))}
                </cf-vstack>
              </cf-card>
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>Items</cf-heading>
                  <cf-hstack gap="2">
                    <cf-input
                      $value={draft}
                      placeholder="Add an item's text"
                      style="flex: 1;"
                    />
                    <cf-button onClick={addDraft}>Add</cf-button>
                  </cf-hstack>
                  {itemLines.map((line) => (
                    <cf-hstack gap="2">
                      <span style="flex: 1;">{line.text}</span>
                      <span style={{ color: line.color }}>{line.verdict}</span>
                    </cf-hstack>
                  ))}
                </cf-vstack>
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content,
      },
      goal,
      items,
      rules,
      history,
      published,
      pseudonym,
      rows,
      summary,
      heldOutF1,
      rewrite,
      setGoal,
      submitItem,
      settleRewrite,
      retryRewrite,
      publish,
    };
  },
);
