/**
 * Test Pattern: Annotation
 *
 * An annotation finds the pieces it can point at through the #mentionable wish
 * and the annotations it can be blocked by through the #annotation wish. The
 * test puts two small pieces in the space's mentionable list and favorites
 * them in the home space as annotations, then drives every control the view
 * binds: the kind and status selectors, the resolve shortcut, the content
 * field, the target picker with its search, and the blocker picker with its
 * search.
 */
import { action, assert, NAME, pattern, TESTS, UI, wish } from "commonfabric";
import type { Writable } from "commonfabric";
import Annotation from "./annotation.tsx";
import {
  clickButton,
  findElement,
  findElements,
  findNode,
  findNodeByProp,
  findNodes,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  isButton,
  isElement,
  propValue,
  textContent,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";

interface HomeDefault {
  favorites: { cell: unknown; tags: string[] }[];
  backlinksIndex: { mentionable: unknown[] };
}

/** A piece to point at or be blocked by: a name and some content, and no
 * view, so that reading the annotation's view does not walk another one. */
const Piece = pattern<
  { name: string; content: string },
  { [NAME]: string; content: string }
>(({ name, content }) => ({ [NAME]: name, content }));

const TARGET_SEARCH = "Search for a piece to annotate...";
const BLOCKER_SEARCH = "Search annotations...";

/** The innermost stack holding the input whose placeholder is `placeholder`
 * and the list of choices under it. */
const picker = (ui: unknown, placeholder: string): unknown =>
  innermostNode(
    ui,
    (node) =>
      isElement(node, "cf-vstack") &&
      findNodeByProp(node, "placeholder", placeholder) !== undefined &&
      findElement(node, "button") !== undefined,
  );

/** The labels of the choices `root` offers. */
const choices = (root: unknown): string[] =>
  findElements(root, "button").map((node) => textContent(node).trim());

/** Picks `value` in the `index`th selector, or reports a change that names
 * no value when there is none. */
const choose = (ui: unknown, index: number, value?: string): void =>
  fireEvent(
    findElements(ui, "select")[index],
    "onChange",
    value === undefined ? {} : { target: { value } },
    "a selector",
  );

/** The value of the option the `index`th selector shows as selected. */
const selected = (ui: unknown, index: number): unknown => {
  const option = findNode(
    findElements(ui, "select")[index],
    (node) => isElement(node, "option") && propValue(node, "selected") === true,
  );
  return propValue(option, "value");
};

/** The rows of the current blockers: each holds a link and a Remove. */
const blockerRows = (ui: unknown): unknown[] =>
  findNodes(
    ui,
    (node) =>
      isElement(node, "cf-hstack") && propValue(node, "key") !== undefined &&
      findElement(node, "cf-cell-link") !== undefined &&
      findNode(node, isButton("Remove")) !== undefined,
  );

export default pattern(() => {
  const review = Piece({ name: "📌 Design review", content: "Look it over" });
  const ship = Piece({ name: "✨ Ship it", content: "Release" });
  const subject = Annotation({
    content: "Fix the login bug",
    kind: "todo",
    status: "open",
    targetPiece: null,
    blockedBy: [],
    isAnnotation: true,
    isHidden: false,
  });
  const home = wish<Writable<HomeDefault>>({ query: "#default" }).result!;

  // ===== Initial state =====

  const assert_named_for_kind_and_content = assert(() =>
    subject[NAME] === "☐ Fix the login bug"
  );
  const assert_starts_open_and_unlinked = assert(() =>
    subject.status === "open" && subject.isAnnotation === true &&
    subject.targetPiece === null && subject.blockedBy.length === 0 &&
    subject.mentioned.length === 0
  );
  const assert_selectors_show_state = assert(() =>
    selected(subject[UI], 0) === "todo" && selected(subject[UI], 1) === "open"
  );
  const assert_offers_resolve = assert(() =>
    findNode(subject[UI], isButton("Mark resolved")) !== undefined
  );
  const assert_nothing_to_pick = assert(() =>
    choices(subject[UI]).length === 0
  );

  // ===== Choosing a target =====

  const action_seed_space = action(() => {
    home.key("backlinksIndex").key("mentionable").set([review, ship]);
    home.key("favorites").set([
      { cell: review, tags: ["annotation"] },
      { cell: ship, tags: ["annotation"] },
    ]);
  });
  const assert_targets_offered = assert(() =>
    choices(picker(subject[UI], TARGET_SEARCH)).join("|") ===
      "📌 Design review|✨ Ship it"
  );

  const action_search_targets = action(() => {
    typeInto(subject[UI], TARGET_SEARCH, "SHIP");
  });
  const assert_targets_filtered = assert(() =>
    choices(picker(subject[UI], TARGET_SEARCH)).join("|") === "✨ Ship it"
  );

  const action_search_targets_no_match = action(() => {
    typeInto(subject[UI], TARGET_SEARCH, "nothing like this");
  });
  const assert_no_targets_match = assert(() =>
    choices(picker(subject[UI], TARGET_SEARCH)).length === 0
  );

  const action_pick_target = action(() => {
    clickButton(picker(subject[UI], TARGET_SEARCH), "✨ Ship it");
  });
  const assert_target_set = assert(() =>
    subject.targetPiece?.[NAME] === "✨ Ship it" &&
    subject.mentioned.length === 1 &&
    subject.mentioned[0]?.[NAME] === "✨ Ship it"
  );
  const assert_target_shown_with_remove = assert(() =>
    findElement(subject[UI], "cf-cell-link") !== undefined &&
    findNodeByProp(subject[UI], "placeholder", TARGET_SEARCH) === undefined &&
    findNode(subject[UI], isButton("Remove")) !== undefined
  );

  const action_clear_target = action(() => {
    clickButton(subject[UI], "Remove");
  });
  const assert_target_cleared = assert(() =>
    subject.targetPiece === null && subject.mentioned.length === 0
  );
  const assert_search_reset = assert(() =>
    propValue(
      findNodeByProp(subject[UI], "placeholder", TARGET_SEARCH),
      "$value",
    ) === ""
  );

  // ===== Blockers =====

  const assert_blocker_picker_hidden = assert(() =>
    findNodeByProp(subject[UI], "placeholder", BLOCKER_SEARCH) === undefined
  );

  const action_open_blocker_picker = action(() => {
    clickButton(subject[UI], "+ Add blocker");
  });
  const assert_blockers_offered = assert(() =>
    choices(picker(subject[UI], BLOCKER_SEARCH)).join("|") ===
      "📌 Design review|✨ Ship it"
  );

  const action_search_blockers = action(() => {
    typeInto(subject[UI], BLOCKER_SEARCH, "LOOK it");
  });
  const assert_blockers_filtered = assert(() =>
    choices(picker(subject[UI], BLOCKER_SEARCH)).join("|") ===
      "📌 Design review"
  );

  const action_add_review_blocker = action(() => {
    clickButton(picker(subject[UI], BLOCKER_SEARCH), "📌 Design review");
  });
  const assert_review_blocks = assert(() =>
    subject.blockedBy.length === 1 &&
    subject.blockedBy[0]?.[NAME] === "📌 Design review" &&
    blockerRows(subject[UI]).length === 1
  );
  const assert_added_blocker_not_offered = assert(() =>
    choices(picker(subject[UI], BLOCKER_SEARCH)).join("|") === "✨ Ship it"
  );

  const action_add_ship_blocker = action(() => {
    clickButton(picker(subject[UI], BLOCKER_SEARCH), "✨ Ship it");
  });
  const assert_both_block = assert(() =>
    subject.blockedBy.map((b) => b[NAME]).join("|") ===
      "📌 Design review|✨ Ship it" &&
    blockerRows(subject[UI]).length === 2
  );

  const action_remove_first_blocker = action(() => {
    fireClick(
      findNode(blockerRows(subject[UI])[0], isButton("Remove")),
      "the first blocker's Remove",
    );
  });
  const assert_only_ship_blocks = assert(() =>
    subject.blockedBy.map((b) => b[NAME]).join("|") === "✨ Ship it" &&
    blockerRows(subject[UI]).length === 1
  );

  const action_close_blocker_picker = action(() => {
    clickButton(subject[UI], "+ Add blocker");
  });

  // ===== Kind, status, and content =====

  const action_choose_wish = action(() => {
    choose(subject[UI], 0, "wish");
  });
  const assert_is_wish = assert(() =>
    subject.kind === "wish" && subject[NAME] === "✨ Fix the login bug" &&
    selected(subject[UI], 0) === "wish"
  );

  const action_choose_nothing = action(() => {
    choose(subject[UI], 0);
    choose(subject[UI], 1);
  });
  const assert_still_wish_and_open = assert(() =>
    subject.kind === "wish" && subject.status === "open"
  );

  const action_choose_in_progress = action(() => {
    choose(subject[UI], 1, "in-progress");
  });
  const assert_in_progress_still_resolvable = assert(() =>
    subject.status === "in-progress" &&
    selected(subject[UI], 1) === "in-progress" &&
    findNode(subject[UI], isButton("Mark resolved")) !== undefined
  );

  const action_mark_resolved = action(() => {
    clickButton(subject[UI], "Mark resolved");
  });
  const assert_resolved = assert(() =>
    subject.status === "resolved" &&
    findNode(subject[UI], isButton("Mark resolved")) === undefined &&
    findNode(
        subject[UI],
        (node) => isElement(node, "span") && hasText(node, "resolved"),
      ) !== undefined
  );

  const action_choose_dismissed = action(() => {
    choose(subject[UI], 1, "dismissed");
  });
  const assert_dismissed = assert(() =>
    subject.status === "dismissed" &&
    findNode(subject[UI], isButton("Mark resolved")) === undefined &&
    findNode(
        subject[UI],
        (node) => isElement(node, "span") && hasText(node, "dismissed"),
      ) !== undefined
  );

  const action_clear_content = action(() => {
    typeInto(subject[UI], "Annotation content...", "   ");
  });
  const assert_named_as_new = assert(() =>
    subject[NAME] === "✨ New annotation"
  );

  const action_choose_note = action(() => {
    choose(subject[UI], 0, "note");
  });
  const assert_named_as_note = assert(() =>
    subject[NAME] === "📌 New annotation"
  );

  return {
    [TESTS]: [
      { assertion: assert_named_for_kind_and_content },
      { assertion: assert_starts_open_and_unlinked },
      { assertion: assert_selectors_show_state },
      { assertion: assert_offers_resolve },
      { assertion: assert_nothing_to_pick },

      { action: action_seed_space },
      { assertion: assert_targets_offered },
      { action: action_search_targets },
      { assertion: assert_targets_filtered },
      { action: action_search_targets_no_match },
      { assertion: assert_no_targets_match },
      { action: action_search_targets },
      { action: action_pick_target },
      { assertion: assert_target_set },
      { assertion: assert_target_shown_with_remove },
      { action: action_clear_target },
      { assertion: assert_target_cleared },
      { assertion: assert_search_reset },

      { assertion: assert_blocker_picker_hidden },
      { action: action_open_blocker_picker },
      { assertion: assert_blockers_offered },
      { action: action_search_blockers },
      { assertion: assert_blockers_filtered },
      { action: action_add_review_blocker },
      { assertion: assert_review_blocks },
      { assertion: assert_added_blocker_not_offered },
      { action: action_add_ship_blocker },
      { assertion: assert_both_block },
      { action: action_remove_first_blocker },
      { assertion: assert_only_ship_blocks },
      { action: action_close_blocker_picker },
      { assertion: assert_blocker_picker_hidden },

      { action: action_choose_wish },
      { assertion: assert_is_wish },
      { action: action_choose_nothing },
      { assertion: assert_still_wish_and_open },
      { action: action_choose_in_progress },
      { assertion: assert_in_progress_still_resolvable },
      { action: action_mark_resolved },
      { assertion: assert_resolved },
      { action: action_choose_dismissed },
      { assertion: assert_dismissed },
      { action: action_clear_content },
      { assertion: assert_named_as_new },
      { action: action_choose_note },
      { assertion: assert_named_as_note },
    ],
    subject,
    review,
    ship,
    // Allows any console warning, as the runner offers no narrower
    // allowance. The one this test draws is the runtime's scoped-link
    // warning, once per pick: the test's space is its home space, so the
    // pickers' links are user scoped, and storing one in the annotation's
    // space-scoped target or blockers warns.
    allowConsoleWarnings: true,
  };
});
