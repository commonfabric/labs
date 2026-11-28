/**
 * Test: opening a row of a notebook records the notebook as the row's parent.
 *
 * A row's chip opens the note or notebook the row holds, and first records
 * this notebook as its `parentNotebook`, so the opened piece's "In:" chip leads
 * back here. The rows here hold a note filed elsewhere before, a note with no
 * parent, and a nested notebook with no parent; each open re-parents only the
 * row opened.
 *
 * A navigation is not observable from a pattern test, so these steps assert
 * the recorded parent and not where the click went.
 *
 * Run: deno task cf test patterns/system/notes/notebook-open.test.tsx --root patterns --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findNode,
  findNodeByProp,
  fireClick,
  isElement,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import Notebook from "./notebook.tsx";
import Note from "./note.tsx";

// Module scope: SES callbacks may not capture callables from enclosing
// function scopes.

/** The clickable wrapper around the chip labelled `label`, in its row. */
const openerOf = (root: unknown, label: string): unknown => {
  const row = findNode(
    root,
    (node) =>
      isElement(node, "tr") &&
      findNodeByProp(node, "label", label) !== undefined,
  );
  return findNode(
    row,
    (node) =>
      propsOf(node)?.onClick !== undefined &&
      findElement(node, "cf-chip") !== undefined,
  );
};

/** The title of the notebook a piece records as its parent, if any. */
const parentOf = (
  piece: { parentNotebook?: { title?: string } | null },
): string | undefined => piece.parentNotebook?.title ?? undefined;

export default pattern(() => {
  const elsewhere = Notebook({
    title: "Elsewhere",
    notes: [],
    isHidden: false,
  });
  const filed = Note({
    title: "Filed",
    content: "",
    isHidden: true,
    parentNotebook: elsewhere,
  });
  const loose = Note({ title: "Loose", content: "", isHidden: true });
  const nested = Notebook({ title: "Nested", notes: [], isHidden: true });
  const home = Notebook({
    title: "Home",
    notes: [filed, loose, nested],
    isHidden: false,
  });

  const assert_initial_parents = assert(() =>
    parentOf(filed) === "Elsewhere" && parentOf(loose) === undefined &&
    parentOf(nested) === undefined
  );

  const action_open_filed = action(() =>
    fireClick(openerOf(home[UI], "📝 Filed"), "Filed's chip")
  );
  const assert_filed_reparented = assert(() =>
    parentOf(filed) === "Home" && parentOf(loose) === undefined &&
    parentOf(nested) === undefined
  );

  const action_open_nested = action(() =>
    fireClick(openerOf(home[UI], "📓 Nested (0)"), "Nested's chip")
  );
  // The nested notebook's own view now shows the chip that leads back.
  const assert_nested_parented = assert(() =>
    parentOf(nested) === "Home" && parentOf(loose) === undefined &&
    findNodeByProp(nested[UI], "label", "📓 Home (3)") !== undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_parents },
      { action: action_open_filed },
      { assertion: assert_filed_reparented },
      { action: action_open_nested },
      { assertion: assert_nested_parented },
    ],
    home,
    // With server execution on, a navigation an action's event makes is a
    // cascade hop, which the client does not enact ahead of the server, and
    // the runtime warns `optimistic-navigate-skipped`.
    allowConsoleWarnings: true,
  };
});
