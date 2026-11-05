/**
 * Creates rooms, each a piece in a space of its own that only its creator
 * may reach until they grant someone else — fixture for
 * `space-access-multi-runtime.test.ts`.
 */

import {
  Default,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Room, { type RoomOutput } from "./room.tsx";

export interface CreateEvent {
  title: string;
}

const create = handler<CreateEvent, { rooms: Writable<RoomOutput[]> }>(
  (event, { rooms }) => {
    rooms.push(Room.inSpace()({ title: event.title, members: [] }));
  },
);

export interface ManagerInput {
  rooms: Writable<Default<RoomOutput[], []>>;
}

export interface ManagerOutput {
  [NAME]: string;
  [UI]: VNode;
  rooms: RoomOutput[];

  /** Creates a room in a new space, owned by the event's actor. */
  create: Stream<CreateEvent>;
}

export default pattern<ManagerInput, ManagerOutput>(({ rooms }) => ({
  [NAME]: "Space access manager fixture",
  [UI]: (
    <div>
      <span>space access manager fixture</span>
    </div>
  ),
  rooms,
  create: create({ rooms }),
}));
