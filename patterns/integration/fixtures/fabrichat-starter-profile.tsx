/** Holds profile choices beside the standalone starter for its integration test. */

import { type Cell, handler, pattern, UI, Writable } from "commonfabric";
import Starter from "../../system/fabrichat/space-starter.tsx";
import type { ChatProfile } from "../../system/fabrichat/schemas.tsx";

/** Holds a real profile where the test reader's home can select it. */
const holdProfile = handler<
  { profile: Cell<ChatProfile> },
  { profile: Writable<Cell<ChatProfile> | undefined> }
>(({ profile: selected }, { profile }) => profile.set(selected));

export default pattern(() => {
  const profile = new Writable<Cell<ChatProfile> | undefined>();
  const emptyProfile = new Writable<ChatProfile>();
  const starter = Starter({});
  return {
    [UI]: starter[UI],
    profile,
    emptyProfile,
    holdProfile: holdProfile({ profile }),
  };
});
