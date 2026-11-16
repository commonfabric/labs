import type { BuiltInLLMMessage } from "commonfabric";

export type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  /**
   * The pasted text, for a clipboard attachment. `cf-prompt-input` declares
   * this `unknown`, and a schema field typed `unknown` reads as a reference
   * rather than the value, so `any` is what lets a handler read the text.
   */
  // deno-lint-ignore no-explicit-any
  data?: any;
};

export type PromptSendEvent = {
  detail: {
    text: string;
    attachments?: Array<PromptAttachment>;
  };
};

export const promptInputMessage = (
  event: PromptSendEvent,
): BuiltInLLMMessage => {
  const { text, attachments } = event.detail;
  let resolved = text;
  for (const attachment of attachments ?? []) {
    if (
      attachment.type === "clipboard" && typeof attachment.data === "string"
    ) {
      resolved = resolved.split(`[${attachment.name}](#${attachment.id})`)
        .join(attachment.data);
    }
  }

  return makeUserPromptMessage(resolved);
};

export const makeUserPromptMessage = (prompt: string): BuiltInLLMMessage => ({
  role: "user",
  content: [{ type: "text" as const, text: prompt }],
});
