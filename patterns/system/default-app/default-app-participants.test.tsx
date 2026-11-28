/** The space root's roster links each profile once, and lists it. */
import {
  action,
  assert,
  type Confidential,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  countElements,
  findElementByExactText,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import DefaultApp, { joinAsViewer } from "./default-app.tsx";

type TestProfile = Confidential<
  { name?: string; avatar?: string },
  readonly ["default-app-test-profile"]
>;

export default pattern(() => {
  const subject = DefaultApp();

  // Labeled, as a real profile is.
  const member = Writable.of<TestProfile>({ name: "Member" });
  const other = Writable.of<TestProfile>({ name: "Other" });

  const join = action(() => subject.addParticipant.send({ profile: member }));
  const joinOther = action(() =>
    subject.addParticipant.send({ profile: other })
  );

  // What "Join this space" is bound to, with the viewer's profile absent and
  // then present.
  const absent = Writable.of<TestProfile>();
  const viewer = Writable.of<TestProfile>({ name: "Viewer" });
  const joinWithoutProfile = joinAsViewer({
    join: subject.addParticipant,
    profile: absent,
  });
  const joinAsTheViewer = joinAsViewer({
    join: subject.addParticipant,
    profile: viewer,
  });

  return {
    [TESTS]: [
      { assertion: assert(() => subject.participants.length === 0) },

      // A viewer with no profile is offered Join, disabled until one exists.
      { render: subject[UI] },
      {
        assertion: assert(() =>
          propValue(
            findElementByExactText(subject[UI], "cf-button", "Join this space"),
            "disabled",
          ) === true
        ),
      },

      { action: join },
      {
        assertion: assert(() =>
          subject.participants.length === 1 &&
          subject.participants[0].equals(member)
        ),
      },

      { action: join },
      { assertion: assert(() => subject.participants.length === 1) },

      { action: joinOther },
      {
        assertion: assert(() =>
          subject.participants.length === 2 &&
          subject.participants[1].equals(other)
        ),
      },

      // An unresolved profile joins no one; a resolved one joins once.
      { action: joinWithoutProfile },
      { assertion: assert(() => subject.participants.length === 2) },
      { action: joinAsTheViewer },
      {
        assertion: assert(() =>
          subject.participants.length === 3 &&
          subject.participants[2].equals(viewer)
        ),
      },
      { action: joinAsTheViewer },
      { assertion: assert(() => subject.participants.length === 3) },

      { render: subject[UI] },
      {
        assertion: assert(() =>
          hasText(subject[UI], "Participants") &&
          countElements(subject[UI], "cf-profile-badge") === 3
        ),
      },
    ],
  };
});
