/// <cts-enable />

/**
 * Fixture for `spaceAccess()` in a single-user run. The test's space is born
 * with an access list naming the test's identity OWNER, so a computed and a
 * handler both read `"OWNER"`. Without that list both read `undefined`.
 */

import {
  assert,
  computed,
  handler,
  pattern,
  spaceAccess,
  TESTS,
  Writable,
} from "commonfabric";

const record = handler<
  unknown,
  { room: Writable<{ title: string }>; seen: Writable<string> }
>((_event, { room, seen }) => {
  seen.set(String(spaceAccess(room)));
});

export default pattern(() => {
  const room = Writable.of({ title: "room" });
  const seen = Writable.of("");
  const level = computed(() => String(spaceAccess(room)));

  return {
    [TESTS]: [
      { assertion: assert(() => level === "OWNER") },
      { action: record({ room, seen }), event: {} },
      { assertion: assert(() => seen.get() === "OWNER") },
    ],
  };
});
