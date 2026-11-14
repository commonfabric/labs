import {
  type BuiltInLLMMessage,
  computed,
  type Default,
  handler,
  llmDialog,
  NAME,
  pattern,
  patternTool,
  str,
  type Stream,
  toSchema,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  readWebpage,
  searchWeb,
} from "../../system/common-fabric/common-fabric.tsx";
import { type ResearchResult, researchSections } from "./research-result.ts";

const triggerGeneration = handler<
  unknown,
  {
    addMessage: Stream<BuiltInLLMMessage>;
    situation: string;
    result: any | null;
  }
>((_, { addMessage, situation, result }) => {
  if (!result) {
    addMessage.send({
      role: "user",
      content: [{ type: "text" as const, text: situation }],
    });
  }
});

const sendMessage = handler<
  { detail: { text: string; attachments?: Array<any> } },
  { addMessage: Stream<BuiltInLLMMessage> }
>((event, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.text }],
  });
});

const showRefineInput = handler<unknown, { showRefine: Writable<boolean> }>(
  (_, { showRefine }) => {
    showRefine.set(true);
  },
);

export default pattern<
  {
    situation:
      | string
      | Default<"What are the latest developments in AI agents?">;
    messages?: Writable<Array<BuiltInLLMMessage> | Default<[]>>;
    context?: { [id: string]: any };
  },
  { [NAME]: string; result: any; [UI]: VNode }
>(({ situation, messages, context }) => {
  const systemPrompt = computed(
    () =>
      `You are a deep research agent. Given a question, use the available tools to:
1. Search the web for relevant information
2. Read promising web pages to gather detailed content
3. Synthesize your findings into a comprehensive answer

Your textual responses are invisible to the user, they can only see the presented result.

Be thorough - search for multiple aspects of the question and read several sources before forming your answer.
When done, call presentResult with your structured findings.`,
  );

  const {
    addMessage,
    pending,
    result: dialogResult,
  } = llmDialog({
    system: systemPrompt,
    messages,
    tools: {
      searchWeb: patternTool(searchWeb),
      readWebpage: patternTool(readWebpage),
    },
    context: computed(() => context ?? {}),
    resultSchema: toSchema<ResearchResult>(),
  });

  const result = computed(() => dialogResult as ResearchResult | undefined);
  const sections = computed(() => researchSections(result));
  const showRefine = new Writable(false);

  return {
    [NAME]: str`Research: ${situation}`,
    result,
    [UI]: (
      <div style="display:contents">
        <cf-autostart
          onstart={triggerGeneration({
            addMessage,
            situation,
            result,
          })}
        />
        <cf-message-beads
          label="research"
          $messages={messages}
          pending={pending}
          oncf-refine={showRefineInput({ showRefine })}
        />
        <div>
          <h3>{sections.summaryHeading}</h3>
          <p>{sections.summary}</p>
          <p>
            <em>{sections.confidence}</em>
          </p>
          <h3>{sections.findingsHeading}</h3>
          <p style="white-space:pre-wrap">{sections.findings}</p>
          <h3>{sections.sourcesHeading}</h3>
          <p>{sections.sources}</p>
        </div>
        <cf-prompt-input
          placeholder="Refine research..."
          pending={pending}
          style={computed(() => (showRefine.get() ? "" : "display:none"))}
          oncf-send={sendMessage({ addMessage })}
        />
      </div>
    ),
  };
});
