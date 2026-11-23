/**
 * Joining lists the joiner's own profile on the roster once, and lists
 * nothing while that profile has not resolved.
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
import { joinAsViewer } from "./participants.tsx";
import type { ParticipantRoster } from "./schemas.tsx";

type TestProfile = Confidential<
  { name?: string; avatar?: string },
  readonly ["loom-test-profile"]
>;

export default pattern(() => {
  const loom = Loom({ participants: Writable.of<ParticipantRoster>({}) });

  // The root's own stream is bound to the viewer's `#profile`, which a
  // pattern test cannot resolve: sending it lists nothing.
  const joinUnresolved = action(() => loom.joinAsViewer.send());

  // The handler bound to stand-in profiles, as the root binds it to the
  // viewer's.
  const guest = Writable.of<TestProfile>({ name: "Guest" });
  const guestJoins = joinAsViewer({
    join: loom.addParticipant,
    profile: guest,
  });
  const nobodyJoins = joinAsViewer({
    join: loom.addParticipant,
    profile: undefined,
  });
  const joinGuest = action(() => guestJoins.send());
  const joinNobody = action(() => nobodyJoins.send());

  return {
    [TESTS]: [
      { action: joinUnresolved },
      { assertion: assert(() => loom.participants.length === 0) },
      { action: joinNobody },
      { assertion: assert(() => loom.participants.length === 0) },
      { action: joinGuest },
      {
        assertion: assert(() =>
          loom.participants.length === 1 &&
          loom.participants[0].equals(guest)
        ),
      },
      // A guest who opens the Loom again joins again: the roster lists them
      // once.
      { action: joinGuest },
      { assertion: assert(() => loom.participants.length === 1) },
    ],
  };
});
