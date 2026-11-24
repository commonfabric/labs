/**
 * Lo-fi inductor: one yes-or-no goal, a stream of items, and a frontier model
 * (hi-fi) that labels each of them. Alongside it runs a cheap rule set (lo-fi):
 * case-insensitive regular expressions in a restricted grammar. Where the two
 * disagree the rule set was surprised; once enough surprises are new, the
 * model proposes a whole new rule set, which replaces the current one only if
 * every rule is in grammar and safe and the set scores clearly better on
 * enough of a held-out split. See README.md for the design and its CFC debt.
 *
 * State lives in the space (`PerSpace`): the items, the rules learned from
 * them, and the history are the piece's own, and every reader derives the same
 * hi-fi labels, so they are asked for once per item, not once per viewer. Only
 * the drafts in the goal and add-an-item boxes are per session.
 *
 * This pattern holds the state, the verbs, and the judgements; the cards it
 * lays out (`items-card.tsx`, `rules-card.tsx`, `history-card.tsx`,
 * `pool-card.tsx`, `settings-card.tsx`) render them and send the verbs.
 */

import {
  action,
  computed,
  type Default,
  equals,
  FS,
  generateObject,
  hasError,
  isObsolete,
  isPending,
  isSyncing,
  NAME,
  pattern,
  type PerSpace,
  resultOf,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  adoptedAfter,
  buildHifiPrompt,
  gradeItems,
  heldOutExamples,
  HIFI_SCHEMA,
  HIFI_SYSTEM,
  type HifiAnswer,
  type HistoryEntry,
  type Item,
  type ItemRow,
  labellingCount,
  markdownOf,
  percent,
  type PoolOffer,
  poolOffer,
  type PoolRule,
  type Proposal,
  PROPOSAL_SCHEMA,
  type Published,
  REWRITE_SYSTEM,
  rewriteRequest,
  type RewriteStatus,
  rewriteStatus,
  sameGoal,
  scoreRules,
  settle,
  shareable,
  summarize,
  type Summary,
  verdictsOf,
} from "./induction.ts";
import type { CanonicalRule } from "../shared/rule-grammar.ts";
import type { ContributionEvent } from "../pool/pool-policy.tsx";
import ItemsCard, { type ItemRef, type SubmittedItem } from "./items-card.tsx";
import RulesCard, { type RuleRef } from "./rules-card.tsx";
import PoolCard from "./pool-card.tsx";
import HistoryCard from "./history-card.tsx";
import SettingsCard from "./settings-card.tsx";

export type { CanonicalRule } from "../shared/rule-grammar.ts";
export type {
  HistoryEntry,
  Item,
  ItemRow,
  PoolOffer,
  PoolRule,
  Published,
  RewriteStatus,
  Summary,
} from "./induction.ts";
export type { ItemRef, RuleRef, SubmittedItem };

/**
 * What the inductor needs of a pool: its goal, where to contribute, and how
 * to take a contribution back. It is written out here rather than picked from
 * the pool's output type, so the inductor depends on the pool's shape and its
 * policy, not on the pattern: anything of this shape may receive what the
 * inductor publishes, and the policy's label decides what it can do with it.
 */
export interface PoolTarget {
  goal: string;
  submit: Stream<PoolSubmission>;
  /** Takes the sender's contribution out of the pool. */
  withdraw: Stream<void>;
  /** The rules the pool releases, most-held first. */
  consensus: PoolRule[];
}

/**
 * What a pool's `submit` takes: a rule set under a pseudonym, labelled with
 * the real pool's policy (`../pool/pool-policy.tsx`). The label, not the
 * receiver, is what keeps the rules private: any pattern with a pool's shape
 * and this goal receives them, but only the real pool's `releaseConsensus`
 * may make them public.
 */
export type PoolSubmission = ContributionEvent;

/** A new goal, as `setGoal` takes it. */
export interface GoalEvent {
  goal: string;
}

/** Several items, as `addItems` takes them. */
export interface SubmittedItems {
  items: SubmittedItem[];
}

/** How many new surprises start a rewrite, as `setRewriteAfter` takes it. */
export interface RewriteAfterEvent {
  count: number;
}

/** The held-out share, as `setHeldOutPercent` takes it. */
export interface HeldOutPercentEvent {
  percent: number;
}

/**
 * The hi-fi model, as `setHifiModel` takes it: a model name, or "" for the
 * deployment's default.
 */
export interface HifiModelEvent {
  model: string;
}

interface LofiInductorInput {
  /** The yes-or-no question, such as "Is this email a bill?". */
  goal?: PerSpace<Writable<string | Default<"">>>;
  /** The items to label. Anything can feed them, through `addItem`. */
  items?: PerSpace<Writable<Item[] | Default<[]>>>;
  /** The current rule set, in canonical form. */
  rules?: PerSpace<Writable<CanonicalRule[] | Default<[]>>>;
  /** Every judged proposal, accepted or not. */
  history?: PerSpace<Writable<HistoryEntry[] | Default<[]>>>;
  /** The rules as last published, or null. */
  published?: PerSpace<Writable<Published | null | Default<null>>>;
  /**
   * This piece's pseudonym in the goal's pool, minted on the first publish.
   * One piece holds one goal, so it is one per goal. Each piece mints its
   * own, so the strings do not relate across goals, but they are not
   * unlinkable: the pool space's commits and `authored-by` labels name the
   * person's core identity (CFC debt cut 2, see the README).
   */
  pseudonym?: PerSpace<Writable<string | Default<"">>>;
  /**
   * The pool to publish to. Omitted, the inductor wishes for a
   * `#inductorPool`; either way it publishes only to a pool for its goal.
   */
  pool?: PoolTarget;
  /**
   * The model that labels items and proposes rules. Empty, the deployment's
   * default `generateObject` model answers; any model the gateway lists
   * (`/api/ai/llm/models`) can be named.
   */
  hifiModel?: PerSpace<Writable<string | Default<"">>>;
  /** How many new surprises start a rewrite. */
  rewriteAfter?: PerSpace<Writable<number | Default<3>>>;
  /** The share of items held out to score proposals on, in percent. */
  heldOutPercent?: PerSpace<Writable<number | Default<30>>>;
  /** Retries of the current rewrite's failed model call. */
  rewriteAttempt?: PerSpace<Writable<number | Default<0>>>;
  /**
   * The keys of the current rules adopted from the pool, which publishing
   * leaves out (`adoptedAfter`).
   */
  adopted?: PerSpace<Writable<string[] | Default<[]>>>;
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
  /** The keys of the current rules adopted from the pool, never published. */
  adopted: string[];
  /** The model that labels items and proposes rules, or "" for the default. */
  hifiModel: string;
  /** How many new surprises start a rewrite. */
  rewriteAfter: number;
  /** The share of items held out to score proposals on, in percent. */
  heldOutPercent: number;
  /** Every item with its hi-fi and lo-fi labels. */
  rows: ItemRow[];
  summary: Summary;
  /** The current rules' F1 on the held-out items. */
  heldOutF1: number;
  /** Where the current rewrite stands. */
  rewrite: RewriteStatus;
  /**
   * Ask a new question. The old goal's contribution is withdrawn from its
   * pool, and the rules, the history, the pseudonym, and what was published
   * were all for the old question, so they are cleared; the items stay, and
   * the hi-fi model labels them for the new question. The same question again
   * changes nothing; a blank one is refused.
   */
  setGoal: Stream<GoalEvent>;
  /**
   * Add one item: string fields, at least one, and an optional id that
   * deduplicates (an id the list holds already adds nothing). An item with no
   * fields is refused; the event's schema drops a field that is not a string
   * before the verb sees it.
   */
  addItem: Stream<SubmittedItem>;
  /** Add several items at once, each as `addItem` takes it. */
  addItems: Stream<SubmittedItems>;
  /**
   * Take one item out, by reference: the item as read from `items`. An item
   * the list no longer holds changes nothing.
   */
  removeItem: Stream<ItemRef>;
  /**
   * Take one rule out of the current set: the rule with the given rule's
   * canonical `key`, as read from `rules`. A rule the set no longer holds
   * changes nothing; one without a key is refused.
   */
  removeRule: Stream<RuleRef>;
  /** Empty the current rule set. The history stays. */
  resetRules: Stream<void>;
  /**
   * Record the rewrite's judgement once it is ready: adopt the proposed set if
   * it was accepted, and add the round to the history either way.
   */
  settleRewrite: Stream<void>;
  /** Ask the model again after the rewrite's call failed. */
  retryRewrite: Stream<void>;
  /** Set how many new surprises start a rewrite: a whole number, at least 1. */
  setRewriteAfter: Stream<RewriteAfterEvent>;
  /** Set the held-out share: a number above 0 and below 100. */
  setHeldOutPercent: Stream<HeldOutPercentEvent>;
  /** Name the model, or "" for the default. Every item is asked again. */
  setHifiModel: Stream<HifiModelEvent>;
  /**
   * The pool's released rules for this goal, judged as a candidate set on
   * this piece's held-out items, or null when there is nothing new to offer.
   */
  poolOffer: PoolOffer | null;
  /**
   * Record the pool offer's judgement: adopt the pool's rules if they were
   * accepted, and add the round to the history either way.
   */
  settlePoolOffer: Stream<void>;
  /** Publish the current rules for the goal. */
  publish: Stream<void>;
  /**
   * Take this piece's contribution back out of the goal's pool and forget
   * what was published. The pseudonym stays, for the next publish.
   */
  unpublish: Stream<void>;
}

/** The item an `addItem` event describes; throws on one that is malformed. */
function checkedItem(
  event: SubmittedItem,
): { id: string; fields: Item["fields"] } {
  if (typeof event !== "object" || event === null) {
    throw new Error("An item is an object with `fields`.");
  }
  const raw = event.fields;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("An item needs `fields`, an object of strings.");
  }
  // A copy, so the item stored is plain data rather than the event's.
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) fields[name] = value;
  if (Object.keys(fields).length === 0) {
    throw new Error("An item needs at least one field.");
  }
  if (event.id !== undefined && typeof event.id !== "string") {
    throw new Error("An item's `id` is a string when given.");
  }
  return { id: event.id?.trim() ?? "", fields };
}

/**
 * Appends the items `events` describe to `items`, skipping an id the list
 * holds already or the batch repeats. The id is only a dedupe key, so a
 * connector that sends the same record twice adds it once; nothing addresses
 * an item by it. Throws, adding none, if any event is malformed.
 */
function appendItems(
  items: Writable<Item[]>,
  events: readonly SubmittedItem[],
): void {
  const checked = events.map(checkedItem);
  const seen = new Set(items.get().map((existing) => existing.id));
  const added: Item[] = [];
  for (const { id, fields } of checked) {
    const key = id !== ""
      ? id
      : `item-${Math.random().toString(36).slice(2, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ id: key, fields });
  }
  if (added.length > 0) items.pushAll(added);
}

/**
 * Asks `target` to withdraw this piece's contribution, if it is the pool for
 * `question`. A pool binds the principal, so it takes out only the sender's.
 */
function withdrawFrom(target: PoolTarget | null, question: string): void {
  if (target !== null && sameGoal(target.goal ?? "", question)) {
    target.withdraw.send();
  }
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
    adopted,
  }) => {
    const goalDraft = new Writable.perSession("");

    // An empty name asks for the deployment's default, which the builtin
    // picks only when no model is given.
    const hifiModelName = computed(() => hifiModel.get() || undefined);

    // Grading counts a label only when the model call has a usable answer.
    const hifi = items.map((item) => {
      const prompt = computed(() => buildHifiPrompt(goal.get(), item));
      const request = generateObject<HifiAnswer>({
        prompt,
        system: HIFI_SYSTEM,
        schema: HIFI_SCHEMA,
        model: hifiModelName,
      });
      const answer = computed(() => {
        if (isPending(request) || isSyncing(request)) return { pending: true };
        if (hasError(request) || isObsolete(request)) {
          return {
            pending: false,
            error: request.message || "This label output has been retired.",
          };
        }
        return { pending: false, result: resultOf(request) };
      });
      return {
        id: item.id,
        answer,
      };
    });

    const rows = computed(() =>
      gradeItems(items.get(), hifi, rules.get(), heldOutPercent.get())
    );
    const labelling = computed(() => labellingCount(hifi));
    const summary = computed(() => summarize(rows));
    const heldOutF1 = computed(() =>
      scoreRules(rules.get(), heldOutExamples(rows)).f1
    );

    // A whole new rule set once enough surprises are new.
    const request = computed(() =>
      rewriteRequest(
        goal.get(),
        rules.get(),
        rows,
        history.get(),
        rewriteAfter.get(),
        rewriteAttempt.get(),
      )
    );
    const rewritePrompt = computed(() => request?.prompt ?? "");
    const proposal = generateObject<Proposal>({
      prompt: rewritePrompt,
      system: REWRITE_SYSTEM,
      schema: PROPOSAL_SCHEMA,
      model: hifiModelName,
    });
    const proposalState = computed(() => {
      if (isPending(proposal) || isSyncing(proposal)) return { pending: true };
      if (hasError(proposal) || isObsolete(proposal)) {
        return {
          pending: false,
          error: proposal.message || "This rewrite output has been retired.",
        };
      }
      return { pending: false, result: resultOf(proposal) };
    });
    const rewrite = computed(() =>
      rewriteStatus(
        request,
        proposalState,
        rules.get(),
        rows,
        history.get(),
        rewriteAfter.get(),
        labelling,
      )
    );

    // A computed cannot write, so a person or an agent records the judgement
    // by sending `settleRewrite`. Recording on every new item would read
    // `rewrite` while hi-fi calls are in flight, which can lose their results
    // (README.md, "Known runtime issues"); `rewrite` is ready only once every
    // hi-fi call has finished, so a settle sent sooner writes nothing.
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
      adopted.set(
        adoptedAfter(adopted.get(), rules.get(), status.judgement, false),
      );
      if (status.judgement.accepted) rules.set(next.rules);
      history.push(next.entry);
      rewriteAttempt.set(0);
    });

    // A failed model call records nothing; this asks the same question again.
    const retryRewrite = action(() => {
      if (rewrite.status !== "failed") return;
      rewriteAttempt.increment(1);
    });

    const setRewriteAfter = action((event: RewriteAfterEvent) => {
      const count = event?.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
        throw new Error("`count` is a whole number, at least 1.");
      }
      rewriteAfter.set(count);
    });

    const setHeldOutPercent = action((event: HeldOutPercentEvent) => {
      const share = event?.percent;
      if (
        typeof share !== "number" || !Number.isFinite(share) || share <= 0 ||
        share >= 100
      ) {
        throw new Error("`percent` is a number above 0 and below 100.");
      }
      heldOutPercent.set(share);
    });

    const setHifiModel = action((event: HifiModelEvent) => {
      if (typeof event?.model !== "string") {
        throw new Error('`model` is a model name, or "" for the default.');
      }
      hifiModel.set(event.model.trim());
    });

    // The pool to publish to. A pool serves one goal, and the wish cannot yet
    // match on it, so every use checks the goal first.
    const poolWish = wish<PoolTarget>({
      query: "#inductorPool",
      scope: ["~", "."],
    });
    // Null, not undefined, when there is none: an action whose context
    // holds an undefined value does not run.
    const discoveredPool = computed(() => {
      const response = poolWish.result;
      if (hasError(response) && poolWish.errorCode === "no-match") return null;
      return resultOf(response);
    });
    const target = pool ?? discoveredPool;

    // Every hi-fi call is asked for the goal, so it changes only here, never
    // per keystroke. A new question withdraws the old one's contribution and
    // gets a new pseudonym, so the pool cannot link the two.
    const setGoal = action((event: GoalEvent) => {
      if (typeof event?.goal !== "string" || event.goal.trim() === "") {
        throw new Error("`goal` is a yes-or-no question, not blank.");
      }
      const next = event.goal.trim();
      const current = goal.get().trim();
      // The pool compares goals this way too, so a change of case or spacing
      // is the same question.
      if (sameGoal(next, current)) return;
      if (pseudonym.get() !== "") withdrawFrom(target, current);
      goal.set(next);
      rules.set([]);
      history.set([]);
      published.set(null);
      pseudonym.set("");
      adopted.set([]);
    });

    const applyGoalDraft = action(() => {
      const next = goalDraft.get().trim();
      if (next === "") return;
      setGoal.send({ goal: next });
      goalDraft.set("");
    });

    const addItems = action((event: SubmittedItems) => {
      if (!Array.isArray(event?.items)) {
        throw new Error("`items` is a list of items.");
      }
      appendItems(items, event.items);
    });

    const addItem = action((event: SubmittedItem) => {
      appendItems(items, [event]);
    });

    const removeItem = action((event: ItemRef) => {
      if (event?.item === undefined || event.item === null) {
        throw new Error("`item` is an item read from `items`.");
      }
      const current = items.get();
      const index = current.findIndex((each) => equals(each, event.item));
      if (index >= 0) items.set(current.toSpliced(index, 1));
    });

    const removeRule = action((event: RuleRef) => {
      if (typeof event?.rule?.key !== "string") {
        throw new Error("`rule` is a rule read from `rules`.");
      }
      // A rule is a value, known by its canonical key.
      const key = event.rule.key;
      const current = rules.get();
      const index = current.findIndex((each) => each.key === key);
      if (index < 0) return;
      rules.set(current.toSpliced(index, 1));
      adopted.removeByValue(key);
    });

    const resetRules = action(() => {
      rules.set([]);
      adopted.set([]);
    });

    // What the pool for this goal releases. A pool for another goal offers
    // nothing.
    const poolConnected = computed(() =>
      target !== null && sameGoal(target.goal ?? "", goal.get())
    );
    const releasedHere = computed((): PoolRule[] => {
      if (target === null || !poolConnected) return [];
      return (target.consensus ?? []).map((rule) => ({
        field: rule.field,
        pattern: rule.pattern,
        predicts: rule.predicts,
      }));
    });
    const offer = computed(() =>
      poolOffer(
        rules.get(),
        releasedHere,
        heldOutExamples(rows),
        history.get(),
        labelling,
      )
    );

    // Recorded by a send, as a rewrite is, and for the same reasons.
    const settlePoolOffer = action(() => {
      const current = offer;
      if (current === null) return;
      const next = settle(
        rules.get(),
        history.get().length + 1,
        current.judgement,
        [],
        Date.now(),
        current.key,
      );
      // The pool's rules are others' learning: marked, so that publishing
      // does not send them back as this person's.
      adopted.set(
        adoptedAfter(adopted.get(), rules.get(), current.judgement, true),
      );
      if (current.judgement.accepted) rules.set(next.rules);
      history.push(next.entry);
    });

    const publish = action(() => {
      const question = goal.get().trim();
      const { rules: snapshot, withheld, adopted: fromPool } = shareable(
        rules.get(),
        adopted.get(),
      );
      const reached = snapshot.length > 0 && target !== null &&
        sameGoal(target.goal ?? "", question);
      // Randomness is allowed in an action, so the first publish with a rule
      // to send mints the pseudonym, kept for when a pool for the goal
      // appears. The pool binds this principal, whatever it is called.
      if (snapshot.length > 0 && !pseudonym.get()) {
        pseudonym.set(`p-${Math.random().toString(36).slice(2, 12)}`);
      }
      published.set({
        goal: question,
        rules: snapshot,
        publishedAt: Date.now(),
        pooled: reached,
        withheld,
        adopted: fromPool,
      });
      // Nothing to send leaves nothing of an earlier publish behind either,
      // an empty rule set included. Without a pseudonym nothing was sent, so
      // there is nothing to withdraw.
      if (reached) {
        target.submit.send({ pseudonym: pseudonym.get(), rules: snapshot });
      } else if (pseudonym.get() !== "") withdrawFrom(target, question);
    });

    // Nothing to take back before the first publish, which mints the
    // pseudonym.
    const unpublish = action(() => {
      if (pseudonym.get() === "") return;
      withdrawFrom(target, goal.get().trim());
      published.set(null);
    });

    const title = computed(() => {
      const question = goal.get().trim();
      return question ? `Lo-fi inductor: ${question}` : "Lo-fi inductor";
    });
    const content = computed(() =>
      markdownOf(goal.get(), summary, rules.get(), heldOutF1, history.get())
    );
    const hasGoal = computed(() => goal.get().trim() !== "");
    const statsLine = computed(() =>
      !hasGoal
        ? "Set a question first. The model answers it for each item, and " +
          "rules are learned from its answers."
        : `${summary.items} items · ${summary.labelled} labelled · ` +
          `${
            percent(summary.agreementRate)
          } agreement · ${summary.surprises} surprises`
    );
    const verdicts = computed(() =>
      verdictsOf(rows, hasGoal, rules.get().length > 0)
    );
    const sendable = computed(() =>
      shareable(rules.get(), adopted.get()).rules.length
    );

    // The cards are known by their position in the view (composition.md), in
    // the order a person works through them; the settings card comes last.
    const itemsCard = ItemsCard({ items, verdicts, addItem, removeItem });
    const rulesCard = RulesCard({
      rules,
      heldOutF1,
      summary,
      rewrite,
      settleRewrite,
      retryRewrite,
      removeRule,
      resetRules,
    });
    const historyCard = HistoryCard({ history });
    const poolCard = PoolCard({
      offer,
      published,
      rules,
      sendable,
      connected: poolConnected,
      settlePoolOffer,
      publish,
      unpublish,
    });
    const settingsCard = SettingsCard({
      hifiModel,
      rewriteAfter,
      heldOutPercent,
      setHifiModel,
      setRewriteAfter,
      setHeldOutPercent,
    });

    return {
      [NAME]: title,
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="2" padding="4">
            <cf-heading level={4}>{title}</cf-heading>
            <cf-hstack gap="2">
              <cf-input
                $value={goalDraft}
                placeholder="A new yes-or-no question, such as “Is this email a bill?”"
                style="flex: 1;"
              />
              <cf-button color="primary" onClick={applyGoalDraft}>
                Set goal
              </cf-button>
            </cf-hstack>
            <cf-text tone="muted">{statsLine}</cf-text>
          </cf-vstack>
          <cf-vstack gap="3" padding="4">
            {itemsCard}
            {rulesCard}
            {historyCard}
            {poolCard}
            {settingsCard}
          </cf-vstack>
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
      adopted,
      hifiModel,
      rewriteAfter,
      heldOutPercent,
      rows,
      summary,
      heldOutF1,
      rewrite,
      setGoal,
      addItem,
      addItems,
      removeItem,
      removeRule,
      resetRules,
      settleRewrite,
      retryRewrite,
      setRewriteAfter,
      setHeldOutPercent,
      setHifiModel,
      poolOffer: offer,
      settlePoolOffer,
      publish,
      unpublish,
    };
  },
);
