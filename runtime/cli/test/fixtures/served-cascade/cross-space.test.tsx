/**
 * Fixture for a cascade that crosses spaces. The test fires one event at a
 * handler in its own space, which sends one to a child in a space of its own,
 * and that child's handler writes there, so the assertion after the action
 * holds only when the settle waited for the delivery and for the child's
 * loop.
 */

import {
  assert,
  handler,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";

const land = handler<{ value: string }, { landed: Writable<string[]> }>(
  (event, { landed }) => {
    landed.push(event.value);
  },
);

interface Child {
  landed: string[];
  note: Stream<{ value: string }>;
}

const Child = pattern<{ landed: Writable<string[]> }, Child>(({ landed }) => ({
  landed,
  note: land({ landed }),
}));

const create = handler<
  Record<string, never>,
  { children: Writable<Child[]> }
>((_event, { children }) => {
  children.push(
    Child.inSpace()({ landed: Writable.of<string[]>([]) }) as Child,
  );
});

const relay = handler<{ value: string }, { children: Writable<Child[]> }>(
  (event, { children }) => {
    children.get()[0].note.send(event);
  },
);

const Parent = pattern<
  { children: Writable<Child[]> },
  {
    children: Child[];
    create: Stream<Record<string, never>>;
    relay: Stream<{ value: string }>;
  }
>(({ children }) => ({
  children,
  create: create({ children }),
  relay: relay({ children }),
}));

export default pattern(() => {
  const parent = Parent({ children: Writable.of<Child[]>([]) });

  return {
    [TESTS]: [
      { action: parent.create, event: {} },
      { assertion: assert(() => parent.children.length === 1) },
      { action: parent.relay, event: { value: "first" } },
      {
        assertion: assert(() =>
          parent.children[0].landed.length === 1 &&
          parent.children[0].landed[0] === "first"
        ),
      },
    ],
  };
});
