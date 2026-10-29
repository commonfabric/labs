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

export const participant = pattern<{ setup: State }>(({ setup }) => {
  const projected = computed(() =>
    setup.records.get().map((_, index) => setup.records.key(index))
  );
  const plainProjected = computed(() =>
    setup.records.get().length > 1 ? [setup.records.key(1)] : []
  );
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
    ],
  };
});

export default participant;
