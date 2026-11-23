/**
 * A handler whose state holds a conditional written at the binding: the
 * instance computes which cell the handler is bound to.
 */
import { type Cell, handler, pattern, type Stream } from "commonfabric";

const bump = handler<unknown, { target?: Cell<{ n: number }> }>(
  (_event, { target }) => {
    if (target === undefined) return;
    target.set({ n: target.get().n + 1 });
  },
);

export const Bound = pattern<
  { own: boolean; counter: Cell<{ n: number }> },
  { go: Stream<unknown> }
>(({ own, counter }) => ({
  go: bump({ target: own ? undefined : counter }),
}));
