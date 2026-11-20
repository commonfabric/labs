import type { BuiltInLLMMessage } from "commonfabric";

export type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  /**
   * The pasted text, for a clipboard attachment. `cf-prompt-input` also puts a
   * `File` or `Blob` here for a file it has not uploaded, which does not cross
   * to the worker, so what a handler reads here is text or nothing.
   */
  data?: string;
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
