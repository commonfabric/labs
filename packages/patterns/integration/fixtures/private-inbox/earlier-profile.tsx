/**
 * Stands in for a profile of an earlier vintage: a name, a pointer and
 * `setInbox`, and none of the current profile's other fields and streams.
 * Fixture for `private-inbox-multi-runtime.test.ts`.
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
export interface EarlierProfileOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The stand-in's name, which every profile vintage holds. */
  name: string;

  /** Where the stand-in points. */
  inbox: Pointer;

  /** Points the stand-in at an inbox, or clears its pointer. */
  setInbox: Stream<SetPointerEvent>;
}

export default pattern<Record<never, never>, EarlierProfileOutput>(() => {
  const inbox = new Writable<Pointer>({}).for("inbox");
  return {
    [NAME]: "Earlier profile",
    name: "Earlier profile",
    [UI]: <div>earlier profile</div>,
    inbox,
    setInbox: setInbox({ inbox }),
  };
});
