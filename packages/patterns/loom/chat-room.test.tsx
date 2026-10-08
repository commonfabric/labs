/**
 * The Loom names its chat room, reads it back, clears it, forgets it with the
 * room's last panel, and refuses a room in another space.
 */
import { action, assert, NAME, pattern, TESTS, Writable } from "commonfabric";
import Loom from "./main.tsx";

/** A piece standing in for a room, created in a space of its own. */
const Elsewhere = pattern<Record<PropertyKey, never>, { [NAME]: string }>(
  () => ({ [NAME]: "Elsewhere" }),
);

export default pattern(() => {
  const loom = Loom({});
  // A root instantiated with only the fields every Loom has held.
  const oldRoot = Loom({
    title: "Earlier Loom",
    panels: [],
    presentation: { stagedPanels: [] },
    participants: {},
  });
  const room = new Writable({ [NAME]: "Room" });
  const other = new Writable({ [NAME]: "Other room" });
  const unrelated = new Writable({ [NAME]: "Unrelated piece" });
  const name = action(() => loom.setChatRoom.send({ room }));
  const nameOther = action(() => loom.setChatRoom.send({ room: other }));
  const clear = action(() => loom.setChatRoom.send({}));
  const nameForeign = action(() =>
    loom.setChatRoom.send({ room: Elsewhere.inSpace()({}) })
  );
  const addRoom = action(() => loom.addPiece.send({ piece: room }));
  const addUnrelated = action(() => loom.addPiece.send({ piece: unrelated }));
  const duplicateRoom = action(() =>
    loom.duplicatePanel.send({ panel: loom.panels[0] })
  );
  const removeFirst = action(() =>
    loom.removePanel.send({ panel: loom.panels[0] })
  );
  const removeUnrelated = action(() =>
    loom.removePiece.send({ piece: unrelated })
  );
  const removeRoomPiece = action(() => loom.removePiece.send({ piece: room }));
  return {
    allowRuntimeErrors: true,
    expectRuntimeErrors: 1,
    allowConsoleErrors: true,
    [TESTS]: [
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      { assertion: assert(() => oldRoot.chatRoom?.get() === undefined) },
      { action: name },
      { assertion: assert(() => loom.chatRoom?.equals(room) === true) },
      { assertion: assert(() => loom.chatRoom?.equals(other) === false) },
      { action: name },
      { assertion: assert(() => loom.chatRoom?.equals(room) === true) },
      { action: nameOther },
      { assertion: assert(() => loom.chatRoom?.equals(other) === true) },
      // Naming another room replaces the link and leaves the first room as
      // it was.
      { assertion: assert(() => room.get()[NAME] === "Room") },
      { action: clear },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      { action: clear },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      { action: name },
      { action: nameForeign },
      { assertion: assert(() => loom.chatRoom?.equals(room) === true) },
      // Removing panels other than the room's leaves it named, and so does
      // removing one of two occurrences of the room.
      { action: addRoom },
      { action: duplicateRoom },
      { action: addUnrelated },
      { action: removeUnrelated },
      { assertion: assert(() => loom.chatRoom?.equals(room) === true) },
      { action: removeFirst },
      { assertion: assert(() => loom.panels.length === 1) },
      { assertion: assert(() => loom.chatRoom?.equals(room) === true) },
      { action: removeFirst },
      { assertion: assert(() => loom.panels.length === 0) },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      // `removePiece` clears it too.
      { action: addRoom },
      { action: name },
      { action: removeRoomPiece },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      // A room that is not a panel stays named through a removal.
      { action: addUnrelated },
      { action: name },
      { action: removeUnrelated },
      { assertion: assert(() => loom.chatRoom?.equals(room) === true) },
    ],
  };
});
