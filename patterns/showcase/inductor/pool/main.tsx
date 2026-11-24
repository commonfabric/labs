/**
 * Inductor pool: one goal's lo-fi rules, contributed under pseudonyms, and
 * released once enough distinct contributors hold the same rule. See README.md
 * for the design and its CFC debt.
 *
 * This module is the pattern and its view. The policy, and the one handler
 * that writes what it guards, are in `pool-policy.tsx`, so that editing the
 * view does not change the policy's identity.
 *
 * The pool's public result is `consensus`, the output of the policy's one
 * released function, read where it is computed. It is not copied into a public
 * store: the runtime refuses that write today (README.md, "Workaround: the
 * release is not stored").
 */

import {
  action,
  computed,
  type Default,
  FS,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import { describeRule } from "../shared/rule-grammar.ts";
import {
  DEFAULT_JITTER,
  DEFAULT_THRESHOLD_CENTER,
  MIN_SEALED_THRESHOLD,
  type ReleasedRule,
} from "./consensus.ts";
import {
  type ContributionEvent,
  releaseConsensus,
  type StoredContribution,
  submitContribution,
} from "./pool-policy.tsx";

export type {
  CanonicalRule,
  Contribution,
  PoolSeal,
  ReleasedRule,
} from "./consensus.ts";
export type { ContributionEvent, StoredContribution } from "./pool-policy.tsx";

interface InductorPoolInput {
  /** The yes-or-no question this pool collects rules for. */
  goal: Default<string, "">;
  /**
   * The threshold a rule has before its offset, at least
   * `MIN_SEALED_THRESHOLD` (5). The first contribution seals it, with
   * `jitter`, narrowed so no rule's threshold is below that floor; the
   * release never reads it again.
   */
  thresholdCenter: Default<number, typeof DEFAULT_THRESHOLD_CENTER>;
  /** The bound `k` of each rule's offset, in `[-k, +k]`. */
  jitter: Default<number, typeof DEFAULT_JITTER>;
  /** One entry per contributor, written only by `submit` and `withdraw`. */
  contributions: Writable<Default<StoredContribution[], []>>;
}

/**
 * A #inductorPool: collects lo-fi rules for one goal under per-goal
 * pseudonyms and releases a rule, with its count, once enough distinct
 * contributors hold it. Lo-fi inductors find one with
 * `wish({ query: "#inductorPool" })`.
 */
export interface InductorPoolOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  goal: string;
  thresholdCenter: number;
  jitter: number;
  /** The stored contributions, confidential to the pool's policy. */
  contributions: StoredContribution[];
  /**
   * The pool's public result: what `releaseConsensus` computes now, the rules
   * at threshold and their counts. The policy releases it, so anyone may read
   * it. It is derived, not stored (README.md, "Workaround: the release is not
   * stored").
   */
  consensus: ReleasedRule[];
  /** How many rules are released. */
  releasedCount: number;
  /**
   * Contribute the sender's rule set under a pseudonym, replacing any set
   * they gave before.
   */
  submit: Stream<ContributionEvent>;
  /** Take the sender's contribution out, whatever pseudonym it is under. */
  withdraw: Stream<void>;
}

export default pattern<InductorPoolInput, InductorPoolOutput>(
  ({ goal, thresholdCenter, jitter, contributions }) => {
    const consensus = releaseConsensus(contributions);
    // Every write to the contributions is `submitContribution`'s, the one
    // writer the policy's input witness and `WriteAuthorizedBy` name, so both
    // verbs go through it: `submit` is its binding, and `withdraw` sends to a
    // second binding, set `withdrawing`, which ignores its event. `withdraw`
    // is an action rather than that binding itself because a stream's event
    // type is exact, and the handler's is a contribution, not `void`.
    const submit = submitContribution({
      contributions,
      thresholdCenter,
      jitter,
    });
    const withdrawing = submitContribution({
      contributions,
      thresholdCenter,
      jitter,
      withdrawing: true,
    });
    const withdraw = action(() => {
      withdrawing.send({ pseudonym: "", rules: [] });
    });

    const releasedCount = computed(() => consensus.length);
    const nothingReleased = computed(() => consensus.length === 0);
    const title = computed(() => {
      const question = goal.trim();
      return question ? `Inductor pool: ${question}` : "Inductor pool";
    });
    const thresholdLine = computed(() =>
      `This pool is set to show a rule once about ${thresholdCenter} ` +
      `contributors hold it (give or take ${jitter}, and never fewer than ` +
      `${MIN_SEALED_THRESHOLD}). Each rule's exact threshold is kept secret. ` +
      `The setting in force at the first contribution is fixed for good, ` +
      `so changing it afterwards has no effect.`
    );
    const releasedLines = computed(() =>
      consensus.map((rule: ReleasedRule) => ({
        rule: describeRule(rule),
        count: rule.count === 1
          ? "1 contributor"
          : `${rule.count} contributors`,
      }))
    );
    const content = computed(() =>
      [
        `# ${title}`,
        "",
        thresholdLine,
        "",
        ...consensus.map((rule: ReleasedRule) =>
          `- \`${describeRule(rule)}\` (${rule.count} contributors)`
        ),
      ].join("\n")
    );

    return {
      [NAME]: title,
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1" padding="4">
            <cf-heading level={4}>{title}</cf-heading>
            <cf-text tone="muted">
              Rules that many contributors learned on their own, for one
              yes-or-no question, shared without saying who learned them.
            </cf-text>
          </cf-vstack>
          <cf-vstack gap="3" padding="4">
            <cf-card>
              <cf-vstack gap="2">
                <cf-hstack gap="2" align="center">
                  <cf-heading level={5}>Released rules</cf-heading>
                  <cf-badge color="primary">{releasedCount}</cf-badge>
                </cf-hstack>
                {nothingReleased
                  ? (
                    <cf-empty-state message="No rule has enough contributors yet." />
                  )
                  : null}
                {releasedLines.map((line) => (
                  <cf-hstack gap="2" align="center">
                    <cf-text style="flex: 1; font-family: var(--cf-theme-mono-font-family);">
                      {line.rule}
                    </cf-text>
                    <cf-text tone="muted">{line.count}</cf-text>
                  </cf-hstack>
                ))}
              </cf-vstack>
            </cf-card>
            <cf-card>
              <cf-vstack gap="2">
                <cf-heading level={5}>How it works</cf-heading>
                <cf-text>{thresholdLine}</cf-text>
                <cf-text tone="muted">
                  Until then no one learns the rule, how many contributors hold
                  it, or that it exists, and no one learns who holds a released
                  one.
                </cf-text>
              </cf-vstack>
            </cf-card>
            <cf-card>
              <cf-vstack gap="2">
                <cf-heading level={5}>Contribute</cf-heading>
                <cf-text>
                  Publish from a lo-fi inductor for this question. It sends the
                  rules you accepted under your one pseudonym for the question,
                  and publishing again replaces what you sent before. You can
                  withdraw at any time, which takes your rules out of every
                  count.
                </cf-text>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content,
      },
      goal,
      thresholdCenter,
      jitter,
      contributions,
      consensus,
      releasedCount,
      submit,
      withdraw,
    };
  },
);
