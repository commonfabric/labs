/// <cts-enable />

/**
 * Fixture for `spaceAccess()` in a multi-user run. The shared space's access
 * list names the first participant's user OWNER, and every other user at the
 * level one of its participants declares, `WRITE` when none declares one, or
 * not at all for `"none"`. `readerAgain` is a second session of `reader`'s
 * user, and holds that user's level. Each participant reads its own level, in
 * a computed and in a handler.
 */

import {
  assert,
  computed,
  handler,
  multiUserTest,
  pattern,
  spaceAccess,
  TESTS,
  Writable,
} from "commonfabric";

export interface AccessSetup {
  room: Writable<{ title: string }>;
}

export const setup = pattern<Record<string, never>, AccessSetup>(() => ({
  room: Writable.of({ title: "room" }),
}));

const record = handler<
  unknown,
  { room: Writable<{ title: string }>; seen: Writable<string> }
>((_event, { room, seen }) => {
  seen.set(String(spaceAccess(room)));
});

export const owner = pattern<{ setup: AccessSetup }>(({ setup }) => {
  const seen = Writable.of("");
  const level = computed(() => String(spaceAccess(setup.room)));
  return {
    [TESTS]: [
      { assertion: assert(() => level === "OWNER") },
      { action: record({ room: setup.room, seen }), event: {} },
      { assertion: assert(() => seen.get() === "OWNER") },
    ],
  };
});

export const writer = pattern<{ setup: AccessSetup }>(({ setup }) => {
  const seen = Writable.of("");
  const level = computed(() => String(spaceAccess(setup.room)));
  return {
    [TESTS]: [
      { assertion: assert(() => level === "WRITE") },
      { action: record({ room: setup.room, seen }), event: {} },
      { assertion: assert(() => seen.get() === "WRITE") },
    ],
  };
});

export const reader = pattern<{ setup: AccessSetup }>(({ setup }) => {
  const seen = Writable.of("");
  const level = computed(() => String(spaceAccess(setup.room)));
  return {
    [TESTS]: [
      { assertion: assert(() => level === "READ") },
      { action: record({ room: setup.room, seen }), event: {} },
      { assertion: assert(() => seen.get() === "READ") },
    ],
  };
});

export const outsider = pattern<{ setup: AccessSetup }>(({ setup }) => {
  const seen = Writable.of("");
  const level = computed(() => String(spaceAccess(setup.room)));
  return {
    [TESTS]: [
      { assertion: assert(() => level === "none") },
      { action: record({ room: setup.room, seen }), event: {} },
      { assertion: assert(() => seen.get() === "none") },
    ],
  };
});

export const defaulted = pattern<{ setup: AccessSetup }>(({ setup }) => {
  const seen = Writable.of("");
  const level = computed(() => String(spaceAccess(setup.room)));
  return {
    [TESTS]: [
      { assertion: assert(() => level === "WRITE") },
      { action: record({ room: setup.room, seen }), event: {} },
      { assertion: assert(() => seen.get() === "WRITE") },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    owner,
    writer: { pattern: writer, access: "WRITE" },
    reader: { pattern: reader, access: "READ" },
    readerAgain: { pattern: reader, user: "reader" },
    outsider: { pattern: outsider, access: "none" },
    defaulted,
  },
});
