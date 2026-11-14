/**
 * Test Pattern: Mobile App Demo
 *
 * Reads each tab's surface, and drives the new-task sheet and the toast it
 * raises through the rendered view.
 *
 * Run: deno task cf test patterns/examples/mobile-app-demo/mobile-app-demo.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElement,
  findNodeByProp,
  fireEvent,
  hasText,
  propValue,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import MobileAppDemo from "./mobile-app-demo.tsx";

const sheetOpen = (root: unknown): unknown =>
  propValue(findElement(root, "cf-modal"), "$open");

const toastOpen = (root: unknown): unknown =>
  propValue(findElement(root, "cf-toast"), "open");

const tabBar = (root: unknown): unknown => findElement(root, "cf-tab-bar");

/** Selects `tab` in the tab bar by writing the cell the bar binds as its
 * `$value`, as tapping that tab does. */
const selectTab = (root: unknown, tab: string): void =>
  setBound(tabBar(root), "$value", tab, "the tab bar");

const headingText = (root: unknown): unknown =>
  findElement(findElement(root, "cf-vscroll"), "cf-heading");

// The home surface: its greeting, every task under its section, the
// shortcuts and artifacts, and each task's action chip colored by its tone.
const showsHome = (root: unknown): boolean =>
  hasText(headingText(root), "Good evening.") &&
  hasText(root, "Last woven just now") &&
  hasText(root, "Schedule an appointment with a vet specializing in GI") &&
  hasText(root, "Triage the latest partner threads before tomorrow morning") &&
  hasText(root, "about Fabric") && hasText(root, "Workspace map") &&
  propValue(findNodeByProp(root, "label", "Review"), "color") === "primary" &&
  propValue(findNodeByProp(root, "label", "Launch"), "color") === "accent" &&
  propValue(findNodeByProp(root, "label", "Start"), "color") === "neutral";

export default pattern(() => {
  const demo = MobileAppDemo({});

  const assert_named = assert(() => demo[NAME] === "Mobile App Demo");
  const assert_home = assert(() =>
    showsHome(demo[UI]) &&
    propValue(tabBar(demo[UI]), "$value") === "home"
  );

  const action_inbox = action(() => selectTab(demo[UI], "inbox"));
  const assert_inbox = assert(() =>
    hasText(headingText(demo[UI]), "Inbox") &&
    hasText(demo[UI], "Design review moved to Friday") &&
    hasText(demo[UI], "From: Chris") && hasText(demo[UI], "Yesterday") &&
    !hasText(demo[UI], "Good evening.")
  );

  const action_search = action(() => selectTab(demo[UI], "search"));
  const assert_search = assert(() =>
    hasText(headingText(demo[UI]), "Search") &&
    hasText(demo[UI], "Pattern deploy notes") &&
    hasText(demo[UI], "12 results") &&
    !hasText(demo[UI], "Design review moved to Friday")
  );

  const action_profile = action(() => selectTab(demo[UI], "profile"));
  const assert_profile = assert(() =>
    hasText(headingText(demo[UI]), "Profile") &&
    hasText(demo[UI], "Notification preferences") &&
    hasText(demo[UI], "2 active") &&
    !hasText(demo[UI], "Pattern deploy notes")
  );

  const action_home = action(() => selectTab(demo[UI], "home"));
  const assert_back_home = assert(() =>
    showsHome(demo[UI]) && !hasText(demo[UI], "Notification preferences")
  );

  const assert_closed = assert(() =>
    sheetOpen(demo[UI]) === false && toastOpen(demo[UI]) === false
  );

  const action_open_sheet = action(() => clickButton(demo[UI], "＋"));
  const assert_sheet_open = assert(() =>
    sheetOpen(demo[UI]) === true && toastOpen(demo[UI]) === false
  );

  const action_cancel = action(() => clickButton(demo[UI], "Cancel"));
  const action_create = action(() => clickButton(demo[UI], "Create"));
  const assert_created = assert(() =>
    sheetOpen(demo[UI]) === false && toastOpen(demo[UI]) === true
  );

  const action_dismiss_toast = action(() =>
    fireEvent(
      findElement(demo[UI], "cf-toast"),
      "oncf-toast-dismiss",
      { type: "cf-toast-dismiss" },
      "the toast",
    )
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_home },
      { action: action_inbox },
      { assertion: assert_inbox },
      { action: action_search },
      { assertion: assert_search },
      { action: action_profile },
      { assertion: assert_profile },
      { action: action_home },
      { assertion: assert_back_home },
      { assertion: assert_closed },
      { action: action_open_sheet },
      { assertion: assert_sheet_open },
      // Cancel closes the sheet without creating anything.
      { action: action_cancel },
      { assertion: assert_closed },
      { action: action_open_sheet },
      { action: action_create },
      { assertion: assert_created },
      { action: action_dismiss_toast },
      { assertion: assert_closed },
    ],
    demo,
  };
});
