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

function keep(value: unknown): boolean {
  return value !== undefined;
}

type PanelEvent = { panel: Writable<Panel> };
type PanelState = { panels: Writable<Writable<Panel>[]> };

const addThroughFallback = handler<PanelEvent, PanelState>(
  ({ panel }, { panels }) => {
    const list = panels.get();
    if (list.some((existing) => existing.equals(panel))) return;
    if (keep(list ?? [])) return;
  },
);

const addThroughLocalHoldingRoot = handler<PanelEvent, PanelState>(
  (event, state) => {
    const list = state.panels.get();
    if (list.some((existing) => existing.equals(event.panel))) return;
    const box = { state };
    if (keep(box)) return;
  },
);

const addThroughRootFallback = handler<PanelEvent, PanelState>(
  (event, state) => {
    const list = state.panels.get();
    if (list.some((existing) => existing.equals(event.panel))) return;
    if (keep(state ?? undefined)) return;
  },
);

const addThroughArrayHoldingRoot = handler<PanelEvent, PanelState>(
  (event, state) => {
    const list = state.panels.get();
    if (list.some((existing) => existing.equals(event.panel))) return;
    if (keep([state])) return;
  },
);

// FIXTURE: identity-element-escaped-to-helper
// Verifies: elements compared with `equals` keep their full schema when the
// list also leaves whole for a helper with no summary, which may read them;
// they are not narrowed to comparable cells as elements only compared are.
// The list leaves on its own and as a fallback's operand; the state holding
// it leaves in a local, as a fallback's operand, and in an array.
export {
  addPanel,
  addThroughArrayHoldingRoot,
  addThroughFallback,
  addThroughLocalHoldingRoot,
  addThroughRootFallback,
};
