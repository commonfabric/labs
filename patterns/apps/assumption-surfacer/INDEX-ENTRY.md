## `apps/assumption-surfacer/assumption-surfacer.tsx`

A chat that shows, beside the conversation, the assumptions the assistant is
making about you. Before each reply the assistant records its few most
consequential guesses (your language, skill level, goal…) through a
`recordAssumptions` tool, each with alternatives. The sidebar lists them, newest
first; pick the right alternative or "None of these". A correction is also sent
to the chat, and every settled assumption is folded into the system prompt so
later replies build on it.

**Keywords:** llm, chat, llmDialog, tools, assumptions, clarification

### Input Schema

```ts
interface Assumption {
  id: string; // a1, a2, … in recording order
  turn: number; // which user message (1-based) the reply answered
  about: string; // excerpt of that message
  label: string;
  description: string;
  alternatives: string[];
  assumedIndex: number;
  status: "open" | "confirmed" | "corrected" | "rejected";
  chosenIndex: number; // when corrected, else -1
}

interface AssumptionSurfacerInput {
  messages?: PerSpace<Writable<BuiltInLLMMessage[] | Default<[]>>>;
  assumptions?: PerSpace<Writable<Assumption[] | Default<[]>>>;
  systemPrompt?: PerSpace<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface AssumptionSurfacerOutput {
  messages: BuiltInLLMMessage[];
  assumptions: Assumption[];
  openCount: number;
  settled: string[]; // settled facts, as fed to the model
  system: string; // the full system prompt
  pending: boolean | undefined;
  recordAssumptions: Stream<{ assumptions: ReportedAssumption[] }, string>;
  confirmAssumption: Stream<{ id: string }>;
  rejectAssumption: Stream<{ id: string }>;
  chooseAlternative: Stream<{ id: string; index: number }>;
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
  clearChat: Stream<void>;
}
```

<!-- demo-list: `apps/assumption-surfacer/` (a chat that surfaces the assistant's assumptions for you to confirm or correct) -->
