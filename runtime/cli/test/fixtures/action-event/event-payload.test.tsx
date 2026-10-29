/**
 * Fixture for an action step's `event` payload. The handler records what it
 * received, so the assertions fail if the runner delivers anything other than
 * what the step authored. An object payload is the case that matters: a
 * primitive one has always arrived.
 */

import {
  assert,
  type Default,
  handler,
  pattern,
  TESTS,
  type Writable,
} from "commonfabric";

interface Seen {
  n: number | Default<-1>;
  nested: string | Default<"">;
}

const record = handler<
  { n?: number; inner?: { label?: string } },
  { seen: Writable<Seen> }
>((event, { seen }) => {
  seen.set({ n: event?.n ?? -1, nested: event?.inner?.label ?? "" });
});

const recordNumber = handler<number, { seen: Writable<Seen> }>(
  (event, { seen }) => {
    seen.set({ n: typeof event === "number" ? event : -1, nested: "" });
  },
);

export default pattern<
  { seen: Writable<Seen | Default<{ n: -1; nested: "" }>> },
  { seen: Seen }
>(({ seen }) => {
  return {
    seen,
    [TESTS]: [
      { action: recordNumber({ seen }), event: 7 },
      { assertion: assert(() => seen.get().n === 7) },
      { action: record({ seen }), event: { n: 42, inner: { label: "deep" } } },
      {
        assertion: assert(() =>
          seen.get().n === 42 && seen.get().nested === "deep"
        ),
      },
    ],
  };
});
