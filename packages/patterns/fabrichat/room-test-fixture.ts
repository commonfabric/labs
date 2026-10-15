/** Shared protected storage and attested profiles for FabriChat room tests. */
import {
  handler,
  pattern,
  type RepresentsCurrentUser,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";
import type {
  ReactionList,
  SentActivity,
  SentMessage,
  StoredActivityCounters,
  StoredRequestMemo,
  StoredUsedTime,
} from "./room-records.tsx";
import type { ChatProfile } from "./schemas.tsx";

/** Fresh protected records shared by the viewers of one test room. */
export const testRoomStorage = pattern(() => {
  return {
    messages: Writable.of<SentMessage[]>([]),
    reactionLists: Writable.of<ReactionList[]>([]),
    requests: Writable.of<StoredRequestMemo[]>([]),
    usedTimes: Writable.of<StoredUsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<StoredActivityCounters[]>([]),
  };
});

/** A profile whose label names the actor who initializes it. */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof writeProfile,
    "ChatTestProfile",
    "ChatTestProfileSurface"
  >
>;

/** The profile initialized by the authenticated test participant. */
interface ProfileState {
  /** The actor's own profile. */
  profile: Writable<OwnProfile>;
}

/** Attests the profile used to display the authenticated sender's controls. */
const writeProfile = handler<void, ProfileState>(
  (_, { profile }) => {
    profile.set({ name: "Alice" } as OwnProfile);
  },
);

/** The reviewed gesture that initializes a test profile. */
export const profileGesture = {
  surface: "ChatTestProfileSurface",
  action: "ChatTestProfile",
};

/** A fresh profile and the gesture stream that attests its owner. */
export const testRoomProfile = pattern(() => {
  const profile = new Writable<OwnProfile>();
  return { profile, initialize: writeProfile({ profile }) };
});
