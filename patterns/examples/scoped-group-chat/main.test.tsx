import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import ScopedGroupChat, {
  type Conversation,
  type SelectedRoom,
} from "./main-with-writable-inputs.tsx";

export default pattern(() => {
  const selectedRoom = new Writable<SelectedRoom>({});
  const conversation = new Writable<Conversation>({
    rooms: [],
  });
  const draft = new Writable("Hello Library");
  const chat = ScopedGroupChat({
    name: new Writable(""),
    selectedRoom,
    conversation,
    draft,
    newRoomName: new Writable(""),
  });

  const action_add_new_room = action(() => {
    chat.addRoom.send({ name: "Garden" });
  });

  const action_add_second_room = action(() => {
    chat.addRoom.send({ name: "Library" });
  });

  const action_select_first_room = action(() => {
    chat.selectRoom.send({
      room: conversation.key("rooms", 0),
    });
  });

  const assert_initial_scoped_fields = assert(() => chat.roomCount === 0);

  const assert_added_room_is_selected = assert(() =>
    chat.roomCount === 1 &&
    chat.selectedRoom.room?.name === "Garden" &&
    chat.messageCount === 0
  );

  const assert_second_room_is_selected = assert(() =>
    chat.roomCount === 2 &&
    chat.selectedRoom.room?.name === "Library" &&
    chat.messageCount === 0
  );

  const assert_selected_room_reference_changed = assert(() =>
    chat.selectedRoom.room?.name === "Garden"
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_scoped_fields },
      { action: action_add_new_room },
      { assertion: assert_added_room_is_selected },
      { action: action_add_second_room },
      { assertion: assert_second_room_is_selected },
      { action: action_select_first_room },
      { assertion: assert_selected_room_reference_changed },
    ],
    chat,
  };
});
