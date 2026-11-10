/**
 * A FabriChat manager as a person's runtime runs it, finding its reader through
 * the person's own `#profile` wish, beside a place to hold a profile that the
 * person's home can then list. Fixture for
 * `fabrichat-manager-profile-wish-multi-runtime.test.ts`.
 */

import {
  type Cell,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import FabriChatManager from "../../../system/fabrichat/manager.tsx";
import type { ChatProfile } from "../../../system/fabrichat/schemas.tsx";

/** What holding a profile asks: the profile, as the link a session holds. */
interface HoldProfileEvent {
  /** The profile. */
  profile: Cell<ChatProfile>;
}

/** Holds the event's profile where the person's home can be pointed at it. */
const holdProfile = handler<
  HoldProfileEvent,
  { profile: Writable<Cell<ChatProfile> | undefined> }
>((event, { profile }) => {
  profile.set(event.profile);
});

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The profile held for the person's home to list. */
  profile: Cell<ChatProfile> | undefined;

  /** Holds a profile for the person's home to list. */
  holdProfile: Stream<HoldProfileEvent>;
}

export default pattern<Record<string, never>, MainOutput>(() => {
  const profile = new Writable<Cell<ChatProfile> | undefined>(undefined)
    .for("profile");
  const manager = FabriChatManager({});
  return {
    [NAME]: "FabriChat manager profile wish fixture",
    [UI]: manager[UI],
    profile,
    holdProfile: holdProfile({ profile }),
  };
});
