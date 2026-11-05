import { action, computed, pattern, UI, VNode, Writable } from "commonfabric";

interface View {
  value: unknown;
  label: string;
}

interface Item {
  name: string;
  value: Record<string, unknown> | null;
}

interface State {
  view: View;
  items: Item[];
  log: Writable<string>;
  title: string;
}

function propOf(view: View): unknown {
  return view.value;
}

function labeledBase(label: string) {
  return class {
    label = label;
  };
}

function formatterFor(name: string): <T>(value: T) => string {
  return (value) => `${name}: ${String(value)}`;
}

// FIXTURE: captures-skip-type-positions
// Verifies: a name that appears only in erased syntax is not captured
//   (value as { set: (next: string) => void })  → no `next` capture
//   (stream as { send: (event: …) => void })    → no `event` capture
//   const copy: typeof view = view              → `view` captured for the
//                                                 value, not for the type
//   (item.value as { get: (key: string) => … })  → neither `get` nor `key`
//   interface Setter { set(next: string): void } → no `next` capture
//   interface Local extends Tagged / implements → no `Tagged` capture
//   Mode.Alpha (a `const enum`, inlined)        → no `Mode` capture, in a
//                                                 callback and in a JSX
//                                                 expression; the regular
//                                                 `enum` Kind is captured
// and that a value inside a type-shaped node is still captured:
//   class extends labeledBase(title)            → `title` captured
//   formatterFor(title)<string>                 → `title` captured
// Context: the same capture collector serves actions, computeds and array
//   callbacks, and none of them may bind an erased name as an input: with no
//   such binding in scope, an unshrunk state would require it and the callback
//   would never run.
export default pattern<State, { [UI]: VNode }>(
  ({ view, items, log, title }) => {
    interface Tagged {
      tag: string;
    }
    const enum Mode {
      Alpha = "alpha",
    }
    enum Kind {
      Beta = "beta",
    }

    const setIt = action(() => {
      const value = propOf(view);
      if (typeof value === "object" && value !== null && "set" in value) {
        (value as { set: (next: string) => void }).set("x");
      }
      log.set(view.label);
    });

    const viaDeclarations = action(() => {
      interface Setter {
        set(next: string): void;
        (event: string): void;
      }
      interface Local extends Tagged {
        label: string;
      }
      class Label implements Tagged {
        tag = "label";
      }
      const setter = propOf(view) as Setter | null;
      const local: Local = { tag: new Label().tag, label: view.label };
      if (setter) setter.set(local.label);
    });

    const viaClassExtends = action(() => {
      class Named extends labeledBase(title) {}
      log.set(new Named().label);
    });

    const viaInstantiation = action(() => {
      const format = formatterFor(title)<string>;
      log.set(format(view.label));
    });

    const viaEnums = action(() => {
      log.set(`${Mode.Alpha}:${Kind.Beta}`);
    });

    const summary = computed(() => {
      const copy: typeof view = view;
      const value = copy.value;
      return typeof value === "object" && value !== null && "send" in value
        ? String((value as { send: (event: Record<string, never>) => void }))
        : copy.label;
    });

    return {
      [UI]: (
        <div>
          <button type="button" onClick={setIt}>{summary}</button>
          <button type="button" onClick={viaDeclarations}>declarations</button>
          <button type="button" onClick={viaClassExtends}>extends</button>
          <button type="button" onClick={viaInstantiation}>instantiate</button>
          <button type="button" onClick={viaEnums}>enums</button>
          {items.map((item) => (
            <span>
              {typeof item.value === "object" && item.value !== null
                ? String((item.value as { get: (key: string) => unknown }))
                : item.name}
              <b>{item.name + Mode.Alpha + Kind.Beta}</b>
            </span>
          ))}
        </div>
      ),
    };
  },
);
