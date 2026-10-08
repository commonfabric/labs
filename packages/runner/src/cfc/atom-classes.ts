import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Integrity-atom propagation classes (spec §15 registry, §3.1.6.1):
 *
 * - `hereditary`: survives combination via the class-aware meet — an output
 *   carries it only when EVERY input carried it (weakest-link, the
 *   `PolicyCertified` family).
 * - `value-bound`: a claim about the exact current value. Any
 *   value-changing transformation drops it; a verified projection keeps a
 *   form of it scoped to the projected path (§8.3.2).
 * - `provenance`: evidence about a specific event, boundary evaluation, or
 *   environment (gestures, renders, prompt-slot bindings, role membership)
 *   rather than about a value's content. It never propagates, and no
 *   registry claim, projection scoping included, may carry it onto an
 *   output (§15.1.1).
 *
 * Unknown atom types default to `value-bound` (SC-10): dropping on
 * combination under-claims integrity, which is the fail-safe direction.
 */
export type PropagationClass = "hereditary" | "value-bound" | "provenance";

// `User` / `Space` / `Expires` are deliberately ABSENT: they are
// confidentiality principals/constraints (spec §15.2), and confidentiality
// atoms have no propagation class — they always propagate by CNF join and are
// removed only by exchange-rule evaluation or explicit declassification
// (§15.1). Listing them here would wrongly suggest the integrity meet ever
// consults them.
const CLASS_BY_TYPE = new Map<string, PropagationClass>([
  [CFC_ATOM_TYPE.PolicyCertified, "hereditary"],
  [CFC_ATOM_TYPE.InjectionSafe, "value-bound"],
  [CFC_ATOM_TYPE.LinkReference, "value-bound"],
  [CFC_ATOM_TYPE.Caveat, "value-bound"],
  // Screening evidence makes exact-current-value claims (its value-stage form
  // binds via `valueRef`), so it is value-bound (spec §15.4) — any
  // transformation invalidates the binding; discharge rules re-verify the
  // `valueRef` against the current value rather than trusting survival.
  [CFC_ATOM_TYPE.CaveatScreened, "value-bound"],
  [CFC_ATOM_TYPE.Resource, "value-bound"],
  // Code identity and computation integrity describe the value they label,
  // and each operation mints its own `TransformedBy` (spec §15.4, §3.1.6.2).
  [CFC_ATOM_TYPE.Builtin, "value-bound"],
  [CFC_ATOM_TYPE.TransformedBy, "value-bound"],
  // The registry's default for this example family (spec §15.6). No runtime
  // code here mints it.
  [CFC_ATOM_TYPE.UserSurfaceInput, "value-bound"],
  // A deviation from spec §15.4, which makes this admission claim value-bound
  // through its `valueDigest`. Nothing here verifies that digest against the
  // value the atom labels, so the runtime keeps the claim off every
  // derivative, projections included. Moving a family from value-bound to
  // provenance only removes survival paths, which §15.1.1 holds sound.
  [CFC_ATOM_TYPE.ExternalIngest, "provenance"],
  [CFC_ATOM_TYPE.LlmDerived, "provenance"],
  [CFC_ATOM_TYPE.Origin, "provenance"],
  // Records a single binding of a value into a prompt slot; the authority
  // that binding confers belongs to that value alone (spec §15.4).
  [CFC_ATOM_TYPE.PromptSlotBound, "provenance"],
  [CFC_ATOM_TYPE.PromptSlotInfluence, "provenance"],
  // Event/boundary/role evidence (spec §15.4): facts about a specific render,
  // acknowledgment, sink emission, assessment, boundary evaluation, or role
  // membership — never claims about a derived value's content, so no registry
  // claim (endorsed transformer, projection scoping) may carry them onto an
  // output.
  [CFC_ATOM_TYPE.BoundaryContext, "provenance"],
  [CFC_ATOM_TYPE.CaveatAssessment, "provenance"],
  [CFC_ATOM_TYPE.DisclaimerAttached, "provenance"],
  [CFC_ATOM_TYPE.DisclosureAcknowledged, "provenance"],
  [CFC_ATOM_TYPE.DisclosureRendered, "provenance"],
  [CFC_ATOM_TYPE.HasRole, "provenance"],
]);

export const atomPropagationClass = (atom: unknown): PropagationClass => {
  if (isObjectOrArray(atom) && typeof atom.type === "string") {
    return CLASS_BY_TYPE.get(atom.type) ?? "value-bound";
  }
  // String atoms and kind-shaped records (authored-by /
  // represents-principal) have no registered class — fail-safe.
  return "value-bound";
};

const ATOM_URI = "https://commonfabric.org/cfc/atom/";

// The spec §15 registry's class, as a value-intrinsic exchange guard reads it
// (`matchesOnlyValueBoundClaims`), for the families `CLASS_BY_TYPE` classes
// differently or does not list. The registry has `TransformedBy`, `Builtin`
// and `UserSurfaceInput` value-bound, each a claim about how the exact current
// value was produced, where `CLASS_BY_TYPE` has them provenance; and it has
// `PromptSlotBound` provenance, where `CLASS_BY_TYPE` has it value-bound.
// `CLASS_BY_TYPE` decides the hereditary meet and which integrity a
// projection scopes onto its output, and still has `TransformedBy` as
// provenance there, which the registry does not. The registry has
// `ExternalIngest` value-bound too, through the digest of the value it
// marks, but this runtime does not check that digest against the value a
// path holds, so it reads the mark as provenance here as `CLASS_BY_TYPE`
// does: a rule guarded on it releases at the boundary that evaluates it and
// never carries. The other provenance families below are evidence of an
// event, an environment or an access rather than claims about a value, and
// `CLASS_BY_TYPE` does not list them.
const GUARD_CLASS_BY_TYPE = new Map<string, PropagationClass>([
  [CFC_ATOM_TYPE.TransformedBy, "value-bound"],
  [CFC_ATOM_TYPE.Builtin, "value-bound"],
  [CFC_ATOM_TYPE.UserSurfaceInput, "value-bound"],
  [CFC_ATOM_TYPE.ExternalIngest, "provenance"],
  [CFC_ATOM_TYPE.PromptSlotBound, "provenance"],
  ...[
    "AddMemberIntent",
    "Attestation",
    "AudienceRepresents",
    "AudioTrigger",
    "CaveatWarningRendered",
    "ClientAppAttested",
    "DeviceTier",
    "GestureProvenance",
    "PromptInfluenceVerified",
    "RuntimeImage",
    "RuntimeObservationLimited",
    "RuntimeObservationProfile",
    "RuntimeProfile",
    "RuntimeProvider",
    "RuntimeTEE",
    "SinkContentDisclaimerAttached",
    "TrustedProvider",
    "UIIntent",
    "UserAcknowledgedCaveat",
  ].map((name): [string, PropagationClass] => [
    `${ATOM_URI}${name}`,
    "provenance",
  ]),
]);

/**
 * Whether every atom `pattern` can match is a claim bound to the exact current
 * value it labels: a record naming a concrete family the spec §15 registry
 * classes value-bound, an unregistered family included (§15.1.1's default).
 * `IntegritySummary` is value-bound only for a `surviving-content` basis, so a
 * pattern on it qualifies only when it names that basis. An exchange rule
 * guarded only by such patterns is value-intrinsic (§5.3).
 */
export const matchesOnlyValueBoundClaims = (pattern: unknown): boolean => {
  if (!isObjectOrArray(pattern) || Array.isArray(pattern)) return false;
  const type = pattern.type;
  if (typeof type !== "string") return false;
  if (type === `${ATOM_URI}IntegritySummary`) {
    return pattern.basis === "surviving-content";
  }
  return (GUARD_CLASS_BY_TYPE.get(type) ?? CLASS_BY_TYPE.get(type) ??
    "value-bound") === "value-bound";
};
