/**
 * Test: a per-user value read in a computed header block renders.
 *
 * The repro reads a `PerUser` input inside a `computed()` that sits in
 * `cf-screen`'s header slot, which once blanked the whole body. The test
 * checks the header shows the question and the value the computed read, and
 * that the body below it renders too, for an empty name and for a set one.
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeByProp,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import MinimalRepro from "./MINIMAL-REPRO.tsx";

export default pattern(() => {
  const unnamed = MinimalRepro({});
  const named = MinimalRepro({ question: "Lunch?", myName: "  Ada  " });

  const assert_named = assert(() => unnamed[NAME] === "ct1597-minimal-repro");

  const assert_header_reads_empty_name = assert(() =>
    hasText(findNodeByProp(unnamed[UI], "slot", "header"), 'me is: ""') &&
    hasText(
      findNodeByProp(unnamed[UI], "slot", "header"),
      "Where should we eat?",
    )
  );

  // The computed trims the name it reads, so the header shows it without the
  // padding it was given.
  const assert_header_reads_name = assert(() =>
    hasText(findNodeByProp(named[UI], "slot", "header"), 'me is: "Ada"') &&
    hasText(findNodeByProp(named[UI], "slot", "header"), "Lunch?")
  );

  const assert_body_renders = assert(() =>
    hasText(unnamed[UI], "(body") && hasText(named[UI], "(body")
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_header_reads_empty_name },
      { assertion: assert_header_reads_name },
      { assertion: assert_body_renders },
    ],
  };
});
