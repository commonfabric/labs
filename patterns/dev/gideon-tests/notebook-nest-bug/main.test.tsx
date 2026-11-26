import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import type { MinimalPiece } from "../../../system/notes/schemas.tsx";
import {
  findElement,
  hasText,
  propValue,
} from "../../../tools/test-support/vnode-helpers.ts";
import NotebookNestBug from "./main.tsx";

/** The `display` style of the first `name` element in the view. */
const displayOf = (ui: unknown, name: string): unknown => {
  const style = propValue(findElement(ui, name), "style");
  return typeof style === "object" && style !== null && "display" in style
    ? style.display
    : undefined;
};

export default pattern(() => {
  const pieceRegistry = wish<Writable<MinimalPiece[]>>({
    query: "#pieceRegistry",
  }).result!;
  const subject = NotebookNestBug({});

  const action_create_nested_notebooks = action(() => {
    subject.requestCreate.send();
  });

  const assert_starts_empty = assert(() => pieceRegistry.get().length === 0);
  const assert_shows_idle_view = assert(() =>
    subject[NAME] === "Nest Bug Repro" &&
    hasText(subject[UI], "Nest Bug Repro idle") &&
    displayOf(subject[UI], "cf-button") === "inline-flex" &&
    displayOf(subject[UI], "cf-hstack") === "none" &&
    displayOf(subject[UI], "cf-card") === "none"
  );
  const assert_registers_complete_tree = assert(() =>
    pieceRegistry.get().length === 12
  );
  const assert_shows_done_view = assert(() =>
    hasText(subject[UI], "Nest Bug Repro done") &&
    displayOf(subject[UI], "cf-button") === "none" &&
    displayOf(subject[UI], "cf-hstack") === "none" &&
    displayOf(subject[UI], "cf-card") === "block"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { assertion: assert_shows_idle_view },
      { action: action_create_nested_notebooks },
      { assertion: assert_registers_complete_tree },
      { assertion: assert_shows_done_view },
    ],
    subject,
  };
});
