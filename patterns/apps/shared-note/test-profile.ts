/** A profile of its own for each viewer of a shared-note test. */

import {
  handler,
  type RepresentsCurrentUser,
  type TrustedActionWrite,
  type Writable,
} from "commonfabric";
import type { NoteProfile } from "./main.tsx";

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "SharedNoteTestProfileSurface";
const PROFILE_ACTION = "SharedNoteTestWriteProfile";

/** The gesture writing a profile takes. */
export const profileGesture = {
  surface: PROFILE_SURFACE,
  action: PROFILE_ACTION,
};

/**
 * A stand-in for a viewer's `#profile`, which a pattern test cannot resolve:
 * a profile of the person who wrote it, as a Fabric profile is, and which
 * only `writeOwnProfile` writes, from its reviewed surface.
 */
export type TestProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    NoteProfile,
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  /** The profile to write. */
  profile: Writable<TestProfile>;

  /** The name to write into it. */
  name: string;
}

/** Writes `name` into `profile`, as its owner does. */
export const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name } as TestProfile);
});
