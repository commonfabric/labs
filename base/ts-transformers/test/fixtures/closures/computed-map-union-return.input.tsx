import { computed, pattern, UI } from "commonfabric";

interface ContentPart {
  type: "text" | "image";
  text?: string;
  image?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

interface State {
  messages: Message[];
}

// FIXTURE: computed-map-union-return
// Verifies: a computed returning a union type (string | null) with a nested .map() infers the correct output schema
//   computed(() => { ...; return content }) → lift(schema, anyOf[string, null])({ messages })
//   inner .map() inside the computed callback → NOT transformed (plain array after unwrap)
// Context: previously caused schema to fall back to `true` when the callback became synthetic
export default pattern<State>((state) => {
  // This computed callback contains a nested map and returns string | null.
  // The callback becomes synthetic during transformation, which previously
  // caused type inference to fail, resulting in a 'true' schema instead of
  // the correct union type schema.
  const latestMessage = computed(() => {
    const messages = state.messages;
    if (!messages || messages.length === 0) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role === "assistant") {
        // This map call inside the computed callback was the key issue
        const content = typeof msg.content === "string"
          ? msg.content
          : msg.content.map((part) => {
            if (part.type === "text") return part.text || "";
            return "";
          }).join("");
        return content;
      }
    }
    return null;
  });

  return {
    [UI]: (
      <div>
        <div>Latest: {latestMessage}</div>
      </div>
    ),
  };
});
