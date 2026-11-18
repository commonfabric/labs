/// <cts-enable />

/** An action receives a cell link produced by an otherwise unread projection. */

import {
  assert,
  type Cell,
  computed,
  type Default,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

export interface State {
  /** Records created by the first action. */
  records: Writable<{ body: string }[] | Default<[]>>;

  /** The second action's observation through its event's cell link. */
  seen: Writable<string | Default<"">>;
}

export const setup = pattern<Record<string, never>, State>(() => ({
  records: Writable.of<{ body: string }[]>([]),
  seen: Writable.of<string>(""),
}));

const append = handler<void, State>((_, { records }) => {
  records.push({ body: "ready" });
  records.push({ body: "plain ready" });
});

const record = handler<
  { message: Cell<{ body: string }>; index: number },
  State
>(
  (event, { records, seen }) => {
    seen.set(
      equals(event.message, records.key(event.index))
        ? event.message.get()?.body ?? "missing"
        : "wrong target",
    );
  },
);

const recordNested = handler<
  {
    nested: { records: { message: Cell<{ body: string }>; scalar: number }[] };
    scalar: number;
  },
  State
>((event, { records, seen }) => {
  const nested = event.nested.records[0];
  seen.set(
    equals(nested.message, records.key(1)) && nested.scalar === 4 &&
      event.scalar === 4 && nested.message.get().body === "plain ready"
      ? "nested ready"
      : "wrong nested payload",
  );
});

export const participant = pattern<{ setup: State }>(({ setup }) => {
  const projected = computed(() =>
    setup.records.get().map((_, index) => setup.records.key(index))
  );
  const plainProjected = computed(() =>
    setup.records.get().length > 1 ? [setup.records.key(1)] : []
  );
  const scalar = computed(() => setup.records.get().length * 2);
  const nestedEvent = computed(() => ({
    nested: { records: [{ message: setup.records.key(1), scalar }] },
    scalar,
  }));
  return {
    [TESTS]: [
      { action: append(setup) },
      {
        action: record(setup),
        event: { message: projected[0], index: 0 },
        trustedUi: { surface: "TestSurface", action: "Record" },
      },
      { assertion: assert(() => setup.seen.get() === "ready") },
      {
        action: record(setup),
        event: { message: plainProjected[0], index: 1 },
      },
      { assertion: assert(() => setup.seen.get() === "plain ready") },
      {
        action: recordNested(setup),
        event: nestedEvent,
        trustedUi: { surface: "TestSurface", action: "RecordNested" },
      },
      { assertion: assert(() => setup.seen.get() === "nested ready") },
    ],
  };
});

export default participant;
