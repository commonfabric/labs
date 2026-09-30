/**
 * A piece meant to live in a space of its own, whose owner grants others
 * access to that space — fixture for `space-access-multi-runtime.test.ts`.
 */

import {
  Default,
  type DID,
  grantSpaceAccess,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface GrantEvent {
  principal: DID;
}

const grant = handler<GrantEvent, { members: Writable<DID[]> }>(
  (event, { members }) => {
    grantSpaceAccess(members, event.principal, "READ");
    members.push(event.principal);
  },
);

export interface RoomInput {
  title: Default<string, "">;
  members: Writable<Default<DID[], []>>;
}

export interface RoomOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  members: DID[];

  /** Grants `principal` READ in this piece's space, as a trusted gesture. */
  grant: Stream<GrantEvent>;
}

export default pattern<RoomInput, RoomOutput>(({ title, members }) => ({
  [NAME]: "Space access room fixture",
  [UI]: (
    <div>
      <span>{title}</span>
    </div>
  ),
  title,
  members,
  grant: grant({ members }),
}));
