/**
 * Fixture for a cascade that crosses spaces. The test fires one event at a
 * handler in its own space, which sends one to a child in a space of its own,
 * where further handlers relay it and the last one writes, so the assertion
 * after the action holds only when the settle waited for the delivery and for
 * the child's loop.
 */

import {
  assert,
  handler,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";

type Note = { value: string; spent?: number };

const land = handler<Note, { landed: Writable<string[]> }>(
  (event, { landed }) => {
    landed.push(event.value);
  },
);

interface Child {
  landed: string[];
  note: Stream<Note>;
}

const relay = handler<Note, { next: Stream<Note> }>(
  (event, { next }) => {
    next.send(event);
  },
);

/**
 * Holds up the wave the event is served in past its flush deadline, so that the
 * event this handler sends is served in a later wave than the one that carries
 * this event's consequence.
 */
const relayAfterTheDeadline = handler<
  Note,
  { next: Stream<Note> }
>((event, { next }) => {
  // Counted rather than timed: a pattern's clock does not move during a run.
  let spent = 0;
  for (let i = 0; i < 300_000_000; i++) spent = (spent + i) | 0;
  next.send({ value: event.value, spent });
});

const Child = pattern<{ landed: Writable<string[]> }, Child>(({ landed }) => {
  const last = land({ landed });
  const second = relay({ next: last });
  return { landed, note: relayAfterTheDeadline({ next: second }) };
});

export default pattern(() => {
  const child = Child.inSpace()({ landed: Writable.of<string[]>([]) });
  const start = relay({ next: child.note });

  return {
    [TESTS]: [
      { assertion: assert(() => child.landed.length === 0) },
      { action: start, event: { value: "first" } },
      {
        assertion: assert(() =>
          child.landed.length === 1 && child.landed[0] === "first"
        ),
      },
    ],
  };
});
