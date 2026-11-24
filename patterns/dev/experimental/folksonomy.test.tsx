/**
 * Test Pattern: the folksonomy patterns
 *
 * Folksonomy is tagging shared across patterns by scope: two items given the
 * same scope see each other's tags, and an item in a different scope does not.
 * The tags pattern is the per-item editor, the demo wires three items into two
 * scopes to show the sharing, and the stress test builds many tagged items at
 * once.
 *
 * What this checks is the demo's wiring: each item's tags reach the demo's
 * output from the cell they were written to, a tag added to one item arrives
 * at that item and at neither of the others, and the view names the shared
 * scope built from the custom scope name. Every read goes through the pattern
 * rather than through the cell the test holds, so it is the demo's projection
 * being checked and not the test's own array. The tag editor and the stress
 * test have tests of their own.
 *
 * Cross-scope sharing — item A and B seeing each other's tags, item C not — is
 * not checked here. That routing runs through an aggregator the tags pattern
 * discovers with a wish, which resolves to nothing in an empty space, so there
 * is no sharing to observe.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  hasText,
  innermostNode,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import FolksonomyDemo from "./folksonomy-demo.tsx";

export default pattern(() => {
  const itemATags = new Writable<string[]>(["shared-a"]);
  const itemBTags = new Writable<string[]>(["shared-b"]);
  const itemCTags = new Writable<string[]>(["isolated-c"]);
  const demo = FolksonomyDemo({
    itemATags,
    itemBTags,
    itemCTags,
    customScope: "pantry",
  });

  const action_tag_item_a = action(() => {
    itemATags.push("late-arrival");
  });

  // Each item's tags reach the demo's output from its own cell.
  const assert_demo_items_keep_their_tags = assert(() =>
    demo.itemATags.length === 1 && demo.itemATags[0] === "shared-a" &&
    demo.itemBTags.length === 1 && demo.itemBTags[0] === "shared-b" &&
    demo.itemCTags.length === 1 && demo.itemCTags[0] === "isolated-c"
  );

  // Items A and B share the scope named after the custom scope; item C keeps
  // its own.
  const assert_view_names_the_scopes = assert(() =>
    hasText(
      demo[UI],
      "Scope: https://github.com/commontools/folksonomy-demo/pantry",
    ) &&
    !hasText(demo[UI], "folksonomy-demo/demo-shared") &&
    hasText(demo[UI], "Scope: demo-isolated")
  );

  // With no aggregator in the space, the status banner says so in amber.
  const assert_view_reports_no_aggregator = assert(() => {
    const banner = innermostNode(
      demo[UI],
      (node) =>
        JSON.stringify(propValue(node, "style") ?? {}).includes('"border"') &&
        hasText(node, "Aggregator not found."),
    );
    return banner !== undefined &&
      JSON.stringify(propValue(banner, "style")).includes(
        '"border":"1px solid #fcd34d"',
      ) &&
      !hasText(demo[UI], "Connected to folksonomy-aggregator");
  });

  // A tag added to one item lands on that item and nowhere else.
  const assert_new_tag_lands_on_item_a = assert(() =>
    demo.itemATags.length === 2 &&
    demo.itemATags[1] === "late-arrival" &&
    demo.itemBTags.length === 1 &&
    demo.itemCTags.length === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_demo_items_keep_their_tags },
      { assertion: assert_view_names_the_scopes },
      { assertion: assert_view_reports_no_aggregator },

      { action: action_tag_item_a },
      { assertion: assert_new_tag_lands_on_item_a },
    ],
  };
});
