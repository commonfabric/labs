/**
 * A handler that calls two built-ins the executor does not have: one the
 * runtime answers, the acting principal, and a class of the data model,
 * whose instance it stores.
 */
import {
  currentPrincipal,
  FabricEpochNsec,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface Stamp {
  by?: string;
  at?: FabricEpochNsec;
}

const stamp = handler<{ nsec: number }, { held: Writable<Stamp> }>(
  (event, { held }) => {
    held.set({
      by: currentPrincipal(),
      at: new FabricEpochNsec(BigInt(event.nsec)),
    });
  },
);

export const Stamped = pattern<
  Record<string, never>,
  { held: Stamp; stamp: Stream<{ nsec: number }> }
>(() => {
  const held = new Writable<Stamp>({});
  return { held, stamp: stamp({ held }) };
});
