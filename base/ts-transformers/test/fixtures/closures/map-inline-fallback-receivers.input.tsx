import { pattern, UI } from "commonfabric";

interface Reaction {
  emoji: string;
  userNames: string[];
}

interface Message {
  id: string;
  reactions?: Reaction[];
}

interface Input {
  messages: Message[];
}

// FIXTURE: map-inline-fallback-receivers
// Verifies: inline fallback array-method receivers are transformed structurally
//   (msg.reactions ?? []).map(fn) → lift(...)(...).mapWithPattern(pattern(...).curry({ msg: { id: ... } }))
//   (msg.reactions || []).map(fn) → lift(...)(...).mapWithPattern(pattern(...).curry({ msg: { id: ... } }))
// Context: Nested map — outer maps messages, inner fallback receivers capture msg.id and message-local reaction data
export default pattern<Input>(({ messages }) => {
  return {
    [UI]: (
      <div>
        {messages.map((msg) => (
          <section>
            {(msg.reactions ?? []).map((reaction) => (
              <button type="button" data-msg-id={msg.id}>
                {reaction.emoji}
              </button>
            ))}
            {(msg.reactions || []).map((reaction) => (
              <span>
                {msg.id}:{reaction.userNames.length}
              </span>
            ))}
          </section>
        ))}
      </div>
    ),
  };
});
