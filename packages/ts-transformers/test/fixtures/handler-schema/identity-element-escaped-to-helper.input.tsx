import { handler, Writable } from "commonfabric";

interface Panel {
  name: string;
}

function holdsName(list: readonly Writable<Panel>[], name: string): boolean {
  return list.some((panel) => panel.get().name === name);
}

const addPanel = handler<
  { panel: Writable<Panel>; name: string },
  { panels: Writable<Writable<Panel>[]> }
>(({ panel, name }, { panels }) => {
  const list = panels.get();
  if (list.some((existing) => existing.equals(panel))) return;
  if (holdsName(list, name)) return;
  panels.set([...list, panel]);
});

// FIXTURE: identity-element-escaped-to-helper
// Verifies: elements compared with `equals` keep their full schema when the
// list also leaves whole for a helper with no summary, which may read them;
// they are not narrowed to comparable cells as elements only compared are.
export { addPanel };
