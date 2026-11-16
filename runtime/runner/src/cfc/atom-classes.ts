import { isObjectOrArray } from "@commonfabric/js-values/types";
import {
  atomPropagationClass,
  type PropagationClass,
} from "@commonfabric/memory/v2/cfc-atom-classes";

// The propagation classes are decided in the store, which meets integrity
// too; the runner's callers reach them here.
export { atomPropagationClass, type PropagationClass };

const ATOM_URI = "https://commonfabric.org/cfc/atom/";

// Families the specification treats as provenance that the store's class
// table does not list: evidence of an event, an environment or an access
// rather than a claim about a value. They are the §15 registry's provenance
// families and `UIRuntime`, the UI-runtime attestation an intent carries
// (§6.3.1). A value-intrinsic guard reads them as provenance.
const UNLISTED_PROVENANCE_FAMILIES: ReadonlySet<string> = new Set(
  [
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
    "UIRuntime",
    "UserAcknowledgedCaveat",
  ].map((name) => `${ATOM_URI}${name}`),
);

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
  if (UNLISTED_PROVENANCE_FAMILIES.has(type)) return false;
  return atomPropagationClass({ type }) === "value-bound";
};
