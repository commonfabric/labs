/**
 * Test Pattern: Annotation Manager
 *
 * The manager lists every #annotation the wish finds. The test favorites four
 * stand-in annotations in the home space, one in each status, then walks the
 * filter tabs and presses each row's Resolve, Dismiss, and Reopen, checking the
 * annotation's own status and the counts and rows the view shows after each.
 * A render step follows each change, before the assertions that read it. The
 * wish waits for the favorited pieces' documents to load before it lists
 * them, and an assertion pulls its value once, so it can read the list from
 * before they loaded; a render step settles the view's computations, the
 * wish among them, until they converge, as a mounted view does.
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import type {
  AnnotationKind,
  AnnotationStatus,
} from "../annotation/annotation.tsx";
import AnnotationManager from "./annotation-manager.tsx";
import {
  findElements,
  findNode,
  findNodes,
  hasText,
  isButton,
  isElement,
  styleOf,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";

interface HomeDefault {
  favorites: { cell: unknown; tags: string[] }[];
}

/** A piece an annotation can point at. */
const Target = pattern<{ name: string }, { [NAME]: string }>(({ name }) => ({
  [NAME]: name,
}));

/** A stand-in for an annotation: the fields the manager reads, and no view,
 * so that reading the manager's view does not walk another one. */
const Note = pattern<
  {
    name: string;
    kind: AnnotationKind;
    status: Writable<AnnotationStatus>;
    targetPiece: { [NAME]: string } | null;
  },
  {
    [NAME]: string;
    kind: AnnotationKind;
    status: AnnotationStatus;
    targetPiece: { [NAME]: string } | null;
  }
>(({ name, kind, status, targetPiece }) => ({
  [NAME]: name,
  kind,
  status,
  targetPiece,
}));

/** The filter tab whose label starts with `label`. */
const tab = (ui: unknown, label: string): unknown =>
  findNode(
    ui,
    (node) =>
      isElement(node, "button") && textContent(node).startsWith(`${label} (`),
  );

/** The text of every filter tab, in order. */
const tabLabels = (ui: unknown): string =>
  findElements(ui, "button").map(textContent).join("|");

/** How many buttons labelled `label` the view shows. */
const countButtons = (ui: unknown, label: string): number =>
  findNodes(ui, isButton(label)).length;

export default pattern(() => {
  const home = wish<Writable<HomeDefault>>({ query: "#default" }).result!;
  const login = Target({ name: "Login page" });
  const open = Note({
    name: "Check copy",
    kind: "note",
    status: "open",
    targetPiece: login,
  });
  const working = Note({
    name: "Fix login",
    kind: "todo",
    status: "in-progress",
    targetPiece: null,
  });
  const resolved = Note({
    name: "Dark mode",
    kind: "wish",
    status: "resolved",
    targetPiece: null,
  });
  const dismissed = Note({
    name: "Old idea",
    kind: "note",
    status: "dismissed",
    targetPiece: null,
  });
  const manager = AnnotationManager({});

  // ===== No annotations =====

  const assert_empty = assert(() =>
    manager[NAME] === "🗂 Annotations (0 open)" &&
    hasText(manager[UI], "No open annotations.") &&
    tabLabels(manager[UI]) ===
      "Open (0)|In progress (0)|Resolved (0)|Dismissed (0)|All (0)"
  );

  // ===== One annotation in each status =====

  const action_favorite_notes = action(() => {
    home.key("favorites").set([
      { cell: open, tags: ["annotation"] },
      { cell: working, tags: ["annotation"] },
      { cell: resolved, tags: ["annotation"] },
      { cell: dismissed, tags: ["annotation"] },
    ]);
  });
  const assert_counted = assert(() =>
    manager[NAME] === "🗂 Annotations (1 open)" &&
    tabLabels(manager[UI]) ===
      "Open (1)|In progress (1)|Resolved (1)|Dismissed (1)|All (4)"
  );
  const assert_open_tab_selected = assert(() =>
    styleOf(tab(manager[UI], "Open"), "fontWeight") === "600" &&
    styleOf(tab(manager[UI], "Open"), "background") === "#1d4ed8" &&
    styleOf(tab(manager[UI], "Open"), "color") === "white" &&
    styleOf(tab(manager[UI], "All"), "fontWeight") === "400" &&
    styleOf(tab(manager[UI], "All"), "background") === "white" &&
    styleOf(tab(manager[UI], "All"), "color") === "#374151"
  );
  const assert_open_row_shown = assert(() =>
    !hasText(manager[UI], "No open annotations.") &&
    hasText(manager[UI], "📌") && hasText(manager[UI], "on:") &&
    findNode(
        manager[UI],
        (node) =>
          isElement(node, "span") && textContent(node) === "open" &&
          styleOf(node, "background") === "#dbeafe",
      ) !== undefined &&
    findNode(manager[UI], isButton("Resolve")) !== undefined &&
    findNode(manager[UI], isButton("Dismiss")) !== undefined &&
    findNode(manager[UI], isButton("Reopen")) === undefined
  );

  const assert_open_resolved = assert(() =>
    open.status === "resolved" &&
    manager[NAME] === "🗂 Annotations (0 open)" &&
    hasText(manager[UI], "No open annotations.")
  );

  const assert_resolved_listed = assert(() =>
    styleOf(tab(manager[UI], "Resolved"), "fontWeight") === "600" &&
    hasText(manager[UI], "📌") && hasText(manager[UI], "✨") &&
    !hasText(manager[UI], "☐") &&
    findNode(manager[UI], isButton("Resolve")) === undefined
  );

  const assert_wish_reopened = assert(() =>
    resolved.status === "open" &&
    manager[NAME] === "🗂 Annotations (1 open)" &&
    !hasText(manager[UI], "✨")
  );

  const assert_in_progress_listed = assert(() =>
    hasText(manager[UI], "☐") && hasText(manager[UI], "in-progress") &&
    findNode(manager[UI], isButton("Resolve")) !== undefined
  );

  const assert_todo_dismissed = assert(() =>
    working.status === "dismissed" &&
    hasText(manager[UI], "No in-progress annotations.")
  );

  const assert_all_listed = assert(() =>
    tabLabels(manager[UI]) ===
      "Open (1)|In progress (0)|Resolved (1)|Dismissed (2)|All (4)" &&
    countButtons(manager[UI], "Reopen") === 3 &&
    countButtons(manager[UI], "Resolve") === 1 &&
    !hasText(manager[UI], "annotations.")
  );

  return {
    [TESTS]: [
      { assertion: assert_empty },
      { action: action_favorite_notes },
      { render: manager[UI] },
      { assertion: assert_counted },
      { assertion: assert_open_tab_selected },
      { assertion: assert_open_row_shown },
      { press: manager[UI], control: "Resolve" },
      { render: manager[UI] },
      { assertion: assert_open_resolved },
      { press: manager[UI], control: "Resolved (2)" },
      { render: manager[UI] },
      { assertion: assert_resolved_listed },
      { press: manager[UI], control: "Reopen", within: "✨" },
      { render: manager[UI] },
      { assertion: assert_wish_reopened },
      { press: manager[UI], control: "In progress (1)" },
      { render: manager[UI] },
      { assertion: assert_in_progress_listed },
      { press: manager[UI], control: "Dismiss" },
      { render: manager[UI] },
      { assertion: assert_todo_dismissed },
      { press: manager[UI], control: "All (4)" },
      { render: manager[UI] },
      { assertion: assert_all_listed },
    ],
    manager,
  };
});
