/**
 * Tests the prompt-injection demo's controls: the model pickers list the
 * fetched model directory, the run buttons and prompt inputs post the user's
 * request to the agent they name and leave the other alone, and each clear
 * button empties only what it says.
 *
 * No model answers here, since `cf test` has nothing that can stand in for one,
 * so each request ends in an error reply and no tool is ever called.
 * runtime/runner/test/cfc-agent-prompt-injection-demo.test.ts drives the
 * agents' tool calls with a model fixture.
 *
 * Run: deno task cf test patterns/examples/cfc-agent-prompt-injection-demo/main.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElement,
  findElementByText,
  fireEvent,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Demo from "./main.tsx";

const DEMO_PROMPT_START = "Read the briefing, see whether the project";
const UNSAFE_TITLE = "Unsafe raw reader";
const SAFE_TITLE = "Safe generic subAgent path";

// The directory names the default model again, which the picker lists once.
export const fetchMocks = [
  {
    urlIncludes: "/api/ai/llm/models",
    contentType: "application/json",
    body: '{"gateway:z-ai/glm-5.2":{},"openai:gpt-test":{}}',
  },
];

type Message = { role: string; content: unknown };

const firstText = (messages: readonly Message[]): string => {
  const content = messages[0]?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const part: unknown = content[0];
  if (typeof part !== "object" || part === null || !("text" in part)) {
    return "";
  }
  return typeof part.text === "string" ? part.text : "";
};

const userAsked = (messages: readonly Message[], prompt: string): boolean =>
  messages[0]?.role === "user" && firstText(messages).startsWith(prompt);

/** The agent panel whose heading is `title`. */
const panel = (view: unknown, title: string): unknown =>
  findElementByText(view, "section", title);

const pickerValues = (view: unknown): unknown[] => {
  const items = propValue(findElement(view, "cf-select"), "items");
  if (!Array.isArray(items)) return [];
  return items.map((item: unknown) =>
    typeof item === "object" && item !== null && "value" in item
      ? item.value
      : undefined
  );
};

const sendPrompt = (view: unknown, title: string, text: string): void =>
  fireEvent(
    findElement(panel(view, title), "cf-prompt-input"),
    "oncf-send",
    { detail: { text } },
    `the ${title} prompt input`,
  );

export default pattern(() => {
  const subject = Demo({});

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          subject[NAME] === "CFC agent prompt injection demo"
        ),
      },
      { settle: true },
      {
        assertion: assert(() =>
          pickerValues(subject[UI]).join(",") ===
            "anthropic:claude-sonnet-4-6,gateway:claude-sonnet-5," +
              "gateway:z-ai/glm-5.2,openai:gpt-test"
        ),
      },
      {
        assertion: assert(() =>
          hasText(subject[UI], "0 email(s) sent") &&
          hasText(subject[UI], "No mail sent yet.")
        ),
      },
      {
        assertion: assert(() =>
          subject.unsafeMessages.length === 0 &&
          subject.safeMessages.length === 0
        ),
      },

      // The shared button asks both agents.
      { action: action(() => clickButton(subject[UI], "Run both agents")) },
      {
        assertion: assert(() =>
          userAsked(subject.unsafeMessages, DEMO_PROMPT_START) &&
          userAsked(subject.safeMessages, DEMO_PROMPT_START)
        ),
      },
      { action: action(() => clickButton(subject[UI], "Clear unsafe")) },
      {
        assertion: assert(() =>
          subject.unsafeMessages.length === 0 &&
          userAsked(subject.safeMessages, DEMO_PROMPT_START)
        ),
      },
      { action: action(() => clickButton(subject[UI], "Clear safe")) },
      { assertion: assert(() => subject.safeMessages.length === 0) },

      // Each single-agent button asks only the agent it names.
      { action: action(() => clickButton(subject[UI], "Run unsafe only")) },
      {
        assertion: assert(() =>
          userAsked(subject.unsafeMessages, DEMO_PROMPT_START) &&
          subject.safeMessages.length === 0
        ),
      },
      {
        action: action(() =>
          clickButton(panel(subject[UI], UNSAFE_TITLE), "Clear")
        ),
      },
      { assertion: assert(() => subject.unsafeMessages.length === 0) },
      { action: action(() => clickButton(subject[UI], "Run safe only")) },
      {
        assertion: assert(() =>
          userAsked(subject.safeMessages, DEMO_PROMPT_START) &&
          subject.unsafeMessages.length === 0
        ),
      },
      {
        action: action(() =>
          clickButton(panel(subject[UI], SAFE_TITLE), "Clear")
        ),
      },
      { assertion: assert(() => subject.safeMessages.length === 0) },

      // A panel's prompt input asks its own agent.
      {
        action: action(() =>
          sendPrompt(subject[UI], UNSAFE_TITLE, "Summarize the briefing.")
        ),
      },
      {
        assertion: assert(() =>
          userAsked(subject.unsafeMessages, "Summarize the briefing.") &&
          subject.safeMessages.length === 0
        ),
      },
      {
        action: action(() =>
          sendPrompt(subject[UI], SAFE_TITLE, "Who approved it?")
        ),
      },
      {
        assertion: assert(() =>
          userAsked(subject.safeMessages, "Who approved it?")
        ),
      },

      // Only a model's tool call sends mail, and no agent here reached one,
      // so the log is still empty, and clearing it leaves it so.
      {
        assertion: assert(() =>
          subject.emails.length === 0 &&
          hasText(subject[UI], "0 email(s) sent")
        ),
      },
      { action: action(() => clickButton(subject[UI], "Clear emails")) },
      {
        assertion: assert(() =>
          subject.emails.length === 0 &&
          hasText(subject[UI], "No mail sent yet.")
        ),
      },
    ],
    subject,
  };
});
