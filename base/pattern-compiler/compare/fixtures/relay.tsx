/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

const bump = handler<{ by: number }, { total: Writable<number> }>(
  (event, { total }) => {
    total.set(total.get() + event.by);
  },
);

const relay = handler<
  { by: number },
  { relayed: Writable<number>; target: Stream<{ by: number }> }
>((event, { relayed, target }) => {
  relayed.set(relayed.get() + 1);
  target.send({ by: event.by });
});

// A handler that writes a state cell and sends an event to another stream
// of the piece, whose handler writes another state cell: `relay` counts its
// runs in `relayed` and sends to `bump`, which adds to `total`.
export default pattern<{ start: number }>(({ start }) => {
  const total = Writable.of(0);
  const relayed = Writable.of(0);
  const bumped = bump({ total });
  return {
    start,
    total,
    relayed,
    bump: bumped,
    relay: relay({ relayed, target: bumped }),
  };
});
