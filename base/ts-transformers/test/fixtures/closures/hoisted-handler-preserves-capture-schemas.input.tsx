import {
  action,
  NAME,
  pattern,
  SELF,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// `navigateTo` is a CommonFabric built-in for SPA navigation; importing
// it ensures it lives at module scope and the action bodies that
// reference it (a) compile and (b) close over a module-level symbol.
declare const navigateTo: (target: any) => any;

interface Item {
  id: number;
  label: string;
  [NAME]: string;
}

interface ListOutput {
  [NAME]: string;
  [UI]: VNode;
  read: any;
  write: any;
}

const Item = pattern<{ id: number; label: string }, Item>(
  ({ id, label }) => ({
    id,
    label,
    [NAME]: label,
  }),
);

// FIXTURE: hoisted-handler-preserves-capture-schemas (CT-1585 regression)
export default pattern<{ items: Writable<Item[]> }, ListOutput>(
  ({ items, [SELF]: self }) => {
    // `read` action: matches the shape of notebook.tsx's
    // `goToAllNotesAction` — reads `items.get()`, filters, conditionally
    // navigates. Triggers `items` to be classified `readonly` in this
    // action's captures schema.
    const read = action(() => {
      const pieces = items.get() ?? [];
      const existing = pieces.find((p) => {
        const n = p?.[NAME];
        return typeof n === "string" && n.startsWith("All ");
      });
      if (existing) {
        return navigateTo(existing);
      }
    });
    // `write` action: matches the shape of notebook.tsx's
    // `createNoteStreamAction` — pushes a new item, returns it. Should
    // get a schema with `items` classified `writeonly` (plus `self`).
    const write = action(
      (
        { label }: { label: string },
      ) => {
        const newItem = Item({ id: 0, label, parent: self } as any);
        items.push(newItem as any);
        return newItem;
      },
    );
    return {
      [NAME]: "List",
      [UI]: <button type="button" onClick={write}>Create</button>,
      read,
      write,
    };
  },
);
