/**
 * Test support for the Responses API migration.
 *
 * The gateway stubs in these suites describe intent ("the model answers with
 * this text", "the model calls this tool"), which is independent of the wire
 * shape. These helpers translate between that intent and the Responses wire
 * format so 100+ fixtures did not have to be restated.
 *
 * Tests that assert on the Responses wire format itself — reasoning
 * passthrough, encrypted continuation replay — build their bodies directly
 * instead of going through these helpers.
 */

import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Projects an outgoing Responses request back into the chat-shaped view these
 * suites assert against, so assertions about *content* ("the skills context
 * reached the model", "the tool result came back on the next turn") stay
 * readable. Assertions about the Responses wire format itself read the raw
 * body instead.
 */
export interface ChatViewMessage {
  role: string;

  /**
   * Text turns project to a plain string. Multimodal turns project to the
   * chat-style content-part array; those few assertions cast to read it.
   */
  content: string;

  tool_call_id?: string;
}

export const chatViewOfRequest = (
  body: unknown,
): { messages: ChatViewMessage[]; tools: string[] } => {
  const record = isObjectOrArray(body) ? body as Record<string, unknown> : {};
  // Turns that stay on Chat Completions (provider-native tools, non-OpenAI
  // models) are already in this shape.
  if (Array.isArray(record.messages)) {
    return {
      messages: record.messages as ChatViewMessage[],
      tools: ((record.tools as unknown[]) ?? []).flatMap((tool) => {
        if (!isObjectOrArray(tool)) return [];
        const fn = (tool as Record<string, unknown>).function;
        return isObjectOrArray(fn)
          ? [String((fn as Record<string, unknown>).name)]
          : [];
      }),
    };
  }
  const messages: ChatViewMessage[] = [];
  if (typeof record.instructions === "string") {
    messages.push({ role: "system", content: record.instructions });
  }
  for (const rawItem of (record.input as unknown[]) ?? []) {
    if (!isObjectOrArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "function_call") continue;
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id as string,
        content: item.output as string,
      });
      continue;
    }
    const content = item.content;
    if (!Array.isArray(content)) continue;
    // Both `{role, content}` and the fully-qualified `{type:"message", role,
    // content}` are legal Responses input items, and assistant turns use
    // output_text where user turns use input_text. Handle every combination
    // rather than keying on `type`, so a producer change cannot silently
    // project real content as an empty string.
    const parts: Record<string, unknown>[] = content.flatMap((
      rawPart,
    ): Record<string, unknown>[] => {
      if (!isObjectOrArray(rawPart)) return [];
      const part = rawPart as Record<string, unknown>;
      if (part.type === "input_text" || part.type === "output_text") {
        return [{ type: "text", text: part.text as string }];
      }
      if (part.type === "input_image") {
        return [{ type: "image_url", image_url: { url: part.image_url } }];
      }
      return [];
    });
    // Text-only turns read as a plain string, matching the chat contract;
    // anything carrying an image keeps the content-part array.
    const textOnly = parts.every((part) => part.type === "text");
    messages.push({
      role: String(item.role),
      content: (textOnly
        ? parts.map((part) =>
          part.text as string
        ).join("")
        : parts) as unknown as string,
    });
  }
  const tools = ((record.tools as unknown[]) ?? []).flatMap((tool) =>
    isObjectOrArray(tool)
      ? [String((tool as Record<string, unknown>).name)]
      : []
  );
  return { messages, tools };
};

export const responsesBodyFromChatFixture = (
  body: unknown,
  requestBody?: BodyInit | null,
): unknown => {
  if (!isObjectNotArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.choices)) return body;
  // A stub can serve both APIs across turns (the web_search profile switches to
  // a Gemini model mid-run). When the request was Chat Completions, the chat
  // fixture is already the right shape.
  if (typeof requestBody === "string") {
    try {
      const parsed = JSON.parse(requestBody) as Record<string, unknown>;
      if (Array.isArray(parsed.messages)) return body;
    } catch {
      // Unparseable request bodies fall through to conversion.
    }
  }
  const output: Record<string, unknown>[] = [];
  for (const rawChoice of record.choices) {
    if (!isObjectOrArray(rawChoice)) continue;
    const message = (rawChoice as Record<string, unknown>).message;
    if (!isObjectOrArray(message)) continue;
    const messageRecord = message as Record<string, unknown>;
    const content = messageRecord.content;
    if (typeof content === "string" && content.length > 0) {
      output.push({
        type: "message",
        id: `msg_fixture_${output.length}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: content, annotations: [] }],
      });
    }
    const toolCalls = messageRecord.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const rawCall of toolCalls) {
        if (!isObjectOrArray(rawCall)) continue;
        const call = rawCall as Record<string, unknown>;
        const fn = call.function as Record<string, unknown> | undefined;
        // No item `id`: that would make the client record a provider
        // continuation these legacy fixtures never asserted on. Continuation
        // replay has its own dedicated tests.
        output.push({
          type: "function_call",
          call_id: call.id,
          name: fn?.name,
          arguments: fn?.arguments,
        });
      }
    }
  }
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    object: "response",
    status: "completed",
    output,
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
};
