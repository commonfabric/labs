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
