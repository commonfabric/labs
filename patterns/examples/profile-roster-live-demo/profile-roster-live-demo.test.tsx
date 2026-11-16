import { assert, NAME, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  countElements,
  findElement,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ProfileRosterLive, {
  join,
  type Roster,
  type ViewerState,
} from "./profile-roster-live-demo.tsx";

type StandInProfile = { name?: string };

const joinButton = (root: unknown) => findElement(root, "cf-button");

export default pattern(() => {
  const roster = Writable.of<Roster>({ participants: [] });
  const viewer = Writable.of<ViewerState>({});
  const otherViewer = Writable.of<ViewerState>({});
  const live = ProfileRosterLive({ roster, viewer });

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
    live[NAME] === "Live profile roster"
  );
  // With no profile resolved, the button offers to join under a placeholder.
  const assert_starts_unjoined = assert(() =>
    live.participantCount === 0 &&
    hasText(live[UI], "Participants (0)") &&
    hasText(joinButton(live[UI]), "Join as …") &&
    propValue(joinButton(live[UI]), "disabled") === false
  );

  // A viewer with no name, or no profile cell, has nothing to contribute.
  const assert_nobody_joined = assert(() =>
    live.participantCount === 0 && viewer.get().joined !== true
  );

  const assert_alex_joined = assert(() =>
    live.participantCount === 1 &&
    roster.get().participants[0].name === "Alex" &&
    viewer.get().joined === true &&
    hasText(live[UI], "Participants (1)") &&
    // The viewer's own badge, and one live badge per participant.
    countElements(live[UI], "cf-profile-badge") === 2 &&
    hasText(joinButton(live[UI]), "Joined") &&
    propValue(joinButton(live[UI]), "disabled") === true
  );

  // Joining again is idempotent: the roster is keyed on the profile cell.
  const assert_rejoin_adds_nobody = assert(() => live.participantCount === 1);

  // The other Alex shares the name but not the profile cell, so joins too.
  const assert_namesake_joined = assert(() =>
    live.participantCount === 2 &&
    otherViewer.get().joined === true &&
    hasText(live[UI], "Participants (2)") &&
    countElements(live[UI], "cf-profile-badge") === 3
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
    live,
  };
});
