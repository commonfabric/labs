import {
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// Fixture for `drag-reorder-list.test.ts`: a list reordered by dragging one
// row onto another. Each row is a drop zone holding a drag source bound to
// the row, and a drop moves the dragged row to the target row's position. The
// handler finds both rows by name in the list as it stands, so the list's
// order after a drop says which row the drop event named as dragged.
//
// The rows are inline entries of a stored list, so `.map()` keeps each
// rendered row in its position while a reorder moves another entry into it,
// and resolving a row's cell lands on a snapshot of the entry's content. The
// handler writes back the entries it read, as a reorder that keeps every
// other field of a row does.

interface Row {
  name: string;
}

interface Input {
  rows: Writable<
    Row[] | Default<[{ name: "A" }, { name: "B" }, { name: "C" }]>
  >;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  rows: Row[];
  dragged: string[];
}

const moveRow = handler<
  { detail: { sourceCell: Writable<Row> } },
  { rows: Writable<Row[]>; target: Writable<Row>; dragged: Writable<string[]> }
>((event, { rows, target, dragged }) => {
  const sourceName = event.detail.sourceCell.get().name;
  const targetName = target.get().name;
  dragged.push(sourceName);
  const list = rows.get();
  const from = list.findIndex(({ name }) => name === sourceName);
  const to = list.findIndex(({ name }) => name === targetName);
  if (from < 0 || to < 0 || from === to) return;
  const rest = list.filter((_, i) => i !== from);
  rows.set([...rest.slice(0, to), list[from], ...rest.slice(to)]);
});

const DragReorderList = pattern<Input, Output>(({ rows }) => {
  const dragged = Writable.of<string[]>([]);
  return {
    [NAME]: "drag-reorder-list",
    [UI]: (
      <div style="display: flex; flex-direction: column; gap: 1rem; padding: 2rem; width: 20rem;">
        {rows.map((row) => (
          <cf-drop-zone
            accept="row"
            oncf-drop={moveRow({ rows, target: row, dragged })}
          >
            <cf-drag-source $cell={row} type="row">
              <div style="padding: 1rem; border: 1px solid #ccc;">
                {row.name}
              </div>
            </cf-drag-source>
          </cf-drop-zone>
        ))}
      </div>
    ),
    rows,
    dragged,
  };
});

export default DragReorderList;
