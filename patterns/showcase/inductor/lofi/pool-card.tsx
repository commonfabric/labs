/**
 * The lo-fi inductor's side of the pool: what the pool for its goal offers,
 * judged on this piece's held-out items, what was last published, and the
 * buttons that adopt or dismiss the offer, publish, and take a contribution
 * back.
 */

import {
  computed,
  type Default,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
} from "commonfabric";
import {
  LOOKS_PERSONAL,
  MONO,
  percent,
  type PoolOffer,
  type Published,
} from "./induction.ts";
import { type CanonicalRule, describeRule } from "../shared/rule-grammar.ts";

interface PoolCardInput {
  offer: PoolOffer | null;
  published: Published | null;
  rules: CanonicalRule[];

  /** How many of the rules a publish would send (`shareable`). */
  sendable?: number | Default<0>;

  /** Whether a pool for the inductor's goal is connected. */
  connected?: boolean | Default<false>;

  settlePoolOffer: Stream<void>;
  publish: Stream<void>;
  unpublish: Stream<void>;
}

/** The pool's offer to the inductor, and what the inductor published. */
export interface PoolCardOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<PoolCardInput, PoolCardOutput>(
  ({
    offer,
    published,
    rules,
    sendable,
    connected,
    settlePoolOffer,
    publish,
    unpublish,
  }) => {
    const hasOffer = computed(() => offer !== null);
    const offerLine = computed(() =>
      offer === null
        ? ""
        : `The pool for this goal offers ${offer.judgement.rules.length} ` +
          `rules your held-out items exercise. On those items: ` +
          `${offer.judgement.reason}.`
    );
    // Each released rule, and what became of it: offered, refused, or left
    // out because none of the held-out items exercises it.
    const offerLines = computed(() =>
      offer === null ? [] : [
        ...offer.judgement.rules.map((rule) =>
          `offered: ${describeRule(rule)}`
        ),
        ...offer.judgement.refusals.map((reason) => `refused: ${reason}`),
        ...(offer.unexercised ?? []).map((rule) =>
          `left out, no held-out item matches it: ${describeRule(rule)}`
        ),
      ]
    );
    const offerAccepted = computed(() => offer?.judgement.accepted === true);
    const offerLabel = computed(() => {
      if (offer === null) return "";
      const { accepted, currentF1, proposedF1 } = offer.judgement;
      return accepted
        ? `Adopt the pool's rules (F1 ${percent(currentF1)} → ${
          percent(proposedF1)
        })`
        : "Dismiss the pool's rules";
    });
    const offerColor = computed(() => offerAccepted ? "primary" : "neutral");
    const offerVariant = computed(() => offerAccepted ? "solid" : "outline");

    // The pool's answer to a submission is not visible here: a refusal is
    // thrown in the pool's handler, and a contribution is confidential to the
    // pool. So the line says what this piece did, which is send.
    const publishedLine = computed(() => {
      const snapshot = published;
      if (!snapshot) {
        if (rules.length === 0) return "No rules to publish yet.";
        return sendable === 0
          ? "Nothing to publish: every rule was adopted from the pool or " +
            `looks personal (${LOOKS_PERSONAL}).`
          : "Not published yet.";
      }
      const withheld = (snapshot.withheld
        ? ` Held back ${snapshot.withheld} that look personal ` +
          `(${LOOKS_PERSONAL}).`
        : "") +
        (snapshot.adopted
          ? ` Left out ${snapshot.adopted} adopted from the pool.`
          : "");
      if (snapshot.pooled) {
        return `Sent ${snapshot.rules.length} rules to the pool for ` +
          `“${snapshot.goal}”. No one learns a rule from it until enough ` +
          `others hold it too.${withheld}`;
      }
      return snapshot.rules.length === 0
        ? `Nothing was sent.${withheld}`
        : `No pool for “${snapshot.goal}” found; nothing was sent.${withheld}`;
    });
    const connectionLine = computed(() =>
      connected
        ? "A pool for this question is connected."
        : "No pool for this question is connected. To get one, deploy an " +
          "inductor-pool with the same question in a space you can reach, " +
          "or link one to this piece as `pool`."
    );
    const cannotPublish = computed(() => !connected || sendable === 0);
    const nothingPublished = computed(() => published?.pooled !== true);

    return {
      [NAME]: "Pool",
      [UI]: (
        <cf-card>
          <cf-vstack gap="2">
            <cf-heading level={5}>Pool</cf-heading>
            <cf-text tone="muted">{connectionLine}</cf-text>
            {hasOffer
              ? (
                <cf-vstack gap="1">
                  <cf-text>{offerLine}</cf-text>
                  {offerLines.map((line) => (
                    <cf-text variant="caption" style={MONO}>{line}</cf-text>
                  ))}
                  <cf-button
                    color={offerColor}
                    variant={offerVariant}
                    onClick={() => settlePoolOffer.send()}
                  >
                    {offerLabel}
                  </cf-button>
                </cf-vstack>
              )
              : null}
            <cf-text tone="muted">{publishedLine}</cf-text>
            <cf-hstack gap="2">
              <cf-button
                color="primary"
                disabled={cannotPublish}
                onClick={() => publish.send()}
              >
                Publish rules
              </cf-button>
              <cf-button
                variant="ghost"
                disabled={nothingPublished}
                onClick={() => unpublish.send()}
              >
                Unpublish
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-card>
      ),
    };
  },
);
