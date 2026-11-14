import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  fireEvent,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import TagsDemo from "./cf-tags.tsx";

// What `cf-tags` reports when its tag list changes.
const changeTags = (root: unknown, tags: string[]): void =>
  fireEvent(
    findElement(root, "cf-tags"),
    "oncf-change",
    { detail: { tags } },
    "the tag editor",
  );

export default pattern(() => {
  const subject = TagsDemo({ tags: ["red"] });

  const action_add_tags = action(() =>
    changeTags(subject[UI], ["red", "green", "blue"])
  );
  const action_clear_tags = action(() => changeTags(subject[UI], []));

  const assert_starts_with_seed = assert(() =>
    subject.tags.join(",") === "red"
  );
  const assert_edit_is_stored = assert(() =>
    subject.tags.join(",") === "red,green,blue"
  );
  const assert_editor_shows_edit = assert(() => {
    const shown = propValue(findElement(subject[UI], "cf-tags"), "tags");
    return Array.isArray(shown) && shown.join(",") === "red,green,blue";
  });
  const assert_cleared = assert(() => subject.tags.length === 0);

  return {
    [TESTS]: [
      { assertion: assert_starts_with_seed },
      { action: action_add_tags },
      { assertion: assert_edit_is_stored },
      { assertion: assert_editor_shows_edit },
      { action: action_clear_tags },
      { assertion: assert_cleared },
    ],
    subject,
  };
});
