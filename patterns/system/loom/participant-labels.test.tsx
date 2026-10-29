/**
 * The roster links each document it is given once, the first entry included,
 * whether or not the runtime holds a label for it.
 */
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
  // A bare document carries no label, so it names no principal. The roster
  // holds claims, and links it as it links a labeled profile: a consumer
  // keeps the entries whose profile names a principal with access.
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
    [TESTS]: [
      { action: addBareFirst },
      {
        assertion: assert(() =>
          empty.participants.length === 1 &&
          empty.participants[0].equals(bare)
        ),
      },
      { action: joinEmpty },
      {
        assertion: assert(() =>
          empty.participants.length === 2 &&
          empty.participants[1].equals(member)
        ),
      },
      { action: addBareFirst },
      { assertion: assert(() => empty.participants.length === 2) },
      { action: joinListed },
      { action: addBareLater },
      {
        assertion: assert(() =>
          listed.participants.length === 2 &&
          listed.participants[0].equals(member) &&
          listed.participants[1].equals(bare)
        ),
      },
    ],
  };
});
