/**
 * Fixture for a handler that instantiates a pattern in a space of its own,
 * with `inSpace()`. The child is replicated into that space from the test's
 * own compiled closure, so the run fails on the replication's error unless the
 * runner wrote that closure into the test's space.
 */

import {
  assert,
  handler,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";

interface Child {
  label: string;
}

const Child = pattern<{ label: string }, Child>(({ label }) => ({ label }));

const create = handler<{ label: string }, { children: Writable<Child[]> }>(
  (event, { children }) => {
    children.push(Child.inSpace()({ label: event.label }) as Child);
  },
);

const Parent = pattern<
  { children: Writable<Child[]> },
  { children: Child[]; create: Stream<{ label: string }> }
>(({ children }) => ({ children, create: create({ children }) }));

export default pattern(() => {
  const parent = Parent({ children: Writable.of<Child[]>([]) });

  return {
    [TESTS]: [
      { assertion: assert(() => parent.children.length === 0) },
      { action: parent.create, event: { label: "first" } },
      {
        assertion: assert(() =>
          parent.children.length === 1 && parent.children[0].label === "first"
        ),
      },
    ],
  };
});
