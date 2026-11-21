/**
 * Test: the cell-link fixture names itself from its title and links a note.
 *
 * The fixture builds a note and hands the whole instance to `cf-cell-link`
 * through `$cell`, which is the binding it exists to exercise. The test checks
 * the name the title sets and that the link is bound to that note, read back
 * through the bound cell.
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import CellLink from "./cell-link.tsx";

export default pattern(() => {
  const titled = CellLink({ title: "Linked Note" });

  const assert_title_names_it = assert(() => titled[NAME] === "Linked Note");

  const assert_heading_renders = assert(() =>
    hasText(titled[UI], "cf-cell-link test")
  );

  const assert_link_bound_to_note = assert(() => {
    const linked = propValue(findElement(titled[UI], "cf-cell-link"), "$cell");
    return typeof linked === "object" && linked !== null &&
      "title" in linked && linked.title === "Demo";
  });

  return {
    [TESTS]: [
      { assertion: assert_title_names_it },
      { assertion: assert_heading_renders },
      { assertion: assert_link_bound_to_note },
    ],
  };
});
