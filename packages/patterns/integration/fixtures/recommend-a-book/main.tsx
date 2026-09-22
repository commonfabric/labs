// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/** Supplies a public originator profile to the actual recommendation invitation. */
import { pattern, Writable } from "commonfabric";
import Invitation, {
  type SharedInvitationOutput,
} from "../../../recommend-a-book/shared-invitation.tsx";

export default pattern<Record<string, never>, SharedInvitationOutput>(() => {
  const profile = new Writable({ name: "Originator" });
  const library = new Writable.perSpace({});
  return Invitation({ originatorProfile: profile, library });
});
