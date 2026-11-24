/// <cts-enable />

/**
 * Fixture for a cascade of served handlers' own events under multi-user. Alice
 * fires one event, each handler sends the next, and only the last link writes.
 * Alice reads that right after her action, and Bob once he crosses her marker,
 * so each holds only when the settle waited for the whole chain: for Alice
 * before her next step, and for both before she announces the marker.
 */

import {
  assert,
  handler,
  multiUserTest,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";

type Note = { value: string; spent?: number };

const land = handler<Note, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.value);
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

export interface CascadeSetup {
  note: Writable<string>;
  start: Stream<Note>;
}

export const setup = pattern<Record<string, never>, CascadeSetup>(() => {
  const note = Writable.of<string>("");
  const last = land({ note });
  const third = relay({ next: last });
  const second = relay({ next: third });
  return { note, start: relayAfterTheDeadline({ next: second }) };
});

export const alice = pattern<{ setup: CascadeSetup }>(({ setup }) => ({
  [TESTS]: [
    { action: setup.start, event: { value: "from alice" } },
    { assertion: assert(() => setup.note.get() === "from alice") },
    { label: "alice-started" },
  ],
}));

export const bob = pattern<{ setup: CascadeSetup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-started" },
    { assertion: assert(() => setup.note.get() === "from alice") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
