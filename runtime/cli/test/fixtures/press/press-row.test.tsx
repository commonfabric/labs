/**
 * Fixture for a press step: two rows, each with a "Remove" control whose
 * handler is bound only in the view. The step presses the one in the row
 * showing "pear", and the assertion says that row is the one removed.
 */

import { assert, handler, pattern, TESTS, UI, Writable } from "commonfabric";

const remove = handler<unknown, { items: Writable<string[]>; name: string }>(
  (_, { items, name }) => {
    items.set(items.get().filter((item) => item !== name));
  },
);

export default pattern(() => {
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
      { press: view, control: "Remove", within: "pear" },
      {
        assertion: assert(() =>
          items.get().length === 1 && items.get()[0] === "apple"
        ),
      },
    ],
  };
});
