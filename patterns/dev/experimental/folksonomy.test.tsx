/**
 * Test Pattern: the folksonomy patterns
 *
 * Folksonomy is tagging shared across patterns by scope: two items given the
 * same scope see each other's tags, and an item in a different scope does not.
 * The tags pattern is the per-item editor, the demo wires three items into two
 * scopes to show the sharing, and the stress test builds many tagged items at
 * once.
 *
 * What this checks is the wiring: each item's tags reach the demo's output
 * from the cell they were written to, and a tag added to one item arrives at
 * that item and at neither of the others. Every read goes through the pattern
 * rather than through the cell the test holds, so it is the demo's projection
 * being checked and not the test's own array.
 *
 * Cross-scope sharing — item A and B seeing each other's tags, item C not — is
 * not checked here. That routing runs through an aggregator the tags pattern
 * discovers with a wish, which resolves to nothing in an empty space, so there
 * is no sharing to observe.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { textContent } from "../../tools/test-support/vnode-helpers.ts";
import FolksonomyDemo from "./folksonomy-demo.tsx";
import FolksonomyStressTest from "./folksonomy-stress-test.tsx";
import FolksonomyTags from "./folksonomy-tags.tsx";

export default pattern(() => {
  const scope = new Writable("demo-shared");
  const tags = new Writable<string[]>(["red", "blue"]);
  const tagEditor = FolksonomyTags({ scope, tags });

  const itemATags = new Writable<string[]>(["shared-a"]);
  const itemBTags = new Writable<string[]>(["shared-b"]);
  const itemCTags = new Writable<string[]>(["isolated-c"]);
  const demo = FolksonomyDemo({
    itemATags,
    itemBTags,
    itemCTags,
    customScope: "demo-shared",
  });

  const stressTest = FolksonomyStressTest({});

  const action_tag_item_a = action(() => {
    itemATags.push("late-arrival");
  });

  const assert_editor_holds_its_tags = assert(() =>
    tagEditor.tags.length === 2 && tagEditor.tags[0] === "red" &&
    scope.get() === "demo-shared" &&
    tagEditor[UI] != null
  );

  // Each item's tags reach the demo's output from its own cell.
  const assert_demo_items_keep_their_tags = assert(() =>
    demo.itemATags.length === 1 && demo.itemATags[0] === "shared-a" &&
    demo.itemBTags.length === 1 && demo.itemBTags[0] === "shared-b" &&
    demo.itemCTags.length === 1 && demo.itemCTags[0] === "isolated-c" &&
    demo[UI] != null
  );

  // A tag added to one item lands on that item and nowhere else.
  const assert_new_tag_lands_on_item_a = assert(() =>
    demo.itemATags.length === 2 &&
    demo.itemATags[1] === "late-arrival" &&
    demo.itemBTags.length === 1 &&
    demo.itemCTags.length === 1
  );

  const assert_stress_test_builds = assert(() =>
    textContent(stressTest[UI]).length > 0
  );

  return {
    [TESTS]: [
      { assertion: assert_editor_holds_its_tags },
      { assertion: assert_demo_items_keep_their_tags },
      { assertion: assert_stress_test_builds },

      { action: action_tag_item_a },
      { assertion: assert_new_tag_lands_on_item_a },
    ],
  };
});
