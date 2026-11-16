import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  countElements,
  findElement,
  findNodeByProp,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Aside from "./aside.tsx";

export default pattern(() => {
  const instance = Aside({});

  const assert_names_itself = assert(() => instance[NAME] === "Aside");
  const assert_header_and_footer_fill_their_slots = assert(() =>
    hasText(findNodeByProp(instance[UI], "slot", "header"), "Header Section") &&
    hasText(findNodeByProp(instance[UI], "slot", "footer"), "Footer Section")
  );
  // The layout names one tab per main panel, and both sidebars sit beside
  // the panels rather than among them. A view read does not descend into an
  // array prop's elements, so the tab names are counted rather than read.
  const assert_layout_has_two_tabs_and_two_sidebars = assert(() => {
    const layout = findElement(instance[UI], "cf-autolayout");
    const tabNames = propValue(layout, "tabNames");
    return Array.isArray(tabNames) && tabNames.length === 2 &&
      hasText(layout, "Main Content Area") &&
      hasText(layout, "Second Content Area") &&
      hasText(findNodeByProp(layout, "slot", "left"), "Left Sidebar") &&
      hasText(findNodeByProp(layout, "slot", "right"), "Right Sidebar") &&
      countElements(layout, "aside") === 2;
  });
  const assert_every_area_has_its_button = assert(() =>
    countElements(instance[UI], "cf-button") === 4 &&
    hasText(instance[UI], "Left Button") &&
    hasText(instance[UI], "Main Button") &&
    hasText(instance[UI], "Second Button") &&
    hasText(instance[UI], "Right Button")
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_header_and_footer_fill_their_slots },
      { assertion: assert_layout_has_two_tabs_and_two_sidebars },
      { assertion: assert_every_area_has_its_button },
    ],
    instance,
  };
});
