/**
 * What the exemplar's item actually RENDERS into its body editor: that the
 * board's mention universe reaches `$mentionable` populated, and that each
 * entry carries the two properties the completion needs — the display name
 * `cf-code-editor` declares as required, and the `shortName` a `#42` query
 * matches.
 *
 * This is the stage's headline wiring, and every other test in this directory
 * stops one step short of it: `board.test.tsx` proves the board PUBLISHES the
 * universe, and the item's own render assertions predate the universe
 * entirely. A row projection that dropped `shortName`, or an item that stopped
 * binding `$mentionable` on its editor, leaves both of those green and the `#`
 * trigger dead.
 *
 * WHAT THIS CANNOT CATCH, two things, and the second is why the member below
 * is composed rather than taken off the board. A pattern test sees the cell,
 * not the component's schema-filtered view of it, so narrowing the universe to
 * a projection the component would reject still reads whole here; only a
 * browser test crosses that boundary, which is the gap
 * `topics/render-shape.test.tsx` records after walking into it. And
 * `addItem`'s own argument list is out of reach: a created item is published
 * through the board's row demand, which carries no `[UI]` and no verbs, so
 * nothing here can open the editor of an item the board built. The member
 * below is composed with the universe `addItem` passes it, which holds the
 * item's side of that contract and leaves the board's side to review.
 *
 * Deliberately its own file, as the Topics one is: it touches the board's
 * create verb and nothing else, so it keeps compiling while a demand-narrowing
 * change is in flight — which is exactly when a render contract needs
 * guarding.
 */

import {
  action,
  assert,
  Default,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElement, propValue, readValue } from "../test/vnode-helpers.ts";
import Board from "./board.tsx";
import type { ItemDemand } from "./board.tsx";
import Item from "./item.tsx";
import type { NamesMap } from "./naming.ts";

export default pattern(() => {
  const items = new Writable<ItemDemand[] | Default<[]>>([]);
  const names = new Writable<NamesMap>({});
  const board = Board({ items, names });

  // Two members, so an entry carrying a name proves the universe reached the
  // editor rather than that the editor found the item it belongs to.
  const action_file_two = action(() => {
    board.addItem.send({ title: "First item", agentName: "Sol" });
    board.addItem.send({ title: "Second item", agentName: "Sol" });
  });

  // Composed the way `addItem` composes one, so what is under test is the
  // wiring the board hands a member and not this test's own arrangement.
  const viewer = Item({
    title: "Viewer",
    body: "",
    mentionable: board.mentionable,
  });
  // Through the verb that opens it, which is the only route in.
  const action_open_the_editor = action(() => {
    viewer.startEditBody.send();
  });

  const assert_editor_receives_the_universe = assert(() => {
    const editor = findElement(viewer[UI], "cf-code-editor");
    if (editor === undefined) return false;
    const entries = propValue(editor, "$mentionable");
    if (!Array.isArray(entries) || entries.length !== 2) return false;
    return entries.every((entry) => {
      const row = readValue(entry) as Record<PropertyKey, unknown> | undefined;
      const name = readValue(row?.[NAME]);
      const shortName = readValue(row?.shortName);
      return typeof name === "string" && name.length > 0 &&
        typeof shortName === "string" && shortName.length > 0;
    });
  });

  // The names the board allocated, in the rows an editor completes over: a
  // universe that arrived but carried no numbers offers nothing to `#42`.
  const assert_entries_carry_the_allocated_names = assert(() => {
    const editor = findElement(viewer[UI], "cf-code-editor");
    const entries = propValue(editor, "$mentionable");
    if (!Array.isArray(entries)) return false;
    return entries
      .map((entry) =>
        readValue(
          (readValue(entry) as Record<PropertyKey, unknown>)?.shortName,
        )
      )
      .join(",") === "1,2";
  });

  // The editor is not rendered until the body is being edited, so the
  // assertions above would pass vacuously on a tree that never opened one.
  const assert_no_editor_before_editing = assert(() =>
    findElement(viewer[UI], "cf-code-editor") === undefined
  );

  return {
    [TESTS]: [
      { action: action_file_two },
      { render: viewer[UI] },
      { assertion: assert_no_editor_before_editing },
      { action: action_open_the_editor },
      { render: viewer[UI] },
      { assertion: assert_editor_receives_the_universe },
      { assertion: assert_entries_carry_the_allocated_names },
    ],
  };
});
