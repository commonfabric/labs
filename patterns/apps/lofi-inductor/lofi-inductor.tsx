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
  Writable,
} from "commonfabric";
import {
  buildHifiPrompt,
  buildRewritePrompt,
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
  /** Every item with its hi-fi and lo-fi labels. */
  rows: ItemRow[];
  summary: Summary;
  /** The current rules' F1 on the held-out items. */
  heldOutF1: number;
  /** Where the current rewrite stands. */
  rewrite: RewriteStatus;
  /** Add one item. An id the list holds already adds nothing. */
  submitItem: Stream<SubmittedItem>;
  /**
   * Record the rewrite's judgement once it is ready: adopt the proposed set if
   * it was accepted, and add the round to the history either way.
   */
  settleRewrite: Stream<void>;
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
    hifiModel,
    rewriteAfter,
    heldOutPercent,
  }) => {
    const draft = new Writable.perSession("");

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

    const rewritePrompt = computed(() =>
      buildRewritePrompt(
        goal.get(),
        rules.get(),
        rows,
        history.get(),
        rewriteAfter,
      )
    );
    const proposal = generateObject<Proposal>({
      prompt: rewritePrompt,
      system: REWRITE_SYSTEM,
    });
    const rewrite = computed(() =>
      rewriteStatus(
        rewritePrompt,
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
      const next = settle(
        rules.get(),
        history.get().length + 1,
        status.judgement,
        newSurprises(rows, history.get()),
        Date.now(),
      );
      if (status.judgement.accepted) rules.set(next.rules);
      history.push(next.entry);
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

    // TODO(inductor-pool): publishing is where the rules leave this piece.
    // The `inductor-pool` pattern (README.md) will take `published` under the
    // goal's pseudonym and release a rule once enough distinct contributors
    // hold it. Until the CFC cuts it needs are approved, this only records
    // the snapshot.
    const publish = action(() => {
      published.set({
        goal: goal.get().trim(),
        rules: rules.get().map((rule) => ({ ...rule })),
        publishedAt: Date.now(),
      });
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
      const status = rewrite.status;
      if (status === "idle") {
        return `Waiting for ${
          Math.max(1, rewriteAfter) -
          newSurprises(rows, history.get()).length
        } more surprises before proposing new rules.`;
      }
      if (status === "pending") return "Proposing a new rule set…";
      return "A proposal has been judged and is ready to record.";
    });
    const rewriteReady = computed(() => rewrite.status === "ready");
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
      return snapshot
        ? `Published ${snapshot.rules.length} rules for “${snapshot.goal}”.`
        : "Not published yet.";
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
            <cf-input
              $value={goal}
              placeholder="A yes-or-no question, such as “Is this email a bill?”"
            />
            <span>{statsLine}</span>
          </cf-vstack>
          <cf-vscroll>
            <cf-vstack gap="3" style="padding: 1rem;">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>{rulesHeading}</cf-heading>
                  {ruleLines.map((line) => <code>{line}</code>)}
                  <span>{rewriteLine}</span>
                  {rewriteReady
                    ? (
                      <cf-button onClick={() => settleRewrite.send()}>
                        Record the judgement
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
      rows,
      summary,
      heldOutF1,
      rewrite,
      submitItem,
      settleRewrite,
      publish,
    };
  },
);
