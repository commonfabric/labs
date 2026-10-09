/**
 * Stands in for a profile whose pointer is kept per user: a name, a pointer in
 * a user-scoped cell, and `setInbox`. Another space's serving runtime refuses
 * to read the pointer. Fixture for `private-inbox-multi-runtime.test.ts`.
 */

import {
  type Cell,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { PrivateInboxPiece } from "../../../system/private-inbox.tsx";

/** A pointer as a profile holds it. */
type Pointer = { piece?: Cell<PrivateInboxPiece> };

/** An event pointing the pointer at an inbox, or clearing it. */
type SetPointerEvent = { inbox?: Cell<PrivateInboxPiece> };

/** Points the pointer where the event says. */
const setInbox = handler<SetPointerEvent, { inbox: Writable<Pointer> }>(
  (event, { inbox }) => {
    inbox.set(event.inbox === undefined ? {} : { piece: event.inbox });
  },
);

/** The stand-in's result. */
export interface UserScopedProfileOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The stand-in's name. */
  name: string;

  /** Where the stand-in points, for the user reading it. */
  inbox: Pointer;

  /** Points the stand-in at an inbox, or clears its pointer. */
  setInbox: Stream<SetPointerEvent>;
}

export default pattern<Record<never, never>, UserScopedProfileOutput>(() => {
  const inbox = new Writable.perUser<Pointer>({});
  return {
    [NAME]: "User-scoped profile",
    name: "User-scoped profile",
    [UI]: <div>user-scoped profile</div>,
    inbox,
    setInbox: setInbox({ inbox }),
  };
});
