/**
 * Tests the event-firing, binding and text helpers in `vnode-helpers.ts`: a
 * control that binds a handler receives the event, a bound cell found by
 * `boundViewCell` writes through to what the control binds, and one that binds
 * nothing under the prop, or a node that was not found, makes the helper throw
 * rather than pass as a control that did nothing.
 */
import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  boundViewCell,
  findElementByText,
  fireClick,
  fireEvent,
  isElement,
  sendMessage,
  setBound,
  viewShows,
} from "./vnode-helpers.ts";

const count = handler<void, { clicks: Writable<number> }>((_, { clicks }) => {
  clicks.set(clicks.get() + 1);
});

const record = handler<
  { detail: { message: string } },
  { sent: Writable<string[]> }
>(({ detail }, { sent }) => {
  sent.push(detail.message);
});

/** Sets the cell the first `cf-checkbox` under `ui` binds as `prop` to
 * true, recording the message when it binds nothing there. */
const checkThrough = handler<
  void,
  { ui: Writable<VNode>; prop: string; failures: Writable<string[]> }
>((_, { ui, prop, failures }) => {
  try {
    boundViewCell(
      ui,
      (node) => isElement(node, "cf-checkbox"),
      prop,
      "the checkbox",
    ).set(true);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
});

const Controls = pattern<
  {
    clicks: Writable<number>;
    sent: Writable<string[]>;
    done: Writable<boolean>;
  }
>(({ clicks, sent, done }) => ({
  [UI]: (
    <div>
      <cf-button onClick={count({ clicks })}>Count</cf-button>
      <span>Inert</span>
      <cf-message-input oncf-send={record({ sent })} />
      <cf-checkbox $checked={done}>Done</cf-checkbox>
    </div>
  ),
}));

const Label = pattern(() => ({ [UI]: <span>Inert</span> }));

export default pattern(() => {
  const clicks = new Writable(0);
  const sent = new Writable<string[]>([]);
  const done = new Writable(false);
  const controls = Controls({ clicks, sent, done });
  const label = Label({});
  const failures = new Writable<string[]>([]);
  const action_check_unbound = checkThrough({
    ui: controls[UI],
    prop: "$value",
    failures,
  });
  const action_check_bound = checkThrough({
    ui: controls[UI],
    prop: "$checked",
    failures,
  });

  const action_send = action(() => {
    sendMessage(controls[UI], "hello");
  });
  const action_send_without_input = action(() => {
    try {
      sendMessage(label[UI], "lost", "the absent input");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  });

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
      {
        assertion: assert(() =>
          viewShows(controls[UI], ["Count", "Inert"], ["Missing"]) &&
          !viewShows(controls[UI], ["Count", "Missing"]) &&
          !viewShows(controls[UI], ["Count"], ["Inert"])
        ),
      },
      { action: action_send },
      { assertion: assert(() => sent.get().join("|") === "hello") },
      { action: action_send_without_input },
      {
        assertion: assert(() =>
          sent.get().join("|") === "hello" &&
          failures.get().join("|") ===
            "fireEvent: the absent input was not found"
        ),
      },
      { action: action_click_bound },
      { assertion: assert(() => clicks.get() === 1) },
      { action: action_fire_unbound },
      {
        assertion: assert(() =>
          failures.get().slice(1).join("|") ===
            "fireEvent: the inert label has no onClick to fire|" +
              "fireEvent: the inert label has no oncf-submit to fire"
        ),
      },
      { assertion: assert(() => clicks.get() === 1) },
      { action: action_set_unbound },
      {
        assertion: assert(() =>
          failures.get().slice(3).join("|") ===
            "setBound: the inert label binds no $value|" +
              "setBound: the inert label was not found"
        ),
      },
      { action: action_check_unbound },
      {
        assertion: assert(() =>
          !done.get() &&
          failures.get().slice(5).join("|") ===
            "boundViewCell: the checkbox binding $value was not found"
        ),
      },
      { action: action_check_bound },
      {
        assertion: assert(() => done.get() && failures.get().length === 6),
      },
    ],
  };
});
