/**
 * Test Pattern: the cf-toast story
 *
 * Each button in the story opens one toast, and each toast closes itself
 * through its dismiss event. This presses every button and checks that it
 * opens its own toast and no other, then dismisses every toast and checks
 * they all close.
 *
 * Run: deno task cf test patterns/dev/catalog/stories/cf-toast-story.test.tsx --root patterns
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  childNodes,
  clickButton,
  findElement,
  fireEvent,
  propValue,
  textContent,
} from "../../../tools/test-support/vnode-helpers.ts";
import ToastStory from "./cf-toast-story.tsx";

/** Each toast's opening words, in the order the story lists them. */
const TOASTS = [
  "This is",
  "Changes saved",
  "Connection lost",
  "Storage",
  "Wish",
];

/** The toasts under the story's provider. */
const toasts = (ui: unknown): unknown[] =>
  childNodes(findElement(ui, "cf-toast-provider"));

/** The opening words of every open toast. */
const openToasts = (ui: unknown): string[] =>
  toasts(ui).filter((toast) => propValue(toast, "open") === true).map((
    toast,
  ) => TOASTS.find((words) => textContent(toast).trim().startsWith(words)))
    .filter((words) => words !== undefined);

export default pattern(() => {
  const story = ToastStory({});

  const action_open_default = action(() => clickButton(story[UI], "Default"));
  const action_open_rest = action(() => {
    clickButton(story[UI], "Success");
    clickButton(story[UI], "Error");
    clickButton(story[UI], "Warning");
    clickButton(story[UI], "With Action");
  });
  const action_dismiss_all = action(() => {
    for (const toast of toasts(story[UI])) {
      fireEvent(toast, "oncf-toast-dismiss", {}, "a toast");
    }
  });

  const assert_starts_closed = assert(() =>
    story[NAME] === "cf-toast Story" && toasts(story[UI]).length === 5 &&
    openToasts(story[UI]).length === 0
  );
  const assert_default_opens_alone = assert(() => {
    const open = openToasts(story[UI]);
    return open.length === 1 && open[0] === "This is";
  });
  const assert_every_toast_opens = assert(() =>
    openToasts(story[UI]).join("|") === TOASTS.join("|")
  );
  const assert_dismiss_closes_all = assert(() =>
    openToasts(story[UI]).length === 0
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_closed },
      { action: action_open_default },
      { assertion: assert_default_opens_alone },
      { action: action_open_rest },
      { assertion: assert_every_toast_opens },
      { action: action_dismiss_all },
      { assertion: assert_dismiss_closes_all },
    ],
  };
});
