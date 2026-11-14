/**
 * Test Pattern: Chatbot
 *
 * A message the prompt input sends carries pasted content inline in place of
 * the reference to it (`cfc/prompt-injection/prompt.test.ts` states the
 * rule); the model picker lists the models the server offers; an untitled
 * chat shows its placeholder title; and the Clear button empties the
 * transcript.
 *
 * The test environment has no language model: the dialog answers each
 * message with its error reply, and the title generator falls back to its
 * placeholder.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElement,
  fireEvent,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Chatbot from "./chatbot.tsx";

type Message = { role: string; content: unknown };
type ModelItem = { label: string; value: string };

/** The text of the message whose content is one text part, if it is. */
const onlyTextOf = (message: Message | undefined): string | undefined => {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.length === 1 && parts[0]?.type === "text"
    ? parts[0].text
    : undefined;
};

export const fetchMocks = [
  {
    urlIncludes: "/api/ai/llm/models",
    body: '{"anthropic:claude-sonnet-4-5":{},"openai:gpt-5":{}}',
  },
];

export default pattern(() => {
  const chat = Chatbot({ system: "Be brief." });

  const action_send_with_paste = action(() => {
    fireEvent(findElement(chat[UI], "cf-prompt-input"), "oncf-send", {
      detail: {
        text: "Summarize [Pasted text](#att-1)",
        attachments: [
          {
            id: "att-1",
            name: "Pasted text",
            type: "clipboard",
            data: "the pasted words",
          },
        ],
        mentions: [],
        message: "",
      },
    }, "the prompt input");
  });
  const action_clear = action(() => {
    clickButton(chat[UI], "Clear");
  });

  const assert_models_listed = assert(() => {
    const items = (propValue(
      findElement(chat[UI], "cf-prompt-input"),
      "modelItems",
    ) ?? []) as ModelItem[];
    const models = ["anthropic:claude-sonnet-4-5", "openai:gpt-5"];
    return items.length === models.length &&
      items.every((item, i) =>
        item.label === models[i] && item.value === models[i]
      );
  });
  const assert_paste_resolved_inline = assert(() => {
    const messages = (chat.messages ?? []) as Message[];
    return messages.length === 2 && messages[0]?.role === "user" &&
      onlyTextOf(messages[0]) === "Summarize the pasted words" &&
      messages[1]?.role === "assistant" &&
      chat.pending === false;
  });
  const assert_untitled = assert(() =>
    chat[NAME] === "Untitled Chat" && chat.title === "Untitled Chat"
  );
  const assert_cleared = assert(() =>
    (chat.messages ?? []).length === 0 && chat.pending === false
  );

  return {
    [TESTS]: [
      { settle: true },
      { assertion: assert_models_listed },
      { action: action_send_with_paste },
      { settle: true },
      { assertion: assert_paste_resolved_inline },
      { assertion: assert_untitled },
      { action: action_clear },
      { assertion: assert_cleared },
    ],
    chat,
    // The dialog and the title generator warn that they cannot reach the
    // language model.
    allowConsoleWarnings: true,
  };
});
