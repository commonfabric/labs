/**
 * Tests the event-firing and binding helpers in `vnode-helpers.ts`: a control
 * that binds a handler receives the event, and one that binds nothing under
 * the prop, or a node that was not found, makes the helper throw rather than
 * pass as a control that did nothing.
 */
import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByText,
  fireClick,
  fireEvent,
  setBound,
} from "./vnode-helpers.ts";

const count = handler<void, { clicks: Writable<number> }>((_, { clicks }) => {
  clicks.set(clicks.get() + 1);
});

const Controls = pattern<{ clicks: Writable<number> }>(({ clicks }) => ({
  [UI]: (
    <div>
      <cf-button onClick={count({ clicks })}>Count</cf-button>
      <span>Inert</span>
    </div>
  ),
}));

export default pattern(() => {
  const clicks = new Writable(0);
  const controls = Controls({ clicks });
  const failures = new Writable<string[]>([]);

  const action_click_bound = action(() => {
    fireClick(findElementByText(controls[UI], "cf-button", "Count"));
  });
  const action_set_unbound = action(() => {
    for (
      const node of [
        findElementByText(controls[UI], "span", "Inert"),
        undefined,
      ]
    ) {
      try {
        setBound(node, "$value", "typed", "the inert label");
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  });
  const action_fire_unbound = action(() => {
    for (const prop of ["onClick", "oncf-submit"]) {
      try {
        fireEvent(
          findElementByText(controls[UI], "span", "Inert"),
          prop,
          {},
          "the inert label",
        );
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  });

  return {
    [TESTS]: [
      { action: action_click_bound },
      { assertion: assert(() => clicks.get() === 1) },
      { action: action_fire_unbound },
      {
        assertion: assert(() =>
          failures.get().join("|") ===
            "fireEvent: the inert label has no onClick to fire|" +
              "fireEvent: the inert label has no oncf-submit to fire"
        ),
      },
      { assertion: assert(() => clicks.get() === 1) },
      { action: action_set_unbound },
      {
        assertion: assert(() =>
          failures.get().slice(2).join("|") ===
            "setBound: the inert label binds no $value|" +
              "setBound: the inert label was not found"
        ),
      },
    ],
  };
});
