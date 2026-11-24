/**
 * `cf pattern publish`: naming the person as the author of one pattern
 * lineage, under one of their Common Fabric profiles. Their other patterns
 * stay anonymous and are not linked to it.
 *
 * The index stores only a reference to the profile, and takes the person's
 * word for it only with proof: the delegation the profile space issued to
 * the person's core identity when it was made to own itself, which Home
 * records (`docs/specs/profile-delegation.md`). `cf` signs index calls as
 * that same core identity, so the profile's own delegation is the whole
 * proof.
 */

import {
  decodeDelegation,
  type Delegation,
  type DIDKey,
  verifyDelegation,
} from "@commonfabric/identity";
import { indexProofs } from "@commonfabric/pattern-index/membership";
import type { ListedProfile } from "./profile.ts";

/** The profile a pattern is published under, and what proves it is theirs. */
export interface NamingProfile {
  space: string;
  piece: string;
  displayName: string;

  /** The delegations Home records over the profile space. */
  delegations: readonly Uint8Array[];
}

/** A refusal phrased for the person, with nothing published. */
export class NamingError extends Error {
  override name = "NamingError";
}

/**
 * The profile to publish under among `profiles`: the one whose space is
 * `space`, else the one `#profile` answers with.
 *
 * @throws NamingError when there is none, or `space` names none of them.
 */
export function chooseProfile(
  profiles: readonly ListedProfile[],
  space: string | undefined,
): ListedProfile {
  const chosen = space === undefined
    ? profiles.find((profile) => profile.current)
    : profiles.find((profile) => profile.space === space);
  if (chosen === undefined) {
    throw new NamingError(
      space !== undefined
        ? `None of your profiles lives in ${space}; cf profile ls lists them.`
        : profiles.length === 0
        ? "You have no profile to publish under: make one with cf profile create."
        : "None of your profiles is the current one; name one with --profile <space> (cf profile ls lists them).",
    );
  }
  if (chosen.name === "") {
    throw new NamingError(
      `The profile in ${chosen.space} has no name to show: set one with cf profile rename.`,
    );
  }
  return chosen;
}

/**
 * The `profileProof` for publishing under `profile` as `signer`: the
 * profile space's own delegation of `/memory` to the signer.
 *
 * @throws NamingError when Home records no such delegation, which is the
 *   case for a profile made before profiles owned themselves.
 */
export async function profileProof(
  profile: NamingProfile,
  signer: DIDKey,
): Promise<string[]> {
  // Only the profile's own delegation to the signer is needed, so a record
  // that does not decode or verify is passed over rather than failing the
  // publish; the index would refuse a proof whose signature does not hold,
  // and by then the pattern would already be shared.
  let root: Delegation | undefined;
  for (const bytes of profile.delegations) {
    const delegation = await decodeDelegation(bytes).catch(() => undefined);
    if (
      delegation === undefined ||
      delegation.payload.iss !== profile.space ||
      delegation.payload.sub !== profile.space ||
      delegation.payload.aud !== signer ||
      delegation.payload.cmd !== "/memory" ||
      !await verifyDelegation(delegation).then(() => true, () => false)
    ) continue;
    root = delegation;
    break;
  }
  if (root === undefined) {
    throw new NamingError(
      `The profile in ${profile.space} holds no delegation to this identity, so the index could not tell it is yours; a profile made before profiles owned themselves cannot be published under yet.`,
    );
  }
  return indexProofs([root.bytes]);
}

/** The one line said before anything is named. */
export const namingWarning = (displayName: string): string =>
  `Publishing shows "${displayName}" as this pattern's author to every member of the index. Once someone has seen it, it cannot be unseen, even after cf pattern unpublish.`;
