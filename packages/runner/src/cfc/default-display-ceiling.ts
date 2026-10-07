import { type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";

import { PROMPT_CAVEAT_FAMILY_KINDS } from "./prompt-caveat-kinds.ts";

/**
 * The §8.10.6 initial display-sink release ceiling, in a leaf module so that
 * every display, a main-thread host's among them, builds it from one place:
 * what a display surface admits when no authored policy covers it.
 *
 * The audience of a display sink is the acting user, so the identity and
 * personal-space principal forms naming exactly that audience are admissible
 * by construction. Shared `Space(...)` principals are not listed: they
 * resolve to the acting user through the verified `HasRole` exchange rules at
 * a render boundary that runs them, which admits them without widening this
 * static ceiling.
 *
 * Tighten-only evolution (spec §8.10.6): removing an entry needs no ceremony;
 * admitting a new atom family or caveat kind is a release decision that needs
 * authored policy or verified authority.
 */
export const defaultDisplayCeiling = (actingUser: string): {
  atoms: CfcAtom[];
  caveatKinds: string[];
} => ({
  // Acting-user identity atoms: the audience of a display sink is the acting
  // user, so atoms naming exactly that audience are admissible by
  // construction (spec §8.10.6). Both the §15.2 principal atom objects
  // (`User`, `PersonalSpace`) and the legacy DID-string form are listed; the
  // ceiling is a set, and every entry names exactly this audience.
  atoms: [
    cfcAtom.user(actingUser),
    cfcAtom.personalSpace(actingUser),
    actingUser,
  ],
  // The whole §10.1 prompt-caveat family (SC-54, proposed §8.10.6), screening
  // tiers included. A prompt caveat says not to trust the content as
  // instructions to a model; a display shows it to the acting user. Admitting
  // it is not discharging it: it stays on the value.
  caveatKinds: [...PROMPT_CAVEAT_FAMILY_KINDS],
});
