/// <cts-enable />

/**
 * Fixture for `noticeSpaceAccess()` in a single-user run. The handler creates
 * a room in a space of its own, whose grants give a guest `WRITE`, and tells
 * the guest about it. The runtime's inbox is the in-process one `cf test`
 * answers, so the notice is delivered and nothing is logged, and the test
 * reads what was sent from its `spaceAccessNotices` input once a
 * `{ settle: true }` step has brought it up to date. Without that inbox the
 * send fails and is logged at error level, which fails the file.
 */

import {
  assert,
  currentPrincipal,
  type DID,
  handler,
  noticeSpaceAccess,
  pattern,
  type SentSpaceAccessNotice,
  TESTS,
  Writable,
} from "commonfabric";

/** The guest the room's space grants `WRITE`, and who is told about it. */
const GUEST: DID = "did:key:z6MkfXnSkGc27B8ahD4GEgW7egL6kYfu7kpNiUV9ESpMRHAk";

interface Room {
  title: string;
}

const Room = pattern<{ title: string }, Room>(({ title }) => ({ title }));

const invite = handler<
  unknown,
  { rooms: Writable<Room[]>; actor: Writable<string> }
>((_event, { rooms, actor }) => {
  actor.set(currentPrincipal() ?? "");
  const room = Room.inSpace(undefined, { grants: { [GUEST]: "WRITE" } })({
    title: "Donut committee",
  });
  rooms.push(room as Room);
  // The list's entry is a cell linking to the room's document, which is what
  // the notice names once it follows the link.
  noticeSpaceAccess(GUEST, rooms.key(0));
});

export default pattern<{ spaceAccessNotices: SentSpaceAccessNotice[] }>(
  ({ spaceAccessNotices }) => {
    const rooms = Writable.of<Room[]>([]);
    const actor = Writable.of("");

    return {
      [TESTS]: [
        { assertion: assert(() => spaceAccessNotices.length === 0) },
        { action: invite({ rooms, actor }), event: {} },
        { settle: true },
        { assertion: assert(() => spaceAccessNotices.length === 1) },
        {
          assertion: assert(() => spaceAccessNotices[0]?.recipient === GUEST),
        },
        {
          assertion: assert(() =>
            spaceAccessNotices[0]?.sender === actor.get()
          ),
        },
        // The room's space is one of its own, not the actor's home space.
        {
          assertion: assert(() => spaceAccessNotices[0]?.space !== actor.get()),
        },
        {
          assertion: assert(() =>
            spaceAccessNotices[0]?.entry.startsWith("of:") === true
          ),
        },
      ],
    };
  },
);
