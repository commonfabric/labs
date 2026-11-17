/**
 * Rules and stores the inductor pool's tests share.
 */
import type { MaxConfidentiality } from "commonfabric";
import { type CanonicalRule, checkRule } from "../shared/rule-grammar.ts";
import type { ReleasedRule } from "./consensus.ts";

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

/** A store anyone may read, with no write binding: only its label guards it. */
export type OpenPublic = MaxConfidentiality<ReleasedRule[], readonly []>;

/**
 * What a probe store starts as: no release produces it, so a refused publish
 * is told apart from one that wrote an empty list.
 */
export type Untouched = [{
  field: "untouched";
  pattern: "untouched";
  predicts: false;
  key: "untouched";
  count: -1;
}];
