import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  addFirstUserPromptCacheBreakpoint,
  continuationOutput,
  normalizeTerminalResponse,
  toResponsesInput,
} from "../../src/model/responses-protocol.ts";

const PROVIDER = "openai-codex";
const MODEL = "gpt-5.4";
const LABEL = "test Responses";

const reasoningItem = {
  type: "reasoning",
  id: "rs_1",
  encrypted_content: "encrypted",
};

describe("responses-protocol", () => {
  describe("continuationOutput()", () => {
    it("returns the replayable items of a well-formed continuation", () => {
      expect(continuationOutput(
        {
          providerId: PROVIDER,
          state: { version: 1, sourceModel: MODEL, output: [reasoningItem] },
        },
        MODEL,
        PROVIDER,
      )).toEqual([reasoningItem]);
    });

    it("returns no items when the state is not an object", () => {
      expect(continuationOutput(
        { providerId: PROVIDER, state: "not a state" },
        MODEL,
        PROVIDER,
      )).toEqual([]);
    });

    it("returns no items when the output is not an array", () => {
      expect(continuationOutput(
        {
          providerId: PROVIDER,
          state: { version: 1, sourceModel: MODEL, output: reasoningItem },
        },
        MODEL,
        PROVIDER,
      )).toEqual([]);
    });

    it("drops output entries that are not objects", () => {
      expect(continuationOutput(
        {
          providerId: PROVIDER,
          state: {
            version: 1,
            sourceModel: MODEL,
            output: [null, "reasoning", reasoningItem],
          },
        },
        MODEL,
        PROVIDER,
      )).toEqual([reasoningItem]);
    });
  });

  describe("toResponsesInput()", () => {
    const assistantTextItem = (text: string) => ({
      type: "message",
      id: "msg_cf_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });

    it("sends the transcript's assistant text when the continuation state is not an object", async () => {
      const { input } = await toResponsesInput(
        [
          { role: "user", content: "Search." },
          {
            role: "assistant",
            content: "From the transcript.",
            providerContinuation: { providerId: PROVIDER, state: 42 },
          },
        ],
        MODEL,
        PROVIDER,
        LABEL,
      );

      expect(input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Search." }] },
        assistantTextItem("From the transcript."),
      ]);
    });

    it("replays stored search output whose projection matches the transcript", async () => {
      const searchOutput = [
        { type: "web_search_call", id: "ws_1", status: "completed" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Stored answer." }],
        },
      ];
      const { input } = await toResponsesInput(
        [{
          role: "assistant",
          content: "Stored answer.",
          nativeModelToolResults: [{
            type: "cf-harness.native-model-tool-result",
            toolId: "openai_web_search",
            provider: "openai-codex",
            providerMetadata: { searchCalls: [searchOutput[0]] },
            sources: [],
          }],
          providerContinuation: {
            providerId: PROVIDER,
            state: { version: 2, sourceModel: MODEL, output: [], searchOutput },
          },
        }],
        MODEL,
        PROVIDER,
        LABEL,
      );

      expect(input).toEqual(searchOutput);
    });

    it("sends the transcript instead of stored search output that no longer projects", async () => {
      // Two calls under one id with different arguments cannot be projected,
      // so the stored output is not trusted and the transcript is sent.
      const call = (args: string) => ({
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: args,
      });
      const { input } = await toResponsesInput(
        [{
          role: "assistant",
          content: "From the transcript.",
          providerContinuation: {
            providerId: PROVIDER,
            state: {
              version: 2,
              sourceModel: MODEL,
              output: [],
              searchOutput: [
                { type: "web_search_call", id: "ws_1", status: "completed" },
                call('{"path":"a"}'),
                call('{"path":"b"}'),
              ],
            },
          },
        }],
        MODEL,
        PROVIDER,
        LABEL,
      );

      expect(input).toEqual([{
        ...assistantTextItem("From the transcript."),
        id: "msg_cf_0",
      }]);
    });
  });

  describe("addFirstUserPromptCacheBreakpoint()", () => {
    it("marks the last cacheable block, passing over blocks that are not objects", () => {
      const marked = addFirstUserPromptCacheBreakpoint(
        [{
          role: "user",
          content: [{ type: "input_text", text: "Cache me." }, "loose text"],
        }],
        LABEL,
      );

      expect(marked).toEqual([{
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Cache me.",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
          "loose text",
        ],
      }]);
    });
  });

  describe("normalizeTerminalResponse()", () => {
    it("throws the provider's stated reason for a failed response", () => {
      expect(() =>
        normalizeTerminalResponse(
          {
            status: "failed",
            output: [],
            error: { code: "server_error", message: "upstream broke" },
          },
          MODEL,
          PROVIDER,
          LABEL,
        )
      ).toThrow("test Responses ended with status failed");
    });

    it("throws for a status it does not know", () => {
      expect(() =>
        normalizeTerminalResponse(
          { status: "queued", output: [] },
          MODEL,
          PROVIDER,
          LABEL,
        )
      ).toThrow("test Responses terminal event has an unknown status");
    });

    it("throws when a completed response has no output array", () => {
      expect(() =>
        normalizeTerminalResponse(
          { status: "completed" },
          MODEL,
          PROVIDER,
          LABEL,
        )
      ).toThrow("test Responses terminal event did not include output");
    });

    it("reads text past output items and content parts that are not objects", () => {
      const assistant = normalizeTerminalResponse(
        {
          status: "completed",
          output: [
            "stray",
            {
              type: "message",
              role: "assistant",
              content: [null, { type: "output_text", text: "Kept." }],
            },
          ],
        },
        MODEL,
        PROVIDER,
        LABEL,
      );

      expect(assistant).toEqual({ role: "assistant", content: "Kept." });
    });

    it("returns one tool call for identical calls sharing an id", () => {
      const call = {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"a"}',
      };
      const assistant = normalizeTerminalResponse(
        { status: "completed", output: [call, { ...call }] },
        MODEL,
        PROVIDER,
        LABEL,
      );

      expect(assistant.toolCalls).toEqual([{
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a"}' },
      }]);
    });
  });
});
