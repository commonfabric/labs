import { equals, handler, Writable } from "commonfabric";

interface Panel {
  name: string;
}

const compareFallback = handler<
  { panel: Writable<Panel> },
  { panels: Writable<Writable<Panel>[]> }
>((event, state) => {
  const list = state.panels.get();
  if (list.some((item) => item.equals(event.panel))) return;
  if (equals(state ?? undefined, state)) return;
});

// FIXTURE: identity-call-fallback-argument
// Verifies: a fallback handed to a known identity call is compared, not read,
// so the elements the body only compares stay comparable cells.
export { compareFallback };
