import { CFC_ATOM_TYPE, CFC_CONCEPT_KIND } from "@commonfabric/api/cfc";
import type { CfcPolicyRecordInput, ExchangeRule } from "./policy.ts";
import { MATERIAL_RISK_DISCHARGE_KINDS } from "./prompt-caveat-kinds.ts";

export {
  MATERIAL_RISK_DISCHARGE_KINDS,
  MATERIAL_RISK_KINDS,
} from "./prompt-caveat-kinds.ts";

/**
 * The §10.1 standard prompt-caveat profile, expressed entirely as ordinary
 * exchange rules (Epic B6 of docs/history/plans/cfc-future-work-implementation.md §3;
 * spec §10.1 / §8.10.5). There is NO prompt-specific runtime branch: the
 * runtime surfaces atoms (caveats in confidentiality, evidence in integrity,
 * `BoundaryContext` at release sites) and these rules decide discharge.
 *
 * Two DISTINCT rule sets, because bare-`InjectionSafe` discharge is only sound
 * where the evidence is known to be on the CURRENT value/path (§10.1):
 * - `MATERIAL_RISK_DISCHARGE_POLICY` — the material-risk drop rules, guarded by
 *   bare `InjectionSafe`. Consumed ONLY by the trusted-schema sanitizer
 *   (`schema-sanitization.ts`), which runs them over ONE instruction-inert
 *   path's confidentiality with THAT path's freshly-minted `InjectionSafe`, so
 *   the discharge is value-local by construction — replacing the old hardcoded
 *   `filterMaterialRiskAtoms` strip with a rule firing (goldens prove
 *   equivalence). This set is deliberately NOT in the deployment profile: at a
 *   boundary the integrity pool is the whole consumed label's join, so a bare
 *   `InjectionSafe` from one value would discharge a material-risk caveat on
 *   another (cubic P1 on #4567 — the tx-wide-aggregation cross-value hole).
 * - `STANDARD_PROMPT_CAVEAT_POLICY` — the tier upgrades, the value-screened
 *   discharge, and the display/influence discharge, all SOURCE-bound (and, for
 *   influence, SINK-bound) so they are safe against tx-wide integrity
 *   aggregation. Deployments spread this into `RuntimeOptions.cfcPolicyRecords`
 *   so it runs at real boundaries under `cfcPolicyEvaluation`. At a boundary a
 *   material-risk caveat is handled through the screening gradient
 *   (`CaveatScreened` evidence carries a `source`, so the tier rules correlate
 *   it to the caveat) → value-screened discharge — never by bare
 *   `InjectionSafe`.
 */

const injectionSafeGuard = { type: CFC_ATOM_TYPE.InjectionSafe } as const;

// A material-risk caveat is discharged (clause/alternative dropped) by
// positive InjectionSafe integrity on the value (§8.10.5). One rule per kind:
// AtomPattern matches a single concrete `kind`. The pattern names ONLY `type`
// and `kind` (subset semantics leave every other field unconstrained), so a
// caveat with or without a `source` discharges alike — exactly the
// source-generic, field-agnostic reach the old wholesale strip had. Guarded by
// bare `InjectionSafe`, so these rules are SANITIZER-ONLY (path-local): see the
// module doc for why they must not run at a tx-wide boundary.
const materialRiskDischargeRules: ExchangeRule[] = MATERIAL_RISK_DISCHARGE_KINDS
  .map((kind) => ({
    id: `discharge-material-risk:${kind}`,
    appliesTo: {
      type: CFC_ATOM_TYPE.Caveat,
      kind,
    },
    preCondition: { integrity: [injectionSafeGuard] },
    post: { dropClause: true },
  }));

// Tier upgrades (§10.1): ADD the higher-tier caveat as an alternative in the
// same clause, guarded by stage-matched `CaveatScreened{verdict:"pass"}` whose
// kind + source structurally match the caveat being upgraded. The lower tier
// remains (harmless — strictly harder to discharge). Upgrades never discharge
// and never touch PROMPT_INFLUENCE.
const ingressUpgradeRule: ExchangeRule = {
  id: "tier-upgrade:unscreened-to-ingress",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
    source: { var: "$s" },
  },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.CaveatScreened,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
      source: { var: "$s" },
      stage: "ingress",
      verdict: "pass",
    }],
  },
  post: {
    addAlternatives: [{
      type: CFC_ATOM_TYPE.Caveat,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
      source: { var: "$s" },
    }],
  },
};

const valueUpgradeRule: ExchangeRule = {
  id: "tier-upgrade:ingress-to-value",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
    source: { var: "$s" },
  },
  preCondition: {
    // Value-stage evidence binds the exact current value via `valueRef`. The
    // binding re-verification is carried by CaveatScreened's value-bound
    // propagation class (§15.4): a non-exactCopyOf transform drops the atom,
    // so a stale value-screened alternative can never be re-derived — the
    // rule simply stops matching (spec §10.1 re-binding blind spot).
    integrity: [{
      type: CFC_ATOM_TYPE.CaveatScreened,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
      source: { var: "$s" },
      stage: "value",
      verdict: "pass",
      valueRef: { var: "$r" },
    }],
  },
  post: {
    addAlternatives: [{
      type: CFC_ATOM_TYPE.Caveat,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source: { var: "$s" },
    }],
  },
};

// Value-screened discharge (§8.10.5): the value-screened tier is dischargeable
// by its own value-stage screening evidence (with the binding held, via the
// value-bound propagation above) WITHOUT a separate InjectionSafe — the
// screening IS the positive evidence for this tier. A rule that omitted the
// CaveatScreened value-stage guard would be unsound (the tier alternative is a
// marker, not evidence).
const valueScreenedDischargeRule: ExchangeRule = {
  id: "discharge-value-screened",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
    source: { var: "$s" },
  },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.CaveatScreened,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source: { var: "$s" },
      stage: "value",
      verdict: "pass",
      valueRef: { var: "$r" },
    }],
  },
  post: { dropClause: true },
};

// Influence-caveat display discharge (§8.10.5): PROMPT_INFLUENCE is released
// only by disclosure/acknowledgment/disclaimer evidence that binds the same
// `source` AND the same sink as the release site — NEVER by InjectionSafe
// (§10.1: "InjectionSafe MUST NOT clear prompt-influence"). The sink binding
// is load-bearing (cubic P1 on #4567): the evidence's `sink` field is unified
// (`$sink`) with a `BoundaryContext{key:"sink"}` atom the boundary mints for
// the CURRENT sink, so a disclosure/disclaimer rendered for one sink cannot
// clear an influence caveat egressing to another. Each rule also gates on the
// boundary's sink class / field role, so a content-field disclaimer cannot
// release an influence caveat routed to an action field.
const boundarySinkGuard = {
  type: CFC_ATOM_TYPE.BoundaryContext,
  key: "sink",
  value: { var: "$sink" },
} as const;

const influenceDisclosureRenderedRule: ExchangeRule = {
  id: "discharge-influence-display-rendered",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInfluence,
    source: { var: "$s" },
  },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.DisclosureRendered,
      kind: CFC_CONCEPT_KIND.PromptInfluence,
      source: { var: "$s" },
      sink: { var: "$sink" },
    }],
    boundary: [
      {
        type: CFC_ATOM_TYPE.BoundaryContext,
        key: "sinkClass",
        value: "display",
      },
      boundarySinkGuard,
    ],
  },
  post: { dropClause: true },
};

const influenceAcknowledgedRule: ExchangeRule = {
  id: "discharge-influence-action-acknowledged",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInfluence,
    source: { var: "$s" },
  },
  preCondition: {
    // Routing-sensitive action fields require explicit user acknowledgment
    // (§10.1 conservative default), not a mere rendered disclosure. The
    // acknowledgment must name the SINK it was given for (`sink` is optional
    // on the atom, so an acknowledgment minted without one fails closed — it
    // cannot discharge at any sink).
    integrity: [{
      type: CFC_ATOM_TYPE.DisclosureAcknowledged,
      kind: CFC_CONCEPT_KIND.PromptInfluence,
      source: { var: "$s" },
      sink: { var: "$sink" },
    }],
    boundary: [
      {
        type: CFC_ATOM_TYPE.BoundaryContext,
        key: "fieldRole",
        value: "routing",
      },
      boundarySinkGuard,
    ],
  },
  post: { dropClause: true },
};

const influenceDisclaimerRule: ExchangeRule = {
  id: "discharge-influence-content-disclaimer",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInfluence,
    source: { var: "$s" },
  },
  preCondition: {
    // Content fields may accept an attached disclaimer where policy permits.
    integrity: [{
      type: CFC_ATOM_TYPE.DisclaimerAttached,
      kind: CFC_CONCEPT_KIND.PromptInfluence,
      source: { var: "$s" },
      sink: { var: "$sink" },
    }],
    boundary: [
      {
        type: CFC_ATOM_TYPE.BoundaryContext,
        key: "fieldRole",
        value: "content",
      },
      boundarySinkGuard,
    ],
  },
  post: { dropClause: true },
};

/**
 * The material-risk discharge rules, isolated as their own policy. Consumed
 * ONLY by the trusted-schema sanitizer, which runs them path-locally with the
 * path's own minted `InjectionSafe` (see module doc). NOT part of the
 * deployment profile — bare-`InjectionSafe` discharge is unsound against the
 * tx-wide integrity a boundary evaluates over.
 */
export const MATERIAL_RISK_DISCHARGE_POLICY: readonly CfcPolicyRecordInput[] = [
  {
    id: "cfc:material-risk-discharge",
    rules: [...materialRiskDischargeRules],
  },
];

/**
 * The deployment standard profile: tier upgrades, value-screened discharge,
 * and the source-and-sink-bound influence discharge. Every rule here is safe
 * against tx-wide integrity aggregation, so it may run at real boundaries
 * under `cfcPolicyEvaluation`. Material-risk discharge is deliberately absent
 * (it lives in `MATERIAL_RISK_DISCHARGE_POLICY`, sanitizer-only).
 */
export const STANDARD_PROMPT_CAVEAT_POLICY: readonly CfcPolicyRecordInput[] = [{
  id: "cfc:standard-prompt-caveat-profile",
  rules: [
    ingressUpgradeRule,
    valueUpgradeRule,
    valueScreenedDischargeRule,
    influenceDisclosureRenderedRule,
    influenceAcknowledgedRule,
    influenceDisclaimerRule,
  ],
}];
