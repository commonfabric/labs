// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/** Supplies a public originator profile to the actual recommendation invitation. */
import { pattern, Writable } from "commonfabric";
import Invitation, {
  type InvitationOutput,
} from "../../../recommend-a-book/main.tsx";

export default pattern<Record<string, never>, InvitationOutput>(() => {
  const profile = new Writable({ name: "Originator" });
  return Invitation({ originatorProfile: profile });
});
