/**
 * Test Pattern: component catalog
 *
 * The catalog is a browser for the component stories: a sidebar of categories
 * down one side, the selected story rendered beside it, and that story's
 * controls panel underneath. Picking an item in the sidebar changes which
 * story is shown.
 *
 * This drives that loop. It starts the catalog on its default story, walks the
 * rendered tree to a sidebar item, sends its click stream, and checks the
 * selection moved and the newly shown story is the one that was picked. It
 * also collapses and reopens the sidebar, since the catalog swaps the whole
 * sidebar for a single reopen button while it is collapsed. And it checks the
 * sidebar and the story renderer agree: every item listed opens a story, and
 * every story is listed.
 */
import {
  action,
  assert,
  computed,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElement,
  findNode,
  hasExactText,
  hasText,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import Catalog from "./catalog.tsx";
import { storyIds } from "./ui/story-renderer.tsx";

type ClickStream = { send: (event: Record<string, never>) => void };

// Click the clickable node whose own text is exactly `text`. Matching the
// whole text rather than a substring picks the row itself out of the tree
// rather than one of the containers that also carries the row's text.
function click(root: unknown, text: string): void {
  const node = findNode(
    root,
    (candidate) =>
      propsOf(candidate)?.onClick !== undefined &&
      hasExactText(candidate, text),
  );
  const onClick = propsOf(node)?.onClick;
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as ClickStream).send({});
  }
}

export default pattern(() => {
  const selectedStory = new Writable<string>("button");
  const catalog = Catalog({ selectedStory });

  // Which story the pane is showing, read off the component the story builds
  // its example from.
  const showing = computed(() => {
    if (findElement(catalog[UI], "cf-badge") != null) return "badge";
    if (findElement(catalog[UI], "cf-chart") != null) return "chart";
    if (findElement(catalog[UI], "cf-hover-reveal") != null) {
      return "hover-reveal";
    }
    if (findElement(catalog[UI], "cf-hover-card") != null) {
      return "hover-card";
    }
    if (findElement(catalog[UI], "cf-button") != null) return "button";
    return "none";
  });

  const action_pick_badge = action(() => {
    click(catalog[UI], "Badge");
  });

  const action_pick_chart = action(() => {
    click(catalog[UI], "Chart");
  });

  const action_pick_hover_reveal = action(() => {
    click(catalog[UI], "Hover Reveal");
  });

  const action_pick_hover_card = action(() => {
    click(catalog[UI], "Hover Card");
  });

  // The catalog collapses its sidebar when a story is picked, so reopening it
  // is part of picking a second one.
  const action_reopen_sidebar = action(() => {
    const reopen = findElement(catalog[UI], "cf-button");
    const onClick = propsOf(reopen)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as ClickStream).send({});
    }
  });

  const assert_catalog_named = assert(() =>
    catalog[NAME] === "Component Catalog"
  );

  // The sidebar lists every category it was given, so its headings are in the
  // rendered tree from the start.
  const assert_sidebar_lists_categories = assert(() =>
    hasText(catalog[UI], "Inputs") &&
    hasText(catalog[UI], "Layout") &&
    hasText(catalog[UI], "Overview")
  );

  const listedIds = computed(() =>
    catalog.categories.flatMap((category) =>
      category.items.map((item) => item.id)
    )
  );
  const assert_every_listed_item_has_a_story = assert(() =>
    listedIds.filter((id) => !storyIds().includes(id)).join(", ") === ""
  );
  const assert_every_story_is_listed = assert(() =>
    storyIds().filter((id) => !listedIds.includes(id)).join(", ") ===
      ""
  );

  const assert_starts_on_button = assert(() =>
    catalog.selectedStory === "button" && showing === "button"
  );

  // The badge shows the badge story's own label, not the label cell of the
  // story shown before it.
  const assert_shows_badge = assert(() =>
    catalog.selectedStory === "badge" && showing === "badge" &&
    hasExactText(findElement(catalog[UI], "cf-badge"), "Badge")
  );

  const assert_shows_chart = assert(() =>
    catalog.selectedStory === "chart" && showing === "chart"
  );
  const assert_shows_hover_reveal = assert(() =>
    catalog.selectedStory === "hover-reveal" && showing === "hover-reveal"
  );
  const assert_shows_hover_card = assert(() =>
    catalog.selectedStory === "hover-card" && showing === "hover-card"
  );

  // Picking a story collapses the sidebar, so the category headings go away
  // and the reopen button takes their place.
  const assert_sidebar_collapsed = assert(() =>
    !hasText(catalog[UI], "Inputs")
  );

  const assert_sidebar_reopened = assert(() => hasText(catalog[UI], "Inputs"));

  return {
    [TESTS]: [
      { assertion: assert_catalog_named },
      { assertion: assert_sidebar_lists_categories },
      { assertion: assert_every_listed_item_has_a_story },
      { assertion: assert_every_story_is_listed },
      { assertion: assert_starts_on_button },

      { action: action_pick_badge },
      { assertion: assert_shows_badge },
      { assertion: assert_sidebar_collapsed },

      { action: action_reopen_sidebar },
      { assertion: assert_sidebar_reopened },

      { action: action_pick_chart },
      { assertion: assert_shows_chart },

      { action: action_reopen_sidebar },
      { action: action_pick_hover_reveal },
      { assertion: assert_shows_hover_reveal },

      { action: action_reopen_sidebar },
      { action: action_pick_hover_card },
      { assertion: assert_shows_hover_card },
    ],
    catalog,
  };
});
