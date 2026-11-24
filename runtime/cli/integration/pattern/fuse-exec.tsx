import {
  computed,
  handler,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  schema,
  str,
  type Stream,
} from "commonfabric";
import "commonfabric/schema";

interface Input {
  lastMessage: string;
  messageCount: number;
  legacyCount: number;
  messages: string[];
}

interface RecordNoteEvent {
  note: string;
}

interface Output {
  [NAME]: string;
  lastMessage: string;
  messageCount: number;
  legacyCount: number;
  messages: string[];
  recordMessage: Stream<{ message: string }>;
  recordNote: Stream<RecordNoteEvent>;
  legacyWrite: Stream<Record<string, never>>;
  search: PatternToolResult<{ source: string }>;
}

const model = schema({
  type: "object",
  properties: {
    lastMessage: { type: "string", default: "", asCell: ["cell"] },
    messageCount: { type: "number", default: 0, asCell: ["cell"] },
    legacyCount: { type: "number", default: 0, asCell: ["cell"] },
    messages: {
      type: "array",
      items: { type: "string" },
      default: [],
      asCell: ["cell"],
    },
  },
  default: {
    lastMessage: "",
    messageCount: 0,
    legacyCount: 0,
    messages: [],
  },
});

const recordMessage = handler(
  {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
  },
  model,
  ({ message }, state) => {
    state.lastMessage.set(message);
    state.messageCount.set(state.messageCount.get() + 1);
    state.messages.push(message);
  },
);

// The event schema sits behind a top-level local $ref, deliberately: it is
// the shape a pattern routinely deploys, and the deployed stream schema then
// carries no top-level `properties` of its own. What a caller sees through
// that indirection — the flags, the required-ness, the refusal when a
// payload is missing — is what the integration scenario exercises.
// `recordMessage` keeps the inline form so the fixture carries one verb of
// each shape and the two can be compared.
const recordNote = handler(
  {
    $ref: "#/$defs/RecordNoteEvent",
    $defs: {
      RecordNoteEvent: {
        type: "object",
        properties: {
          note: { type: "string" },
        },
        required: ["note"],
      },
    },
  } as const,
  model,
  (event, state) => {
    // Tolerates a missing event on purpose: if an absent payload ever reaches
    // dispatch again, the handling records "(no event)" instead of throwing,
    // so the retry test observes the silent id-spend as data.
    const note = (event as RecordNoteEvent | undefined)?.note ?? "(no event)";
    state.lastMessage.set(note);
    state.messageCount.set(state.messageCount.get() + 1);
    state.messages.push(note);
  },
);

const legacyWrite = handler(
  {
    type: "object",
    properties: {},
  },
  model,
  (_event, state) => {
    state.legacyCount.set(state.legacyCount.get() + 1);
  },
);

const searchTool = pattern(
  (
    { query, help, source }: { query: string; help?: string; source: string },
  ) => {
    const helpValue = computed(() => help ?? "");
    return {
      query,
      help: helpValue,
      source,
      summary: str`${source}:${query}:${helpValue}`,
    };
  },
  {
    type: "object",
    properties: {
      query: { type: "string" },
      help: { type: "string" },
      source: { type: "string" },
    },
    required: ["query", "source"],
  },
  {
    type: "object",
    properties: {
      query: { type: "string" },
      help: { type: "string" },
      source: { type: "string" },
      summary: { type: "string" },
    },
    required: ["query", "help", "source", "summary"],
  },
);

export const customPatternExport = pattern<Input, Output>(
  (cell) => {
    return {
      [NAME]: "Fuse Exec Fixture",
      lastMessage: cell.lastMessage,
      messageCount: cell.messageCount,
      legacyCount: cell.legacyCount,
      messages: cell.messages,
      recordMessage: recordMessage(cell),
      recordNote: recordNote(cell),
      legacyWrite: legacyWrite(cell),
      search: patternTool(searchTool, {
        source: "bound-source",
      }),
    };
  },
  model,
);
