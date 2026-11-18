/**
 * A FabriChat room whose reader has no profile offers the form that creates
 * one. `#profile` resolves nothing in this lane, so the room's reader here has
 * none; `../../integration/fabrichat-room-profile-wish-multi-runtime.test.ts`
 * checks that a reader with a profile isn't offered the form.
 */
import { assert, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeById,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import FabriChatRoom from "./room.tsx";

// The display of the room's profile-setup surface, under `root`.
const setupDisplay = (root: unknown): unknown =>
  readValue(
    (propValue(findNodeById(root, "fabrichat-profile-setup"), "style") as {
      display?: unknown;
    })?.display,
  );

export default pattern(() => {
  const room = FabriChatRoom({});
  return {
    [TESTS]: [
      { assertion: assert(() => setupDisplay(room[UI]) === "block") },
    ],
  };
});
