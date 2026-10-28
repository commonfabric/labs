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
} from "../test/vnode-helpers.ts";
import DefaultApp from "./default-app.tsx";

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

      { render: subject[UI] },
      {
        assertion: assert(() =>
          hasText(subject[UI], "Participants") &&
          countElements(subject[UI], "cf-profile-badge") === 2
        ),
      },
    ],
  };
});
