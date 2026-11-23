/**
 * A handler that sends to a stream which the state of its binding alone
 * holds: the result holds the stream `relay` and the total, and no stored
 * value links the stream of `count`.
 */
import { handler, pattern, type Stream, Writable } from "commonfabric";

const count = handler<{ by: number }, { total: Writable<number> }>(
  (event, { total }) => {
    total.set(total.get() + event.by);
  },
);

const relay = handler<{ by: number }, { counted: Stream<{ by: number }> }>(
  (event, { counted }) => {
    counted.send({ by: event.by });
  },
);

export const Relayed = pattern<
  Record<string, never>,
  { total: number; relay: Stream<{ by: number }> }
>(() => {
  const total = new Writable<number>(0);
  const counted = count({ total });
  return { total, relay: relay({ counted }) };
});
