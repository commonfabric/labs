/** The roster links only a labeled profile, the first entry included. */
import {
  action,
  assert,
  type Confidential,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import Loom from "./main.tsx";
import type { ParticipantRoster } from "./schemas.tsx";

type TestProfile = Confidential<
  { name?: string; avatar?: string },
  readonly ["loom-test-profile"]
>;

export default pattern(() => {
  // A bare document carries no label, so the runtime cannot say whose
  // profile it is, and the roster refuses to link it.
  const bare = Writable.of({ name: "Bare" });
  const member = Writable.of<TestProfile>({ name: "Member" });

  // The first add creates the roster's `items` array in the same
  // transaction that links the profile.
  const empty = Loom({ participants: Writable.of<ParticipantRoster>({}) });
  const addBareFirst = action(() =>
    empty.addParticipant.send({ profile: bare })
  );
  const joinEmpty = action(() =>
    empty.addParticipant.send({ profile: member })
  );

  // Here the array already exists when the bare document arrives.
  const listed = Loom({ participants: Writable.of<ParticipantRoster>({}) });
  const joinListed = action(() =>
    listed.addParticipant.send({ profile: member })
  );
  const addBareLater = action(() =>
    listed.addParticipant.send({ profile: bare })
  );

  return {
    // Each refused link is reported as a CFC policy warning.
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: addBareFirst },
      { assertion: assert(() => empty.participants.length === 0) },
      { action: joinEmpty },
      {
        assertion: assert(() =>
          empty.participants.length === 1 &&
          empty.participants[0].equals(member)
        ),
      },
      { action: joinListed },
      { action: addBareLater },
      {
        assertion: assert(() =>
          listed.participants.length === 1 &&
          listed.participants[0].equals(member)
        ),
      },
    ],
  };
});
