import { CFC_CONCEPT_KIND } from "@commonfabric/api/cfc";

/**
 * The prompt-caveat kinds of the §10.1 standard profile, in one place with no
 * other dependencies, so both the profile's exchange rules
 * (`standard-profile.ts`) and a host's default display ceiling (lib-shell)
 * read the same lists.
 */

/** The canonical material-risk tier kinds (the screening gradient). */
export const MATERIAL_RISK_KINDS: readonly string[] = [
  CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
  CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
  CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
];

// Short aliases participate in discharge only. The tier gradient is defined
// over the canonical URIs, into which a deployment normalizes aliases before
// tier evaluation (§10.1 SHOULD-normalize).
const MATERIAL_RISK_ALIAS_KINDS: readonly string[] = [
  "prompt-injection-risk-unscreened",
  "prompt-injection-risk-ingress-screened",
  "prompt-injection-risk-value-screened",
];

/** Every caveat kind a positive `InjectionSafe` discharges. */
export const MATERIAL_RISK_DISCHARGE_KINDS: readonly string[] = [
  ...MATERIAL_RISK_KINDS,
  ...MATERIAL_RISK_ALIAS_KINDS,
];

/**
 * The whole §10.1 prompt-caveat family: the legacy single-risk form, the
 * three screening-gradient tiers and prompt influence, each in its canonical
 * spelling and in the short spelling shipped patterns mint.
 *
 * Every member says the same thing: do not trust this content as instructions
 * to a model. The default display ceiling admits the family (§8.10.6),
 * because a display shows content to the acting user. Admitting a caveat at a
 * display is not discharging it: the caveat stays on the value, and every
 * model sink still evaluates it.
 */
export const PROMPT_CAVEAT_FAMILY_KINDS: readonly string[] = [
  "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
  ...MATERIAL_RISK_KINDS,
  CFC_CONCEPT_KIND.PromptInfluence,
  "prompt-injection-risk",
  ...MATERIAL_RISK_ALIAS_KINDS,
  "prompt-influence",
];
