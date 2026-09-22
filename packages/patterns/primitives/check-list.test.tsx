/**
 * Tests CheckList: adding, toggling, removing, the counts, and that a
 * reference held across an edit still addresses its item.
 *
 * Run: deno task cf test packages/patterns/primitives/check-list.test.tsx
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { clickButton, textContent } from "../test/vnode-helpers.ts";

import CheckList from "./check-list.tsx";

export default pattern(() => {
  const list = CheckList({});
  const parentItems = new Writable.perSpace([
    { title: "Set table", done: false, quantity: 1 },
    { title: "Buy bread", done: false, quantity: 1 },
  ]);
  const seeded = CheckList({ items: parentItems });
  const external = CheckList({
    items: new Writable.perSpace([
      { title: "Passport", done: false, quantity: 1 },
      { title: "Tickets", done: false, quantity: 1 },
    ]),
  });
  // The held-reference sequence from the primitives contract: stash an item,
  // mutate the list through the atom, then operate via the stashed reference.
  const held = new Writable<{ title: string; done: boolean; quantity: number }>(
    { title: "", done: false, quantity: 1 },
  );

  const addPassport = action(() => list.addItem.send({ title: "Passport" }));
  const addSocks = action(() =>
    list.addItem.send({ title: "Socks", quantity: 6 })
  );
  const addBlank = action(() => list.addItem.send({ title: "   " }));
  const stashFirst = action(() => held.set(list.items[0]));
  const toggleHeld = action(() => list.toggleItem.send({ item: held.get() }));
  const removeHeld = action(() => list.removeItem.send({ item: held.get() }));
  const clearCompleted = action(() => list.clearCompleted.send());

  return {
    [TESTS]: [
      { assertion: assert(() => list.items.length === 0) },
      { assertion: assert(() => list.remainingCount === 0) },

      { action: addPassport },
      { action: addSocks },
      { assertion: assert(() => list.items.length === 2) },
      { assertion: assert(() => list.remainingCount === 2) },
      { assertion: assert(() => list.completedCount === 0) },
      // A quantity the caller gave, and the default for one it did not.
      { assertion: assert(() => list.items[0].quantity === 1) },
      { assertion: assert(() => list.items[1].quantity === 6) },

      // An item with no title is not something anyone can tick off.
      { action: addBlank },
      { assertion: assert(() => list.items.length === 2) },

      { action: stashFirst },
      { action: toggleHeld },
      { assertion: assert(() => list.items[0].done === true) },
      { assertion: assert(() => list.remainingCount === 1) },
      { assertion: assert(() => list.completedCount === 1) },
      {
        assertion: assert(() => list.summary === "done: Passport, open: Socks"),
      },

      // Toggling writes through the element's cell rather than replacing the
      // slot, so the reference stashed before the edit still matches.
      { action: toggleHeld },
      { assertion: assert(() => list.items[0].done === false) },
      { action: toggleHeld },
      { assertion: assert(() => list.completedCount === 1) },

      { action: clearCompleted },
      { assertion: assert(() => list.items.length === 1) },
      { assertion: assert(() => list.items[0].title === "Socks") },

      { action: stashFirst },
      { action: removeHeld },
      { assertion: assert(() => list.items.length === 0) },

      // The default UI's own controls, reached through the rendered tree.
      { action: action(() => list.addItem.send({ title: "Boots" })) },
      {
        assertion: assert(() =>
          textContent(list[UI]).includes("1 left, 0 done")
        ),
      },
      { assertion: assert(() => list[NAME] === "Checklist (1 left)") },
      { action: action(() => clickButton(list[UI], "Remove")) },
      { assertion: assert(() => list.items.length === 0) },

      // The Add button reads the draft field; with nothing typed it adds
      // nothing rather than an untitled row.
      { action: action(() => clickButton(list[UI], "Add")) },
      { assertion: assert(() => list.items.length === 0) },

      // Constructor-seeded rows retain their parent's slot identity.
      { render: seeded[UI] },
      { assertion: assert(() => parentItems.get().length === 2) },
      { action: action(() => clickButton(seeded[UI], "Remove")) },
      { assertion: assert(() => parentItems.get().length === 1) },
      { assertion: assert(() => parentItems.get()[0].title === "Buy bread") },
      { assertion: assert(() => seeded.remainingCount === 1) },
      {
        action: action(() =>
          external.removeItem.send({ item: external.items[0] })
        ),
      },
      { assertion: assert(() => external.items.length === 1) },
      { assertion: assert(() => external.items[0].title === "Tickets") },
    ],
  };
});
