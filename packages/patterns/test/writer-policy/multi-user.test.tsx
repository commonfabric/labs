/// <cts-enable />
/**
 * One room shared by two members, each in a runtime of their own. The named
 * handlers write the writer-policied list and record from both runtimes; a
 * handler that is not the named one is refused in both, and leaves nothing
 * behind. Alice's runtime creates the room, so Bob's is the one that starts
 * a piece it did not create.
 *
 * Bob's piece start also installs the room's policy manifest, which Alice's
 * runtime installed already, and that install is refused as a create-only
 * conflict (`entity-absent precondition target already exists`) whatever
 * the writer policies say: a separate defect with a separate fix. That
 * refusal is the console error Bob's run allows. The writer-policy half of
 * piece start is pinned without it by
 * `packages/runner/test/cfc-writer-policy-cold-start.test.ts`.
 */
import {
  action,
  assert,
  handler,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import Room, { type Entry, type RoomOutput } from "./main.tsx";

interface Setup {
  room: RoomOutput;
}

export const setup = pattern(() => ({ room: Room({}) }));

/** Appends to the list without being the handler its policy names. */
const forgeEntry = handler<void, { entries: Writable<Entry[]> }>(
  (_, { entries }) => {
    entries.push({ seat: 99, digest: "forged" });
  },
);

/** Overwrites the record without being the handler its policy names. */
const forgeFrozen = handler<void, { frozen: Writable<Entry> }>(
  (_, { frozen }) => {
    frozen.set({ seat: 99, digest: "forged" });
  },
);

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const room = setup.room;
  const submit = action(() => room.submit.send({ seat: 1 }));
  const freeze = action(() => room.freeze.send({ digest: "alice" }));
  const forgeList = forgeEntry({ entries: room.entries });
  const forgeRecord = forgeFrozen({ frozen: room.frozen });
  const forge = action(() => {
    forgeList.send();
    forgeRecord.send();
  });
  return {
    [TESTS]: [
      { action: submit },
      { assertion: assert(() => (room.entries ?? []).length === 1) },
      { label: "alice-submitted" },
      { await: "bob-done" },
      // Bob's appends and his freeze, made from his runtime, landed.
      { assertion: assert(() => (room.entries ?? []).length === 2) },
      { assertion: assert(() => room.entries?.[1]?.seat === 2) },
      { assertion: assert(() => room.frozen?.digest === "bob") },
      // The named handler writes the record again, from the other runtime.
      { action: freeze },
      { assertion: assert(() => room.frozen?.digest === "alice") },
      { action: forge },
      { assertion: assert(() => (room.entries ?? []).length === 2) },
      { assertion: assert(() => room.frozen?.digest === "alice") },
    ],
    // The refused forgeries warn as they are dropped.
    allowConsoleWarnings: true,
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const room = setup.room;
  const submit = action(() => room.submit.send({ seat: 2 }));
  const freeze = action(() => room.freeze.send({ digest: "bob" }));
  const forgeList = forgeEntry({ entries: room.entries });
  const forgeRecord = forgeFrozen({ frozen: room.frozen });
  const forge = action(() => {
    forgeList.send();
    forgeRecord.send();
  });
  return {
    [TESTS]: [
      { await: "alice-submitted" },
      { assertion: assert(() => (room.entries ?? []).length === 1) },
      { action: submit },
      { assertion: assert(() => (room.entries ?? []).length === 2) },
      { action: freeze },
      { assertion: assert(() => room.frozen?.digest === "bob") },
      { action: forge },
      { assertion: assert(() => (room.entries ?? []).length === 2) },
      { assertion: assert(() => room.entries?.[1]?.digest === "d2") },
      { assertion: assert(() => room.frozen?.digest === "bob") },
      { label: "bob-done" },
    ],
    allowConsoleWarnings: true,
    // The policy-manifest install conflict described above.
    allowConsoleErrors: true,
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
