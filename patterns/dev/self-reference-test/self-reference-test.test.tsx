/**
 * Test: a node pattern hands its own instance to children and a registry.
 *
 * The fixture reads `[SELF]` and passes it as the parent of each child it
 * creates and as the entry it pushes into a shared registry. The test presses
 * both buttons and checks that what lands in each place is the node itself
 * rather than a copy of it, and that a node built with a parent links to it
 * where a root says it has none.
 */
import {
  action,
  assert,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  countElements,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import Node, { type TreeNode } from "./self-reference-test.tsx";

export default pattern(() => {
  const registry = new Writable<TreeNode[]>([]);
  const root = Node({ label: "Root", parent: null, registry });
  const leaf = Node({ label: "Leaf", parent: root, registry });

  const action_add_child = action(() => clickButton(root[UI], "Add Child"));
  const action_add_to_registry = action(() =>
    clickButton(root[UI], "Add to Registry")
  );

  const assert_root_starts_empty = assert(() =>
    root.children.length === 0 && registry.get().length === 0
  );
  const assert_root_has_no_parent = assert(() =>
    hasText(root[UI], "No parent")
  );

  // The leaf's parent is the root instance, so it renders a link where the
  // root renders its placeholder.
  const assert_leaf_links_parent = assert(() =>
    leaf.parent !== null && equals(leaf.parent, root) &&
    !hasText(leaf[UI], "No parent") &&
    countElements(leaf[UI], "cf-cell-link") === 1
  );

  const assert_child_points_back = assert(() =>
    root.children.length === 1 &&
    root.children[0].label === "Child" &&
    root.children[0].parent !== null && equals(root.children[0].parent, root)
  );
  const assert_child_link_renders = assert(() =>
    countElements(root[UI], "cf-cell-link") === 1
  );

  const assert_registry_holds_root = assert(() =>
    registry.get().length === 1 && equals(registry.get()[0], root)
  );
  const assert_registry_link_renders = assert(() =>
    countElements(root[UI], "cf-cell-link") === 2 &&
    countElements(leaf[UI], "cf-cell-link") === 2
  );

  return {
    [TESTS]: [
      { assertion: assert_root_starts_empty },
      { assertion: assert_root_has_no_parent },
      { assertion: assert_leaf_links_parent },

      { action: action_add_child },
      { assertion: assert_child_points_back },
      { assertion: assert_child_link_renders },

      { action: action_add_to_registry },
      { assertion: assert_registry_holds_root },
      { assertion: assert_registry_link_renders },
    ],
    root,
  };
});
