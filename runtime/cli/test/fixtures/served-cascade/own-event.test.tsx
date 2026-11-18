/**
 * Fixture for a cascade of events that served handlers fire on their own
 * account. The test fires one event; each handler it reaches sends the next,
 * and only the last link writes, so the assertion after the action holds only
 * when the settle waited for the whole chain.
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

const Chain = pattern<
  { landed: Writable<string[]> },
  { landed: string[]; start: Stream<Note> }
>(({ landed }) => {
  const last = land({ landed });
  const third = relay({ next: last });
  const second = relay({ next: third });
  return { landed, start: relayAfterTheDeadline({ next: second }) };
});

export default pattern(() => {
  const chain = Chain({ landed: Writable.of<string[]>([]) });

  return {
    [TESTS]: [
      { assertion: assert(() => chain.landed.length === 0) },
      { action: chain.start, event: { value: "first" } },
      {
        assertion: assert(() =>
          chain.landed.length === 1 && chain.landed[0] === "first"
        ),
      },
    ],
  };
});
