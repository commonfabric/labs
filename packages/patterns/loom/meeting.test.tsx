/** Meeting binding confirms replays and preserves conflicting or unknown state. */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Loom from "./main.tsx";
import type { BindMeetingResult, PortableMeetingIdentity } from "./schemas.tsx";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const PORTABLE = {
  scheme: "ical-uid-slot",
  item_key: "ff91746000eda3309fc01866704976f244a0f1832e418f51f1fab13968b8ccae",
  occurrence_key:
    "064701cd8b686840c32ef69ed46576a0c2726f140ccc6b31c8e64d27497f3aed",
} satisfies PortableMeetingIdentity;

export default pattern(() => {
  const loom = Loom({});
  const oldRoot = Loom({
    title: "Established Loom",
    panels: [],
    presentation: { stagedPanels: [] },
    participants: {},
  });
  const reply = new Writable<BindMeetingResult>({ status: "invalid-key" });
  const bind = action(() => loom.bindMeeting.send({ key: KEY, reply }));
  const conflict = action(() => loom.bindMeeting.send({ key: OTHER, reply }));
  const bindOld = action(() => oldRoot.bindMeeting.send({ key: KEY }));
  const uppercase = action(() =>
    oldRoot.bindMeeting.send({ key: KEY.toUpperCase(), reply })
  );
  const whitespace = action(() =>
    oldRoot.bindMeeting.send({ key: `${KEY} `, reply })
  );
  const short = action(() => oldRoot.bindMeeting.send({ key: "abc", reply }));
  const newline = action(() =>
    oldRoot.bindMeeting.send({ key: `${KEY}\n`, reply })
  );
  const invalid = new Writable({ key: "malformed" });
  const invalidRoot = Loom({ meeting: invalid });
  const bindInvalid = action(() =>
    invalidRoot.bindMeeting.send({ key: KEY, reply })
  );
  const unknown = new Writable<{ key?: string; future: string }>({
    future: "keep",
  });
  const unknownRoot = Loom({ meeting: unknown });
  const bindUnknown = action(() =>
    unknownRoot.bindMeeting.send({ key: KEY, reply })
  );
  const future = new Writable({ key: KEY, future: "keep" });
  const futureRoot = Loom({ meeting: future });
  const replayFuture = action(() =>
    futureRoot.bindMeeting.send({ key: KEY, reply })
  );
  const conflictFuture = action(() =>
    futureRoot.bindMeeting.send({ key: OTHER, reply })
  );
  const portableRoot = Loom({});
  const bindPortable = action(() =>
    portableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: PORTABLE,
      reply,
    })
  );
  const replayPortableAsLegacy = action(() =>
    portableRoot.bindMeeting.send({ key: KEY, reply })
  );
  const enrichFuture = action(() =>
    futureRoot.bindMeeting.send({ key: KEY, portableIdentity: PORTABLE, reply })
  );
  const conflictingPortable = action(() =>
    portableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: { ...PORTABLE, occurrence_key: OTHER },
      reply,
    })
  );
  const invalidPortable = action(() =>
    portableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: { ...PORTABLE, item_key: "invalid" },
      reply,
    })
  );
  const malformedPortableRoot = Loom({});
  const nullPortable = action(() =>
    malformedPortableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: null,
      reply,
    })
  );
  const arrayPortable = action(() =>
    malformedPortableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: [],
      reply,
    })
  );
  const unsupportedPortable = action(() =>
    malformedPortableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: { ...PORTABLE, scheme: "future-scheme" },
      reply,
    })
  );
  const unsupportedStored = new Writable<Record<string, unknown>>({
    key: KEY,
    portableIdentity: {
      ...PORTABLE,
      scheme: "future-scheme",
      occurrence_key: OTHER,
    },
  });
  const unsupportedRoot = Loom({ meeting: unsupportedStored });
  const enrichUnsupported = action(() =>
    unsupportedRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: PORTABLE,
      reply,
    })
  );
  const replayUnsupportedAsLegacy = action(() =>
    unsupportedRoot.bindMeeting.send({ key: KEY, reply })
  );
  const futurePortable = new Writable({
    key: KEY,
    portableIdentity: { ...PORTABLE, future: "keep" },
    future: "keep",
  });
  const futurePortableRoot = Loom({ meeting: futurePortable });
  const replayFuturePortable = action(() =>
    futurePortableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: PORTABLE,
      reply,
    })
  );
  const conflictFuturePortable = action(() =>
    futurePortableRoot.bindMeeting.send({
      key: KEY,
      portableIdentity: { ...PORTABLE, item_key: OTHER },
      reply,
    })
  );
  return {
    [TESTS]: [
      { assertion: assert(() => loom.meeting.key === undefined) },
      { assertion: assert(() => oldRoot.meeting.key === undefined) },
      { action: bind },
      { assertion: assert(() => loom.meeting.key === KEY) },
      { assertion: assert(() => reply.get().status === "bound") },
      { action: bind },
      { assertion: assert(() => reply.get().status === "already-bound") },
      { assertion: assert(() => loom.meeting.key === KEY) },
      { action: conflict },
      { assertion: assert(() => reply.get().status === "conflict") },
      { assertion: assert(() => loom.meeting.key === KEY) },
      { action: uppercase },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { action: whitespace },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { action: short },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { action: newline },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { assertion: assert(() => oldRoot.meeting.key === undefined) },
      { action: bindOld },
      { assertion: assert(() => oldRoot.meeting.key === KEY) },
      { action: bindInvalid },
      { assertion: assert(() => reply.get().status === "invalid-state") },
      { assertion: assert(() => invalid.get().key === "malformed") },
      { action: bindUnknown },
      { assertion: assert(() => reply.get().status === "invalid-state") },
      { assertion: assert(() => unknown.get().future === "keep") },
      { assertion: assert(() => unknown.get().key === undefined) },
      { action: replayFuture },
      { assertion: assert(() => reply.get().status === "already-bound") },
      { assertion: assert(() => future.get().future === "keep") },
      { action: bindPortable },
      { assertion: assert(() => reply.get().status === "bound") },
      { assertion: assert(() => portableRoot.meeting.key === KEY) },
      {
        assertion: assert(() =>
          portableRoot.meeting.portableIdentity?.scheme === PORTABLE.scheme
        ),
      },
      {
        assertion: assert(() =>
          portableRoot.meeting.portableIdentity?.item_key === PORTABLE.item_key
        ),
      },
      { action: replayFuturePortable },
      { assertion: assert(() => reply.get().status === "already-bound") },
      { assertion: assert(() => futurePortable.get().future === "keep") },
      {
        assertion: assert(() =>
          futurePortable.get().portableIdentity.future === "keep"
        ),
      },
      { action: conflictFuturePortable },
      { assertion: assert(() => reply.get().status === "conflict") },
      {
        assertion: assert(() =>
          futurePortable.get().portableIdentity.item_key === PORTABLE.item_key
        ),
      },
      {
        assertion: assert(() =>
          futurePortable.get().portableIdentity.future === "keep"
        ),
      },
      {
        assertion: assert(() =>
          portableRoot.meeting.portableIdentity?.occurrence_key ===
            PORTABLE.occurrence_key
        ),
      },
      { action: bindPortable },
      { assertion: assert(() => reply.get().status === "already-bound") },
      { action: replayPortableAsLegacy },
      { assertion: assert(() => reply.get().status === "already-bound") },
      {
        assertion: assert(() =>
          portableRoot.meeting.portableIdentity?.occurrence_key ===
            PORTABLE.occurrence_key
        ),
      },
      { action: enrichFuture },
      { assertion: assert(() => reply.get().status === "already-bound") },
      { assertion: assert(() => futureRoot.meeting.key === KEY) },
      {
        assertion: assert(() =>
          futureRoot.meeting.portableIdentity?.occurrence_key ===
            PORTABLE.occurrence_key
        ),
      },
      { assertion: assert(() => future.get().future === "keep") },
      { action: conflictingPortable },
      { assertion: assert(() => reply.get().status === "conflict") },
      {
        assertion: assert(() =>
          portableRoot.meeting.portableIdentity?.occurrence_key ===
            PORTABLE.occurrence_key
        ),
      },
      { action: invalidPortable },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      {
        assertion: assert(() =>
          portableRoot.meeting.portableIdentity?.item_key === PORTABLE.item_key
        ),
      },
      { action: nullPortable },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      {
        assertion: assert(() =>
          malformedPortableRoot.meeting.key === undefined
        ),
      },
      { action: arrayPortable },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      {
        assertion: assert(() =>
          malformedPortableRoot.meeting.key === undefined
        ),
      },
      { action: unsupportedPortable },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      {
        assertion: assert(() =>
          malformedPortableRoot.meeting.key === undefined
        ),
      },
      { action: enrichUnsupported },
      { assertion: assert(() => reply.get().status === "invalid-state") },
      {
        assertion: assert(() =>
          unsupportedRoot.meeting.portableIdentity?.occurrence_key === OTHER
        ),
      },
      { action: replayUnsupportedAsLegacy },
      { assertion: assert(() => reply.get().status === "already-bound") },
      {
        assertion: assert(() =>
          unsupportedRoot.meeting.portableIdentity?.occurrence_key === OTHER
        ),
      },
      { action: conflictFuture },
      { assertion: assert(() => reply.get().status === "conflict") },
      { assertion: assert(() => future.get().key === KEY) },
      { assertion: assert(() => future.get().future === "keep") },
    ],
  };
});
