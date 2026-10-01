/// <cts-enable />

/**
 * Fixture for `noticeSpaceAccess()` in a multi-user run. The shared space
 * names alice, the first participant, OWNER, and bob WRITE. Bob tells the
 * setup who he is; alice then tells bob about the shared room, and reads the
 * one notice her own runtime sent from her `spaceAccessNotices` input. Bob's
 * runtime sent none, and his input says so: each participant is handed what
 * its own runtime sent.
 */

import {
  assert,
  currentPrincipal,
  type DID,
  handler,
  multiUserTest,
  noticeSpaceAccess,
  pattern,
  type SentSpaceAccessNotice,
  TESTS,
  Writable,
} from "commonfabric";

/** A DID a participant has written, or `""` before it has. */
type MaybeDID = DID | "";

export interface NoticeSetup {
  room: Writable<{ title: string }>;
  guest: Writable<MaybeDID>;
  host: Writable<MaybeDID>;
}

export const setup = pattern<Record<string, never>, NoticeSetup>(() => ({
  room: Writable.of({ title: "room" }),
  guest: Writable.of<MaybeDID>(""),
  host: Writable.of<MaybeDID>(""),
}));

/** Records the actor's DID in `me`. */
const introduce = handler<unknown, { me: Writable<MaybeDID> }>(
  (_event, { me }) => {
    me.set(currentPrincipal() ?? "");
  },
);

/** Tells the guest about the room, and records who told them. */
const invite = handler<
  unknown,
  {
    room: Writable<{ title: string }>;
    guest: Writable<MaybeDID>;
    host: Writable<MaybeDID>;
  }
>((_event, { room, guest, host }) => {
  host.set(currentPrincipal() ?? "");
  const recipient = guest.get();
  if (recipient === "") return;
  noticeSpaceAccess(recipient, room);
});

interface Inputs {
  setup: NoticeSetup;
  spaceAccessNotices: SentSpaceAccessNotice[];
}

export const alice = pattern<Inputs>(({ setup, spaceAccessNotices }) => ({
  [TESTS]: [
    { await: "bob-introduced" },
    {
      action: invite({
        room: setup.room,
        guest: setup.guest,
        host: setup.host,
      }),
      event: {},
    },
    { settle: true },
    { assertion: assert(() => spaceAccessNotices.length === 1) },
    {
      assertion: assert(() =>
        spaceAccessNotices[0]?.recipient === setup.guest.get()
      ),
    },
    {
      assertion: assert(() =>
        spaceAccessNotices[0]?.sender === setup.host.get()
      ),
    },
    { label: "alice-invited" },
  ],
}));

export const bob = pattern<Inputs>(({ setup, spaceAccessNotices }) => ({
  [TESTS]: [
    { action: introduce({ me: setup.guest }), event: {} },
    { label: "bob-introduced" },
    { await: "alice-invited" },
    { settle: true },
    { assertion: assert(() => spaceAccessNotices.length === 0) },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
