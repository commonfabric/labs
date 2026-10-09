/**
 * Regression test: a handler that compares list elements with `.equals()` and
 * also hands the list to a helper that reads them must receive readable
 * elements.
 *
 * The transformer narrows a handler's state to what the body uses. Elements
 * the body only compares are narrowed to cells that can be compared and not
 * read. A list passed whole to a helper the analysis does not look into can
 * be read in full there, and that once left the comparison's narrowing in
 * place, so the helper read nothing and the handler failed though the pattern
 * type-checked.
 *
 * `admit` refuses a panel already in the list, found by `equals`, and one
 * whose name the helper finds there. Each refusal is checked by its own step.
 * `admitThroughFallback` does the same, handing the helper `list ?? []`.
 *
 * Run: deno task cf test packages/patterns/regression/element-identity-helper-read.test.tsx
 */
import { assert, handler, pattern, TESTS, Writable } from "commonfabric";

interface Panel {
  name: string;
}

/** Whether a panel in `list` is named `name`. */
function holdsName(list: readonly Writable<Panel>[], name: string): boolean {
  return list.some((panel) => panel.get().name === name);
}

const admit = handler<
  { panel: Writable<Panel> },
  { panels: Writable<Writable<Panel>[]> }
>(({ panel }, { panels }) => {
  const list = panels.get();
  if (list.some((existing) => existing.equals(panel))) return;
  if (holdsName(list, panel.get().name)) return;
  panels.set([...list, panel]);
});

const admitThroughFallback = handler<
  { panel: Writable<Panel> },
  { panels: Writable<Writable<Panel>[]> }
>(({ panel }, { panels }) => {
  const list = panels.get();
  if (list.some((existing) => existing.equals(panel))) return;
  if (holdsName(list ?? [], panel.get().name)) return;
  panels.set([...list, panel]);
});

export default pattern(() => {
  const first = new Writable<Panel>({ name: "a" });
  const second = new Writable<Panel>({ name: "b" });
  const namesake = new Writable<Panel>({ name: "a" });
  const panels = new Writable<Writable<Panel>[]>([]);
  const add = admit({ panels });
  const viaFallback = new Writable<Writable<Panel>[]>([]);
  const addViaFallback = admitThroughFallback({ panels: viaFallback });

  const assertBothAdmitted = assert(() => panels.get().length === 2);
  const assertSameRefused = assert(() => panels.get().length === 2);
  const assertNamesakeRefused = assert(() => panels.get().length === 2);
  const assertFallbackNamesakeRefused = assert(() =>
    viaFallback.get().length === 2
  );

  return {
    [TESTS]: [
      { action: add, event: { panel: first } },
      { action: add, event: { panel: second } },
      { assertion: assertBothAdmitted },
      { action: add, event: { panel: first } },
      { assertion: assertSameRefused },
      { action: add, event: { panel: namesake } },
      { assertion: assertNamesakeRefused },
      { action: addViaFallback, event: { panel: first } },
      { action: addViaFallback, event: { panel: second } },
      { action: addViaFallback, event: { panel: namesake } },
      { assertion: assertFallbackNamesakeRefused },
    ],
  };
});
