/**
 * TRANSFORM REPRO: mapped element field comparisons inside helper-call roots
 *
 * The mapped element is lowered to a cell input. A non-JSX comparison such as
 * `message.author === senderName(name.get())` must read `message.author`
 * through a reactive field dependency, not as a plain property on the cell.
 */

import {
  Default,
  pattern,
  UI,
  VNode,
  Writable,
} from "commonfabric";

interface Message {
  author: string;
  body: string;
}

interface Input {
  name: Writable<Default<string, "">>;
  selectedRoom: Writable<Default<{ messages: Message[] }, { messages: [] }>>;
}

interface Output {
  [UI]: VNode;
}

const senderName = (name?: string) => name?.trim() || "Anonymous";

export default pattern<Input, Output>(({ name, selectedRoom }) => {
  return {
    [UI]: (
      <div>
        {selectedRoom.get()?.messages.map((message) => {
          const isMine = message.author === senderName(name.get());
          const isKnownAuthor = message.author === "Alice";
          return (
            <div
              data-author-kind={isKnownAuthor ? "known" : "other"}
              style={{ justifyContent: isMine ? "flex-end" : "flex-start" }}
            >
              {message.author}
              {message.body}
            </div>
          );
        })}
      </div>
    ),
  };
});
