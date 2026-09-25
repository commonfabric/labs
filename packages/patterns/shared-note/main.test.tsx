/** Tests imported text, editor bindings, and recovery without a notebook. */

import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  TILE_UI,
  UI,
} from "commonfabric";
import {
  findElement,
  findNodeById,
  fireEvent,
  hasText,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";
import SharedNote from "./main.tsx";

const MARKDOWN =
  "---\ntitle: Preserve this\n---\n# Team 😀\n\n- [ ] task\n\n```ts\nconst x = `${literal}`;\n```\n";

export default pattern(() => {
  const subject = SharedNote({ title: "Team notes", content: MARKDOWN });
  const blank = SharedNote({});
  const assert_imported_content = assert(() =>
    subject.content === MARKDOWN && subject.title === "Team notes" &&
    subject[NAME] === "Team notes" && blank.content === ""
  );
  const assert_collaborative_editor = assert(() => {
    const props = propsOf(findElement(subject[UI], "cf-code-editor"));
    return readValue(props?.["$value"]) === MARKDOWN &&
      readValue(props?.collaborative) === true &&
      readValue(props?.mode) === "prose" &&
      readValue(props?.wordWrap) === true &&
      readValue(props?.tabIndent) === true &&
      props?.presenceRoom === undefined &&
      readValue(props?.participantName) === "";
  });
  const assert_profile_setup = assert(() =>
    findNodeById(subject[UI], "shared-note-profile-setup") !== undefined
  );
  const assert_embeddable_view = assert(() =>
    readValue(
      propsOf(findElement(subject[TILE_UI], "cf-code-editor"))?.["$value"],
    ) ===
      MARKDOWN
  );
  const action_error = action(() =>
    fireEvent(findElement(subject[UI], "cf-code-editor"), "oncf-error", {
      detail: { message: "Connection refused" },
    })
  );
  const assert_error_visible = assert(() =>
    hasText(subject[UI], "Connection refused") && subject.content === MARKDOWN
  );
  const action_reconcile = action(() =>
    fireEvent(
      findElement(subject[UI], "cf-code-editor"),
      "oncf-collaboration-reconcile",
      {
        detail: { localValue: "My unsent text", canonicalValue: MARKDOWN },
      },
    )
  );
  const assert_recovery_visible = assert(() =>
    readValue(
        propsOf(findNodeById(subject[UI], "shared-note-recovery"))?.value,
      ) ===
      "My unsent text" && subject.content === MARKDOWN
  );
  return {
    [TESTS]: [
      { assertion: assert_imported_content },
      { assertion: assert_collaborative_editor },
      { assertion: assert_profile_setup },
      { assertion: assert_embeddable_view },
      { action: action_error },
      { assertion: assert_error_visible },
      { action: action_reconcile },
      { assertion: assert_recovery_visible },
    ],
    subject,
  };
});
