/**
 * The lo-fi inductor's rules: the current set with its held-out F1, where the
 * rewrite stands, and what a ready proposal holds, with the buttons that
 * record it, retry a failed call, take a rule out, or empty the set. The
 * judgements are the inductor's; this card words them.
 */

import {
  computed,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
} from "commonfabric";
import {
  MONO,
  percent,
  type RewriteStatus,
  type Summary,
} from "./induction.ts";
import { type CanonicalRule, describeRule } from "../shared/rule-grammar.ts";

/** The rule `removeRule` takes out, known by its canonical key. */
export interface RuleRef {
  rule: CanonicalRule;
}

interface RulesCardInput {
  rules: CanonicalRule[];
  heldOutF1: number;
  summary: Summary;
  rewrite: RewriteStatus;
  settleRewrite: Stream<void>;
  retryRewrite: Stream<void>;
  removeRule: Stream<RuleRef>;
  resetRules: Stream<void>;
}

/** The inductor's current rules and the rewrite that may replace them. */
export interface RulesCardOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<RulesCardInput, RulesCardOutput>(
  ({
    rules,
    heldOutF1,
    summary,
    rewrite,
    settleRewrite,
    retryRewrite,
    removeRule,
    resetRules,
  }) => {
    // The F1 means something only once held-out items have hi-fi labels.
    const heading = computed(() =>
      summary.heldOut === 0
        ? "Rules"
        : `Rules · held-out F1 ${percent(heldOutF1)} on ${summary.heldOut} ` +
          "held-out items"
    );
    const noRules = computed(() => rules.length === 0);
    const rewriteLine = computed(() => {
      const status = rewrite;
      if (status.status === "idle") {
        const missing = status.missing ?? 0;
        return missing > 0
          ? `Waiting for ${missing} more surprises before proposing ` +
            "new rules."
          : "Waiting for the hi-fi model to label the items so far.";
      }
      if (status.status === "pending") {
        return status.labelling
          ? `Waiting for the hi-fi model to label ${status.labelling} more ` +
            "items before judging the proposal."
          : "Proposing a new rule set…";
      }
      if (status.status === "failed") {
        return `Proposing failed (${status.reason}); nothing was recorded.`;
      }
      return `Proposed: ${status.judgement.reason}.`;
    });
    const ready = computed(() => rewrite.status === "ready");
    const failed = computed(() => rewrite.status === "failed");
    // Applying an accepted set is the step the card leads to; dismissing a
    // rejected one is not.
    const accepted = computed(() =>
      rewrite.status === "ready" && rewrite.judgement.accepted
    );
    const settleColor = computed(() => accepted ? "primary" : "neutral");
    const settleVariant = computed(() => accepted ? "solid" : "outline");
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
      const { currentF1, proposedF1 } = status.judgement;
      return status.judgement.accepted
        ? `Apply new rules (F1 ${percent(currentF1)} → ${percent(proposedF1)})`
        : "Dismiss rejected proposal";
    });

    return {
      [NAME]: "Rules",
      [UI]: (
        <cf-card>
          <cf-vstack gap="2">
            <cf-hstack gap="2" align="center" justify="between">
              <cf-heading level={5}>{heading}</cf-heading>
              <cf-button
                variant="ghost"
                size="sm"
                disabled={noRules}
                onClick={() => resetRules.send()}
              >
                Clear rules
              </cf-button>
            </cf-hstack>
            {noRules
              ? (
                <cf-empty-state message="No rules yet. The model proposes a set once enough items surprise the current one." />
              )
              : null}
            {rules.map((rule) => (
              <cf-hstack gap="2" align="center">
                <cf-text style={`flex: 1; ${MONO}`}>
                  {computed(() => describeRule(rule))}
                </cf-text>
                <cf-button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRule.send({ rule })}
                >
                  Remove
                </cf-button>
              </cf-hstack>
            ))}
            <cf-text tone="muted">{rewriteLine}</cf-text>
            {proposalLines.map((line) => (
              <cf-text variant="caption" style={MONO}>{line}</cf-text>
            ))}
            {ready
              ? (
                <cf-button
                  color={settleColor}
                  variant={settleVariant}
                  onClick={() => settleRewrite.send()}
                >
                  {settleLabel}
                </cf-button>
              )
              : null}
            {failed
              ? (
                <cf-button
                  variant="outline"
                  onClick={() => retryRewrite.send()}
                >
                  Try again
                </cf-button>
              )
              : null}
          </cf-vstack>
        </cf-card>
      ),
    };
  },
);
