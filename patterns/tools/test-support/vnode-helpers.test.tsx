/**
 * Tests the event-firing, binding and text helpers in `vnode-helpers.ts`: a
 * control that binds a handler receives the event, and one that binds nothing
 * under the prop, or a node that was not found, makes the helper throw rather
 * than pass as a control that did nothing.
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

const Controls = pattern<
  { clicks: Writable<number>; sent: Writable<string[]> }
>(({ clicks, sent }) => ({
  [UI]: (
    <div>
      <cf-button onClick={count({ clicks })}>Count</cf-button>
      <span>Inert</span>
      <cf-message-input oncf-send={record({ sent })} />
    </div>
  ),
}));

const Label = pattern(() => ({ [UI]: <span>Inert</span> }));

export default pattern(() => {
  const clicks = new Writable(0);
  const sent = new Writable<string[]>([]);
  const controls = Controls({ clicks, sent });
  const label = Label({});
  const failures = new Writable<string[]>([]);

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
    ],
  };
});
