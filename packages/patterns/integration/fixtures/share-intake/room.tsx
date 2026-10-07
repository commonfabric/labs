/**
 * Stands in for a room a sender creates, as the root of a space of its own,
 * and offers to the owner. Fixture for `share-intake-multi-runtime.test.ts`.
 */

import { NAME, pattern, UI, type VNode } from "commonfabric";

/** Arguments for the stand-in room. */
export interface RoomInput {
  /** What the room is called. */
  title: string;
}

/** The stand-in room's result. */
export interface RoomOutput {
  [NAME]: string;
  [UI]: VNode;

  /** What the room is called. */
  title: string;
}

export default pattern<RoomInput, RoomOutput>(({ title }) => ({
  [NAME]: title,
  [UI]: <div>{title}</div>,
  title,
}));
