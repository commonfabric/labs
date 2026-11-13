/**
 * Tests that the space overview asks for an analysis as soon as it starts:
 * its autostart sends the dialog one user message requesting an overview.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  fireEvent,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import SpaceOverview from "./space-overview.tsx";

/** The messages the overview's message beads show. */
const shownMessages = (root: unknown) =>
  (propValue(findElement(root, "cf-message-beads"), "$messages") ??
    []) as { role?: string; content?: { text?: string }[] }[];

export default pattern(() => {
  const overview = SpaceOverview({});

  const action_start = action(() => {
    fireEvent(findElement(overview[UI], "cf-autostart"), "onstart", {});
  });

  return {
    [TESTS]: [
      { assertion: assert(() => overview[NAME] === "Space Overview") },
      { assertion: assert(() => shownMessages(overview[UI]).length === 0) },
      { action: action_start },
      {
        assertion: assert(() =>
          shownMessages(overview[UI])[0]?.role === "user" &&
          shownMessages(overview[UI])[0]?.content?.[0]?.text ===
            "Analyze this space and give me an overview of what's here."
        ),
      },
    ],
    overview,
  };
});
