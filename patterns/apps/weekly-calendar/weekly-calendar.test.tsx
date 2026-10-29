import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  wish,
  Writable,
} from "commonfabric";
import {
  createEventAndContinue,
  createEventHandler,
  type EventPiece,
  handleCreateEvent,
} from "./weekly-calendar.tsx";

export default pattern(() => {
  const events = new Writable<EventPiece[]>([]);
  const pieceRegistry = wish<Writable<EventPiece[]>>({
    query: "#pieceRegistry",
  }).result!;
  const newEventTitle = new Writable("Modal Event");
  const newEventDate = new Writable("2026-07-22");
  const newEventStartTime = new Writable("09:00");
  const newEventEndTime = new Writable("10:00");
  const newEventColor = new Writable("#fef08a");
  const showNewEventPrompt = new Writable(true);
  const usedCreateAnother = new Writable(false);

  const createFromPrompt = createEventHandler({
    newEventTitle,
    newEventDate,
    newEventStartTime,
    newEventEndTime,
    newEventColor,
    showNewEventPrompt,
    events,
    pieceRegistry,
  });
  const createAnotherFromPrompt = createEventAndContinue({
    newEventTitle,
    newEventDate,
    newEventStartTime,
    newEventEndTime,
    newEventColor,
    events,
    pieceRegistry,
    usedCreateAnother,
  });
  const createFromStream = handleCreateEvent({ events, pieceRegistry });

  const action_create_from_stream = action(() => {
    createFromStream.send({
      title: "Planning",
      date: "2026-07-22",
      startTime: "08:00",
      endTime: "09:00",
    });
  });
  const action_create_another_from_prompt = action(() => {
    newEventTitle.set("Second Event");
    createAnotherFromPrompt.send();
  });
  const action_create_from_prompt = action(() => {
    newEventTitle.set("Third Event");
    createFromPrompt.send();
  });

  const assert_stream_registers_event = assert(() =>
    events.get().length === 1 && pieceRegistry.get().length === 1
  );
  const assert_registered_event_name = assert(() =>
    pieceRegistry.get()[0]?.[NAME] === "Planning"
  );
  const assert_create_another_keeps_prompt_open = assert(() =>
    events.get().length === 2 &&
    pieceRegistry.get().length === 2 &&
    usedCreateAnother.get() === true &&
    showNewEventPrompt.get() === true
  );
  const assert_create_closes_prompt = assert(() =>
    events.get().length === 3 &&
    pieceRegistry.get().length === 3 &&
    showNewEventPrompt.get() === false
  );

  return {
    [TESTS]: [
      { action: action_create_from_stream },
      { assertion: assert_stream_registers_event },
      { assertion: assert_registered_event_name },
      { action: action_create_another_from_prompt },
      { assertion: assert_create_another_keeps_prompt_open },
      { action: action_create_from_prompt },
      { assertion: assert_create_closes_prompt },
    ],
  };
});
