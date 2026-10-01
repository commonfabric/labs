import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Integrity-atom propagation classes (spec §15 registry, §3.1.6.1):
 *
 * - `hereditary`: survives combination via the class-aware meet — an output
 *   carries it only when EVERY input carried it (weakest-link, the
 *   `PolicyCertified` family).
 * - `value-bound`: bound to a specific value identity; any transformation
 *   invalidates the binding, so it never propagates through the default
 *   transition.
 * - `provenance`: records a specific event, boundary evaluation, or
 *   environment; never propagated or eligible for registry-authorized
 *   preservation.
 *
 * Unknown atom types default to `value-bound` (SC-10): dropping on
 * combination under-claims integrity, which is the fail-safe direction.
 */
export type PropagationClass = "hereditary" | "value-bound" | "provenance";

// Confidentiality families are deliberately absent: they always propagate by
// CNF join and are removed only by exchange-rule evaluation or explicit
// declassification (spec §15.1–15.3).
const CLASS_BY_TYPE = new Map<string, PropagationClass>([
  [CFC_ATOM_TYPE.PolicyCertified, "hereditary"],
  [CFC_ATOM_TYPE.InjectionSafe, "value-bound"],
  [CFC_ATOM_TYPE.LinkReference, "value-bound"],
  [CFC_ATOM_TYPE.Builtin, "value-bound"],
  [CFC_ATOM_TYPE.ConnectorObserved, "value-bound"],
  [CFC_ATOM_TYPE.ExternalIngest, "value-bound"],
  [CFC_ATOM_TYPE.NetworkProvenance, "value-bound"],
  // Screening evidence makes exact-current-value claims (its value-stage form
  // binds via `valueRef`), so it is value-bound (spec §15.4) — any
  // transformation invalidates the binding; discharge rules re-verify the
  // `valueRef` against the current value rather than trusting survival.
  [CFC_ATOM_TYPE.CaveatScreened, "value-bound"],
  [CFC_ATOM_TYPE.UserSurfaceInput, "value-bound"],
  [CFC_ATOM_TYPE.PromptSlotBound, "provenance"],
  // Model output carries this positive provenance atom rather than an ordinary
  // observed-node transformation, so it is non-propagating.
  [CFC_ATOM_TYPE.LlmDerived, "provenance"],
  [CFC_ATOM_TYPE.PromptSlotInfluence, "provenance"],
  // The current carrier records an operation event rather than an exact value
  // binding, so it remains provenance.
  [CFC_ATOM_TYPE.TransformedBy, "provenance"],
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

/** Declared propagation class for an integrity family in the local registry. */
export const registeredAtomPropagationClass = (
  type: string,
): PropagationClass | undefined => CLASS_BY_TYPE.get(type);

export const atomPropagationClass = (atom: unknown): PropagationClass => {
  if (isObjectOrArray(atom) && typeof atom.type === "string") {
    return registeredAtomPropagationClass(atom.type) ?? "value-bound";
  }
  // String atoms and kind-shaped records (authored-by /
  // represents-principal) have no registered class — fail-safe.
  return "value-bound";
};
