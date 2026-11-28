/**
 * Fixture for the `{ deleteSpace }` step: a child in a space of its own, which
 * `spaceDeleted()` reports live until a step deletes its space, and a skipped
 * step leaves alone.
 */

import {
  assert,
  type Cell,
  handler,
  pattern,
  spaceDeleted,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";

interface Child {
  label: string;
}

const Child = pattern<{ label: string }, Child>(({ label }) => ({ label }));

const create = handler<void, { children: Writable<Child[]> }>(
  (_, { children }) => {
    children.push(Child.inSpace()({ label: "child" }) as Child);
  },
);

/** Records what `spaceDeleted()` says of the first child's space. */
const check = handler<
  void,
  { children: Writable<Child[]>; verdict: Writable<string> }
>((_, { children, verdict }) => {
  verdict.set(String(spaceDeleted(children.key(0))));
});

const Parent = pattern<
  { children: Writable<Child[]>; verdict: Writable<string> },
  {
    children: Writable<Child[]>;
    verdict: string;
    create: Stream<void>;
    check: Stream<void>;
  }
>(({ children, verdict }) => ({
  children,
  verdict,
  create: create({ children }),
  check: check({ children, verdict }),
}));

export default pattern(() => {
  const parent = Parent({
    children: Writable.of<Child[]>([]),
    verdict: Writable.of(""),
  });
  const child: Cell<unknown> = parent.children.key(0);

  return {
    [TESTS]: [
      { action: parent.create },
      { deleteSpace: child, skip: true },
      { action: parent.check },
      { assertion: assert(() => parent.verdict === "false") },
      { deleteSpace: child },
      { action: parent.check },
      { assertion: assert(() => parent.verdict === "true") },
    ],
    // Deleting the child's space ends the sessions open on it, which logs
    // errors, and a later release of the watches those sessions held fails,
    // which logs a warning.
    allowConsoleErrors: true,
    allowConsoleWarnings: true,
  };
});
