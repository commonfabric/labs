/**
 * Language-model mocking for pattern tests.
 *
 * A test opts in by exporting a module-scope `llmMocks: LlmMockEntry[]`. The
 * runner reads it after compile and puts the `@commonfabric/llm` client in mock
 * mode for the run, so every language-model request the test makes is answered
 * from the list and none reaches a model. An entry with `object` answers a
 * `generateObject` request, including one given tools, which the builtin sends
 * as a text request offering the `presentResult` tool; an entry with `text`
 * answers any other text request (`generateText`, `llm`, `llmDialog`). Each
 * entry answers one request, the first of its kind whose prompt contains the
 * entry's `promptIncludes`, and is used up by it. A request no entry answers fails, and the builtin reports that
 * as its `error`, so an empty list is how a test reaches the error path.
 */

import {
  addMockObjectResponse,
  addMockResponse,
  enableMockMode,
  type LLMRequest,
  resetMockMode,
} from "@commonfabric/llm";

/** One mocked answer: a `generateObject` result or a text reply. */
export type LlmMockEntry =
  | { promptIncludes: string; object: Record<string, unknown> }
  | { promptIncludes: string; text: string };

/**
 * Reads a test's `llmMocks` export from the compiled module namespace:
 * `undefined` when the test exports none, and a thrown error naming the entry
 * when one is malformed.
 */
export function readLlmMocks(main: unknown): LlmMockEntry[] | undefined {
  if (typeof main !== "object" || main === null || !("llmMocks" in main)) {
    return undefined;
  }
  const raw = main.llmMocks;
  if (!Array.isArray(raw)) {
    throw new Error("The test's `llmMocks` export is not an array");
  }
  return raw.map((entry, index): LlmMockEntry => {
    if (typeof entry === "object" && entry !== null) {
      const { promptIncludes, object, text } = entry;
      if (typeof promptIncludes === "string") {
        if (
          typeof object === "object" && object !== null && text === undefined
        ) {
          return { promptIncludes, object };
        }
        if (typeof text === "string" && object === undefined) {
          return { promptIncludes, text };
        }
      }
    }
    throw new Error(
      `\`llmMocks[${index}]\` needs a string \`promptIncludes\` and either ` +
        "an `object` or a string `text`",
    );
  });
}

/** The tool through which a `generateObject` given tools returns its result. */
const PRESENT_RESULT_TOOL_NAME = "presentResult";

/** Whether a text request comes from a `generateObject` given tools. */
function offersPresentResult(request: Pick<LLMRequest, "tools">): boolean {
  return request.tools?.[PRESENT_RESULT_TOOL_NAME] !== undefined;
}

/** The text of a request's last message, which carries the prompt. */
function promptOf(request: Pick<LLMRequest, "messages">): string {
  const content = request.messages.at(-1)?.content ?? "";
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : "")
    .join(" ");
}

/**
 * Puts the language-model client in mock mode with `entries` as its answers.
 * The client's mock catalog is process-wide, so disposing the result turns
 * mock mode off and clears what is left of the catalog.
 */
export function installLlmMocks(entries: LlmMockEntry[]): Disposable {
  enableMockMode();
  entries.forEach((entry, index) => {
    const id = `llm-mock-${index}`;
    const matches = (request: Pick<LLMRequest, "messages">) =>
      promptOf(request).includes(entry.promptIncludes);
    if ("object" in entry) {
      // The catalog takes the first entry whose matcher accepts a request, so
      // the two registrations share one claim and answer one request between
      // them.
      let claimed = false;
      const claim = (accepted: boolean) => {
        if (claimed || !accepted) return false;
        claimed = true;
        return true;
      };
      addMockObjectResponse((request) => claim(matches(request)), {
        object: entry.object,
      });
      addMockResponse(
        (request) => claim(offersPresentResult(request) && matches(request)),
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: id,
            toolName: PRESENT_RESULT_TOOL_NAME,
            input: entry.object,
          }],
          id,
        },
      );
    } else {
      addMockResponse(
        (request) => !offersPresentResult(request) && matches(request),
        { role: "assistant", content: entry.text, id },
      );
    }
  });
  return { [Symbol.dispose]: resetMockMode };
}
