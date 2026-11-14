import { assert, NAME, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElement,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import SharedProfileRoster, {
  join,
  type Roster,
  type ViewerState,
} from "./main.tsx";

type StandInProfile = { name?: string };

const joinButton = (root: unknown) => findElement(root, "cf-button");

export default pattern(() => {
  const roster = Writable.of<Roster>({ participants: [] });
  const viewer = Writable.of<ViewerState>({});
  const otherViewer = Writable.of<ViewerState>({});
  const lobby = SharedProfileRoster({ roster, viewer });

  // Joining needs the viewer's `#profile`, which a pattern test cannot
  // resolve, so the join handler is bound here to stand-in profile cells.
  // Two people who share the name "Alex" are two cells.
  const firstAlex = Writable.of<StandInProfile>({ name: "Alex" });
  const secondAlex = Writable.of<StandInProfile>({ name: "Alex" });
  const firstAlexJoins = join({
    roster,
    viewer,
    profile: firstAlex,
    name: "  Alex ",
  });
  const secondAlexJoins = join({
    roster,
    viewer: otherViewer,
    profile: secondAlex,
    name: "Alex",
  });
  const namelessJoins = join({
    roster,
    viewer,
    profile: firstAlex,
    name: "  ",
  });
  const profilelessJoins = join({
    roster,
    viewer,
    profile: undefined,
    name: "Alex",
  });

  const assert_names_itself = assert(() =>
    lobby[NAME] === "Shared-profile roster"
  );
  // With no profile resolved, the button offers to join under a placeholder.
  const assert_starts_unjoined = assert(() =>
    lobby.participantCount === 0 &&
    hasText(lobby[UI], "Participants (0)") &&
    hasText(joinButton(lobby[UI]), "Join as …") &&
    propValue(joinButton(lobby[UI]), "disabled") === false
  );

  // A viewer with no name, or no profile cell, has nothing to contribute.
  const assert_nobody_joined = assert(() =>
    lobby.participantCount === 0 && viewer.get().joined !== true
  );

  const assert_alex_joined = assert(() =>
    lobby.participantCount === 1 &&
    roster.get().participants[0].name === "Alex" &&
    roster.get().participants[0].avatar === "" &&
    roster.get().participants[0].picture === undefined &&
    viewer.get().joined === true &&
    viewer.get().joinedName === "Alex" &&
    hasText(lobby[UI], "Participants (1)") &&
    hasText(lobby[UI], "Alex") &&
    hasText(joinButton(lobby[UI]), "Joined") &&
    propValue(joinButton(lobby[UI]), "disabled") === true
  );

  // Joining again is idempotent: the roster is keyed on the profile cell.
  const assert_rejoin_adds_nobody = assert(() => lobby.participantCount === 1);

  // The other Alex shares the name but not the profile cell, so joins too.
  const assert_namesake_joined = assert(() =>
    lobby.participantCount === 2 &&
    otherViewer.get().joined === true &&
    hasText(lobby[UI], "Participants (2)")
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_starts_unjoined },
      { action: namelessJoins },
      { action: profilelessJoins },
      { assertion: assert_nobody_joined },
      { action: firstAlexJoins },
      { assertion: assert_alex_joined },
      { action: firstAlexJoins },
      { assertion: assert_rejoin_adds_nobody },
      { action: secondAlexJoins },
      { assertion: assert_namesake_joined },
    ],
    lobby,
  };
});
