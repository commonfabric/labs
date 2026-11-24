/**
 * Stands in for a room a sender creates and offers to the owner. Fixture for
 * `share-intake-multi-runtime.test.ts`.
 */

import {
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** Arguments for the stand-in room. */
export interface RoomInput {
  /** What the room is called. */
  title: string;
}

/** What the stand-in room says about itself. */
export interface RoomAbout {
  /** What the room is called. */
  title: string;
}

/** A message sent to the stand-in room. */
export interface SendMessageEvent {
  /** The message's text. */
  text: string;
}

/** The stand-in room's result. */
export interface RoomOutput {
  [NAME]: string;
  [UI]: VNode;

  /** What the room says about itself. */
  about: RoomAbout;

  /** The messages sent to the room, oldest first. */
  messages: string[];

  /** What the room recorded recently, oldest first. */
  recentActivity: string[];

  /** Sends the room a message. */
  sendMessage: Stream<SendMessageEvent>;
}

/** Appends the event's text to the room's messages and its activity. */
const sendMessage = handler<
  SendMessageEvent,
  { messages: Writable<string[]>; recentActivity: Writable<string[]> }
>((event, { messages, recentActivity }) => {
  messages.push(event.text);
  recentActivity.push(event.text);
});

export default pattern<RoomInput, RoomOutput>(({ title }) => {
  const messages = new Writable<string[]>([]).for("messages");
  const recentActivity = new Writable<string[]>([]).for("recentActivity");
  return {
    [NAME]: title,
    [UI]: <div>{title}</div>,
    about: { title },
    messages,
    recentActivity,
    sendMessage: sendMessage({ messages, recentActivity }),
  };
});
