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

const land = handler<{ value: string }, { landed: Writable<string[]> }>(
  (event, { landed }) => {
    landed.push(event.value);
  },
);

const relay = handler<{ value: string }, { next: Stream<{ value: string }> }>(
  (event, { next }) => {
    next.send(event);
  },
);

const Chain = pattern<
  { landed: Writable<string[]> },
  { landed: string[]; start: Stream<{ value: string }> }
>(({ landed }) => {
  const last = land({ landed });
  const third = relay({ next: last });
  const second = relay({ next: third });
  return { landed, start: relay({ next: second }) };
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
