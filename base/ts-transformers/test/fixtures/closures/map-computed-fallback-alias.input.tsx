import { computed, pattern, UI } from "commonfabric";

interface Reaction {
  emoji: string;
}

interface Message {
  id: string;
  reactions?: Reaction[];
}

interface Input {
  messages: Message[];
}

// FIXTURE: map-computed-fallback-alias
// Verifies: computed() inside a map callback creates a lift-applied computation and nested map is also transformed
//   computed(() => (msg.reactions ?? [])) → lift(...)(...) with msg.reactions as input
//   messageReactions.map(fn) → nested .mapWithPattern(pattern(...).curry({ msg: { id: msg.key("id") } }))
// Context: Nested map — outer maps messages, inner maps computed reactions; inner captures msg.id
export default pattern<Input>(({ messages }) => {
  return {
    [UI]: (
      <div>
        {messages.map((msg) => {
          const messageReactions = computed(() => (msg.reactions ?? []) as Reaction[]);
          return (
            <div>
              {messageReactions.map((reaction) => (
                <button type="button" data-msg-id={msg.id}>
                  {reaction.emoji}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    ),
  };
});
