/**
 * The redaction policy, and the one computation it releases.
 *
 * What is secret: every value in the vault, and the draft the user types,
 * which holds the same people, numbers and addresses in context. Both are
 * `Confidential` under this module's policy, so the runtime refuses to write
 * them, or anything computed from them, to any store that admits only public
 * values, such as the redactor's `modelPrompt`. The model call itself is not
 * gated: `generateText` is an ungated sink today, so the guarantee holds
 * because the prompt is read from `modelPrompt` (README, CFC debt 2).
 *
 * What is released: the output of `redactDraft`, and nothing else. The rule
 * below drops the policy's clause from a value only when the runtime attests
 * that this module's `redactDraft` alone computed it (`TransformedBy`, bound to
 * this module's content identity). So the redacted draft may go to a model,
 * while the mapping from stand-ins back to originals, the restored reply, the
 * detection list, and any other function of the draft stay with the owner.
 *
 * What the release discloses: the draft with each detected value replaced by a
 * stand-in chosen by order of first appearance per category. That reveals how
 * many distinct values of each kind the draft held, and where, but no part of
 * any value. Anything detection misses is disclosed as written; the leak check
 * in the UI and the vault are how a user narrows that.
 *
 * Changing this module changes its identity, and with it the computation the
 * policy releases; keep it small and keep the logic in `redaction.ts`.
 */
import { type Confidential, lift, type MaxConfidentiality } from "commonfabric";
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";
import {
  type Detection,
  detections,
  leaksIn,
  type PIIEntry,
  redact,
  restore,
  type Substitution,
} from "./redaction.ts";

export const releaseRedactedDraft = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "redactDraft",
      },
    }],
  },
  post: { dropClause: true },
});

/** The owner, and anyone else with reader access to the space that holds
 * the data, may see it (rendered to them, never written anywhere public). */
export const releaseToSpaceReader = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: { addAlternatives: [cfcPattern.user(v("reader"))] },
});

export const redactionRules = exchangeRules([
  releaseRedactedDraft,
  releaseToSpaceReader,
]);

/** A value only its owner may see, released only through `redactDraft`. */
export type Secret<T> = Confidential<
  T,
  readonly [PolicyOf<typeof redactionRules>]
>;

/** A store that admits only public values, such as a model's prompt. */
export type PublicText = MaxConfidentiality<string, readonly []>;

export interface DraftInput {
  draft: string;
  vault: PIIEntry[];
}

/**
 * The released computation: the draft with every detected value replaced.
 * Format detection always runs here, so no caller can switch it off; the
 * vault can only add to what is replaced. A caller can still pass an empty
 * vault, which is why a name the detectors cannot recognize is released as
 * written unless it is in the vault (README, CFC debt).
 */
export const redactDraft = lift(({ draft, vault }: DraftInput): string =>
  redact(draft ?? "", detections(draft ?? "", vault ?? [], true)).redacted
);

// Everything below reads the draft and is not named by the rule, so what it
// computes stays secret.

/** What was found in the draft, and where it came from. */
export const findInDraft = lift(({ draft, vault }: DraftInput): Detection[] =>
  detections(draft ?? "", vault ?? [], true)
);

/** The stand-in for each original: the key to undo the redaction. */
export const substitutionsFor = lift(
  ({ draft, vault }: DraftInput): Substitution[] =>
    redact(draft ?? "", detections(draft ?? "", vault ?? [], true))
      .substitutions,
);

/** A reply with the originals put back. */
export const restoreReply = lift(
  ({ reply, substitutions }: {
    reply: string;
    substitutions: Substitution[];
  }): string => restore(reply ?? "", substitutions ?? []),
);

/** Originals that appear in a text that should hold only stand-ins. */
export const leaksInText = lift(
  ({ text, found, substitutions }: {
    text: string;
    found: Detection[];
    substitutions: Substitution[];
  }): string[] => leaksIn(text ?? "", found ?? [], substitutions ?? []),
);
