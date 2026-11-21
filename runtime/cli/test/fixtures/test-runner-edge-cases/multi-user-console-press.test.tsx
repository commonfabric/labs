/// <cts-enable />

/**
 * Fixture: a multi-user participant whose body writes a console error as the
 * module is evaluated, which is not the test's behavior; whose action writes
 * a console error and a console warning, which are; and which presses a
 * rendered control.
 */

import {
  action,
  assert,
  handler,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";

const remove = handler<unknown, { items: Writable<string[]>; name: string }>(
  (_, { items, name }) => {
    items.set(items.get().filter((item) => item !== name));
  },
);

export const alice = pattern(() => {
  console.error("participant body output before the run");
  const items = Writable.of<string[]>(["apple", "pear"]);
  const view = (
    <div>
      {items.map((name) => (
        <div>
          <span>{name}</span>
          <cf-button onClick={remove({ items, name })}>Remove</cf-button>
        </div>
      ))}
    </div>
  );
  return {
    [UI]: view,
    [TESTS]: [
      {
        action: action(() => {
          console.error("participant console error");
          console.warn("participant console warning");
        }),
      },
      { press: view, control: "Remove", within: "pear" },
      {
        assertion: assert(() =>
          items.get().length === 1 && items.get()[0] === "apple"
        ),
      },
    ],
  };
});

export default multiUserTest({ participants: { alice } });
