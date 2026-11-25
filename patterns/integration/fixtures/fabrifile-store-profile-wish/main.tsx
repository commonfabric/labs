/**
 * A FabriFile store as a person's runtime runs it, finding its viewer with the
 * person's own `#profile` wish, beside a place to hold a profile that the
 * person's home can then list. Fixture for
 * `fabrifile-store-profile-wish-multi-runtime.test.ts`.
 */

import {
  type Cell,
  handler,
  NAME,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";
import type {
  AddFileEvent,
  FileProfile,
  FileRequestOutcome,
} from "../../../system/fabrifile/schemas.tsx";
import FileStore from "../../../system/fabrifile/store.tsx";

/** What holding a profile asks: the profile, as the link a session holds. */
interface HoldProfileEvent {
  /** The profile. */
  profile: Cell<FileProfile>;
}

/** Holds the event's profile where the person's home can be pointed at it. */
const holdProfile = handler<
  HoldProfileEvent,
  { profile: Writable<Cell<FileProfile> | undefined> }
>((event, { profile }) => {
  profile.set(event.profile);
});

export interface MainOutput {
  [NAME]: string;

  /** The outcome of each request to the store. */
  requests: Record<string, FileRequestOutcome>;

  /** Adds a file to the store. */
  add: Stream<AddFileEvent>;

  /** The profile held for the person's home to list. */
  profile: Cell<FileProfile> | undefined;

  /** Holds a profile for the person's home to list. */
  holdProfile: Stream<HoldProfileEvent>;
}

export default pattern<Record<string, never>, MainOutput>(() => {
  const profile = new Writable<Cell<FileProfile> | undefined>(undefined)
    .for("profile");
  const store = FileStore({});
  return {
    [NAME]: "FabriFile store profile wish fixture",
    requests: store.requests,
    add: store.add,
    profile,
    holdProfile: holdProfile({ profile }),
  };
});
