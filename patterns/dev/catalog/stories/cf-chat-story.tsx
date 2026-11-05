import { handler, NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ChatStoryInput {}
export interface ChatStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const sampleMessages = [
  { role: "user", content: "What's the weather in San Francisco?" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "get_weather",
        input: { city: "San Francisco" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "get_weather",
        output: { temp: "62°F", condition: "Partly cloudy" },
      },
    ],
  },
  {
    role: "assistant",
    content: "The weather in San Francisco is 62°F and partly cloudy.",
  },
  { role: "user", content: "Thanks! Can you also check New York?" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "get_weather",
        input: { city: "New York" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_2",
        toolName: "get_weather",
        output: { temp: "45°F", condition: "Rainy" },
      },
    ],
  },
  { role: "assistant", content: "New York is currently 45°F and rainy." },
];

const sampleTools = [
  { name: "get_weather", description: "Get current weather for a city" },
  { name: "search_web", description: "Search the web for information" },
  { name: "run_code", description: "Execute a code snippet" },
];

const sendMessage = handler<
  CustomEvent<{ text?: string }>,
  { messages: Writable<typeof sampleMessages> }
>((event, { messages }) => {
  const text = event?.detail?.text;
  if (text?.trim()) {
    messages.set([
      ...messages.get(),
      { role: "user", content: text.trim() },
    ]);
  }
});

export default pattern<ChatStoryInput, ChatStoryOutput>(() => {
  const pending = new Writable(false);
  const messages = new Writable(sampleMessages);

  return {
    [NAME]: "cf-chat Story",
    [UI]: (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "500px",
          border: "1px solid #e6e9ed",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        {/* Header with beads and tools chip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 12px",
            borderBottom: "1px solid #e6e9ed",
            backgroundColor: "#fafafa",
          }}
        >
          <cf-message-beads
            $messages={messages}
            pending={pending}
            style="flex: 1;"
          />
          <cf-tools-chip tools={sampleTools} />
        </div>

        {/* Chat messages */}
        <cf-vscroll
          style="padding: 1rem; flex: 1;"
          flex
          showScrollbar
          fadeEdges
          snapToBottom
        >
          <cf-chat $messages={messages} pending={pending} />
        </cf-vscroll>

        {/* Prompt input */}
        <div style={{ borderTop: "1px solid #e6e9ed", padding: "8px" }}>
          <cf-prompt-input
            placeholder="Ask the assistant..."
            pending={pending}
            oncf-send={sendMessage({ messages })}
          />
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="pending"
          description="Show pending/loading state"
          defaultValue="false"
          checked={pending}
        />
      </Controls>
    ),
  };
});
