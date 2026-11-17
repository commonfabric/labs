/**
 * Rules, public stores, and publish handlers the inductor pool's tests share.
 *
 * Every refusal probe writes a scalar (a string or a number) into a scalar
 * public store, and its handler types the destination with the store's
 * ceiling (`Writable<PublicText>`, `Writable<PublicCount>`), as
 * `examples/cfc-exchange-rules/blessed-computation.tsx` does. Both halves
 * matter, and each refusal has a control that must land beside it:
 *
 * - An array of objects written into a public store beside a labelled
 *   sibling is refused even when it reads nothing confidential (top/3205),
 *   so an array probe's refusal proves nothing.
 * - A store's ceiling is enforced only when the writing handler's type for
 *   the store repeats it (top/3219), so a probe typed `Writable<string>`
 *   proves nothing either.
 */
import { handler, type MaxConfidentiality, type Writable } from "commonfabric";
import { type CanonicalRule, checkRule } from "../shared/rule-grammar.ts";
import type { ReleasedRule } from "./consensus.ts";
import type { StoredContribution } from "./pool-policy.tsx";

function rule(
  field: string,
  pattern: string,
  predicts: boolean,
): CanonicalRule {
  const checked = checkRule({ field, pattern, predicts });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.rule;
}

export const INVOICE = rule("subject", "invoice", true);
export const BILL = rule("subject", "bill", true);
export const LUNCH = rule("subject", "lunch", false);

/** A text store anyone may read, with no write binding: only its ceiling. */
export type PublicText = MaxConfidentiality<string, readonly []>;

/** A number store anyone may read, with no write binding: only its ceiling. */
export type PublicCount = MaxConfidentiality<number, readonly []>;

/**
 * What a probe's text store starts as (`Default<PublicText, "untouched">`),
 * so a refused publish is told apart from one that wrote an empty string.
 * A count store starts at -1, which no count is.
 */
export const UNTOUCHED = "untouched";

/** The rules' patterns, joined by commas, into `to`. */
export const publishPatterns = handler<
  void,
  { from: ReleasedRule[]; to: Writable<PublicText> }
>((_, { from, to }) => {
  to.set((from ?? []).map((rule) => rule?.pattern ?? "").join(","));
});

/** How many rules there are, into `to`. */
export const publishRuleCount = handler<
  void,
  { from: ReleasedRule[]; to: Writable<PublicCount> }
>((_, { from, to }) => {
  to.set((from ?? []).length);
});

/** A literal, into `to`: the control that the store takes a scalar at all. */
export const publishLiteral = handler<void, { to: Writable<PublicText> }>(
  (_, { to }) => {
    to.set("literal");
  },
);

/** One leaf of the first stored contribution, read raw, into `to`. */
export const publishContributionLeaf = handler<
  void,
  {
    contributions: StoredContribution[];
    leaf: "pattern" | "pseudonym" | "secret";
    to: Writable<PublicText>;
  }
>((_, { contributions, leaf, to }) => {
  const first = contributions?.[0];
  if (leaf === "pattern") to.set(first?.rules?.[0]?.pattern ?? "");
  else if (leaf === "pseudonym") to.set(first?.pseudonym ?? "");
  else to.set(first?.seal?.secret ?? "");
});

/** How many contributions are stored, read raw, into `to`. */
export const publishContributionCount = handler<
  void,
  { contributions: StoredContribution[]; to: Writable<PublicCount> }
>((_, { contributions, to }) => {
  to.set((contributions ?? []).length);
});
