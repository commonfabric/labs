/**
 * Tests that the math note's body is a collaborative prose editor drawing
 * TeX. What the editor draws is the editor's own, and its tests cover it.
 */

import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  propsOf,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import MathNote from "./main.tsx";

const BODY = "Euler: $e^{i\\pi} + 1 = 0$\n\n$$\n\\int_0^1 x\\,dx\n$$\n";

/** The props of the editor under `root`. */
const editorOf = (root: unknown) =>
  propsOf(findElement(root, "cf-code-editor"));

export default pattern(() => {
  const note = MathNote({ title: "Identities", content: BODY });
  const blank = MathNote({});

  const assert_holds_its_title_and_body = assert(() =>
    note.title === "Identities" && note[NAME] === "Identities" &&
    note.content === BODY && blank.title === "Math note" &&
    blank.content === ""
  );
  const assert_edits_the_body_in_prose_with_math = assert(() => {
    const props = editorOf(note[UI]);
    return readValue(props?.["$value"]) === BODY &&
      readValue(props?.mode) === "prose" &&
      readValue(props?.math) === true &&
      readValue(props?.collaborative) === true &&
      readValue(props?.language) === "text/markdown";
  });

  return {
    [TESTS]: [
      { assertion: assert_holds_its_title_and_body },
      { assertion: assert_edits_the_body_in_prose_with_math },
    ],
    note,
  };
});
